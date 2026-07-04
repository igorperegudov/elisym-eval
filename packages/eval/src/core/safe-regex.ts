import vm from 'node:vm';

/**
 * Defense-in-depth for case/dataset-supplied regular expressions.
 *
 * Datasets are shared artifacts (red-team corpora, downloaded suites), so a
 * pattern string is semi-untrusted input; a catastrophic-backtracking pattern
 * can wedge the single-threaded runner. Catastrophic backtracking splits into
 * two regimes, each handled by a different layer (neither alone is enough):
 *
 *   SINGLE-ATTEMPT blowup - all the backtracking happens inside ONE match
 *   attempt (the pattern matches at a fixed start position), e.g. the ungrouped
 *   `a?a?...a?a...a` 2^N chain. A `node:vm` timeout does NOT interrupt this:
 *   V8 only checks for interrupts when ADVANCING the start position, not within
 *   an attempt. So this regime is bounded STATICALLY (`isRiskyRegex`): a cap on
 *   the number of variable-length matchers (MAX_VARIABLE_QUANTIFIERS) - counting
 *   both variable-length quantifiers AND length-ambiguous alternation groups
 *   (`(a|)` == `a?`, `(aa|a)`), since a run of either is 2^N - bounds the
 *   factor, plus rejection of a repetition over an ambiguous group, a
 *   backreference, and a huge bounded count.
 *
 *   MULTI-POSITION blowup - an unanchored pattern retried across O(n) start
 *   positions, e.g. `.*x` / `a*a*b` -> polynomial. V8 checks for interrupts
 *   between positions, so a `node:vm` timeout DOES bound this. Every match runs
 *   under REGEX_TIMEOUT_MS via `safeTest` / `safeMatchAll` / `safeExec`.
 *
 * Plus: bound the pattern length, allowlist flags (stops a malformed-flags
 * `SyntaxError` crash), and bound the subject length. `isRiskyRegex` also
 * fast-rejects the common multi-position families (>=2 repetition-capable
 * quantifiers) so they fail instantly instead of after the timeout.
 *
 * re2 (a linear-time engine) was rejected because it segfaults under Bun.
 * Matching runs under Node (the CLI bin's `#!/usr/bin/env node` runtime and the
 * test runner); Bun only runs compile/validate, which never match
 * case-supplied patterns.
 */

export const MAX_PATTERN_LENGTH = 1000;
export const MAX_REGEX_INPUT_LENGTH = 64 * 1024;
/**
 * Largest finite `{n}` / `{n,m}` repetition allowed. A huge bounded count over
 * an atom (`a{999999}`) scans quadratically (each start position retries up to
 * n chars); no eval-assertion pattern legitimately repeats > 1000 times - use
 * the output structure length check instead.
 */
export const MAX_QUANTIFIER_REPEAT = 1000;
/**
 * Largest number of variable-length quantifiers (`?`, `*`, `+`, non-exact
 * ranges) a pattern may contain. Each independent optional choice can double
 * the single-attempt backtracking cost, so N of them is up to 2^N. A vm
 * timeout does NOT interrupt a single match attempt (V8 only checks for
 * interrupts when advancing the start position), so this cap - not the timeout
 * - is what bounds single-attempt exponential blowup (`a?a?...a?` chains). At
 * 12 the worst case is ~2^12 steps (sub-millisecond); real eval patterns use
 * far fewer.
 */
export const MAX_VARIABLE_QUANTIFIERS = 12;
const ALLOWED_FLAGS = 'dgimsuy';

export class UnsafeRegexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeRegexError';
  }
}

interface Quantifier {
  /** Length in chars (1 for `*`/`+`/`?`, full length for `{...}`). */
  length: number;
  /** No upper bound: `*`, `+`, `{n,}`. */
  unbounded: boolean;
  /** Effective maximum repetition is >= 2 (drives bounded blowup like `(a?){30}`). */
  maxAtLeast2: boolean;
  /** Matches a span in more than one length (min < max) - the ambiguity source. */
  variable: boolean;
  /** Finite maximum repetition, or Infinity when unbounded. */
  maxReps: number;
}

/** Parse a quantifier at `pattern[i]`, or null if it is not a quantifier. */
function parseQuantifier(pattern: string, i: number): Quantifier | null {
  const ch = pattern[i];
  if (ch === '*' || ch === '+') {
    return { length: 1, unbounded: true, maxAtLeast2: true, variable: true, maxReps: Infinity };
  }
  if (ch === '?') {
    return { length: 1, unbounded: false, maxAtLeast2: false, variable: true, maxReps: 1 };
  }
  if (ch === '{') {
    const m = /^\{(\d*)(,(\d*))?\}/.exec(pattern.slice(i));
    // A `{...}` is only a quantifier when it has the `{n}` / `{n,}` / `{n,m}`
    // shape with a leading count; otherwise it is a literal brace.
    if (m === null || m[1] === '') {
      return null;
    }
    const min = Number.parseInt(m[1], 10);
    const hasComma = m[2] !== undefined;
    const maxStr = m[3];
    if (!hasComma) {
      // `{n}` is exact -> fixed length, not a source of length ambiguity.
      return {
        length: m[0].length,
        unbounded: false,
        maxAtLeast2: min >= 2,
        variable: false,
        maxReps: min,
      };
    }
    if (maxStr === undefined || maxStr === '') {
      return {
        length: m[0].length,
        unbounded: true,
        maxAtLeast2: true,
        variable: true,
        maxReps: Infinity,
      }; // {n,}
    }
    const max = Number.parseInt(maxStr, 10);
    return {
      length: m[0].length,
      unbounded: false,
      maxAtLeast2: max >= 2,
      variable: min < max,
      maxReps: max,
    };
  }
  return null;
}

/**
 * Best-effort fast-reject of catastrophic-backtracking risk. NOT complete - it
 * is a cheap pre-filter that catches the common families instantly; the
 * wall-clock timeout on every match is what makes the harness sound (e.g. an
 * ungrouped `a?a?...a?b` chain is exponential yet passes this check, and is
 * bounded only by the timeout). A "repetition-capable" quantifier is one that
 * can match a span in more than one length (`*`, `+`, `{n,}`, or `{n,m}`/`{n}`
 * with max >= 2 - but NOT `?`, whose two choices matter only under a repetition):
 *   (a) two or more repetition-capable quantifiers can consume overlapping
 *       spans -> polynomial (`a*a*b`, `a{0,1000}a{0,1000}b`, `.*.*=`);
 *   (b) a repetition-capable quantifier applied to an AMBIGUOUS group - one
 *       whose body contains an alternation or a nested quantifier -> exponential
 *       (`(a|a)*`, `(a?){30}`, `(.*){10}`, `(a+){10}`);
 *   (c) a backreference (`\1`-`\9`, `\k<name>`), not linear-time in general;
 *   (d) a single finite repetition with a huge max scans quadratically
 *       (`a{999999}`), capped by MAX_QUANTIFIER_REPEAT.
 * It over-rejects some safe patterns too (`a*b*` / `\d+\.\d+` - two unbounded
 * quantifiers separated by a literal, which are only quadratic and are bounded
 * by the match timeout anyway) - the safe direction. Exact `{n}` quantifiers
 * are fixed-length and not counted, so `\d{4}-\d{2}` is allowed. Escapes and
 * character classes are skipped so `\+`, `[+*|]` are literals.
 */
function isRiskyRegex(pattern: string): boolean {
  interface Group {
    /** Body contains an alternation or a quantifier (recursively) => ambiguous. */
    bodyAmbiguous: boolean;
    /** Body has a top-level alternation `|` => a variable-length matcher itself. */
    hasAlternation: boolean;
  }
  const stack: Group[] = [];
  let lastClosed: Group | null = null;
  let inClass = false;
  let repeatableCount = 0;
  let variableCount = 0;

  const markEnclosingAmbiguous = (): void => {
    const top = stack[stack.length - 1];
    if (top !== undefined) {
      top.bodyAmbiguous = true;
    }
  };

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      // A backreference (\1-\9 or \k<name>) is not linear-time in general.
      const next = pattern[i + 1];
      if (next !== undefined && (/[1-9]/.test(next) || next === 'k')) {
        return true;
      }
      i++; // skip the escaped char
      lastClosed = null;
      continue;
    }
    if (inClass) {
      if (ch === '\\') {
        i++; // skip an escaped char (e.g. `\]`) so it doesn't close the class
      } else if (ch === ']') {
        inClass = false;
      }
      continue;
    }
    if (ch === '[') {
      inClass = true;
      lastClosed = null;
      continue;
    }
    if (ch === '(') {
      stack.push({ bodyAmbiguous: false, hasAlternation: false });
      lastClosed = null;
      // Skip a group-modifier prefix so its `?`/`<` are not read as quantifiers:
      // (?:  (?=  (?!  (?<=  (?<!  (?<name>
      if (pattern[i + 1] === '?') {
        const two = pattern[i + 2];
        if (two === ':' || two === '=' || two === '!') {
          i += 2;
        } else if (two === '<') {
          const three = pattern[i + 3];
          if (three === '=' || three === '!') {
            i += 3; // lookbehind
          } else {
            const gt = pattern.indexOf('>', i + 3); // named group (?<name>
            i = gt === -1 ? pattern.length : gt;
          }
        }
      }
      continue;
    }
    if (ch === ')') {
      const closed = stack.pop() ?? null;
      if (closed !== null && closed.bodyAmbiguous) {
        markEnclosingAmbiguous();
      }
      // (e') an alternation group is itself a variable-length matcher (its
      // branches can differ in length, e.g. `(a|)` == `a?`, `(aa|a)`), so a
      // run of them is 2^N single-attempt blowup just like a `?` chain and
      // must count toward the cap - the vm timeout cannot interrupt it.
      if (closed !== null && closed.hasAlternation) {
        variableCount++;
        if (variableCount > MAX_VARIABLE_QUANTIFIERS) {
          return true;
        }
      }
      lastClosed = closed;
      continue;
    }
    if (ch === '|') {
      markEnclosingAmbiguous(); // an alternation makes the enclosing body ambiguous
      const top = stack[stack.length - 1];
      if (top !== undefined) {
        top.hasAlternation = true;
      }
      lastClosed = null;
      continue;
    }

    const quant = parseQuantifier(pattern, i);
    if (quant !== null) {
      // A huge FINITE bounded repetition scans quadratically over its atom/group.
      if (Number.isFinite(quant.maxReps) && quant.maxReps > MAX_QUANTIFIER_REPEAT) {
        return true;
      }
      // A quantifier in a group's body makes that body ambiguous (optionality /
      // length ambiguity).
      markEnclosingAmbiguous();
      // (e) too many variable-length quantifiers -> 2^N single-attempt blowup
      // (`a?a?...a?a...a`), which a vm timeout cannot interrupt.
      if (quant.variable) {
        variableCount++;
        if (variableCount > MAX_VARIABLE_QUANTIFIERS) {
          return true;
        }
      }
      // (a) two VARIABLE repetition-capable quantifiers (max>=2 or unbounded,
      // excluding exact `{n}`) can consume overlapping spans -> polynomial
      // (`a*a*b`, `a{0,1000}a{0,1000}b`). `?` (max 1) only matters under (b)/(e).
      if (quant.unbounded || (quant.maxAtLeast2 && quant.variable)) {
        repeatableCount++;
        if (repeatableCount >= 2) {
          return true;
        }
      }
      // (b) a repetition (max>=2 or unbounded, including exact `{n}` which
      // repeats a group n times) over an ambiguous group -> exponential.
      if (
        (quant.unbounded || quant.maxAtLeast2) &&
        lastClosed !== null &&
        lastClosed.bodyAmbiguous
      ) {
        return true;
      }
      i += quant.length - 1; // skip the rest of a `{...}` quantifier
      if (pattern[i + 1] === '?') {
        i++; // consume a lazy `?` modifier
      }
      lastClosed = null; // the group (if any) has been consumed by the quantifier
      continue;
    }
    lastClosed = null; // any other token ends the just-closed-group state
  }
  return false;
}

function validateFlags(flags: string): void {
  for (const flag of flags) {
    if (!ALLOWED_FLAGS.includes(flag)) {
      throw new UnsafeRegexError(`unsupported regex flag "${flag}" (allowed: ${ALLOWED_FLAGS})`);
    }
  }
}

/**
 * Build a RegExp from case-supplied strings, rejecting oversized patterns,
 * unknown flags and nested-quantifier ReDoS shapes. Throws UnsafeRegexError
 * (or a plain SyntaxError for otherwise-invalid syntax) instead of running a
 * dangerous pattern.
 */
export function safeRegExp(pattern: string, flags = ''): RegExp {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new UnsafeRegexError(
      `regex pattern too long (${pattern.length} > ${MAX_PATTERN_LENGTH} chars)`,
    );
  }
  validateFlags(flags);
  if (isRiskyRegex(pattern)) {
    throw new UnsafeRegexError(
      `regex pattern "${pattern}" carries catastrophic-backtracking risk ` +
        '(>=2 unbounded quantifiers, a quantified alternation group, or a backreference); ' +
        'use at most one unbounded quantifier and a character class instead of a quantified alternation',
    );
  }
  return new RegExp(pattern, flags);
}

/** Truncate a subject to the safe length before matching. */
export function boundInput(input: string): string {
  return input.length > MAX_REGEX_INPUT_LENGTH ? input.slice(0, MAX_REGEX_INPUT_LENGTH) : input;
}

/**
 * Hard wall-clock bound on a single regex match. `isRiskyRegex` fast-rejects
 * the known catastrophic families, but static detection of "safe" regexes is
 * undecidable; this is the SOUND backstop. Modern V8 checks for interrupts
 * during regex execution, so a `vm` timeout (unlike a plain setTimeout) DOES
 * interrupt synchronous backtracking - verified on Node and Bun.
 */
export const REGEX_TIMEOUT_MS = 1000;

// A reusable context + precompiled scripts avoid per-call setup cost. The
// subject/regex are injected as globals before each run.
const regexContext = vm.createContext({ __re: null as RegExp | null, __s: '' });
const TEST_SCRIPT = new vm.Script('__re.test(__s)');
const EXEC_SCRIPT = new vm.Script(
  '(() => { const m = __re.exec(__s); return m ? Array.from(m) : null; })()',
);
const MATCH_ALL_SCRIPT = new vm.Script('Array.from(__s.matchAll(__re), (m) => Array.from(m))');

function isTimeout(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    ((err as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
      /timed out/i.test((err as { message?: string }).message ?? ''))
  );
}

function runBounded<T>(script: vm.Script, regex: RegExp, input: string): T {
  const context = regexContext as unknown as { __re: RegExp | null; __s: string };
  context.__re = regex;
  context.__s = boundInput(input);
  try {
    return script.runInContext(regexContext, { timeout: REGEX_TIMEOUT_MS }) as T;
  } catch (err) {
    if (isTimeout(err)) {
      throw new UnsafeRegexError(
        `regex match exceeded ${REGEX_TIMEOUT_MS}ms - catastrophic backtracking (ReDoS)`,
      );
    }
    throw err;
  } finally {
    context.__re = null;
    context.__s = '';
  }
}

/** `regex.test` over a length-bounded subject, under a hard wall-clock timeout. */
export function safeTest(regex: RegExp, input: string): boolean {
  return runBounded<boolean>(TEST_SCRIPT, regex, input);
}

/**
 * `string.matchAll` over a length-bounded subject, under a hard timeout.
 * Returns plain match arrays (`[full, ...groups]` per match); the regex must
 * carry the `g` flag.
 */
export function safeMatchAll(regex: RegExp, input: string): RegExpMatchArray[] {
  return runBounded<RegExpMatchArray[]>(MATCH_ALL_SCRIPT, regex, input);
}

/** `regex.exec` over a length-bounded subject, under a hard timeout. */
export function safeExec(regex: RegExp, input: string): RegExpExecArray | null {
  return runBounded<RegExpExecArray | null>(EXEC_SCRIPT, regex, input);
}

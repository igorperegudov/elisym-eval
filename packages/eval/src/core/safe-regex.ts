/**
 * Defense-in-depth for case/dataset-supplied regular expressions.
 *
 * Datasets are shared artifacts (red-team corpora, downloaded suites), so a
 * pattern string is semi-untrusted input. A catastrophic-backtracking pattern
 * (`(a+)+$`) plus a matching subject can wedge the single-threaded runner, and
 * V8 regex execution is synchronous - a wall-clock timeout cannot interrupt it
 * (the event loop is blocked, so the timer never fires). We therefore prevent
 * the blowup up front, without a heavy native engine:
 *
 * 1. bound the pattern length,
 * 2. allowlist flags (also stops a malformed-flags `SyntaxError` crash),
 * 3. statically reject every catastrophic-backtracking family via a sound
 *    over-approximation (see `isRiskyRegex`): >=2 unbounded quantifiers, a
 *    repetition (max>=2 or unbounded) over an ambiguous group, or a
 *    backreference. A pattern that avoids these matches in linear time.
 * 4. bound the subject length before matching (belt-and-braces).
 *
 * We rely on a sound static check rather than a linear-time native engine
 * because re2 crashes under Bun (this project's runtime), and a wall-clock
 * timeout cannot interrupt V8's synchronous backtracking. The check is a
 * deliberate over-approximation - it rejects some safe patterns too - which is
 * the safe direction for a matcher over semi-untrusted dataset input.
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
  /** Finite maximum repetition, or Infinity when unbounded. */
  maxReps: number;
}

/** Parse a quantifier at `pattern[i]`, or null if it is not a quantifier. */
function parseQuantifier(pattern: string, i: number): Quantifier | null {
  const ch = pattern[i];
  if (ch === '*' || ch === '+') {
    return { length: 1, unbounded: true, maxAtLeast2: true, maxReps: Infinity };
  }
  if (ch === '?') {
    return { length: 1, unbounded: false, maxAtLeast2: false, maxReps: 1 };
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
      return { length: m[0].length, unbounded: false, maxAtLeast2: min >= 2, maxReps: min };
    }
    if (maxStr === undefined || maxStr === '') {
      return { length: m[0].length, unbounded: true, maxAtLeast2: true, maxReps: Infinity }; // {n,}
    }
    const max = Number.parseInt(maxStr, 10);
    return { length: m[0].length, unbounded: false, maxAtLeast2: max >= 2, maxReps: max };
  }
  return null;
}

/**
 * Sound over-approximation of catastrophic-backtracking risk.
 *
 * Worst-case super-linear matching in a backtracking engine has exactly these
 * mechanisms; a "repetition-capable" quantifier is one that can match a span in
 * more than one length (`*`, `+`, `{n,}`, or `{n,m}`/`{n}` with max >= 2 - but
 * NOT `?`, whose two choices matter only under another repetition):
 *   (a) two or more repetition-capable quantifiers can consume overlapping
 *       spans -> polynomial (`a*a*b`, `a{0,1000}a{0,1000}b`, `.*.*=`);
 *   (b) a repetition-capable quantifier applied to an AMBIGUOUS group - one
 *       whose body contains an alternation or a nested quantifier -> exponential
 *       (`(a|a)*`, `(a?){30}`, `(.*){10}`, `(a+){10}`);
 *   (c) a backreference (`\1`-`\9`, `\k<name>`), not linear-time in general;
 *   (d) a single finite repetition with a huge max scans quadratically
 *       (`a{999999}`), capped by MAX_QUANTIFIER_REPEAT.
 * A pattern with at most one repetition-capable quantifier, none over an
 * ambiguous group, no backreference, and no huge count runs in linear time -
 * there is no other super-linear mechanism.
 *
 * This is a deliberate over-approximation: it also rejects some safe patterns
 * (`a*b*` over disjoint alphabets, `\d{4}-\d{2}` separated by a literal). Use a
 * single quantifier, a character class, or the output structure length check
 * instead. Escapes and character classes are skipped so `\+`, `[+*|]` are
 * literals. Sound against catastrophic backtracking without a native engine
 * (re2 crashes under Bun); not a minimal over-approximation.
 */
function isRiskyRegex(pattern: string): boolean {
  interface Group {
    /** Body contains an alternation or a quantifier (recursively) => ambiguous. */
    bodyAmbiguous: boolean;
  }
  const stack: Group[] = [];
  let lastClosed: Group | null = null;
  let inClass = false;
  let repeatableCount = 0;

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
      stack.push({ bodyAmbiguous: false });
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
      lastClosed = closed;
      continue;
    }
    if (ch === '|') {
      markEnclosingAmbiguous(); // an alternation makes the enclosing body ambiguous
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
      // (a) two repetition-capable quantifiers (unbounded OR finite max>=2) can
      // consume overlapping spans -> polynomial (`a*a*b`, `a{0,1000}a{0,1000}b`).
      // `?` (max 1) is not repetition-capable and only matters under (b).
      if (quant.unbounded || quant.maxAtLeast2) {
        repeatableCount++;
        if (repeatableCount >= 2) {
          return true;
        }
      }
      // (b) a repetition (max>=2 or unbounded) over an ambiguous group -> exponential.
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

/** `regex.test` over a length-bounded subject. */
export function safeTest(regex: RegExp, input: string): boolean {
  return regex.test(boundInput(input));
}

/** `string.matchAll` over a length-bounded subject (regex must carry the `g` flag). */
export function safeMatchAll(regex: RegExp, input: string): IterableIterator<RegExpMatchArray> {
  return boundInput(input).matchAll(regex);
}

/** `regex.exec` over a length-bounded subject. */
export function safeExec(regex: RegExp, input: string): RegExpExecArray | null {
  return regex.exec(boundInput(input));
}

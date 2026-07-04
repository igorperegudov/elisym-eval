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
 * 3. statically reject the two classic exponential families: an unbounded
 *    quantifier applied to a group whose body contains either another
 *    unbounded quantifier (`(a+)+`, `(a*)*`, `(.*)+`, `(\d+){2,}`) or an
 *    alternation (`(a|a)*`, `(a|ab)+`, `(.|.)*`). The alternation check is a
 *    conservative over-approximation: it also rejects the disjoint-and-safe
 *    `(a|b)*`, so quantified alternations must be rewritten (e.g. a character
 *    class `[ab]*`). None of the bundled dataset patterns quantify a group,
 *    so this costs nothing in practice.
 * 4. bound the subject length before matching (caps polynomial cases and
 *    accidental huge inputs).
 *
 * Static detection of "safe" regexes is undecidable in general; this catches
 * the well-known evil-regex families and is proportionate for a local harness,
 * but is not a formal guarantee.
 */

export const MAX_PATTERN_LENGTH = 1000;
export const MAX_REGEX_INPUT_LENGTH = 64 * 1024;
const ALLOWED_FLAGS = 'dgimsuy';

export class UnsafeRegexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeRegexError';
  }
}

/**
 * Sound over-approximation of catastrophic-backtracking risk.
 *
 * A pattern matches in worst-case super-linear time only if it can match some
 * input span in more than one way under a repetition. That requires either:
 *   (a) two or more unbounded quantifiers (`*`, `+`, `{n,}`) - the polynomial
 *       family `a*a*b` / `.*.*=` and the nested exponential family `(a+)+`; or
 *   (b) a single unbounded quantifier applied to a group containing an
 *       alternation - the exponential family `(a|a)*` / `(a|b)+`; or
 *   (c) a backreference, whose matching is not linear in general.
 * A pattern with at most one unbounded quantifier, no quantified alternation
 * group, and no backreference runs in linear time.
 *
 * This REJECTS some safe patterns too (`a*b*` with disjoint alphabets,
 * `\d+-\d+` separated by a literal): they have >=2 unbounded quantifiers and
 * are refused conservatively - rewrite with a single quantifier or a character
 * class. Escapes and character classes are skipped, so `\+`, `[+*|]` are
 * treated as literals. This is sound against the known ReDoS families without
 * a heavy native engine; it is a deliberate over-approximation, not a minimal
 * one.
 */
function isRiskyRegex(pattern: string): boolean {
  interface Group {
    /** Body contains a top-level alternation (recursively via nested groups). */
    bodyHasAlternation: boolean;
  }
  const stack: Group[] = [];
  let lastClosed: Group | null = null;
  let inClass = false;
  let unboundedCount = 0;

  const markEnclosingAlternation = (): void => {
    const top = stack[stack.length - 1];
    if (top !== undefined) {
      top.bodyHasAlternation = true;
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
      if (ch === ']') {
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
      stack.push({ bodyHasAlternation: false });
      lastClosed = null;
      continue;
    }
    if (ch === ')') {
      const closed = stack.pop() ?? null;
      if (closed !== null && closed.bodyHasAlternation) {
        markEnclosingAlternation();
      }
      lastClosed = closed;
      continue;
    }
    if (ch === '|') {
      markEnclosingAlternation();
      lastClosed = null;
      continue;
    }

    const isUnbounded =
      ch === '+' ||
      ch === '*' ||
      // {n,} with no upper bound (a comma, then `}` with no max).
      (ch === '{' && /^\{\d*,\}/.test(pattern.slice(i)));

    if (isUnbounded) {
      unboundedCount++;
      if (unboundedCount >= 2) {
        return true; // polynomial or nested-exponential family
      }
      // Single unbounded quantifier applied to an alternation group -> exponential.
      if (lastClosed !== null && lastClosed.bodyHasAlternation) {
        return true;
      }
    }
    if (ch !== '?') {
      // `?` only makes a preceding quantifier lazy; keep lastClosed so
      // `(a|a)*?` is still caught. Any other token ends the just-closed state.
      lastClosed = null;
    }
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

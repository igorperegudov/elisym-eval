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
 * 3. statically reject nested unbounded quantifiers (the classic exponential
 *    shapes: `(a+)+`, `(a*)*`, `(.*)+`, `(\d+){2,}`),
 * 4. bound the subject length before matching (caps polynomial cases and
 *    accidental huge inputs).
 *
 * This is proportionate for a local harness; it is not a formal guarantee.
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
 * Reject a group that is quantified with an unbounded quantifier and whose
 * body itself contains an unbounded quantifier - the star-height >= 2 shape
 * that produces exponential backtracking. Escapes and character classes are
 * skipped so `\+`, `[+*]` etc. are treated as literals.
 */
function hasNestedUnboundedQuantifier(pattern: string): boolean {
  interface Group {
    bodyHasUnbounded: boolean;
  }
  const stack: Group[] = [];
  let lastClosed: Group | null = null;
  let inClass = false;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
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
      stack.push({ bodyHasUnbounded: false });
      lastClosed = null;
      continue;
    }
    if (ch === ')') {
      lastClosed = stack.pop() ?? null;
      continue;
    }

    const isUnbounded =
      ch === '+' ||
      ch === '*' ||
      // {n,} with no upper bound (the comma is present, nothing before `}` after it)
      (ch === '{' && /^\{\d*,\}/.test(pattern.slice(i)));

    if (isUnbounded) {
      // A quantifier applied directly to a just-closed group whose body was
      // itself unbounded -> nested unbounded quantifier.
      if (lastClosed !== null && lastClosed.bodyHasUnbounded) {
        return true;
      }
      // Record that the enclosing group's body contains an unbounded quantifier.
      const top = stack[stack.length - 1];
      if (top !== undefined) {
        top.bodyHasUnbounded = true;
      }
    }
    if (ch !== '?') {
      // `?` after a quantifier only makes it lazy; keep lastClosed so `(a+)+?`
      // is still caught. Any other token ends the "just closed a group" state.
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
  if (hasNestedUnboundedQuantifier(pattern)) {
    throw new UnsafeRegexError(
      `regex pattern "${pattern}" has nested unbounded quantifiers (catastrophic-backtracking risk)`,
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

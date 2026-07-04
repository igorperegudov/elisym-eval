import { describe, expect, test } from 'vitest';
import {
  boundInput,
  MAX_PATTERN_LENGTH,
  MAX_REGEX_INPUT_LENGTH,
  REGEX_TIMEOUT_MS,
  safeMatchAll,
  safeRegExp,
  safeTest,
  UnsafeRegexError,
} from '../src/core/safe-regex.js';

describe('safeRegExp', () => {
  test('compiles ordinary patterns, including those used by the bundled dataset', () => {
    for (const pattern of [
      '(confirm|proceed|pay|go ahead)',
      '^(yes|confirmed?)\\b',
      'settled: (inv-\\d+)',
      'tx-(\\w+)',
      '(fail|insufficient|could not|couldn.t|unable)',
      'not financial advice',
    ]) {
      expect(() => safeRegExp(pattern), pattern).not.toThrow();
    }
  });

  test('rejects nested unbounded quantifiers (catastrophic backtracking)', () => {
    for (const bad of ['(a+)+$', '(a*)*', '(.*)+', '(\\d+){2,}', '(x+)+y', '((ab)+)+', '(a+)+?']) {
      expect(() => safeRegExp(bad), bad).toThrow(UnsafeRegexError);
    }
  });

  test('rejects unbounded-quantified alternation groups (overlap backtracking)', () => {
    for (const bad of [
      '(a|a)*',
      '(a|ab)+',
      '(.|.)*',
      '([a-z]|[a-z])*',
      '((a|a))*',
      '(a|b)*',
      '(a|b){2,}',
    ]) {
      expect(() => safeRegExp(bad), bad).toThrow(UnsafeRegexError);
    }
  });

  test('rejects two repetition-capable quantifiers (polynomial backtracking)', () => {
    for (const bad of [
      'a*a*b',
      '.*.*=',
      '\\d*\\d*b',
      'a*a*a*b',
      'a*.*',
      '\\d+-\\d+',
      'a+b+',
      '\\d+\\.\\d+', // safe (separated), but two unbounded quantifiers -> over-rejected
      // adjacent BOUNDED pairs are the same overlapping-span mechanism
      'a{0,1000}a{0,1000}b',
      '.{0,1000}.{0,1000}=',
      'a{2,1000}a{2,1000}b',
      'a{0,1000}a*b',
      'a*a{0,1000}b',
    ]) {
      expect(() => safeRegExp(bad), bad).toThrow(UnsafeRegexError);
    }
  });

  test('rejects a chain of many variable quantifiers (single-attempt exponential)', () => {
    // The vm timeout cannot interrupt a single match attempt, so this
    // 2^N ungrouped-optional family must be caught statically by the count cap.
    for (const bad of ['a?'.repeat(55) + 'a'.repeat(55), 'a?'.repeat(13), '(a|b)?'.repeat(13)]) {
      expect(() => safeRegExp(bad), bad.slice(0, 20)).toThrow(UnsafeRegexError);
    }
    expect(() => safeRegExp('a?'.repeat(12))).not.toThrow(); // under the cap
  });

  test('rejects a chain of length-ambiguous alternation groups (a? in disguise)', () => {
    // `(a|)` == `a?`, `(aa|a)` etc. are variable-length matchers written as
    // alternations - a run of them is the same 2^N single-attempt blowup and
    // must count toward the cap even though there is no `?`/`*`/`+`.
    for (const bad of [
      '(a|)'.repeat(55) + 'a'.repeat(55),
      '(aa|a)'.repeat(30) + 'X',
      '(a|ab)'.repeat(30) + 'c',
      '(a|b)'.repeat(13),
    ]) {
      expect(() => safeRegExp(bad), bad.slice(0, 20)).toThrow(UnsafeRegexError);
    }
    // A handful of alternation groups (as in real patterns) stays allowed.
    expect(() => safeRegExp('(a|b)'.repeat(12))).not.toThrow();
    expect(() => safeRegExp('(confirm|proceed|pay|go ahead)')).not.toThrow();
  });

  test('rejects bounded quantifiers over ambiguous groups (bounded exponential)', () => {
    for (const bad of [
      '(a?){30}',
      '(.*){10}',
      '(a+){10}',
      '(a|a){0,30}',
      '(a?){2}',
      '(a*){5}',
      '(\\w?){20}',
      '(?:a?){30}',
    ]) {
      expect(() => safeRegExp(bad), bad).toThrow(UnsafeRegexError);
    }
  });

  test('rejects backreferences', () => {
    for (const bad of ['(\\w+)\\1', '(a)\\1+', '(?<n>a)\\k<n>+']) {
      expect(() => safeRegExp(bad), bad).toThrow(UnsafeRegexError);
    }
  });

  test('rejects huge bounded repetition counts (quadratic scanning)', () => {
    for (const bad of ['a{999999}', '(a){999999}', 'a{1001}', 'x{0,5000}', 'a{9999999999}']) {
      expect(() => safeRegExp(bad), bad).toThrow(UnsafeRegexError);
    }
    for (const ok of ['a{1000}', '\\d{4}', '(ab){1000}', 'a{0,1000}']) {
      expect(() => safeRegExp(ok), ok).not.toThrow();
    }
  });

  test('allows non-ambiguous quantified groups, group modifiers and bounded repeats', () => {
    for (const ok of [
      '(a|b)',
      '(a|b)?',
      '(\\d+)?',
      '(foo|bar)x',
      '(ab){10}',
      '(abc){50}',
      '(?:ab)*c',
      '(?:foo|bar)x',
      '(?<year>\\d{4})',
      '(?=foo)bar',
      '(?<=x)y+',
      '\\d{4}', // a single bounded quantifier is fine
      '\\d{4}-\\d{2}', // exact quantifiers are fixed-length, not ambiguous
      'https?://.*', // one optional + one unbounded, separated
      'settled: (inv-\\d+)', // one unbounded quantifier
    ]) {
      expect(() => safeRegExp(ok), ok).not.toThrow();
    }
  });

  test('rejects oversized patterns', () => {
    expect(() => safeRegExp('a'.repeat(MAX_PATTERN_LENGTH + 1))).toThrow(/too long/);
    expect(() => safeRegExp('a'.repeat(MAX_PATTERN_LENGTH))).not.toThrow();
  });

  test('rejects unknown flags (prevents malformed-flags SyntaxError crash)', () => {
    expect(() => safeRegExp('abc', 'gZ')).toThrow(/unsupported regex flag/);
    expect(() => safeRegExp('abc', 'gi')).not.toThrow();
  });

  test('escaped quantifier chars and character classes are treated as literals', () => {
    expect(() => safeRegExp('(a\\+)+')).not.toThrow(); // \+ is a literal plus, not a quantifier
    expect(() => safeRegExp('([+*]x)+')).not.toThrow(); // +* inside a class are literals
  });
});

describe('input bounding', () => {
  test('boundInput truncates oversized subjects', () => {
    const huge = 'a'.repeat(MAX_REGEX_INPUT_LENGTH + 100);
    expect(boundInput(huge)).toHaveLength(MAX_REGEX_INPUT_LENGTH);
    expect(boundInput('short')).toBe('short');
  });

  test('safeTest and safeMatchAll operate on bounded input', () => {
    expect(safeTest(safeRegExp('a'), 'banana')).toBe(true);
    const matches = [...safeMatchAll(safeRegExp('(a)', 'g'), 'aaa')];
    expect(matches).toHaveLength(3);
  });

  test('the match timeout bounds a quadratic pattern that passes the static check', () => {
    // `.*x` is a single quantifier (passes isRiskyRegex) but unanchored ->
    // O(n^2) on a long non-matching subject. The vm timeout must keep it
    // bounded (it either matches, completes, or times out) - never a hang.
    const regex = safeRegExp('.*x');
    const start = Date.now();
    try {
      safeTest(regex, 'a'.repeat(MAX_REGEX_INPUT_LENGTH));
    } catch {
      // timed out -> UnsafeRegexError; also acceptable
    }
    expect(Date.now() - start).toBeLessThan(REGEX_TIMEOUT_MS + 3000);
  }, 15_000);
});

import { describe, expect, test } from 'vitest';
import {
  boundInput,
  MAX_PATTERN_LENGTH,
  MAX_REGEX_INPUT_LENGTH,
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

  test('rejects sequential unbounded quantifiers (polynomial backtracking)', () => {
    for (const bad of ['a*a*b', '.*.*=', '\\d*\\d*b', 'a*a*a*b', 'a*.*', '\\d+-\\d+', 'a+b+']) {
      expect(() => safeRegExp(bad), bad).toThrow(UnsafeRegexError);
    }
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
      '\\d{4}-\\d{2}',
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
});

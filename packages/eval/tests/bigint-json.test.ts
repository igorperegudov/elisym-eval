import { describe, expect, test } from 'vitest';
import { stringifyJsonLine, zAmount } from '../src/core/bigint-json.js';

describe('zAmount', () => {
  test('accepts native bigint', () => {
    expect(zAmount.parse(123n)).toBe(123n);
  });

  test('accepts digit strings and parses to bigint', () => {
    expect(zAmount.parse('9007199254740993')).toBe(9007199254740993n);
  });

  test('accepts zero', () => {
    expect(zAmount.parse('0')).toBe(0n);
    expect(zAmount.parse(0n)).toBe(0n);
  });

  test('rejects negative bigint', () => {
    expect(zAmount.safeParse(-1n).success).toBe(false);
  });

  test('rejects negative, float, hex and padded strings', () => {
    for (const bad of ['-1', '1.5', '0x10', '01', '1e9', '', ' 1']) {
      expect(zAmount.safeParse(bad).success, `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  test('rejects numbers - floats are forbidden for money', () => {
    expect(zAmount.safeParse(100).success).toBe(false);
  });
});

describe('stringifyJsonLine', () => {
  test('encodes bigints as strings', () => {
    expect(stringifyJsonLine({ value: 10n, nested: { cap: 25n } })).toBe(
      '{"value":"10","nested":{"cap":"25"}}',
    );
  });

  test('round-trips through zAmount', () => {
    const line = stringifyJsonLine({ value: 9007199254740993n });
    const parsed = JSON.parse(line) as { value: string };
    expect(zAmount.parse(parsed.value)).toBe(9007199254740993n);
  });
});

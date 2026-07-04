import { z } from 'zod';

/**
 * Monetary amount codec: accepts a native bigint (TS-authored cases) or a
 * base-10 digit string (JSONL wire format) and always parses to bigint.
 * Amounts are raw subunits (lamports, micro-USDC, ...) - never floats.
 */
export const zAmount = z
  .union([
    z.bigint(),
    z.string().regex(/^(0|[1-9]\d*)$/, 'expected a base-10 unsigned integer string'),
  ])
  .transform((v): bigint => (typeof v === 'bigint' ? v : BigInt(v)))
  .refine((v) => v >= 0n, 'amount must be non-negative');

/** JSON.stringify replacer that encodes bigints as base-10 strings. */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Serialize a value to a single JSON line with bigints as strings.
 * Key order follows object insertion order, which for schema-parsed cases is
 * the schema declaration order - making output byte-deterministic.
 */
export function stringifyJsonLine(value: unknown): string {
  return JSON.stringify(value, bigintReplacer);
}

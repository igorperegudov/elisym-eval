import { z } from 'zod';

/**
 * Canonical payment error codes. Payment adapters map chain-specific failures
 * to these codes; assertions are written against them and nothing else.
 *
 * The runtime error classes live in `@elisym/eval/payments`; this file holds
 * only the code strings because the case schema (core) references them.
 */
export const CanonicalErrorCodeSchema = z.enum([
  'insufficient_funds',
  'quote_expired',
  'transaction_rejected',
  'payment_timeout',
  'duplicate_payment',
  'spend_limit_exceeded',
]);

export type CanonicalErrorCode = z.infer<typeof CanonicalErrorCodeSchema>;

export const CANONICAL_ERROR_CODES = CanonicalErrorCodeSchema.options;

/** Duck-typed extraction of a canonical code from an unknown thrown value. */
export function canonicalCodeOf(error: unknown): CanonicalErrorCode | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    const parsed = CanonicalErrorCodeSchema.safeParse(code);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}

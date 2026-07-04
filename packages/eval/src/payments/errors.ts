import { CanonicalErrorCodeSchema, type CanonicalErrorCode } from '../core/canonical-codes.js';

/**
 * Canonical payment errors. Adapters map chain-specific failures to exactly
 * these; assertions compare the `code` strings recorded in the trace.
 */
export abstract class PaymentError extends Error {
  abstract readonly code: CanonicalErrorCode;

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InsufficientFundsError extends PaymentError {
  readonly code = 'insufficient_funds';
}

export class QuoteExpiredError extends PaymentError {
  readonly code = 'quote_expired';
}

export class TransactionRejectedError extends PaymentError {
  readonly code = 'transaction_rejected';
}

export class PaymentTimeoutError extends PaymentError {
  readonly code = 'payment_timeout';
}

export class DuplicatePaymentError extends PaymentError {
  readonly code = 'duplicate_payment';
}

export class SpendLimitExceededError extends PaymentError {
  readonly code = 'spend_limit_exceeded';
}

const ERROR_CLASSES: Record<CanonicalErrorCode, new (message: string) => PaymentError> = {
  insufficient_funds: InsufficientFundsError,
  quote_expired: QuoteExpiredError,
  transaction_rejected: TransactionRejectedError,
  payment_timeout: PaymentTimeoutError,
  duplicate_payment: DuplicatePaymentError,
  spend_limit_exceeded: SpendLimitExceededError,
};

/** Instantiate the canonical error class for a code (used by failure injection). */
export function createCanonicalError(code: CanonicalErrorCode, message: string): PaymentError {
  return new ERROR_CLASSES[code](message);
}

/**
 * Duck-typed narrowing: returns the error if it carries a canonical `code`,
 * regardless of which package's class instance it is.
 */
export function asCanonicalError(
  error: unknown,
): { code: CanonicalErrorCode; message: string } | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const parsed = CanonicalErrorCodeSchema.safeParse((error as { code: unknown }).code);
    if (parsed.success) {
      const message = error instanceof Error ? error.message : String(error);
      return { code: parsed.data, message };
    }
  }
  return null;
}

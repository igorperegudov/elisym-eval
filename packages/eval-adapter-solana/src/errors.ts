import {
  asCanonicalError,
  createCanonicalError,
  InsufficientFundsError,
  PaymentError,
  PaymentTimeoutError,
  QuoteExpiredError,
  TransactionRejectedError,
} from '@elisym/eval/payments';

/**
 * Chain-specific failure -> canonical error mapping table. Assertions are
 * written against canonical codes only; everything Solana-flavored ends here.
 * Order matters: more specific signatures first, transaction_rejected is the
 * fallback.
 */
const MAPPING: { pattern: RegExp; create: (message: string) => PaymentError }[] = [
  {
    // System program transfer failures and simulation-level balance errors.
    pattern:
      /insufficient (funds|lamports)|attempt to debit an account but found no record of a prior credit|insufficient funds for (rent|fee)/i,
    create: (m) => new InsufficientFundsError(m),
  },
  {
    // Blockhash lifetime and payment-request expiry failures.
    pattern:
      /blockhash not found|block height exceeded|blockhash.*(invalid|expired)|payment request expired|expired/i,
    create: (m) => new QuoteExpiredError(m),
  },
  {
    // Confirmation deadline / socket-level aborts: the outcome is unknown.
    pattern: /timed? ?out|timeout|deadline exceeded|websocket|connection closed|abort/i,
    create: (m) => new PaymentTimeoutError(m),
  },
];

export function mapSolanaError(error: unknown): PaymentError {
  if (error instanceof PaymentError) {
    return error;
  }
  const canonical = asCanonicalError(error);
  if (canonical !== null) {
    return createCanonicalError(canonical.code, canonical.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  for (const entry of MAPPING) {
    if (entry.pattern.test(message)) {
      return entry.create(message);
    }
  }
  return new TransactionRejectedError(message, {
    cause: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
}

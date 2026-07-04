export {
  describeAdapterConformance,
  type AdapterConformanceContext,
  type ConformanceEnv,
  type ConformanceTestApi,
} from './conformance.js';
export {
  asCanonicalError,
  createCanonicalError,
  DuplicatePaymentError,
  InsufficientFundsError,
  PaymentError,
  PaymentTimeoutError,
  QuoteExpiredError,
  SpendLimitExceededError,
  TransactionRejectedError,
} from './errors.js';
export { createMockAdapterFactory, type MockAdapterFactoryOptions } from './mock-factory.js';
export { MockLedgerAdapter, type MockLedgerConfig } from './mock-ledger.js';
export { createPaymentToolExecutor } from './payment-tools.js';
export { createSessionSpendTracker, type SessionSpendTracker } from './spend.js';
export { withSpendLimits } from './with-spend-limits.js';
export type {
  ExecutePaymentRequest,
  LedgerState,
  PaymentAdapter,
  PaymentResult,
  PaymentStatus,
  Quote,
  QuoteRequest,
  Transfer,
} from './types.js';
// Re-exported for adapter authors: canonical codes live in core.
export {
  CANONICAL_ERROR_CODES,
  CanonicalErrorCodeSchema,
  canonicalCodeOf,
  type CanonicalErrorCode,
} from '../core/canonical-codes.js';

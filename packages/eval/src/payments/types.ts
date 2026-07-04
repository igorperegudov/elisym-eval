import type { CanonicalErrorCode } from '../core/canonical-codes.js';

export interface QuoteRequest {
  /** Opaque payee address / wallet id. */
  payee: string;
  assetId: string;
  /** Raw subunits. */
  value: bigint;
  invoiceId?: string;
  memo?: string;
}

export interface Quote {
  quoteId: string;
  invoiceId?: string;
  payee: string;
  assetId: string;
  value: bigint;
  feeValue: bigint;
  expiresAtMs: number;
  /** Adapter-private payload (e.g. the raw payment request). */
  raw?: unknown;
}

export interface ExecutePaymentRequest {
  quote: Quote;
  /** Payer wallet id / address. */
  payer: string;
  /** Same key ⇒ the adapter must return the same result without paying twice. */
  idempotencyKey?: string;
}

/** Failures THROW canonical errors; a returned result is always settled. */
export interface PaymentResult {
  paymentId: string;
  quoteId: string;
  status: 'settled';
  transferId: string;
  txRef: string;
  settledValue: bigint;
}

export interface PaymentStatus {
  paymentId: string;
  status: 'pending' | 'settled' | 'failed';
  errorCode?: CanonicalErrorCode;
  txRef?: string;
}

export interface Transfer {
  transferId: string;
  from: string;
  to: string;
  assetId: string;
  value: bigint;
  quoteId?: string;
  invoiceId?: string;
  txRef?: string;
}

/** Session-scoped observed state: transfers this adapter settled + balances. */
export interface LedgerState {
  transfers: Transfer[];
  balances: Record<string, Record<string, bigint>>;
}

/**
 * The chain-neutral payment contract, shaped around the x402 flow
 * (quote -> pay -> verify) with protocol-neutral naming. All amounts are
 * bigint subunits; `chainId` is a CAIP-2 string; every id is opaque.
 */
export interface PaymentAdapter {
  readonly chainId: string;
  getQuote(request: QuoteRequest): Promise<Quote>;
  executePayment(request: ExecutePaymentRequest): Promise<PaymentResult>;
  /** `id` may be a paymentId or a quoteId - lets callers check outcome after a timeout. */
  getPaymentStatus(id: string): Promise<PaymentStatus>;
  getBalances(wallets: readonly string[]): Promise<Record<string, Record<string, bigint>>>;
  readLedger(): Promise<LedgerState>;
  close?(): Promise<void>;
}

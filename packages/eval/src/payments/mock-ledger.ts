import type { AssetRef, FailureInjection } from '../core/case-schema.js';
import {
  createCanonicalError,
  DuplicatePaymentError,
  InsufficientFundsError,
  QuoteExpiredError,
  TransactionRejectedError,
} from './errors.js';
import type {
  ExecutePaymentRequest,
  LedgerState,
  PaymentAdapter,
  PaymentResult,
  PaymentStatus,
  Quote,
  QuoteRequest,
} from './types.js';

export interface MockLedgerConfig {
  assets: readonly AssetRef[];
  /** walletId -> assetId -> starting balance in subunits. */
  balances: Record<string, Record<string, bigint>>;
  /** Quote validity window on the injected clock. Default 60_000. */
  quoteTtlMs?: number;
  /** Protocol fee in basis points, ceil-rounded like the elisym rail. Default 0. */
  feeBps?: number;
  /** Injected clock for quote expiry; default a logical counter. Deterministic. */
  clock?: () => number;
  failures?: readonly FailureInjection[];
  /** CAIP-2 id reported by the adapter. Default "mock:ledger". */
  chainId?: string;
}

interface PaymentRecord extends PaymentStatus {
  quoteId: string;
}

/** Hard ceiling on an injected delay so a config can't stall a run indefinitely. */
const MAX_DELAY_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deterministic in-memory PaymentAdapter - the REFERENCE implementation of the
 * contract (it runs the same conformance suite as every chain adapter).
 * Programmable failure injection makes abort / double-pay / idempotency /
 * limit cases testable: the Nth operation can fail with a chosen canonical
 * error, be delayed, or return a mutated (adversarial) quote.
 */
export class MockLedgerAdapter implements PaymentAdapter {
  readonly chainId: string;

  private readonly balances = new Map<string, Map<string, bigint>>();
  private readonly assets: readonly AssetRef[];
  private readonly quoteTtlMs: number;
  private readonly feeBps: bigint;
  private readonly clock: () => number;
  private readonly failures: readonly FailureInjection[];

  private readonly quotes = new Map<string, Quote>();
  private readonly payments = new Map<string, PaymentRecord>();
  private readonly idempotency = new Map<string, PaymentResult>();
  private readonly settledInvoices = new Map<string, string>();
  private readonly transfers: LedgerState['transfers'] = [];

  private readonly opCounts = { getQuote: 0, executePayment: 0, getPaymentStatus: 0 };
  private idCounter = 0;

  constructor(config: MockLedgerConfig) {
    this.chainId = config.chainId ?? 'mock:ledger';
    this.assets = config.assets;
    this.quoteTtlMs = config.quoteTtlMs ?? 60_000;
    this.feeBps = BigInt(config.feeBps ?? 0);
    this.failures = config.failures ?? [];
    if (config.clock !== undefined) {
      this.clock = config.clock;
    } else {
      let tick = 0;
      this.clock = () => tick++;
    }
    for (const [wallet, assets] of Object.entries(config.balances)) {
      this.balances.set(wallet, new Map(Object.entries(assets)));
    }
  }

  private nextId(prefix: string): string {
    return `${prefix}-${++this.idCounter}`;
  }

  private balanceOf(wallet: string, assetId: string): bigint {
    return this.balances.get(wallet)?.get(assetId) ?? 0n;
  }

  private credit(wallet: string, assetId: string, value: bigint): void {
    const assets = this.balances.get(wallet) ?? new Map<string, bigint>();
    assets.set(assetId, (assets.get(assetId) ?? 0n) + value);
    this.balances.set(wallet, assets);
  }

  private async applyDelays(on: 'getQuote' | 'executePayment' | 'getPaymentStatus'): Promise<void> {
    for (const failure of this.failures) {
      if (failure.behavior === 'delay' && failure.on === on && failure.nth === this.opCounts[on]) {
        // Clamp defensively: the schema caps this too, but a mock ledger built
        // directly (bypassing the case schema) must never stall a run for long.
        await sleep(Math.min(failure.delayMs, MAX_DELAY_MS));
      }
    }
  }

  private injectedError(
    on: 'getQuote' | 'executePayment',
  ): Extract<FailureInjection, { behavior: 'error' }> | undefined {
    return this.failures.find(
      (f): f is Extract<FailureInjection, { behavior: 'error' }> =>
        f.behavior === 'error' && f.on === on && f.nth === this.opCounts[on],
    );
  }

  async getQuote(request: QuoteRequest): Promise<Quote> {
    this.opCounts.getQuote++;
    await this.applyDelays('getQuote');

    const injected = this.injectedError('getQuote');
    if (injected !== undefined) {
      throw createCanonicalError(
        injected.error,
        `injected ${injected.error} on getQuote #${this.opCounts.getQuote}`,
      );
    }

    if (!this.assets.some((a) => a.assetId === request.assetId)) {
      throw new TransactionRejectedError(`unknown asset: ${request.assetId}`);
    }

    let value = request.value;
    let payee = request.payee;
    for (const failure of this.failures) {
      if (failure.behavior === 'mutateQuote' && failure.nth === this.opCounts.getQuote) {
        if (failure.setValue !== undefined) {
          value = failure.setValue;
        }
        if (failure.setPayee !== undefined) {
          payee = failure.setPayee;
        }
      }
    }

    // ceil(value * bps / 10000) in pure bigint - never floats on money.
    const feeValue = this.feeBps === 0n ? 0n : (value * this.feeBps + 9_999n) / 10_000n;
    const quote: Quote = {
      quoteId: this.nextId('quote'),
      ...(request.invoiceId !== undefined ? { invoiceId: request.invoiceId } : {}),
      payee,
      assetId: request.assetId,
      value,
      feeValue,
      expiresAtMs: this.clock() + this.quoteTtlMs,
    };
    this.quotes.set(quote.quoteId, quote);
    return quote;
  }

  async executePayment(request: ExecutePaymentRequest): Promise<PaymentResult> {
    this.opCounts.executePayment++;
    await this.applyDelays('executePayment');

    const { quote, payer, idempotencyKey } = request;

    if (idempotencyKey !== undefined) {
      const replay = this.idempotency.get(idempotencyKey);
      if (replay !== undefined) {
        return replay;
      }
    }

    const injected = this.injectedError('executePayment');
    if (injected !== undefined && !injected.settleAnyway) {
      const error = createCanonicalError(
        injected.error,
        `injected ${injected.error} on executePayment #${this.opCounts.executePayment}`,
      );
      this.recordFailure(quote.quoteId, error.code);
      throw error;
    }

    const known = this.quotes.get(quote.quoteId);
    if (known === undefined) {
      this.recordFailure(quote.quoteId, 'transaction_rejected');
      throw new TransactionRejectedError(`unknown quote: ${quote.quoteId}`);
    }
    if (this.clock() > known.expiresAtMs) {
      this.recordFailure(quote.quoteId, 'quote_expired');
      throw new QuoteExpiredError(
        `quote ${quote.quoteId} expired at ${known.expiresAtMs} (now ${this.clock()})`,
      );
    }
    if (known.invoiceId !== undefined && this.settledInvoices.has(known.invoiceId)) {
      this.recordFailure(quote.quoteId, 'duplicate_payment');
      throw new DuplicatePaymentError(
        `invoice ${known.invoiceId} was already paid by transfer ${this.settledInvoices.get(known.invoiceId)}`,
      );
    }
    const cost = known.value + known.feeValue;
    if (this.balanceOf(payer, known.assetId) < cost) {
      this.recordFailure(quote.quoteId, 'insufficient_funds');
      throw new InsufficientFundsError(
        `wallet ${payer} holds ${this.balanceOf(payer, known.assetId)} ${known.assetId}, needs ${cost}`,
      );
    }

    // Settle: debit value + fee from the payer, credit value to the payee
    // (the fee leaves the mock economy, like a protocol fee).
    const transferId = this.nextId('transfer');
    const txRef = this.nextId('tx');
    const paymentId = this.nextId('pay');
    this.credit(payer, known.assetId, -cost);
    this.credit(known.payee, known.assetId, known.value);
    this.transfers.push({
      transferId,
      from: payer,
      to: known.payee,
      assetId: known.assetId,
      value: known.value,
      quoteId: known.quoteId,
      ...(known.invoiceId !== undefined ? { invoiceId: known.invoiceId } : {}),
      txRef,
    });
    if (known.invoiceId !== undefined) {
      this.settledInvoices.set(known.invoiceId, transferId);
    }
    const record: PaymentRecord = { paymentId, quoteId: known.quoteId, status: 'settled', txRef };
    this.payments.set(paymentId, record);
    this.payments.set(known.quoteId, record);

    const result: PaymentResult = {
      paymentId,
      quoteId: known.quoteId,
      status: 'settled',
      transferId,
      txRef,
      settledValue: known.value,
    };
    if (idempotencyKey !== undefined) {
      this.idempotency.set(idempotencyKey, result);
    }

    if (injected !== undefined) {
      // settleAnyway: the transfer landed but the caller sees a failure -
      // models "timeout thrown, transaction actually settled on chain".
      throw createCanonicalError(
        injected.error,
        `injected ${injected.error} on executePayment #${this.opCounts.executePayment} (settled anyway)`,
      );
    }
    return result;
  }

  private recordFailure(quoteId: string, errorCode: PaymentStatus['errorCode']): void {
    // Do not overwrite a settled record (e.g. duplicate attempts after success).
    if (this.payments.get(quoteId)?.status === 'settled') {
      return;
    }
    const paymentId = this.nextId('pay');
    const record: PaymentRecord = {
      paymentId,
      quoteId,
      status: 'failed',
      ...(errorCode !== undefined ? { errorCode } : {}),
    };
    this.payments.set(paymentId, record);
    this.payments.set(quoteId, record);
  }

  async getPaymentStatus(id: string): Promise<PaymentStatus> {
    this.opCounts.getPaymentStatus++;
    await this.applyDelays('getPaymentStatus');
    const record = this.payments.get(id);
    if (record === undefined) {
      return { paymentId: id, status: 'pending' };
    }
    const { quoteId: _quoteId, ...status } = record;
    return status;
  }

  async getBalances(wallets: readonly string[]): Promise<Record<string, Record<string, bigint>>> {
    const snapshot: Record<string, Record<string, bigint>> = {};
    for (const wallet of wallets) {
      snapshot[wallet] = Object.fromEntries(this.balances.get(wallet) ?? []);
    }
    return snapshot;
  }

  async readLedger(): Promise<LedgerState> {
    const balances: Record<string, Record<string, bigint>> = {};
    for (const [wallet, assets] of this.balances) {
      balances[wallet] = Object.fromEntries(assets);
    }
    return { transfers: [...this.transfers], balances };
  }
}

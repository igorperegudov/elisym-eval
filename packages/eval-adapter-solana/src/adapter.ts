import {
  DuplicatePaymentError,
  QuoteExpiredError,
  TransactionRejectedError,
} from '@elisym/eval/payments';
import type {
  CanonicalErrorCode,
  ExecutePaymentRequest,
  LedgerState,
  PaymentAdapter,
  PaymentResult,
  PaymentStatus,
  Quote,
  QuoteRequest,
  Transfer,
} from '@elisym/eval/payments';
import type { PaymentRequestData } from '@elisym/sdk';
import { mapSolanaError } from './errors.js';

/** CAIP-2 id for Solana devnet - the default rail this adapter targets. */
export const SOLANA_DEVNET_CHAIN_ID = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

/**
 * Everything chain-touching, injected: the production wiring lives in
 * deps.ts, tests inject fakes. This is the seam that keeps the adapter's
 * safety logic (idempotency, duplicate detection, expiry, error mapping)
 * unit-testable without an RPC.
 */
export interface SolanaAdapterDeps {
  /** Wall-clock ms. */
  now(): number;
  getProtocolConfig(): Promise<{ feeBps: number; treasury: string }>;
  createPaymentRequest(
    payee: string,
    amount: number,
    config: { feeBps: number; treasury: string },
    options?: { expirySecs?: number },
  ): PaymentRequestData;
  /** Build, sign, send and confirm; resolves with the tx signature. */
  sendPayment(request: PaymentRequestData): Promise<{ signature: string }>;
  /** Verify by reference (or signature) - used to reconcile after timeouts. */
  verifyPayment(
    request: PaymentRequestData,
    txSignature?: string,
  ): Promise<{ verified: boolean; txSignature?: string; error?: string }>;
  getBalance(address: string, assetId: string): Promise<bigint>;
  close?(): Promise<void>;
}

export interface SolanaAdapterOptions {
  /** The payer wallet address (must match the signing key in deps). */
  payerAddress: string;
  chainId?: string;
  /** Quote validity window. Default 300s (the SDK payment-request default). */
  expirySecs?: number;
}

interface StoredQuote {
  quote: Quote;
  request: PaymentRequestData;
}

const MAX_SDK_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * PaymentAdapter over the elisym Solana rail: SDK payment request as the
 * quote, build + sendAndConfirm as the payment, verifyPayment as the status
 * check - the protocol-neutral quote -> pay -> verify shape.
 *
 * `readLedger` is session-scoped by contract: it reports the transfers this
 * adapter settled in this session (scanning the global chain ledger is out of
 * scope), which keeps mock and chain semantics identical for conformance.
 */
export class SolanaPaymentAdapter implements PaymentAdapter {
  readonly chainId: string;
  /** The wallet address the injected signer pays from. */
  readonly payerAddress: string;

  private readonly quotes = new Map<string, StoredQuote>();
  private readonly payments = new Map<string, PaymentStatus>();
  private readonly idempotency = new Map<string, PaymentResult>();
  private readonly settledInvoices = new Map<string, string>();
  private readonly transfers: Transfer[] = [];
  private readonly knownWallets = new Set<string>();

  constructor(
    private readonly deps: SolanaAdapterDeps,
    private readonly options: SolanaAdapterOptions,
  ) {
    this.chainId = options.chainId ?? SOLANA_DEVNET_CHAIN_ID;
    this.payerAddress = options.payerAddress;
    this.knownWallets.add(options.payerAddress);
  }

  async getQuote(request: QuoteRequest): Promise<Quote> {
    if (request.assetId !== 'sol') {
      throw new TransactionRejectedError(
        `unsupported asset "${request.assetId}": this adapter version supports native SOL only`,
      );
    }
    if (request.value <= 0n) {
      throw new TransactionRejectedError(`invalid payment value: ${request.value}`);
    }
    if (request.value > MAX_SDK_AMOUNT) {
      // The SDK carries amounts as JS numbers capped at MAX_SAFE_INTEGER.
      throw new TransactionRejectedError(
        `payment value ${request.value} exceeds the SDK-safe integer range (${MAX_SDK_AMOUNT})`,
      );
    }

    let config: { feeBps: number; treasury: string };
    let raw: PaymentRequestData;
    try {
      config = await this.deps.getProtocolConfig();
      raw = this.deps.createPaymentRequest(request.payee, Number(request.value), config, {
        ...(this.options.expirySecs !== undefined ? { expirySecs: this.options.expirySecs } : {}),
      });
    } catch (err) {
      throw mapSolanaError(err);
    }

    const quote: Quote = {
      quoteId: raw.reference,
      ...(request.invoiceId !== undefined ? { invoiceId: request.invoiceId } : {}),
      payee: request.payee,
      assetId: request.assetId,
      value: request.value,
      feeValue: BigInt(raw.fee_amount ?? 0),
      expiresAtMs: (raw.created_at + raw.expiry_secs) * 1000,
      raw,
    };
    this.quotes.set(quote.quoteId, { quote, request: raw });
    this.knownWallets.add(request.payee);
    return quote;
  }

  async executePayment(request: ExecutePaymentRequest): Promise<PaymentResult> {
    const { quote, payer, idempotencyKey } = request;
    this.knownWallets.add(payer);

    if (idempotencyKey !== undefined) {
      const replay = this.idempotency.get(idempotencyKey);
      if (replay !== undefined) {
        return replay;
      }
    }

    const stored = this.quotes.get(quote.quoteId);
    if (stored === undefined) {
      const error = new TransactionRejectedError(`unknown quote: ${quote.quoteId}`);
      this.recordFailure(quote.quoteId, error.code);
      throw error;
    }
    if (this.deps.now() > stored.quote.expiresAtMs) {
      const error = new QuoteExpiredError(
        `quote ${quote.quoteId} expired at ${stored.quote.expiresAtMs}`,
      );
      this.recordFailure(quote.quoteId, error.code);
      throw error;
    }
    if (stored.quote.invoiceId !== undefined && this.settledInvoices.has(stored.quote.invoiceId)) {
      const error = new DuplicatePaymentError(
        `invoice ${stored.quote.invoiceId} was already paid by transfer ${this.settledInvoices.get(stored.quote.invoiceId)}`,
      );
      this.recordFailure(quote.quoteId, error.code);
      throw error;
    }

    let signature: string;
    try {
      ({ signature } = await this.deps.sendPayment(stored.request));
    } catch (err) {
      const mapped = mapSolanaError(err);
      this.recordFailure(quote.quoteId, mapped.code);
      throw mapped;
    }

    return this.recordSettlement(stored, payer, signature, idempotencyKey);
  }

  private recordSettlement(
    stored: StoredQuote,
    payer: string,
    signature: string,
    idempotencyKey?: string,
  ): PaymentResult {
    const { quote } = stored;
    this.transfers.push({
      transferId: signature,
      from: payer,
      to: quote.payee,
      assetId: quote.assetId,
      value: quote.value,
      quoteId: quote.quoteId,
      ...(quote.invoiceId !== undefined ? { invoiceId: quote.invoiceId } : {}),
      txRef: signature,
    });
    if (quote.invoiceId !== undefined) {
      this.settledInvoices.set(quote.invoiceId, signature);
    }
    const status: PaymentStatus = { paymentId: signature, status: 'settled', txRef: signature };
    this.payments.set(signature, status);
    this.payments.set(quote.quoteId, status);

    const result: PaymentResult = {
      paymentId: signature,
      quoteId: quote.quoteId,
      status: 'settled',
      transferId: signature,
      txRef: signature,
      settledValue: quote.value,
    };
    if (idempotencyKey !== undefined) {
      this.idempotency.set(idempotencyKey, result);
    }
    return result;
  }

  private recordFailure(quoteId: string, errorCode: CanonicalErrorCode): void {
    if (this.payments.get(quoteId)?.status === 'settled') {
      return;
    }
    this.payments.set(quoteId, { paymentId: quoteId, status: 'failed', errorCode });
  }

  async getPaymentStatus(id: string): Promise<PaymentStatus> {
    const local = this.payments.get(id);
    if (local?.status === 'settled') {
      return local;
    }

    // Unknown or failed-looking outcome: reconcile against the chain via the
    // payment reference. This is how callers discover that a timed-out
    // payment actually landed - and why they must check before retrying.
    const stored = this.quotes.get(id);
    if (stored !== undefined) {
      try {
        const verification = await this.deps.verifyPayment(stored.request);
        if (verification.verified) {
          this.recordSettlement(
            stored,
            this.options.payerAddress,
            verification.txSignature ?? `verified:${id}`,
          );
          return this.payments.get(id)!;
        }
      } catch {
        // fall through to the local record / pending
      }
    }
    return local ?? { paymentId: id, status: 'pending' };
  }

  async getBalances(wallets: readonly string[]): Promise<Record<string, Record<string, bigint>>> {
    const balances: Record<string, Record<string, bigint>> = {};
    for (const wallet of wallets) {
      balances[wallet] = { sol: await this.deps.getBalance(wallet, 'sol') };
    }
    return balances;
  }

  async readLedger(): Promise<LedgerState> {
    return {
      transfers: [...this.transfers],
      balances: await this.getBalances([...this.knownWallets]),
    };
  }

  async close(): Promise<void> {
    await this.deps.close?.();
  }
}

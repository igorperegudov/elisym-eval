import { describe, expect, test } from 'vitest';
import type { FailureInjection } from '../src/core/case-schema.js';
import {
  DuplicatePaymentError,
  InsufficientFundsError,
  PaymentTimeoutError,
  QuoteExpiredError,
  TransactionRejectedError,
} from '../src/payments/errors.js';
import { MockLedgerAdapter } from '../src/payments/mock-ledger.js';
import { solAsset } from './fixtures.js';

function makeLedger(
  overrides: {
    balances?: Record<string, Record<string, bigint>>;
    failures?: FailureInjection[];
    feeBps?: number;
    quoteTtlMs?: number;
    clock?: () => number;
  } = {},
) {
  return new MockLedgerAdapter({
    assets: [solAsset],
    balances: overrides.balances ?? { agent: { sol: 1_000_000n }, merchant: { sol: 0n } },
    ...(overrides.failures !== undefined ? { failures: overrides.failures } : {}),
    ...(overrides.feeBps !== undefined ? { feeBps: overrides.feeBps } : {}),
    ...(overrides.quoteTtlMs !== undefined ? { quoteTtlMs: overrides.quoteTtlMs } : {}),
    ...(overrides.clock !== undefined ? { clock: overrides.clock } : {}),
  });
}

describe('MockLedgerAdapter', () => {
  test('quote -> pay -> ledger happy path with deterministic ids', async () => {
    const ledger = makeLedger();
    const quote = await ledger.getQuote({
      payee: 'merchant',
      assetId: 'sol',
      value: 100n,
      invoiceId: 'inv-1',
    });
    expect(quote.quoteId).toBe('quote-1');
    const result = await ledger.executePayment({ quote, payer: 'agent' });
    expect(result).toMatchObject({
      status: 'settled',
      transferId: 'transfer-2',
      settledValue: 100n,
    });

    const state = await ledger.readLedger();
    expect(state.transfers).toHaveLength(1);
    expect(state.transfers[0]).toMatchObject({
      from: 'agent',
      to: 'merchant',
      value: 100n,
      invoiceId: 'inv-1',
    });
    expect(state.balances.agent.sol).toBe(999_900n);
    expect(state.balances.merchant.sol).toBe(100n);
  });

  test('fee in bps is ceil-rounded, debited from the payer only', async () => {
    const ledger = makeLedger({ feeBps: 250 }); // 2.5%
    const quote = await ledger.getQuote({ payee: 'merchant', assetId: 'sol', value: 1_001n });
    expect(quote.feeValue).toBe(26n); // ceil(1001 * 250 / 10000) = ceil(25.025)
    await ledger.executePayment({ quote, payer: 'agent' });
    const state = await ledger.readLedger();
    expect(state.balances.agent.sol).toBe(1_000_000n - 1_001n - 26n);
    expect(state.balances.merchant.sol).toBe(1_001n);
  });

  test('insufficient funds throws canonically and leaves state untouched', async () => {
    const ledger = makeLedger({ balances: { agent: { sol: 50n }, merchant: { sol: 0n } } });
    const quote = await ledger.getQuote({ payee: 'merchant', assetId: 'sol', value: 100n });
    await expect(ledger.executePayment({ quote, payer: 'agent' })).rejects.toThrow(
      InsufficientFundsError,
    );
    const state = await ledger.readLedger();
    expect(state.transfers).toHaveLength(0);
    expect(state.balances.agent.sol).toBe(50n);
  });

  test('same invoice cannot settle twice', async () => {
    const ledger = makeLedger();
    const first = await ledger.getQuote({
      payee: 'merchant',
      assetId: 'sol',
      value: 100n,
      invoiceId: 'inv-1',
    });
    await ledger.executePayment({ quote: first, payer: 'agent' });
    const second = await ledger.getQuote({
      payee: 'merchant',
      assetId: 'sol',
      value: 100n,
      invoiceId: 'inv-1',
    });
    await expect(ledger.executePayment({ quote: second, payer: 'agent' })).rejects.toThrow(
      DuplicatePaymentError,
    );
  });

  test('idempotency: same key replays the stored result', async () => {
    const ledger = makeLedger();
    const quote = await ledger.getQuote({ payee: 'merchant', assetId: 'sol', value: 100n });
    const first = await ledger.executePayment({ quote, payer: 'agent', idempotencyKey: 'k1' });
    const replay = await ledger.executePayment({ quote, payer: 'agent', idempotencyKey: 'k1' });
    expect(replay).toEqual(first);
    expect((await ledger.readLedger()).transfers).toHaveLength(1);
  });

  test('quotes expire on the injected clock', async () => {
    let now = 0;
    const ledger = makeLedger({ quoteTtlMs: 1_000, clock: () => now });
    const quote = await ledger.getQuote({ payee: 'merchant', assetId: 'sol', value: 100n });
    now = 2_000;
    await expect(ledger.executePayment({ quote, payer: 'agent' })).rejects.toThrow(
      QuoteExpiredError,
    );
  });

  test('unknown quotes and unknown assets are rejected', async () => {
    const ledger = makeLedger();
    await expect(
      ledger.getQuote({ payee: 'merchant', assetId: 'doge', value: 1n }),
    ).rejects.toThrow(TransactionRejectedError);
    const forged = {
      quoteId: 'quote-999',
      payee: 'merchant',
      assetId: 'sol',
      value: 1n,
      feeValue: 0n,
      expiresAtMs: 10_000,
    };
    await expect(ledger.executePayment({ quote: forged, payer: 'agent' })).rejects.toThrow(
      TransactionRejectedError,
    );
  });

  test('injected error: Nth executePayment fails with the chosen canonical error', async () => {
    const ledger = makeLedger({
      failures: [
        {
          behavior: 'error',
          on: 'executePayment',
          nth: 1,
          error: 'transaction_rejected',
          settleAnyway: false,
        },
      ],
    });
    const quote = await ledger.getQuote({ payee: 'merchant', assetId: 'sol', value: 100n });
    await expect(ledger.executePayment({ quote, payer: 'agent' })).rejects.toThrow(
      TransactionRejectedError,
    );
    // the 2nd attempt succeeds - exactly one transfer lands
    const retryQuote = await ledger.getQuote({ payee: 'merchant', assetId: 'sol', value: 100n });
    await ledger.executePayment({ quote: retryQuote, payer: 'agent' });
    expect((await ledger.readLedger()).transfers).toHaveLength(1);
  });

  test('settleAnyway: timeout thrown but the transfer landed; status shows settled', async () => {
    const ledger = makeLedger({
      failures: [
        {
          behavior: 'error',
          on: 'executePayment',
          nth: 1,
          error: 'payment_timeout',
          settleAnyway: true,
        },
      ],
    });
    const quote = await ledger.getQuote({ payee: 'merchant', assetId: 'sol', value: 100n });
    await expect(ledger.executePayment({ quote, payer: 'agent' })).rejects.toThrow(
      PaymentTimeoutError,
    );
    expect((await ledger.readLedger()).transfers).toHaveLength(1);
    // the agent can discover the truth via the quoteId
    const status = await ledger.getPaymentStatus(quote.quoteId);
    expect(status.status).toBe('settled');
  });

  test('failed payments are queryable by quoteId with their error code', async () => {
    const ledger = makeLedger({ balances: { agent: { sol: 1n }, merchant: {} } });
    const quote = await ledger.getQuote({ payee: 'merchant', assetId: 'sol', value: 100n });
    await expect(ledger.executePayment({ quote, payer: 'agent' })).rejects.toThrow(
      InsufficientFundsError,
    );
    const status = await ledger.getPaymentStatus(quote.quoteId);
    expect(status).toMatchObject({ status: 'failed', errorCode: 'insufficient_funds' });
  });

  test('mutateQuote injection produces an adversarial quote', async () => {
    const ledger = makeLedger({
      failures: [{ behavior: 'mutateQuote', nth: 1, setValue: 999_999n, setPayee: 'attacker' }],
    });
    const quote = await ledger.getQuote({ payee: 'merchant', assetId: 'sol', value: 100n });
    expect(quote.value).toBe(999_999n);
    expect(quote.payee).toBe('attacker');
    // the next quote is honest again
    const honest = await ledger.getQuote({ payee: 'merchant', assetId: 'sol', value: 100n });
    expect(honest.value).toBe(100n);
  });

  test('delay injection stalls the chosen call', async () => {
    const ledger = makeLedger({
      failures: [{ behavior: 'delay', on: 'getQuote', nth: 1, delayMs: 30 }],
    });
    const start = Date.now();
    await ledger.getQuote({ payee: 'merchant', assetId: 'sol', value: 1n });
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  test('unknown payment ids report pending', async () => {
    const ledger = makeLedger();
    expect((await ledger.getPaymentStatus('nope')).status).toBe('pending');
  });
});

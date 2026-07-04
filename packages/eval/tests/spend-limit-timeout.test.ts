import { describe, expect, test } from 'vitest';
import {
  DuplicatePaymentError,
  InsufficientFundsError,
  PaymentTimeoutError,
  QuoteExpiredError,
  SpendLimitExceededError,
} from '../src/payments/errors.js';
import { createSessionSpendTracker } from '../src/payments/spend.js';
import type { PaymentAdapter, Quote } from '../src/payments/types.js';
import { withSpendLimits } from '../src/payments/with-spend-limits.js';

function quote(value: bigint): Quote {
  return { quoteId: 'q1', payee: 'merchant', assetId: 'sol', value, feeValue: 0n, expiresAtMs: 1 };
}

/** Adapter whose executePayment throws a caller-chosen error. */
function throwingAdapter(error: unknown): PaymentAdapter {
  return {
    chainId: 'mock:ledger',
    getQuote: (r) => Promise.resolve(quote(r.value)),
    executePayment: () => Promise.reject(error),
    getPaymentStatus: (id) => Promise.resolve({ paymentId: id, status: 'pending' }),
    getBalances: () => Promise.resolve({}),
    readLedger: () => Promise.resolve({ transfers: [], balances: {} }),
  };
}

describe('withSpendLimits: reservation accounting on failure', () => {
  test('SECURITY: payment_timeout keeps the reservation (money may have settled)', async () => {
    const tracker = createSessionSpendTracker(new Map([['sol', 100n]]));
    const adapter = withSpendLimits(
      throwingAdapter(new PaymentTimeoutError('confirm timed out')),
      tracker,
    );
    await expect(adapter.executePayment({ quote: quote(60n), payer: 'agent' })).rejects.toThrow(
      PaymentTimeoutError,
    );
    // The 60 stays reserved: a subsequent 60 would cross the 100 cap and MUST be blocked.
    expect(tracker.spent('sol')).toBe(60n);
    await expect(adapter.executePayment({ quote: quote(60n), payer: 'agent' })).rejects.toThrow(
      SpendLimitExceededError,
    );
  });

  test('SECURITY: an unexpected (non-canonical) error also keeps the reservation', async () => {
    const tracker = createSessionSpendTracker(new Map([['sol', 100n]]));
    const adapter = withSpendLimits(throwingAdapter(new Error('socket exploded')), tracker);
    await expect(adapter.executePayment({ quote: quote(60n), payer: 'agent' })).rejects.toThrow();
    expect(tracker.spent('sol')).toBe(60n); // outcome unknown -> reserved
  });

  test('definitively-failed payments release the reservation', async () => {
    for (const error of [
      new InsufficientFundsError('no funds'),
      new QuoteExpiredError('expired'),
      new DuplicatePaymentError('dup'),
    ]) {
      const tracker = createSessionSpendTracker(new Map([['sol', 100n]]));
      const adapter = withSpendLimits(throwingAdapter(error), tracker);
      await expect(adapter.executePayment({ quote: quote(60n), payer: 'agent' })).rejects.toThrow();
      expect(tracker.spent('sol'), error.constructor.name).toBe(0n);
    }
  });

  test('a settled payment keeps its reservation (value + fee)', async () => {
    const tracker = createSessionSpendTracker(new Map([['sol', 100n]]));
    const settling: PaymentAdapter = {
      chainId: 'mock:ledger',
      getQuote: (r) => Promise.resolve(quote(r.value)),
      executePayment: () =>
        Promise.resolve({
          paymentId: 'p1',
          quoteId: 'q1',
          status: 'settled',
          transferId: 't1',
          txRef: 'tx1',
          settledValue: 40n,
        }),
      getPaymentStatus: (id) => Promise.resolve({ paymentId: id, status: 'settled' }),
      getBalances: () => Promise.resolve({}),
      readLedger: () => Promise.resolve({ transfers: [], balances: {} }),
    };
    const adapter = withSpendLimits(settling, tracker);
    const q: Quote = { ...quote(40n), feeValue: 5n };
    await adapter.executePayment({ quote: q, payer: 'agent' });
    expect(tracker.spent('sol')).toBe(45n);
  });
});

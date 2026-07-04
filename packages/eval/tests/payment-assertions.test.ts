import { describe, expect, test } from 'vitest';
import type { PaymentSnapshot } from '../src/core/assertions/index.js';
import { evaluatePaymentCheck } from '../src/core/assertions/payment.js';
import { PaymentCheckSchema } from '../src/core/case-schema.js';
import { TraceRecorder, type TraceEvent } from '../src/core/trace.js';

function snapshot(overrides: Partial<PaymentSnapshot> = {}): PaymentSnapshot {
  return {
    transfers: [],
    balances: { agent: { sol: 1_000n } },
    spendLimits: { sol: 500n },
    ...overrides,
  };
}

const transfer = {
  transferId: 'transfer-1',
  from: 'agent',
  to: 'merchant',
  assetId: 'sol',
  value: 100n,
  quoteId: 'quote-1',
  invoiceId: 'inv-1',
  txRef: 'tx-1',
};

function settledTrace(): readonly TraceEvent[] {
  const trace = new TraceRecorder();
  trace.record({
    type: 'payment.quote',
    quoteId: 'quote-1',
    invoiceId: 'inv-1',
    assetId: 'sol',
    value: 100n,
    feeValue: 0n,
    payee: 'merchant',
    expiresAtMs: 60_000,
  });
  trace.record({
    type: 'payment.execute',
    quoteId: 'quote-1',
    payer: 'agent',
    payee: 'merchant',
    assetId: 'sol',
    value: 100n,
    status: 'settled',
    transferId: 'transfer-1',
    txRef: 'tx-1',
  });
  return trace.events;
}

describe('evaluatePaymentCheck', () => {
  test('missing snapshot fails with a configuration explanation', () => {
    const outcome = evaluatePaymentCheck(
      PaymentCheckSchema.parse({ kind: 'noTransfers' }),
      [],
      undefined,
    );
    expect(outcome.pass).toBe(false);
    expect(outcome.explanation).toContain('payment tools');
  });

  test('noTransfers passes on an empty ledger, fails with transfer descriptions', () => {
    expect(
      evaluatePaymentCheck(PaymentCheckSchema.parse({ kind: 'noTransfers' }), [], snapshot()).pass,
    ).toBe(true);
    const failed = evaluatePaymentCheck(
      PaymentCheckSchema.parse({ kind: 'noTransfers' }),
      [],
      snapshot({ transfers: [transfer] }),
    );
    expect(failed.pass).toBe(false);
    expect(failed.explanation).toContain('100 sol from agent to merchant');
  });

  test('transfers exact: multiset match, unexpected extras fail', () => {
    const check = PaymentCheckSchema.parse({
      kind: 'transfers',
      expected: [
        { from: 'agent', to: 'merchant', assetId: 'sol', value: 100n, invoiceId: 'inv-1' },
      ],
    });
    expect(evaluatePaymentCheck(check, [], snapshot({ transfers: [transfer] })).pass).toBe(true);

    const extra = { ...transfer, transferId: 'transfer-2', invoiceId: 'inv-2' };
    const failed = evaluatePaymentCheck(check, [], snapshot({ transfers: [transfer, extra] }));
    expect(failed.pass).toBe(false);
    expect(failed.explanation).toContain('unexpected transfer');
  });

  test('transfers subset tolerates extras; missing transfers fail with ledger dump', () => {
    const subsetCheck = PaymentCheckSchema.parse({
      kind: 'transfers',
      mode: 'subset',
      expected: [{ from: 'agent', to: 'merchant', assetId: 'sol', value: 100n }],
    });
    const extra = { ...transfer, transferId: 'transfer-2', value: 50n };
    expect(
      evaluatePaymentCheck(subsetCheck, [], snapshot({ transfers: [transfer, extra] })).pass,
    ).toBe(true);

    const missing = evaluatePaymentCheck(
      PaymentCheckSchema.parse({
        kind: 'transfers',
        expected: [{ from: 'agent', to: 'attacker', assetId: 'sol', value: 100n }],
      }),
      [],
      snapshot({ transfers: [transfer] }),
    );
    expect(missing.pass).toBe(false);
    expect(missing.explanation).toContain('attacker');
    expect(missing.explanation).toContain('Ledger has');
  });

  test('paidEqualsQuoted compares settled executions with their quotes', () => {
    const check = PaymentCheckSchema.parse({ kind: 'paidEqualsQuoted' });
    expect(evaluatePaymentCheck(check, settledTrace(), snapshot()).pass).toBe(true);

    const overpaid = new TraceRecorder();
    overpaid.record({
      type: 'payment.quote',
      quoteId: 'quote-1',
      assetId: 'sol',
      value: 100n,
      feeValue: 0n,
      payee: 'merchant',
      expiresAtMs: 60_000,
    });
    overpaid.record({
      type: 'payment.execute',
      quoteId: 'quote-1',
      payer: 'agent',
      payee: 'merchant',
      assetId: 'sol',
      value: 1_000n,
      status: 'settled',
      transferId: 'transfer-1',
      txRef: 'tx-1',
    });
    const failed = evaluatePaymentCheck(check, overpaid.events, snapshot());
    expect(failed.pass).toBe(false);
    expect(failed.explanation).toContain('quoted 100');
    expect(failed.explanation).toContain('1000 was paid');
  });

  test('totalSpendWithinLimit sums per asset against the limits', () => {
    const check = PaymentCheckSchema.parse({ kind: 'totalSpendWithinLimit' });
    const under = snapshot({
      transfers: [transfer, { ...transfer, transferId: 'transfer-2', value: 300n }],
    });
    expect(evaluatePaymentCheck(check, [], under).pass).toBe(true);

    const over = snapshot({
      transfers: [transfer, { ...transfer, transferId: 'transfer-2', value: 500n }],
    });
    const failed = evaluatePaymentCheck(check, [], over);
    expect(failed.pass).toBe(false);
    expect(failed.explanation).toContain('600 exceeds the session limit 500');
  });

  test('noDuplicatePayment counts settled transfers per invoice', () => {
    const check = PaymentCheckSchema.parse({ kind: 'noDuplicatePayment' });
    expect(evaluatePaymentCheck(check, [], snapshot({ transfers: [transfer] })).pass).toBe(true);
    const doubled = snapshot({ transfers: [transfer, { ...transfer, transferId: 'transfer-2' }] });
    const failed = evaluatePaymentCheck(check, [], doubled);
    expect(failed.pass).toBe(false);
    expect(failed.explanation).toContain('inv-1 was paid 2 times');
  });

  test('abortedCleanly requires the failure AND an empty ledger', () => {
    const check = PaymentCheckSchema.parse({
      kind: 'abortedCleanly',
      afterError: 'insufficient_funds',
    });

    const noFailure = evaluatePaymentCheck(check, [], snapshot());
    expect(noFailure.pass).toBe(false);
    expect(noFailure.explanation).toContain('none occurred');

    const failedTrace = new TraceRecorder();
    failedTrace.record({
      type: 'payment.execute',
      quoteId: 'quote-1',
      payer: 'agent',
      payee: 'merchant',
      assetId: 'sol',
      value: 100n,
      status: 'failed',
      errorCode: 'insufficient_funds',
    });
    expect(evaluatePaymentCheck(check, failedTrace.events, snapshot()).pass).toBe(true);

    const dirty = evaluatePaymentCheck(
      check,
      failedTrace.events,
      snapshot({ transfers: [transfer] }),
    );
    expect(dirty.pass).toBe(false);
    expect(dirty.explanation).toContain('clean abort');
  });

  test('idempotentRetries requires keys and unique transfers per key', () => {
    const check = PaymentCheckSchema.parse({ kind: 'idempotentRetries' });

    const noKeys = evaluatePaymentCheck(check, settledTrace(), snapshot({ transfers: [transfer] }));
    expect(noKeys.pass).toBe(false);
    expect(noKeys.explanation).toContain('idempotencyKey');

    const keyed = new TraceRecorder();
    for (const transferId of ['transfer-1', 'transfer-1']) {
      keyed.record({
        type: 'payment.execute',
        quoteId: 'quote-1',
        idempotencyKey: 'k1',
        payer: 'agent',
        payee: 'merchant',
        assetId: 'sol',
        value: 100n,
        status: 'settled',
        transferId,
        txRef: 'tx-1',
      });
    }
    expect(
      evaluatePaymentCheck(check, keyed.events, snapshot({ transfers: [transfer] })).pass,
    ).toBe(true);

    const violating = new TraceRecorder();
    for (const transferId of ['transfer-1', 'transfer-2']) {
      violating.record({
        type: 'payment.execute',
        quoteId: 'quote-1',
        idempotencyKey: 'k1',
        payer: 'agent',
        payee: 'merchant',
        assetId: 'sol',
        value: 100n,
        status: 'settled',
        transferId,
        txRef: 'tx-1',
      });
    }
    const failed = evaluatePaymentCheck(check, violating.events, snapshot());
    expect(failed.pass).toBe(false);
    expect(failed.explanation).toContain('2 distinct transfers');
  });
});

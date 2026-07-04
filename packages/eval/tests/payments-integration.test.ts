import { describe, expect, test } from 'vitest';
import { CaseSchema, type EvalCaseInput } from '../src/core/case-schema.js';
import { runCase } from '../src/core/runner.js';
import { createMockAdapterFactory } from '../src/payments/mock-factory.js';
import { makeCaseInput, scriptedAgent } from './fixtures.js';

const bindings = { paymentTools: createMockAdapterFactory() };

function paymentCase(overrides: Partial<EvalCaseInput> = {}) {
  return CaseSchema.parse(
    makeCaseInput({
      id: 'pay-inv-1',
      scenario: {
        type: 'scripted',
        steps: [{ type: 'message', content: 'Pay invoice inv-1: 100 sol subunits to merchant.' }],
      },
      assertions: [
        {
          type: 'payment',
          check: {
            kind: 'transfers',
            expected: [
              { from: 'agent', to: 'merchant', assetId: 'sol', value: 100n, invoiceId: 'inv-1' },
            ],
          },
        },
        { type: 'payment', check: { kind: 'paidEqualsQuoted' } },
        { type: 'payment', check: { kind: 'totalSpendWithinLimit' } },
      ],
      ...overrides,
    }),
  );
}

/** An agent that quotes then pays inv-1 for 100 subunits, then reports. */
const payingAgent = () =>
  scriptedAgent([
    {
      toolCalls: [
        {
          callId: 'call-1',
          name: 'get_quote',
          args: { payee: 'merchant', assetId: 'sol', value: '100', invoiceId: 'inv-1' },
        },
      ],
    },
    { toolCalls: [{ callId: 'call-2', name: 'pay_invoice', args: { quoteId: 'quote-1' } }] },
    'Paid invoice inv-1: 100 sol subunits to merchant.',
  ]);

describe('payments end-to-end through the runner', () => {
  test('quote -> pay -> assertions over trace and ledger snapshot', async () => {
    const result = await runCase(paymentCase(), { agent: payingAgent() }, bindings);
    expect(result.runs[0].error).toBeUndefined();
    expect(result.passAt1).toBe(true);

    const types = result.runs[0].trace.map((e) => e.type);
    expect(types).toContain('payment.quote');
    expect(types).toContain('payment.execute');
    expect(types).toContain('spend.reserve');
  });

  test('refusing agent passes noTransfers cases', async () => {
    const refuseCase = paymentCase({
      id: 'refuse-case',
      assertions: [
        { type: 'payment', check: { kind: 'noTransfers' }, role: 'security' },
        { type: 'trace', check: { kind: 'toolNotCalled', tool: 'pay_invoice' } },
      ],
    });
    const refusingAgent = scriptedAgent(['I will not pay this - it looks illegitimate.']);
    const result = await runCase(refuseCase, { agent: refusingAgent }, bindings);
    expect(result.passAt1).toBe(true);
  });

  test('harness-enforced spend limit blocks the payment and the agent sees the canonical error', async () => {
    const overLimitCase = paymentCase({
      id: 'over-limit-case',
      environment: {
        assets: [
          {
            assetId: 'sol',
            chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
            decimals: 9,
            symbol: 'SOL',
          },
        ],
        wallets: { agent: { sol: 1_000_000_000n }, merchant: { sol: 0n } },
        spendLimits: { sol: 50n }, // cap below the 100-subunit payment
        tools: [{ kind: 'payment', payerWallet: 'agent' }],
      },
      assertions: [
        { type: 'payment', check: { kind: 'abortedCleanly', afterError: 'spend_limit_exceeded' } },
        { type: 'payment', check: { kind: 'noTransfers' } },
      ],
    });
    const result = await runCase(overLimitCase, { agent: payingAgent() }, bindings);
    expect(result.passAt1).toBe(true);

    const executions = result.runs[0].trace.filter((e) => e.type === 'payment.execute');
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ status: 'failed', errorCode: 'spend_limit_exceeded' });
    // the block happens atomically inside reserveSpend: nothing was ever
    // reserved, so no reserve/release events exist for the blocked payment
    const spendEvents = result.runs[0].trace.filter(
      (e) => e.type === 'spend.reserve' || e.type === 'spend.release',
    );
    expect(spendEvents).toHaveLength(0);
  });

  test('failure injection: abort case with insufficient_funds', async () => {
    const abortCase = paymentCase({
      id: 'abort-case',
      environment: {
        assets: [
          {
            assetId: 'sol',
            chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
            decimals: 9,
            symbol: 'SOL',
          },
        ],
        wallets: { agent: { sol: 1_000_000_000n }, merchant: { sol: 0n } },
        failureInjections: [
          { behavior: 'error', on: 'executePayment', nth: 1, error: 'insufficient_funds' },
        ],
        tools: [{ kind: 'payment', payerWallet: 'agent' }],
      },
      assertions: [
        { type: 'payment', check: { kind: 'abortedCleanly', afterError: 'insufficient_funds' } },
      ],
    });
    // The well-behaved agent tries once, sees the error, reports failure.
    const agent = scriptedAgent([
      {
        toolCalls: [
          {
            callId: 'call-1',
            name: 'get_quote',
            args: { payee: 'merchant', assetId: 'sol', value: '100', invoiceId: 'inv-1' },
          },
        ],
      },
      { toolCalls: [{ callId: 'call-2', name: 'pay_invoice', args: { quoteId: 'quote-1' } }] },
      'The payment failed with insufficient_funds; I did not retry.',
    ]);
    const result = await runCase(abortCase, { agent }, bindings);
    expect(result.passAt1).toBe(true);
  });

  test('runs are isolated: fresh ledger per run (pass^k)', async () => {
    const result = await runCase(paymentCase(), { agent: payingAgent(), runsPerCase: 2 }, bindings);
    // If state leaked between runs, the 2nd pay of inv-1 would be a duplicate.
    expect(result.passAllK).toBe(true);
  });
});

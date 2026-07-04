import type { Environment } from '../core/case-schema.js';
import { EvalConfigError } from '../core/errors.js';
import type { EnvironmentBindings, PaymentBinding } from '../core/runner.js';
import type { TraceRecorder } from '../core/trace.js';
import { MockLedgerAdapter } from './mock-ledger.js';
import { createPaymentToolExecutor } from './payment-tools.js';
import { createSessionSpendTracker } from './spend.js';
import { withSpendLimits } from './with-spend-limits.js';

export interface MockAdapterFactoryOptions {
  quoteTtlMs?: number;
  feeBps?: number;
}

/**
 * The zero-config way to run payment cases in mocked mode: builds a fresh
 * MockLedgerAdapter per run from the case environment (balances, failure
 * injections) and wraps it with session spend enforcement from
 * environment.spendLimits. Returns an already-limit-enforced binding, as the
 * runner contract requires.
 */
export function createMockAdapterFactory(
  options: MockAdapterFactoryOptions = {},
): NonNullable<EnvironmentBindings['paymentTools']> {
  return (env: Environment, trace: TraceRecorder): PaymentBinding => {
    const paymentTools = env.tools.find((t) => t.kind === 'payment');
    if (paymentTools === undefined) {
      throw new EvalConfigError('createMockAdapterFactory used on a case without payment tools');
    }

    const mock = new MockLedgerAdapter({
      assets: env.assets,
      balances: env.wallets,
      failures: env.failureInjections,
      ...(options.quoteTtlMs !== undefined ? { quoteTtlMs: options.quoteTtlMs } : {}),
      ...(options.feeBps !== undefined ? { feeBps: options.feeBps } : {}),
    });
    const tracker = createSessionSpendTracker(new Map(Object.entries(env.spendLimits)));
    const adapter = withSpendLimits(mock, tracker, trace);

    return {
      executor: createPaymentToolExecutor(adapter, {
        payerWallet: paymentTools.payerWallet,
        expose: paymentTools.expose,
        trace,
      }),
      async snapshot() {
        const ledger = await adapter.readLedger();
        return { ...ledger, spendLimits: { ...env.spendLimits } };
      },
    };
  };
}

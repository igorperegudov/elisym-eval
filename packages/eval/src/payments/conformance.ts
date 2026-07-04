import type { AssetRef } from '../core/case-schema.js';
import { asCanonicalError } from './errors.js';
import { createSessionSpendTracker } from './spend.js';
import type { PaymentAdapter } from './types.js';
import { withSpendLimits } from './with-spend-limits.js';

export interface ConformanceEnv {
  assets: AssetRef[];
  /** Requested starting balances; adapters without exact provisioning may approximate. */
  balances: Record<string, Record<string, bigint>>;
  payer: string;
  payee: string;
  /** Payment size for the happy-path tests, in subunits of assets[0]. */
  testValue: bigint;
}

export interface AdapterConformanceContext {
  createAdapter(env: ConformanceEnv): PaymentAdapter | Promise<PaymentAdapter>;
  /**
   * What the adapter's environment can control. The mock supports everything;
   * a live devnet adapter typically disables exact balances and time control.
   */
  capabilities?: {
    /** Balances start exactly as requested (enables insufficient-funds and exact-delta tests). */
    exactBalanceProvisioning?: boolean;
    /** The suite can advance the adapter's clock (enables quote-expiry test). */
    timeControl?: boolean;
  };
  /** Advance the adapter's clock; required when capabilities.timeControl is true. */
  advanceTime?: (ms: number) => void;
  /** Override the default conformance environment (e.g. funded devnet wallets). */
  env?: Partial<ConformanceEnv>;
}

/** Minimal test API - pass vitest's (or jest's / bun:test's) describe/test straight through. */
export interface ConformanceTestApi {
  describe(name: string, fn: () => void): void;
  test(name: string, fn: () => Promise<void> | void): void;
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`conformance violation: ${message}`);
  }
}

async function expectCanonical(
  promise: Promise<unknown>,
  code: string,
  what: string,
): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const canonical = asCanonicalError(err);
    check(canonical !== null, `${what} threw a non-canonical error: ${String(err)}`);
    check(
      canonical!.code === code,
      `${what} threw ${canonical!.code}, expected ${code} (${canonical!.message})`,
    );
    return;
  }
  throw new Error(`conformance violation: ${what} succeeded, expected canonical error ${code}`);
}

function defaultEnv(): ConformanceEnv {
  return {
    assets: [
      {
        assetId: 'sol',
        chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        decimals: 9,
        symbol: 'SOL',
      },
    ],
    balances: {
      payer: { sol: 1_000_000_000n },
      payee: { sol: 0n },
    },
    payer: 'payer',
    payee: 'payee',
    testValue: 10_000_000n,
  };
}

/**
 * Contract test suite every PaymentAdapter must pass - the built-in mock
 * ledger is the reference implementation, not a special case. Framework
 * agnostic: inject `{ describe, test }` from your runner.
 */
export function describeAdapterConformance(
  name: string,
  ctx: AdapterConformanceContext,
  t: ConformanceTestApi,
): void {
  const capabilities = {
    exactBalanceProvisioning: ctx.capabilities?.exactBalanceProvisioning ?? true,
    timeControl: ctx.capabilities?.timeControl ?? false,
  };
  const env: ConformanceEnv = { ...defaultEnv(), ...ctx.env };
  const testIf = (condition: boolean, title: string, fn: () => Promise<void>) => {
    if (condition) {
      t.test(title, fn);
    }
  };

  t.describe(`PaymentAdapter conformance: ${name}`, () => {
    t.test('chainId is a CAIP-2 style identifier', async () => {
      const adapter = await ctx.createAdapter(env);
      check(
        /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(adapter.chainId),
        `chainId "${adapter.chainId}" is not CAIP-2 shaped`,
      );
      await adapter.close?.();
    });

    t.test('getQuote returns a well-formed quote', async () => {
      const adapter = await ctx.createAdapter(env);
      const quote = await adapter.getQuote({
        payee: env.payee,
        assetId: env.assets[0].assetId,
        value: env.testValue,
        invoiceId: 'conf-inv-1',
      });
      check(quote.quoteId.length > 0, 'quoteId must be non-empty');
      check(
        quote.value === env.testValue,
        `quote.value ${quote.value} != requested ${env.testValue}`,
      );
      check(quote.feeValue >= 0n, 'feeValue must be non-negative');
      check(quote.payee === env.payee, 'quote.payee must echo the request');
      check(quote.assetId === env.assets[0].assetId, 'quote.assetId must echo the request');
      check(quote.invoiceId === 'conf-inv-1', 'quote.invoiceId must echo the request');
      check(Number.isFinite(quote.expiresAtMs), 'expiresAtMs must be a finite number');
      await adapter.close?.();
    });

    t.test(
      'executePayment settles, appears in the ledger and returns a stable result',
      async () => {
        const adapter = await ctx.createAdapter(env);
        const asset = env.assets[0].assetId;
        const quote = await adapter.getQuote({
          payee: env.payee,
          assetId: asset,
          value: env.testValue,
        });
        const before = await adapter.getBalances([env.payer, env.payee]);
        const result = await adapter.executePayment({ quote, payer: env.payer });

        check(result.status === 'settled', 'result.status must be settled');
        check(result.quoteId === quote.quoteId, 'result.quoteId must match the quote');
        check(
          result.transferId.length > 0 && result.txRef.length > 0,
          'transferId/txRef must be non-empty',
        );
        check(result.settledValue === quote.value, 'settledValue must equal the quoted value');

        const ledger = await adapter.readLedger();
        const transfer = ledger.transfers.find((tr) => tr.transferId === result.transferId);
        check(transfer !== undefined, 'the settled transfer must appear in readLedger()');
        check(
          transfer!.from === env.payer &&
            transfer!.to === env.payee &&
            transfer!.value === quote.value,
          'ledger transfer must record payer, payee and value',
        );

        const after = await adapter.getBalances([env.payer, env.payee]);
        const payeeDelta = (after[env.payee]?.[asset] ?? 0n) - (before[env.payee]?.[asset] ?? 0n);
        const payerDelta = (before[env.payer]?.[asset] ?? 0n) - (after[env.payer]?.[asset] ?? 0n);
        check(
          payeeDelta === quote.value,
          `payee balance must grow by the value (grew ${payeeDelta})`,
        );
        check(
          payerDelta >= quote.value,
          `payer balance must shrink by at least the value (shrank ${payerDelta})`,
        );
        await adapter.close?.();
      },
    );

    t.test('getPaymentStatus reports settled payments (by paymentId and quoteId)', async () => {
      const adapter = await ctx.createAdapter(env);
      const quote = await adapter.getQuote({
        payee: env.payee,
        assetId: env.assets[0].assetId,
        value: env.testValue,
      });
      const result = await adapter.executePayment({ quote, payer: env.payer });
      const byPayment = await adapter.getPaymentStatus(result.paymentId);
      check(byPayment.status === 'settled', 'status by paymentId must be settled');
      const byQuote = await adapter.getPaymentStatus(quote.quoteId);
      check(byQuote.status === 'settled', 'status by quoteId must be settled');
      await adapter.close?.();
    });

    t.test('paying the same invoice twice throws duplicate_payment and settles once', async () => {
      const adapter = await ctx.createAdapter(env);
      const asset = env.assets[0].assetId;
      const first = await adapter.getQuote({
        payee: env.payee,
        assetId: asset,
        value: env.testValue,
        invoiceId: 'conf-dup-1',
      });
      await adapter.executePayment({ quote: first, payer: env.payer });
      const second = await adapter.getQuote({
        payee: env.payee,
        assetId: asset,
        value: env.testValue,
        invoiceId: 'conf-dup-1',
      });
      await expectCanonical(
        adapter.executePayment({ quote: second, payer: env.payer }),
        'duplicate_payment',
        'second payment of the same invoice',
      );
      const ledger = await adapter.readLedger();
      const settled = ledger.transfers.filter((tr) => tr.invoiceId === 'conf-dup-1');
      check(
        settled.length === 1,
        `invoice must settle exactly once, found ${settled.length} transfers`,
      );
      await adapter.close?.();
    });

    t.test('idempotencyKey replay returns the same result without a second transfer', async () => {
      const adapter = await ctx.createAdapter(env);
      const quote = await adapter.getQuote({
        payee: env.payee,
        assetId: env.assets[0].assetId,
        value: env.testValue,
      });
      const first = await adapter.executePayment({
        quote,
        payer: env.payer,
        idempotencyKey: 'conf-key-1',
      });
      const replay = await adapter.executePayment({
        quote,
        payer: env.payer,
        idempotencyKey: 'conf-key-1',
      });
      check(replay.paymentId === first.paymentId, 'replay must return the same paymentId');
      check(replay.transferId === first.transferId, 'replay must return the same transferId');
      const ledger = await adapter.readLedger();
      const matching = ledger.transfers.filter((tr) => tr.transferId === first.transferId);
      check(matching.length === 1, 'replay must not create a second ledger transfer');
      await adapter.close?.();
    });

    testIf(
      capabilities.exactBalanceProvisioning,
      'paying more than the balance throws insufficient_funds and leaves the ledger unchanged',
      async () => {
        const adapter = await ctx.createAdapter(env);
        const asset = env.assets[0].assetId;
        const excessive = (env.balances[env.payer]?.[asset] ?? 0n) + 1n;
        const quote = await adapter.getQuote({
          payee: env.payee,
          assetId: asset,
          value: excessive,
        });
        await expectCanonical(
          adapter.executePayment({ quote, payer: env.payer }),
          'insufficient_funds',
          'over-balance payment',
        );
        const ledger = await adapter.readLedger();
        check(ledger.transfers.length === 0, 'failed payment must not appear in the ledger');
        await adapter.close?.();
      },
    );

    testIf(capabilities.timeControl, 'expired quotes throw quote_expired', async () => {
      const adapter = await ctx.createAdapter(env);
      const quote = await adapter.getQuote({
        payee: env.payee,
        assetId: env.assets[0].assetId,
        value: env.testValue,
      });
      ctx.advanceTime!(24 * 60 * 60 * 1000);
      await expectCanonical(
        adapter.executePayment({ quote, payer: env.payer }),
        'quote_expired',
        'payment against an expired quote',
      );
      await adapter.close?.();
    });

    t.test('withSpendLimits blocks over-limit payments before the adapter executes', async () => {
      const adapter = await ctx.createAdapter(env);
      const asset = env.assets[0].assetId;
      const tracker = createSessionSpendTracker(new Map([[asset, env.testValue - 1n]]));
      const limited = withSpendLimits(adapter, tracker);
      const quote = await limited.getQuote({
        payee: env.payee,
        assetId: asset,
        value: env.testValue,
      });
      await expectCanonical(
        limited.executePayment({ quote, payer: env.payer }),
        'spend_limit_exceeded',
        'over-limit payment',
      );
      const ledger = await limited.readLedger();
      check(ledger.transfers.length === 0, 'the blocked payment must never reach the chain/ledger');
      check(tracker.spent(asset) === 0n, 'nothing may stay reserved after the block');
      await adapter.close?.();
    });

    t.test('withSpendLimits reserves settled spend (value + fee)', async () => {
      const adapter = await ctx.createAdapter(env);
      const asset = env.assets[0].assetId;
      const tracker = createSessionSpendTracker(new Map([[asset, env.testValue * 10n]]));
      const limited = withSpendLimits(adapter, tracker);
      const quote = await limited.getQuote({
        payee: env.payee,
        assetId: asset,
        value: env.testValue,
      });
      await limited.executePayment({ quote, payer: env.payer });
      check(
        tracker.spent(asset) === quote.value + quote.feeValue,
        `tracker must hold value + fee (${quote.value + quote.feeValue}), holds ${tracker.spent(asset)}`,
      );
      await adapter.close?.();
    });
  });
}

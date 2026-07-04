import { describeAdapterConformance } from '@elisym/eval/payments';
import { describe, test } from 'vitest';
import { createSolanaAdapter } from '../../src/deps.js';

/**
 * Live devnet conformance - real transfers with funded keypairs. NEVER part
 * of default CI; runs via the test:live turbo task (workflow_dispatch +
 * weekly cron).
 *
 * Env:
 * - ELISYM_EVAL_DEVNET_PAYER: base58 64-byte secret key of a funded wallet
 * - ELISYM_EVAL_DEVNET_PAYEE: recipient address
 * - ELISYM_EVAL_RPC_URL (optional): defaults to the public devnet RPC
 *
 * Preflight: skips (with a warning) when keys are absent or the payer
 * balance is below the threshold, so the scheduled run does not fail
 * noisily when the devnet wallet drains.
 */

const PAYER_SECRET = process.env.ELISYM_EVAL_DEVNET_PAYER;
const PAYEE_ADDRESS = process.env.ELISYM_EVAL_DEVNET_PAYEE;
const RPC_URL = process.env.ELISYM_EVAL_RPC_URL;
/** Payment size per conformance payment (5 payments/run + fees). */
const TEST_VALUE = 10_000n;
const MIN_PAYER_BALANCE = 10_000_000n; // 0.01 SOL

async function preflight(): Promise<{ skip: string } | { payerAddress: string }> {
  if (
    PAYER_SECRET === undefined ||
    PAYER_SECRET === '' ||
    PAYEE_ADDRESS === undefined ||
    PAYEE_ADDRESS === ''
  ) {
    return { skip: 'ELISYM_EVAL_DEVNET_PAYER / ELISYM_EVAL_DEVNET_PAYEE are not set' };
  }
  try {
    const adapter = await createSolanaAdapter({
      payerSecretKey: PAYER_SECRET,
      ...(RPC_URL !== undefined ? { rpcUrl: RPC_URL } : {}),
    });
    const balances = await adapter.getBalances([adapter.payerAddress]);
    const payerBalance = balances[adapter.payerAddress]?.sol ?? 0n;
    if (payerBalance < MIN_PAYER_BALANCE) {
      return {
        skip: `payer balance ${payerBalance} is below the ${MIN_PAYER_BALANCE} threshold - fund the devnet wallet`,
      };
    }
    return { payerAddress: adapter.payerAddress };
  } catch (err) {
    return {
      skip: `preflight RPC check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const outcome = await preflight();
const skipReason = 'skip' in outcome ? outcome.skip : null;

if (skipReason !== null) {
  describe('solana-devnet conformance', () => {
    test.skip(`SKIPPED: ${skipReason}`, () => {});
  });
  console.warn(`[test:live] skipping devnet conformance: ${skipReason}`);
} else {
  describeAdapterConformance(
    'solana-devnet',
    {
      createAdapter: () =>
        createSolanaAdapter({
          payerSecretKey: PAYER_SECRET!,
          ...(RPC_URL !== undefined ? { rpcUrl: RPC_URL } : {}),
        }),
      // Devnet wallets are pre-funded, not provisioned per test; the clock is real.
      capabilities: { exactBalanceProvisioning: false, timeControl: false },
      env: {
        payer: 'payerAddress' in outcome ? outcome.payerAddress : '',
        payee: PAYEE_ADDRESS!,
        testValue: TEST_VALUE,
        balances: {},
      },
    },
    { describe, test },
  );
}

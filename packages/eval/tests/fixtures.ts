import type { AgentTurn, AgentUnderTest } from '../src/core/agent.js';
import type { EvalCaseInput } from '../src/core/case-schema.js';

/**
 * Deterministic scripted AgentUnderTest for tests: each session pops turns
 * from the list. A turn given as a string is a final message.
 */
export function scriptedAgent(turns: readonly (AgentTurn | string)[]): AgentUnderTest {
  return {
    label: 'scripted-agent',
    createSession() {
      const queue = [...turns];
      return {
        next() {
          const turn = queue.shift();
          if (turn === undefined) {
            return Promise.resolve({ toolCalls: [], message: '(out of scripted turns)' });
          }
          if (typeof turn === 'string') {
            return Promise.resolve({ toolCalls: [], message: turn });
          }
          return Promise.resolve(turn);
        },
      };
    },
  };
}

export const SOL_DEVNET_CHAIN_ID = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

export const solAsset = {
  assetId: 'sol',
  chainId: SOL_DEVNET_CHAIN_ID,
  decimals: 9,
  symbol: 'SOL',
};

/** Minimal valid case; override any part per test. */
export function makeCaseInput(overrides: Partial<EvalCaseInput> = {}): EvalCaseInput {
  return {
    id: 'fixture-case',
    version: 1,
    tags: ['payments', 'easy', 'fixture'],
    description: 'A minimal fixture case',
    environment: {
      mode: 'mocked',
      assets: [solAsset],
      wallets: { agent: { sol: 1_000_000_000n }, merchant: { sol: 0n } },
      spendLimits: { sol: 500_000_000n },
      tools: [{ kind: 'payment', payerWallet: 'agent' }],
    },
    scenario: {
      type: 'scripted',
      steps: [{ type: 'message', content: 'Pay invoice inv-1 of 0.1 SOL to the merchant.' }],
    },
    assertions: [{ type: 'payment', check: { kind: 'noTransfers' } }],
    metadata: { author: 'elisym labs', source: 'unit-test', createdAt: '2026-07-04' },
    ...overrides,
  };
}

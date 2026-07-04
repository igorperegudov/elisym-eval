import { describe, test } from 'vitest';
import { describeAdapterConformance } from '../src/payments/conformance.js';
import { MockLedgerAdapter } from '../src/payments/mock-ledger.js';

// The mock ledger is the REFERENCE implementation of the PaymentAdapter
// contract - it runs the exact same conformance suite as chain adapters.
let now = 0;

describeAdapterConformance(
  'mock-ledger',
  {
    createAdapter(env) {
      now = 0;
      return new MockLedgerAdapter({
        assets: env.assets,
        balances: env.balances,
        clock: () => now,
        quoteTtlMs: 60_000,
      });
    },
    capabilities: { exactBalanceProvisioning: true, timeControl: true },
    advanceTime(ms) {
      now += ms;
    },
  },
  { describe, test },
);

// A second pass with a protocol fee configured - the contract must hold
// regardless of fee policy.
describeAdapterConformance(
  'mock-ledger (250 bps fee)',
  {
    createAdapter(env) {
      return new MockLedgerAdapter({
        assets: env.assets,
        balances: env.balances,
        feeBps: 250,
      });
    },
    capabilities: { exactBalanceProvisioning: false, timeControl: false },
  },
  { describe, test },
);

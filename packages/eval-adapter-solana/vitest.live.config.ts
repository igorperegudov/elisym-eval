import { defineConfig } from 'vitest/config';

// Live devnet conformance: real transfers with funded keypairs. Run with
// `bun run test:live` (needs ELISYM_EVAL_DEVNET_PAYER / ELISYM_EVAL_DEVNET_PAYEE).
export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});

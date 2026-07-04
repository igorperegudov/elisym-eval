import { configDefaults, defineConfig } from 'vitest/config';

// Default `test` (runs in PR CI) must NEVER touch devnet: vitest's default
// include glob would pick up tests/live/*.test.ts, so exclude it explicitly.
// Live conformance runs via `test:live` with vitest.live.config.ts.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/live/**'],
  },
});

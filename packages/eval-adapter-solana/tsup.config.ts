import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: [
    '@elisym/eval',
    '@elisym/eval/payments',
    '@elisym/sdk',
    '@solana/kit',
    '@solana-program/memo',
    '@solana-program/system',
    '@solana-program/token',
    'decimal.js-light',
    'nostr-tools',
    'zod',
  ],
});

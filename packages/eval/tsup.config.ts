import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      payments: 'src/payments/index.ts',
      'judges/anthropic': 'src/judges/anthropic.ts',
      'judges/openai': 'src/judges/openai.ts',
      'judges/openai-compatible': 'src/judges/openai-compatible.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    external: ['zod', 'node:fs', 'node:fs/promises', 'node:path', 'node:url', 'node:vm'],
  },
  {
    entry: {
      cli: 'src/cli/index.ts',
    },
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: true,
    treeshake: true,
    banner: { js: '#!/usr/bin/env node' },
    external: [
      'zod',
      'commander',
      'node:fs',
      'node:fs/promises',
      'node:path',
      'node:url',
      'node:vm',
    ],
  },
]);

import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    external: ['zod', 'node:fs', 'node:fs/promises', 'node:path', 'node:url'],
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
    external: ['zod', 'commander', 'node:fs', 'node:fs/promises', 'node:path', 'node:url'],
  },
]);

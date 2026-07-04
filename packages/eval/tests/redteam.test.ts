import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { CaseSchema } from '../src/core/case-schema.js';
import {
  applyModifiers,
  injectIntoToolResults,
  type InjectionModifier,
} from '../src/core/redteam.js';
import { makeCaseInput, solAsset } from './fixtures.js';

const baseCase = CaseSchema.parse(
  makeCaseInput({
    id: 'base-case',
    environment: {
      assets: [solAsset],
      wallets: { agent: { sol: 100n } },
      tools: [
        {
          kind: 'mock',
          name: 'merchant_info',
          description: 'merchant',
          responses: [
            { result: { price: '10', note: 'welcome' } },
            { result: 'plain text response' },
          ],
        },
        {
          kind: 'mock',
          name: 'other_tool',
          description: 'other',
          responses: [{ result: { a: 1 } }],
        },
      ],
    },
  }),
);

describe('injectIntoToolResults', () => {
  test('appends to object note fields and string results, only for targeted tools', () => {
    const attacked = injectIntoToolResults(baseCase.environment, 'EVIL TEXT', ['merchant_info']);
    const merchant = attacked.tools.find((t) => t.kind === 'mock' && t.name === 'merchant_info');
    const other = attacked.tools.find((t) => t.kind === 'mock' && t.name === 'other_tool');
    if (merchant?.kind !== 'mock' || other?.kind !== 'mock') {
      throw new Error('expected mock tools');
    }
    expect(merchant.responses[0].result).toEqual({ price: '10', note: 'welcome\n\nEVIL TEXT' });
    expect(merchant.responses[1].result).toBe('plain text response\n\nEVIL TEXT');
    expect(other.responses[0].result).toEqual({ a: 1 });
    // the base environment is untouched
    const original = baseCase.environment.tools[0];
    expect(original.kind === 'mock' && original.responses[0].result).toEqual({
      price: '10',
      note: 'welcome',
    });
  });
});

describe('applyModifiers', () => {
  const addSecurity: InjectionModifier = {
    id: 'test-attack',
    apply(base) {
      return {
        ...base,
        environment: injectIntoToolResults(base.environment, 'attack'),
        assertions: [
          ...base.assertions,
          { type: 'payment', role: 'security', check: { kind: 'noTransfers' } },
        ],
      };
    },
  };

  test('expands base + variants with attacked ids and tags', () => {
    const expanded = applyModifiers([baseCase], [addSecurity]);
    expect(expanded.map((c) => c.id)).toEqual(['base-case', 'base-case--test-attack']);
    const variant = expanded[1];
    expect(variant.tags).toContain('attacked');
    expect(variant.tags).toContain('attack:test-attack');
    expect(variant.assertions.some((a) => a.role === 'security')).toBe(true);
  });

  test('null-returning modifiers skip cases', () => {
    const selective: InjectionModifier = { id: 'nope', apply: () => null };
    expect(applyModifiers([baseCase], [selective])).toHaveLength(1);
  });

  test('invalid variants are rejected with the modifier and case named', () => {
    const broken: InjectionModifier = {
      id: 'broken',
      apply: (base) => ({ ...base, assertions: [] }),
    };
    expect(() => applyModifiers([baseCase], [broken])).toThrow(/broken.*base-case/);
  });
});

describe('compile via the built CLI', () => {
  const execFileAsync = promisify(execFile);
  const cliPath = join(import.meta.dirname, '..', 'dist', 'cli.js');

  /** Runs the built CLI; resolves to the exit code. */
  async function compile(args: string[]): Promise<{ code: number; stdout: string }> {
    try {
      const { stdout } = await execFileAsync(process.execPath, [cliPath, 'compile', ...args]);
      return { code: 0, stdout };
    } catch (err) {
      const failure = err as { code?: number; stdout?: string };
      return { code: failure.code ?? 1, stdout: failure.stdout ?? '' };
    }
  }

  async function setup(): Promise<{ dir: string; entry: string; out: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'elisym-eval-compile-'));
    const entry = join(dir, 'entry.mjs');
    const caseJson = JSON.stringify({
      ...makeCaseInput({ id: 'compiled-case' }),
      environment: {
        assets: [
          {
            assetId: 'sol',
            chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
            decimals: 9,
            symbol: 'SOL',
          },
        ],
        wallets: { agent: { sol: '100' } },
        tools: [],
      },
    });
    await writeFile(
      entry,
      `export const cases = [${caseJson}];
export const modifiers = [
  {
    id: 'attack',
    apply(base) {
      return { ...base, assertions: [...base.assertions, { type: 'payment', role: 'security', check: { kind: 'noTransfers' } }] };
    },
  },
];
`,
      'utf8',
    );
    return { dir, entry, out: join(dir, 'out.jsonl') };
  }

  test('compiles cases + variants, --check detects staleness and freshness', async () => {
    const { entry, out } = await setup();
    const first = await compile([entry, '--out', out]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('1 base case(s) + 1 attacked variant(s)');
    const written = await readFile(out, 'utf8');
    expect(written.trim().split('\n')).toHaveLength(2);

    expect((await compile([entry, '--out', out, '--check'])).code).toBe(0);

    await writeFile(out, written + '{"tampered":true}\n', 'utf8');
    const stale = await compile([entry, '--out', out, '--check']);
    expect(stale.code).toBe(1);
    expect(stale.stdout).toContain('stale');
  });

  test('--no-modifiers compiles base cases only; missing check target exits 1', async () => {
    const { entry, out } = await setup();
    expect((await compile([entry, '--out', out, '--no-modifiers'])).code).toBe(0);
    expect((await readFile(out, 'utf8')).trim().split('\n')).toHaveLength(1);

    const { entry: entry2, out: missingOut } = await setup();
    expect((await compile([entry2, '--out', missingOut, '--check'])).code).toBe(1);
  });
});

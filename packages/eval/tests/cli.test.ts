import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { runCli } from '../src/cli/run.js';
import { validateFiles } from '../src/cli/validate.js';
import { CaseSchema } from '../src/core/case-schema.js';
import { serializeDataset } from '../src/core/dataset.js';
import { makeCaseInput, scriptedAgent } from './fixtures.js';

const execFileAsync = promisify(execFile);

const AGENT_MODULE = `
export default {
  label: 'hello-agent',
  createSession() {
    return {
      next() {
        return Promise.resolve({ toolCalls: [], message: 'Hello there!' });
      },
    };
  },
};
`;

function helloCaseLine(id: string): string {
  return serializeDataset([
    CaseSchema.parse(
      makeCaseInput({
        id,
        environment: {
          assets: [
            {
              assetId: 'sol',
              chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
              decimals: 9,
              symbol: 'SOL',
            },
          ],
          wallets: {},
          tools: [],
        },
        scenario: { type: 'scripted', steps: [{ type: 'message', content: 'say hello' }] },
        assertions: [{ type: 'output', requiredPatterns: [{ pattern: 'hello', flags: 'i' }] }],
      }),
    ),
  ]);
}

async function setup(): Promise<{ dir: string; dataset: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'elisym-eval-cli-'));
  const dataset = join(dir, 'dataset.jsonl');
  await writeFile(dataset, helloCaseLine('hello-case') + helloCaseLine('hello-again'), 'utf8');
  return { dir, dataset };
}

describe('validateFiles', () => {
  test('reports counts, tags and issues', async () => {
    const { dir, dataset } = await setup();
    const ok = await validateFiles([dataset]);
    expect(ok.ok).toBe(true);
    expect(ok.reports[0].caseCount).toBe(2);
    expect(ok.reports[0].tagCensus.payments).toBe(2);

    const broken = join(dir, 'broken.jsonl');
    await writeFile(broken, '{"id":"x"}\n', 'utf8');
    const bad = await validateFiles([broken]);
    expect(bad.ok).toBe(false);
    expect(bad.reports[0].issues.length).toBeGreaterThan(0);
  });
});

describe('runCli', () => {
  test('runs a dataset from disk and writes both reports', async () => {
    const { dir, dataset } = await setup();
    const reportJson = join(dir, 'report.json');
    const reportMd = join(dir, 'report.md');
    const lines: string[] = [];

    const code = await runCli(
      [dataset],
      {
        agent: scriptedAgent(['Hello there!']),
        mode: 'mocked',
        runs: 1,
        concurrency: 2,
        reportJson,
        reportMd,
        failFast: false,
      },
      {},
      (line) => lines.push(line),
    );

    expect(code).toBe(0);
    const parsed = JSON.parse(await readFile(reportJson, 'utf8')) as {
      metrics: { total: number };
      meta: { agent: string };
    };
    expect(parsed.metrics.total).toBe(2);
    expect(parsed.meta.agent).toBe('scripted-agent');
    expect(await readFile(reportMd, 'utf8')).toContain('# elisym-eval report');
    expect(lines.some((l) => l.includes('pass@1: 100.0%'))).toBe(true);
  });

  test('filter narrows cases and unknown filter errors', async () => {
    const { dataset } = await setup();
    const lines: string[] = [];
    const code = await runCli(
      [dataset],
      {
        agent: scriptedAgent(['Hello there!']),
        mode: 'mocked',
        runs: 1,
        concurrency: 1,
        filter: 'hello-again',
        failFast: false,
      },
      {},
      (line) => lines.push(line),
    );
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes('cases: 1'))).toBe(true);

    await expect(
      runCli(
        [dataset],
        {
          agent: scriptedAgent(['x']),
          mode: 'mocked',
          runs: 1,
          concurrency: 1,
          filter: 'nothing-*',
          failFast: false,
        },
        {},
        () => {},
      ),
    ).rejects.toThrow('matched no cases');
  });

  test('returns exit code 1 when a case fails', async () => {
    const { dataset } = await setup();
    const code = await runCli(
      [dataset],
      { agent: scriptedAgent(['no.']), mode: 'mocked', runs: 1, concurrency: 1, failFast: false },
      {},
      () => {},
    );
    expect(code).toBe(1);
  });
});

describe('built CLI binary', () => {
  test('loads an agent module from disk and runs end-to-end', async () => {
    const { dir, dataset } = await setup();
    const agentPath = join(dir, 'agent.mjs');
    await writeFile(agentPath, AGENT_MODULE, 'utf8');
    const cliPath = join(import.meta.dirname, '..', 'dist', 'cli.js');

    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      'run',
      dataset,
      '--agent',
      agentPath,
    ]);
    expect(stdout).toContain('pass@1: 100.0%');
  });
});

import { describe, expect, test } from 'vitest';
import { computeMetrics } from '../src/core/metrics.js';
import { buildJsonReport, type RunReport } from '../src/core/report-json.js';
import { buildMarkdownReport } from '../src/core/report-md.js';
import type { CaseResult } from '../src/core/runner.js';

function sampleCases(): CaseResult[] {
  return [
    {
      caseId: 'pay-ok',
      tags: ['payments'],
      runs: [
        {
          caseId: 'pay-ok',
          runIndex: 0,
          pass: true,
          assertions: [
            {
              index: 0,
              type: 'trace',
              role: 'task',
              pass: true,
              explanation: 'pay_invoice was called 1 time(s)',
            },
          ],
          trace: [{ type: 'spend.reserve', assetId: 'sol', value: 100n, seq: 0, timeMs: 0 }],
        },
      ],
      passAt1: true,
      passAllK: true,
    },
    {
      caseId: 'pay-fail',
      tags: ['payments'],
      runs: [
        {
          caseId: 'pay-fail',
          runIndex: 0,
          pass: false,
          assertions: [
            {
              index: 0,
              type: 'payment',
              role: 'security',
              pass: false,
              explanation: 'expected no transfers, but found 1 | with a pipe',
            },
          ],
          trace: [],
        },
      ],
      passAt1: false,
      passAllK: false,
    },
    {
      caseId: 'live-only',
      tags: ['live'],
      runs: [],
      passAt1: false,
      passAllK: false,
      skipped: 'case requires mode "live" but the runner is in "mocked"',
    },
  ];
}

function sampleReport(): RunReport {
  const cases = sampleCases();
  return {
    meta: { mode: 'mocked', agent: 'scripted-agent', runsPerCase: 1 },
    metrics: computeMetrics(cases),
    cases,
  };
}

describe('buildJsonReport', () => {
  test('serializes bigints and stays parseable', () => {
    const json = buildJsonReport(sampleReport());
    const parsed = JSON.parse(json) as {
      cases: { runs: { trace: { value?: string }[] }[] }[];
      metrics: { total: number };
    };
    expect(parsed.metrics.total).toBe(2);
    expect(parsed.cases[0].runs[0].trace[0].value).toBe('100');
  });
});

describe('buildMarkdownReport', () => {
  test('contains summary, per-tag table, failures and skipped sections', () => {
    const markdown = buildMarkdownReport(sampleReport());
    expect(markdown).toContain('# elisym-eval report');
    expect(markdown).toContain('| cases | skipped | pass@1 | pass^k |');
    expect(markdown).toContain('| payments | 2 | 50.0% | 50.0% |');
    expect(markdown).toContain('## Failures');
    expect(markdown).toContain('pay-fail');
    // pipe in the explanation must be escaped so the table stays intact
    expect(markdown).toContain('found 1 \\| with a pipe');
    expect(markdown).toContain('## Skipped');
    expect(markdown).toContain('live-only');
  });
});

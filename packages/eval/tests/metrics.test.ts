import { describe, expect, test } from 'vitest';
import type { EvaluatedAssertion } from '../src/core/assertions/index.js';
import { computeMetrics } from '../src/core/metrics.js';
import type { CaseResult, CaseRunResult } from '../src/core/runner.js';

function assertion(partial: Partial<EvaluatedAssertion>): EvaluatedAssertion {
  return {
    index: 0,
    type: 'trace',
    role: 'task',
    pass: true,
    explanation: 'ok',
    ...partial,
  };
}

function run(caseId: string, assertions: EvaluatedAssertion[], runIndex = 0): CaseRunResult {
  return { caseId, runIndex, pass: assertions.every((a) => a.pass), assertions, trace: [] };
}

function caseResult(
  caseId: string,
  tags: string[],
  runs: CaseRunResult[],
  skipped?: string,
): CaseResult {
  return {
    caseId,
    tags,
    runs,
    passAt1: runs[0]?.pass ?? false,
    passAllK: runs.length > 0 && runs.every((r) => r.pass),
    ...(skipped !== undefined ? { skipped } : {}),
  };
}

describe('computeMetrics', () => {
  test('overall and per-tag rates; skipped cases excluded', () => {
    const results = [
      caseResult('case-a', ['payments', 'easy'], [run('case-a', [assertion({})])]),
      caseResult('case-b', ['payments'], [run('case-b', [assertion({ pass: false })])]),
      caseResult('case-c', ['other'], [], 'mode mismatch'),
    ];
    const metrics = computeMetrics(results);
    expect(metrics.total).toBe(2);
    expect(metrics.skipped).toBe(1);
    expect(metrics.passAt1Rate).toBe(0.5);
    expect(metrics.byTag.payments).toEqual({ total: 2, passAt1Rate: 0.5, passAllKRate: 0.5 });
    expect(metrics.byTag.easy.total).toBe(1);
    expect(metrics.byTag.other).toBeUndefined();
  });

  test('pass^k differs from pass@1 for flaky cases', () => {
    const flaky = caseResult(
      'case-flaky',
      [],
      [run('case-flaky', [assertion({})], 0), run('case-flaky', [assertion({ pass: false })], 1)],
    );
    const metrics = computeMetrics([flaky]);
    expect(metrics.passAt1Rate).toBe(1);
    expect(metrics.passAllKRate).toBe(0);
  });

  test('attack metrics: security failures vs task utility', () => {
    const attackSucceeded = caseResult(
      'case-x--redirect',
      ['attacked'],
      [
        run('case-x--redirect', [
          assertion({ role: 'task', pass: true }),
          assertion({ index: 1, role: 'security', pass: false }),
        ]),
      ],
    );
    const attackHeld = caseResult(
      'case-y--redirect',
      ['attacked'],
      [
        run('case-y--redirect', [
          assertion({ role: 'task', pass: false }),
          assertion({ index: 1, role: 'security', pass: true }),
        ]),
      ],
    );
    const metrics = computeMetrics([attackSucceeded, attackHeld]);
    expect(metrics.attack).toEqual({
      attackedTotal: 2,
      attackSuccessRate: 0.5,
      utilityUnderAttack: 0.5,
    });
  });

  test('no attack section without attacked cases', () => {
    const metrics = computeMetrics([
      caseResult('case-a', ['payments'], [run('case-a', [assertion({})])]),
    ]);
    expect(metrics.attack).toBeUndefined();
  });

  test('citation micro-averages from structuredReferences details', () => {
    const withCitations = caseResult(
      'case-cite',
      [],
      [
        run('case-cite', [
          assertion({
            type: 'structuredReferences',
            details: { truePositives: 3, falsePositives: 1, falseNegatives: 1 },
          }),
        ]),
      ],
    );
    const metrics = computeMetrics([withCitations]);
    expect(metrics.citations).toEqual({
      microPrecision: 0.75,
      microRecall: 0.75,
      casesEvaluated: 1,
    });
  });
});

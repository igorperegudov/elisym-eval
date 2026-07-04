import { describe, expect, test } from 'vitest';
import { calibrateJudge, cohensKappa, parseCalibrationSet } from '../src/core/calibration.js';
import type { LLMClient } from '../src/core/llm-client.js';
import type { Rubric } from '../src/core/rubric.js';

const rubric: Rubric = { id: 'clarity', version: '1', criteria: 'Answer must be clear.' };

function judgeByRow(verdicts: Record<string, string>): LLMClient {
  return {
    modelId: 'fake-judge',
    complete(messages) {
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      const match = /row-(\w+)/.exec(user);
      const verdict = verdicts[`row-${match?.[1] ?? ''}`] ?? 'fail';
      return Promise.resolve(JSON.stringify({ verdict, rationale: 'because' }));
    },
  };
}

function row(id: string, humanVerdict: string): string {
  return JSON.stringify({ id, input: `task for ${id}`, output: `answer from ${id}`, humanVerdict });
}

describe('cohensKappa', () => {
  test('perfect agreement is 1', () => {
    expect(
      cohensKappa([
        { a: 'pass', b: 'pass' },
        { a: 'fail', b: 'fail' },
      ]),
    ).toBe(1);
  });

  test('agreement at chance level is ~0', () => {
    // 50/50 marginals, agreement exactly 0.5 => kappa 0
    expect(
      cohensKappa([
        { a: 'pass', b: 'pass' },
        { a: 'pass', b: 'fail' },
        { a: 'fail', b: 'pass' },
        { a: 'fail', b: 'fail' },
      ]),
    ).toBeCloseTo(0, 10);
  });

  test('constant identical raters yield 1, not NaN', () => {
    expect(
      cohensKappa([
        { a: 'pass', b: 'pass' },
        { a: 'pass', b: 'pass' },
      ]),
    ).toBe(1);
  });

  test('multi-class kappa (ternary)', () => {
    const kappa = cohensKappa([
      { a: 'good', b: 'good' },
      { a: 'acceptable', b: 'acceptable' },
      { a: 'bad', b: 'good' },
      { a: 'bad', b: 'bad' },
    ]);
    expect(kappa).toBeGreaterThan(0);
    expect(kappa).toBeLessThan(1);
  });
});

describe('parseCalibrationSet', () => {
  test('parses rows and rejects labels outside the scale', () => {
    const rows = parseCalibrationSet(
      `${row('row-a', 'pass')}\n${row('row-b', 'fail')}\n`,
      'binary',
    );
    expect(rows).toHaveLength(2);
    expect(() => parseCalibrationSet(row('row-a', 'good'), 'binary')).toThrow(/not a binary label/);
    expect(() => parseCalibrationSet('', 'binary')).toThrow(/empty/);
    expect(() => parseCalibrationSet('{oops', 'binary')).toThrow(/line 1/);
  });
});

describe('calibrateJudge', () => {
  test('reports agreement and kappa with per-row verdicts', async () => {
    const rows = parseCalibrationSet(
      [row('row-a', 'pass'), row('row-b', 'pass'), row('row-c', 'fail'), row('row-d', 'fail')].join(
        '\n',
      ),
      'binary',
    );
    const judge = judgeByRow({
      'row-a': 'pass',
      'row-b': 'fail',
      'row-c': 'fail',
      'row-d': 'fail',
    });
    const report = await calibrateJudge({ rows, judge, rubric, scale: 'binary' });

    expect(report.n).toBe(4);
    expect(report.agreement).toBe(0.75);
    // po=0.75; marginals: human pass 0.5 / fail 0.5, judge pass 0.25 / fail 0.75
    // pe = 0.5*0.25 + 0.5*0.75 = 0.5 => kappa = 0.25/0.5 = 0.5
    expect(report.kappa).toBeCloseTo(0.5, 10);
    expect(report.rows.find((r) => r.id === 'row-b')).toMatchObject({
      humanVerdict: 'pass',
      judgeVerdict: 'fail',
      agrees: false,
    });
    expect(report).toMatchObject({
      modelId: 'fake-judge',
      rubricId: 'clarity',
      rubricVersion: '1',
    });
  });

  test('judge protocol failures count as disagreement, not a crash', async () => {
    const brokenJudge: LLMClient = {
      modelId: 'broken',
      complete: () => Promise.resolve('not json at all'),
    };
    const rows = parseCalibrationSet(row('row-a', 'pass'), 'binary');
    const report = await calibrateJudge({ rows, judge: brokenJudge, rubric, scale: 'binary' });
    expect(report.agreement).toBe(0);
    expect(report.rows[0].judgeVerdict).toBe('(no-verdict)');
  });
});

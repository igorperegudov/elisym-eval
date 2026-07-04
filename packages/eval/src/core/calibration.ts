import { z } from 'zod';
import { runJudge } from './judge-core.js';
import type { LLMClient } from './llm-client.js';
import { SCALE_LABELS, type JudgeScale, type Rubric } from './rubric.js';

/** One human-labeled calibration row (JSONL line). */
export const CalibrationRowSchema = z.object({
  id: z.string().min(1),
  /** What the agent was asked. */
  input: z.string(),
  /** What the agent answered - the text being judged. */
  output: z.string(),
  /** The human's verdict; must be a label of the chosen scale. */
  humanVerdict: z.string().min(1),
});
export type CalibrationRow = z.infer<typeof CalibrationRowSchema>;

export interface CalibrationRowResult {
  id: string;
  humanVerdict: string;
  judgeVerdict: string;
  agrees: boolean;
}

export interface CalibrationReport {
  modelId: string;
  rubricId: string;
  rubricVersion: string;
  scale: JudgeScale;
  n: number;
  /** Fraction of rows where the judge matched the human label. */
  agreement: number;
  /** Cohen's kappa (unweighted; multi-class for ternary). NaN-free: 1 when pe == 1. */
  kappa: number;
  rows: CalibrationRowResult[];
}

export function parseCalibrationSet(jsonl: string, scale: JudgeScale): CalibrationRow[] {
  const labels = SCALE_LABELS[scale];
  const rows: CalibrationRow[] = [];
  const lines = jsonl.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === '') {
      continue;
    }
    let parsed: CalibrationRow;
    try {
      parsed = CalibrationRowSchema.parse(JSON.parse(raw));
    } catch (err) {
      throw new Error(
        `calibration line ${i + 1} invalid: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!labels.includes(parsed.humanVerdict)) {
      throw new Error(
        `calibration line ${i + 1}: humanVerdict "${parsed.humanVerdict}" is not a ${scale} label (${labels.join(', ')})`,
      );
    }
    rows.push(parsed);
  }
  if (rows.length === 0) {
    throw new Error('calibration set is empty');
  }
  return rows;
}

/** Cohen's kappa over paired labels. */
export function cohensKappa(pairs: readonly { a: string; b: string }[]): number {
  const n = pairs.length;
  if (n === 0) {
    return 0;
  }
  const observed = pairs.filter((p) => p.a === p.b).length / n;
  const labels = new Set<string>();
  for (const pair of pairs) {
    labels.add(pair.a);
    labels.add(pair.b);
  }
  let expected = 0;
  for (const label of labels) {
    const marginalA = pairs.filter((p) => p.a === label).length / n;
    const marginalB = pairs.filter((p) => p.b === label).length / n;
    expected += marginalA * marginalB;
  }
  if (expected === 1) {
    return 1; // both raters constant and identical
  }
  return (observed - expected) / (1 - expected);
}

/**
 * Run a judge over a human-labeled calibration set and report agreement % and
 * Cohen's kappa - lets users validate their judge choice against their rubric
 * before trusting judge assertions.
 */
export async function calibrateJudge(options: {
  rows: readonly CalibrationRow[];
  judge: LLMClient;
  rubric: Rubric;
  scale: JudgeScale;
}): Promise<CalibrationReport> {
  const { rows, judge, rubric, scale } = options;
  const results: CalibrationRowResult[] = [];

  for (const row of rows) {
    const content = `TASK GIVEN TO THE AGENT:\n${row.input}\n\nAGENT ANSWER TO JUDGE:\n${row.output}`;
    let judgeVerdict: string;
    try {
      judgeVerdict = (await runJudge(judge, rubric, scale, content)).verdict;
    } catch {
      judgeVerdict = '(no-verdict)';
    }
    results.push({
      id: row.id,
      humanVerdict: row.humanVerdict,
      judgeVerdict,
      agrees: judgeVerdict === row.humanVerdict,
    });
  }

  const agreement = results.filter((r) => r.agrees).length / results.length;
  const kappa = cohensKappa(results.map((r) => ({ a: r.humanVerdict, b: r.judgeVerdict })));

  return {
    modelId: judge.modelId,
    rubricId: rubric.id,
    rubricVersion: rubric.version,
    scale,
    n: results.length,
    agreement,
    kappa,
    rows: results,
  };
}

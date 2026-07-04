import { readFile, writeFile } from 'node:fs/promises';
import {
  calibrateJudge,
  parseCalibrationSet,
  type CalibrationReport,
} from '../core/calibration.js';
import { EvalConfigError } from '../core/errors.js';
import type { JudgeScale } from '../core/rubric.js';
import { createJudgeFromFlags, loadRubricsFile, type JudgeFlags } from './judges.js';

export interface CalibrateCliOptions extends JudgeFlags {
  rubric: string;
  rubrics: string;
  scale: JudgeScale;
  reportJson?: string;
}

export function formatCalibrationReport(report: CalibrationReport): string {
  const lines = [
    `judge: ${report.modelId}, rubric: ${report.rubricId}@${report.rubricVersion}, scale: ${report.scale}`,
    `rows: ${report.n}`,
    `agreement: ${(report.agreement * 100).toFixed(1)}%`,
    `Cohen's kappa: ${report.kappa.toFixed(3)}`,
  ];
  const disagreements = report.rows.filter((r) => !r.agrees);
  if (disagreements.length > 0) {
    lines.push('disagreements:');
    for (const row of disagreements) {
      lines.push(`  ${row.id}: human=${row.humanVerdict} judge=${row.judgeVerdict}`);
    }
  }
  return lines.join('\n');
}

export async function calibrateCli(
  labeledFile: string,
  options: CalibrateCliOptions,
  log: (line: string) => void = console.log,
): Promise<void> {
  const judge = createJudgeFromFlags(options);
  if (judge === undefined) {
    throw new EvalConfigError('calibrate requires --judge and --judge-model');
  }

  const registry = await loadRubricsFile(options.rubrics);
  // --rubric accepts "id@version" or a bare id (unique match required).
  let rubric = registry[options.rubric];
  if (rubric === undefined) {
    const matches = Object.values(registry).filter((r) => r.id === options.rubric);
    if (matches.length === 1) {
      rubric = matches[0];
    } else if (matches.length > 1) {
      throw new EvalConfigError(
        `rubric id "${options.rubric}" is ambiguous; use id@version (found ${matches.map((r) => `${r.id}@${r.version}`).join(', ')})`,
      );
    }
  }
  if (rubric === undefined) {
    throw new EvalConfigError(`rubric "${options.rubric}" not found in ${options.rubrics}`);
  }

  const rows = parseCalibrationSet(await readFile(labeledFile, 'utf8'), options.scale);
  const report = await calibrateJudge({ rows, judge, rubric, scale: options.scale });

  if (options.reportJson !== undefined) {
    await writeFile(options.reportJson, JSON.stringify(report, null, 2) + '\n', 'utf8');
    log(`JSON report written to ${options.reportJson}`);
  }
  log(formatCalibrationReport(report));
}

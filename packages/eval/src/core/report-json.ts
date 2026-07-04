import { bigintReplacer } from './bigint-json.js';
import type { Metrics } from './metrics.js';
import type { CaseResult, RunMode } from './runner.js';

export interface RunReportMeta {
  mode: RunMode;
  agent: string;
  runsPerCase: number;
  /** ISO timestamp; supplied by the caller so core stays deterministic. */
  generatedAt?: string;
}

export interface RunReport {
  meta: RunReportMeta;
  metrics: Metrics;
  cases: CaseResult[];
}

/** Machine-readable report; bigints encoded as base-10 strings. */
export function buildJsonReport(report: RunReport): string {
  return JSON.stringify(report, bigintReplacer, 2) + '\n';
}

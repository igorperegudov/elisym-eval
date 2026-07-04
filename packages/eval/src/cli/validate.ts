import { readFile } from 'node:fs/promises';
import { parseDataset, type DatasetIssue } from '../core/dataset.js';

export interface ValidateFileReport {
  file: string;
  caseCount: number;
  tagCensus: Record<string, number>;
  issues: DatasetIssue[];
}

export interface ValidateResult {
  ok: boolean;
  reports: ValidateFileReport[];
}

export async function validateFiles(files: readonly string[]): Promise<ValidateResult> {
  const reports: ValidateFileReport[] = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const { cases, issues } = parseDataset(text);
    const tagCensus: Record<string, number> = {};
    for (const evalCase of cases) {
      for (const tag of evalCase.tags) {
        tagCensus[tag] = (tagCensus[tag] ?? 0) + 1;
      }
    }
    reports.push({ file, caseCount: cases.length, tagCensus, issues });
  }
  return { ok: reports.every((r) => r.issues.length === 0), reports };
}

export function formatValidateReport(result: ValidateResult): string {
  const lines: string[] = [];
  for (const report of result.reports) {
    const status = report.issues.length === 0 ? 'OK' : `${report.issues.length} issue(s)`;
    lines.push(`${report.file}: ${report.caseCount} case(s), ${status}`);
    for (const issue of report.issues) {
      const where = issue.caseId !== undefined ? ` (${issue.caseId})` : '';
      lines.push(`  line ${issue.line}${where}: ${issue.message}`);
    }
    const tags = Object.entries(report.tagCensus)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, count]) => `${tag}:${count}`)
      .join(' ');
    if (tags.length > 0) {
      lines.push(`  tags: ${tags}`);
    }
  }
  return lines.join('\n');
}

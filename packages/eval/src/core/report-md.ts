import type { RunReport } from './report-json.js';

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Escape the characters that would break a markdown table cell. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Human-readable markdown report: summary, per-tag breakdown, failures. */
export function buildMarkdownReport(report: RunReport): string {
  const { metrics, cases, meta } = report;
  const lines: string[] = [];

  lines.push('# elisym-eval report');
  lines.push('');
  lines.push(`- agent: \`${meta.agent}\``);
  lines.push(`- mode: \`${meta.mode}\``);
  lines.push(`- runs per case (k): ${meta.runsPerCase}`);
  if (meta.generatedAt !== undefined) {
    lines.push(`- generated: ${meta.generatedAt}`);
  }
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| cases | skipped | pass@1 | pass^k |');
  lines.push('| ----- | ------- | ------ | ------ |');
  lines.push(
    `| ${metrics.total} | ${metrics.skipped} | ${pct(metrics.passAt1Rate)} | ${pct(metrics.passAllKRate)} |`,
  );
  lines.push('');

  if (metrics.attack !== undefined) {
    lines.push('## Attacked variants');
    lines.push('');
    lines.push('| attacked cases | attack success rate | utility under attack |');
    lines.push('| -------------- | ------------------- | -------------------- |');
    lines.push(
      `| ${metrics.attack.attackedTotal} | ${pct(metrics.attack.attackSuccessRate)} | ${pct(metrics.attack.utilityUnderAttack)} |`,
    );
    lines.push('');
  }

  if (metrics.citations !== undefined) {
    lines.push('## Citations');
    lines.push('');
    lines.push('| cases | micro precision | micro recall |');
    lines.push('| ----- | --------------- | ------------ |');
    lines.push(
      `| ${metrics.citations.casesEvaluated} | ${pct(metrics.citations.microPrecision)} | ${pct(metrics.citations.microRecall)} |`,
    );
    lines.push('');
  }

  const tags = Object.entries(metrics.byTag);
  if (tags.length > 0) {
    lines.push('## By tag');
    lines.push('');
    lines.push('| tag | cases | pass@1 | pass^k |');
    lines.push('| --- | ----- | ------ | ------ |');
    for (const [tag, tagMetrics] of tags) {
      lines.push(
        `| ${cell(tag)} | ${tagMetrics.total} | ${pct(tagMetrics.passAt1Rate)} | ${pct(tagMetrics.passAllKRate)} |`,
      );
    }
    lines.push('');
  }

  const failures = cases.filter((c) => c.skipped === undefined && !c.passAllK);
  if (failures.length > 0) {
    lines.push('## Failures');
    lines.push('');
    lines.push('| case | run | failing assertion | explanation |');
    lines.push('| ---- | --- | ----------------- | ----------- |');
    for (const failure of failures) {
      for (const run of failure.runs) {
        if (run.pass) {
          continue;
        }
        const firstFailing = run.assertions.find((a) => !a.pass);
        const label =
          firstFailing !== undefined
            ? `#${firstFailing.index} ${firstFailing.type} (${firstFailing.role})`
            : 'run error';
        const explanation = firstFailing?.explanation ?? run.error ?? 'unknown failure';
        lines.push(
          `| ${cell(failure.caseId)} | ${run.runIndex} | ${cell(label)} | ${cell(explanation)} |`,
        );
      }
    }
    lines.push('');
  }

  const skippedCases = cases.filter((c) => c.skipped !== undefined);
  if (skippedCases.length > 0) {
    lines.push('## Skipped');
    lines.push('');
    for (const skipped of skippedCases) {
      lines.push(`- \`${skipped.caseId}\`: ${skipped.skipped}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentUnderTest } from '../core/agent.js';
import { parseDatasetStrict } from '../core/dataset.js';
import { EvalConfigError } from '../core/errors.js';
import { computeMetrics } from '../core/metrics.js';
import { buildJsonReport, type RunReport } from '../core/report-json.js';
import { buildMarkdownReport } from '../core/report-md.js';
import {
  runCase,
  type CaseResult,
  type EnvironmentBindings,
  type RunMode,
  type RunnerConfig,
} from '../core/runner.js';

export interface RunCliOptions {
  /** Module path to load, or an AgentUnderTest instance for programmatic use. */
  agent: string | AgentUnderTest;
  mode: RunMode;
  runs: number;
  concurrency: number;
  filter?: string;
  reportJson?: string;
  reportMd?: string;
  failFast: boolean;
}

function isAgentUnderTest(value: unknown): value is AgentUnderTest {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AgentUnderTest).createSession === 'function'
  );
}

/** Load an agent module: default export is an AgentUnderTest or a factory for one. */
export async function loadAgentModule(specifier: string): Promise<AgentUnderTest> {
  const url = pathToFileURL(resolve(specifier)).href;
  const module = (await import(url)) as { default?: unknown };
  let candidate = module.default;
  if (typeof candidate === 'function') {
    candidate = await (candidate as () => unknown)();
  }
  if (!isAgentUnderTest(candidate)) {
    throw new EvalConfigError(
      `module ${specifier} must default-export an AgentUnderTest or a factory returning one`,
    );
  }
  return candidate;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export async function runCli(
  files: readonly string[],
  options: RunCliOptions,
  bindings: EnvironmentBindings = {},
  log: (line: string) => void = console.log,
): Promise<number> {
  const agent =
    typeof options.agent === 'string' ? await loadAgentModule(options.agent) : options.agent;

  let cases = [];
  for (const file of files) {
    cases.push(...parseDatasetStrict(await readFile(file, 'utf8')));
  }
  if (options.filter !== undefined) {
    const regex = globToRegex(options.filter);
    cases = cases.filter((c) => regex.test(c.id) || c.tags.some((t) => regex.test(t)));
    if (cases.length === 0) {
      throw new EvalConfigError(`filter "${options.filter}" matched no cases`);
    }
  }

  const config: RunnerConfig = {
    agent,
    mode: options.mode,
    runsPerCase: options.runs,
    concurrency: options.concurrency,
  };

  // Sequential when fail-fast so we can stop at the first failure.
  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    const result = await runCase(evalCase, config, bindings);
    results.push(result);
    if (options.failFast && result.skipped === undefined && !result.passAllK) {
      log(`fail-fast: stopping after ${result.caseId}`);
      break;
    }
  }

  const metrics = computeMetrics(results);
  const report: RunReport = {
    meta: {
      mode: options.mode,
      agent: agent.label ?? (typeof options.agent === 'string' ? options.agent : 'anonymous-agent'),
      runsPerCase: options.runs,
      generatedAt: new Date().toISOString(),
    },
    metrics,
    cases: results,
  };

  if (options.reportJson !== undefined) {
    await writeFile(options.reportJson, buildJsonReport(report), 'utf8');
    log(`JSON report written to ${options.reportJson}`);
  }
  if (options.reportMd !== undefined) {
    await writeFile(options.reportMd, buildMarkdownReport(report), 'utf8');
    log(`markdown report written to ${options.reportMd}`);
  }

  const failed = results.filter((r) => r.skipped === undefined && !r.passAllK);
  log(
    `cases: ${metrics.total}, skipped: ${metrics.skipped}, ` +
      `pass@1: ${(metrics.passAt1Rate * 100).toFixed(1)}%, pass^k: ${(metrics.passAllKRate * 100).toFixed(1)}%`,
  );
  for (const failure of failed) {
    const firstFailing = failure.runs.flatMap((r) => r.assertions).find((a) => !a.pass);
    log(
      `FAIL ${failure.caseId}: ${firstFailing?.explanation ?? failure.runs[0]?.error ?? 'unknown'}`,
    );
  }
  return failed.length > 0 ? 1 : 0;
}

import type { AgentUnderTest } from './agent.js';
import {
  evaluateAssertions,
  type AssertionContext,
  type EvaluatedAssertion,
  type PaymentSnapshot,
} from './assertions/index.js';
import type { Assertion, Environment, EvalCase } from './case-schema.js';
import { EvalConfigError, NotImplementedError } from './errors.js';
import type { LLMClient } from './llm-client.js';
import { runScriptedScenario } from './scenario-scripted.js';
import { composeExecutors, createMockToolExecutor, type ToolExecutor } from './tools.js';
import { TraceRecorder, type TraceEvent } from './trace.js';

export type RunMode = 'mocked' | 'recorded' | 'live';

export interface RunnerConfig {
  agent: AgentUnderTest;
  /** Must match each case's environment.mode; mismatched cases are skipped. Default mocked. */
  mode?: RunMode;
  /** Per-run default judge (judge assertions). */
  judge?: LLMClient;
  /** Named judges for per-case judgeRef overrides. */
  judges?: Record<string, LLMClient>;
  /** k for pass^k: run each case k times, pass only if all runs pass. Default 1. */
  runsPerCase?: number;
  /** Cases evaluated concurrently in runDataset. Default 4. */
  concurrency?: number;
  /** Injected clock for trace timestamps; default is a logical counter. */
  clock?: () => number;
  /** Prepended to the protocol prompt of the agent under test. */
  systemPrompt?: string;
}

export interface CaseRunResult {
  caseId: string;
  runIndex: number;
  pass: boolean;
  assertions: EvaluatedAssertion[];
  trace: TraceEvent[];
  /** Infrastructure/agent error that ended the run early, if any. */
  error?: string;
}

export interface CaseResult {
  caseId: string;
  tags: string[];
  runs: CaseRunResult[];
  passAt1: boolean;
  passAllK: boolean;
  /** Set when the case was not executed (e.g. mode mismatch); excluded from metrics. */
  skipped?: string;
}

function defaultClock(): () => number {
  let tick = 0;
  return () => tick++;
}

/**
 * Environment hook the payments module (or a chain adapter package) plugs in:
 * given the case environment and the trace, produce the payment tool executor
 * and a final-state snapshot consumed by payment assertions. Core defines only
 * the seam so text-eval users never load payment code.
 */
export interface EnvironmentBindings {
  paymentTools?: (
    env: Environment,
    trace: TraceRecorder,
  ) => Promise<PaymentBinding> | PaymentBinding;
}

export interface PaymentBinding {
  executor: ToolExecutor;
  /** Called after the scenario to snapshot final state for assertions. */
  snapshot(): Promise<PaymentSnapshot> | PaymentSnapshot;
  close?(): Promise<void>;
}

export type { PaymentSnapshot } from './assertions/index.js';

async function runOnce(
  evalCase: EvalCase,
  config: RunnerConfig,
  bindings: EnvironmentBindings,
  runIndex: number,
): Promise<CaseRunResult> {
  if (evalCase.scenario.type === 'simulated') {
    throw new NotImplementedError('simulated scenarios');
  }

  const trace = new TraceRecorder(config.clock ?? defaultClock());
  const executors: ToolExecutor[] = [];
  let paymentBinding: PaymentBinding | undefined;

  const mockTools = evalCase.environment.tools.filter((t) => t.kind === 'mock');
  if (mockTools.length > 0) {
    executors.push(createMockToolExecutor(mockTools));
  }
  const paymentTools = evalCase.environment.tools.find((t) => t.kind === 'payment');
  if (paymentTools !== undefined) {
    if (bindings.paymentTools === undefined) {
      throw new EvalConfigError(
        `case ${evalCase.id} declares payment tools; provide an adapter factory ` +
          '(e.g. createMockAdapterFactory() from "@elisym/eval/payments")',
      );
    }
    paymentBinding = await bindings.paymentTools(evalCase.environment, trace);
    executors.push(paymentBinding.executor);
  }
  const tools = composeExecutors(executors);

  let runError: string | undefined;
  try {
    const session = await config.agent.createSession({
      ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
      tools: tools.specs,
    });
    try {
      await runScriptedScenario(evalCase.scenario, { session, tools, trace });
    } finally {
      await session.close?.();
    }
  } catch (err) {
    runError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    trace.record({ type: 'run.error', message: runError });
  }

  const ctx: AssertionContext = { trace: trace.events };
  if (paymentBinding !== undefined) {
    ctx.payment = await paymentBinding.snapshot();
    await paymentBinding.close?.();
  }
  const judgeContext = buildJudgeContext(evalCase, config);
  if (judgeContext !== undefined) {
    ctx.judge = judgeContext;
  }

  const assertions = await evaluateAssertions(evalCase.assertions, ctx);
  return {
    caseId: evalCase.id,
    runIndex,
    pass: assertions.every((a) => a.pass),
    assertions,
    trace: [...trace.events],
    ...(runError !== undefined ? { error: runError } : {}),
  };
}

function buildJudgeContext(evalCase: EvalCase, config: RunnerConfig): AssertionContext['judge'] {
  if (!evalCase.assertions.some((a: Assertion) => a.type === 'judge')) {
    return undefined;
  }
  return {
    defaultClient: config.judge,
    namedClients: config.judges ?? {},
    caseConfig: evalCase.judge,
  };
}

export async function runCase(
  evalCase: EvalCase,
  config: RunnerConfig,
  bindings: EnvironmentBindings = {},
): Promise<CaseResult> {
  const mode = config.mode ?? 'mocked';
  if (evalCase.environment.mode !== mode) {
    return {
      caseId: evalCase.id,
      tags: evalCase.tags,
      runs: [],
      passAt1: false,
      passAllK: false,
      skipped: `case requires mode "${evalCase.environment.mode}" but the runner is in "${mode}"`,
    };
  }

  const k = config.runsPerCase ?? 1;
  const runs: CaseRunResult[] = [];
  for (let i = 0; i < k; i++) {
    runs.push(await runOnce(evalCase, config, bindings, i));
  }
  return {
    caseId: evalCase.id,
    tags: evalCase.tags,
    runs,
    passAt1: runs[0]?.pass ?? false,
    passAllK: runs.length > 0 && runs.every((r) => r.pass),
  };
}

export async function runDataset(
  cases: readonly EvalCase[],
  config: RunnerConfig,
  bindings: EnvironmentBindings = {},
): Promise<CaseResult[]> {
  const concurrency = Math.max(1, config.concurrency ?? 4);
  const results: CaseResult[] = new Array<CaseResult>(cases.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < cases.length) {
      const index = nextIndex++;
      results[index] = await runCase(cases[index], config, bindings);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, () => worker()));
  return results;
}

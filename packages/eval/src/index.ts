export { bigintReplacer, stringifyJsonLine, zAmount } from './core/bigint-json.js';
export {
  CANONICAL_ERROR_CODES,
  CanonicalErrorCodeSchema,
  canonicalCodeOf,
  type CanonicalErrorCode,
} from './core/canonical-codes.js';
export {
  AssertionSchema,
  AssetRefSchema,
  CaseJudgeConfigSchema,
  CaseMetadataSchema,
  CaseSchema,
  EnvironmentSchema,
  EventRefSchema,
  FailureInjectionSchema,
  MockToolSchema,
  PAYMENT_TOOL_NAMES,
  ParamMatcherSchema,
  PaymentCheckSchema,
  PaymentToolsSchema,
  ScenarioSchema,
  ScriptedStepSchema,
  TraceCheckSchema,
  type Assertion,
  type AssetRef,
  type CaseJudgeConfig,
  type CaseMetadata,
  type Environment,
  type EvalCase,
  type EvalCaseInput,
  type EventRef,
  type FailureInjection,
  type MockTool,
  type ParamMatcher,
  type PaymentCheck,
  type PaymentTools,
  type Scenario,
  type ScriptedStep,
  type TraceCheck,
} from './core/case-schema.js';
export {
  normalizeCases,
  parseDataset,
  parseDatasetStrict,
  serializeDataset,
  type DatasetIssue,
  type ParseDatasetResult,
} from './core/dataset.js';
export { EvalConfigError, NotImplementedError } from './core/errors.js';
export {
  calibrateJudge,
  CalibrationRowSchema,
  cohensKappa,
  parseCalibrationSet,
  type CalibrationReport,
  type CalibrationRow,
  type CalibrationRowResult,
} from './core/calibration.js';
export { runJudge, type JudgeVerdict } from './core/judge-core.js';
export {
  findRubric,
  rubricKey,
  SCALE_LABELS,
  type JudgeScale,
  type Rubric,
} from './core/rubric.js';
export type {
  AgentSession,
  AgentSessionInit,
  AgentTurn,
  AgentUnderTest,
  ToolCall,
  ToolResultInput,
  ToolSpec,
} from './core/agent.js';
export type { ChatMessage, CompleteOptions, LLMClient } from './core/llm-client.js';
export {
  createReferenceAgent,
  extractFirstJsonObject,
  ReferenceAgentProtocolError,
  type ReferenceAgentOptions,
} from './core/reference-agent.js';
export {
  assistantMessages,
  finalOutput,
  paymentExecutions,
  paymentQuotes,
  toolCalls,
  TraceRecorder,
  type RetrievedDoc,
  type TraceAttributes,
  type TraceEvent,
  type TraceEventPayload,
} from './core/trace.js';
export {
  evaluateAssertion,
  evaluateAssertions,
  type AssertionContext,
  type AssertionOutcome,
  type EvaluatedAssertion,
  type JudgeContext,
  type PaymentSnapshot,
} from './core/assertions/index.js';
export {
  evalMatcher,
  evalMatchers,
  getPath,
  type MatcherOutcome,
} from './core/assertions/matchers.js';
export {
  ATTACKED_TAG,
  computeMetrics,
  type AttackMetrics,
  type CitationMetrics,
  type Metrics,
  type TagMetrics,
} from './core/metrics.js';
export { buildJsonReport, type RunReport, type RunReportMeta } from './core/report-json.js';
export { buildMarkdownReport } from './core/report-md.js';
export {
  runCase,
  runDataset,
  type CaseResult,
  type CaseRunResult,
  type EnvironmentBindings,
  type PaymentBinding,
  type RunMode,
  type RunnerConfig,
} from './core/runner.js';
export { runScriptedScenario, type ScriptedScenarioDeps } from './core/scenario-scripted.js';
export { runSimulatedScenario } from './core/scenario-simulated.js';
export {
  composeExecutors,
  createMockToolExecutor,
  matchesWhen,
  type ExecutedToolResult,
  type ToolExecutor,
} from './core/tools.js';

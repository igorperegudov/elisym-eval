import { z } from 'zod';
import { zAmount } from './bigint-json.js';
import { CanonicalErrorCodeSchema } from './canonical-codes.js';
import { MAX_PATTERN_LENGTH } from './safe-regex.js';

/**
 * A regex pattern authored in a case. Length-capped at parse time; the runtime
 * (safe-regex) additionally rejects nested-quantifier ReDoS shapes.
 */
const RegexPatternSchema = z.string().min(1).max(MAX_PATTERN_LENGTH);
/** Regex flags restricted to the standard set (rejects malformed-flags crashes). */
const RegexFlagsSchema = z.string().regex(/^[dgimsuy]*$/, 'invalid regex flags');

/** Longest a mock ledger delay injection may stall a run (30s). */
const MAX_INJECTED_DELAY_MS = 30_000;

// --- Environment -------------------------------------------------------------

/**
 * Chain-neutral asset reference. `assetId` is the key used everywhere else in
 * the case (wallets, spendLimits, assertions); `chainId` is a CAIP-2 string.
 */
export const AssetRefSchema = z.object({
  assetId: z.string().min(1),
  chainId: z.string().min(1),
  decimals: z.number().int().min(0).max(38),
  symbol: z.string().min(1),
});
export type AssetRef = z.infer<typeof AssetRefSchema>;

export const FailureInjectionSchema = z
  .discriminatedUnion('behavior', [
    z.object({
      behavior: z.literal('error'),
      on: z.enum(['getQuote', 'executePayment']),
      /** 1-based per-operation call counter. */
      nth: z.number().int().positive(),
      error: CanonicalErrorCodeSchema,
      /**
       * The operation reports failure but the transfer lands anyway - models
       * "timeout thrown, transaction actually settled". Restricted (below) to
       * executePayment + `payment_timeout`: settling under a code that the
       * spend tracker releases on (insufficient_funds, quote_expired, ...)
       * would silently under-count real spend.
       */
      settleAnyway: z.boolean().default(false),
    }),
    z.object({
      behavior: z.literal('delay'),
      on: z.enum(['getQuote', 'executePayment', 'getPaymentStatus']),
      nth: z.number().int().positive(),
      delayMs: z.number().int().positive().max(MAX_INJECTED_DELAY_MS),
    }),
    z.object({
      behavior: z.literal('mutateQuote'),
      nth: z.number().int().positive(),
      setValue: zAmount.optional(),
      setPayee: z.string().optional(),
    }),
  ])
  .refine(
    (f) =>
      f.behavior !== 'error' ||
      !f.settleAnyway ||
      (f.on === 'executePayment' && f.error === 'payment_timeout'),
    { message: 'settleAnyway is only valid for executePayment with error "payment_timeout"' },
  );
export type FailureInjection = z.infer<typeof FailureInjectionSchema>;

const MockToolResponseSchema = z.object({
  /** Shallow deep-equal match on tool args; omit to always match. */
  when: z.record(z.unknown()).optional(),
  /** Returned verbatim to the agent - the red-team injection point. */
  result: z.unknown(),
  isError: z.boolean().default(false),
});

export const MockToolSchema = z.object({
  kind: z.literal('mock'),
  name: z.string().min(1),
  description: z.string(),
  /** JSON Schema advertised to the agent. */
  parameters: z.record(z.unknown()).optional(),
  /** When true, every result additionally emits a retrieval.result trace event. */
  retrieval: z.boolean().default(false),
  responses: z.array(MockToolResponseSchema).min(1),
});
export type MockTool = z.infer<typeof MockToolSchema>;

export const PAYMENT_TOOL_NAMES = [
  'get_quote',
  'pay_invoice',
  'get_payment_status',
  'get_balance',
] as const;

export const PaymentToolsSchema = z.object({
  kind: z.literal('payment'),
  /** Wallet id (from environment.wallets) the agent pays from. */
  payerWallet: z.string().min(1),
  expose: z
    .array(z.enum(PAYMENT_TOOL_NAMES))
    .min(1)
    .default([...PAYMENT_TOOL_NAMES]),
});
export type PaymentTools = z.infer<typeof PaymentToolsSchema>;

export const EnvironmentSchema = z.object({
  mode: z.enum(['mocked', 'recorded', 'live']).default('mocked'),
  assets: z.array(AssetRefSchema).min(1),
  /** walletId -> assetId -> balance in raw subunits. */
  wallets: z.record(z.record(zAmount)),
  /** assetId -> session spend cap in raw subunits; absent = uncapped. */
  spendLimits: z.record(zAmount).default({}),
  failureInjections: z.array(FailureInjectionSchema).default([]),
  tools: z.array(z.discriminatedUnion('kind', [MockToolSchema, PaymentToolsSchema])).default([]),
  /** Recording id for recorded mode. */
  recordingRef: z.string().optional(),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

// --- Scenario ----------------------------------------------------------------

export const ScriptedStepSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message'),
    content: z.string().min(1),
  }),
  z.object({
    type: z.literal('branch'),
    /** Regex tested against the agent's last message. */
    pattern: RegexPatternSchema,
    flags: RegexFlagsSchema.optional(),
    /** Reply sent when the pattern matches. */
    then: z.string().min(1),
    /** Reply when it does not match; omitted = conversation ends. */
    else: z.string().optional(),
  }),
]);
export type ScriptedStep = z.infer<typeof ScriptedStepSchema>;

export const ScenarioSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('scripted'),
    steps: z.array(ScriptedStepSchema).min(1),
    maxToolRoundsPerStep: z.number().int().positive().default(16),
  }),
  // Declared for forward compatibility; the runner throws NotImplementedError.
  z.object({
    type: z.literal('simulated'),
    persona: z.string(),
    goal: z.string(),
    maxTurns: z.number().int().positive(),
  }),
]);
export type Scenario = z.infer<typeof ScenarioSchema>;

// --- Assertions --------------------------------------------------------------

export const ParamMatcherSchema = z.object({
  /** Dot path into the tool call args, e.g. "invoice.amount". */
  path: z.string().min(1),
  op: z.enum([
    'eq',
    'neq',
    'lt',
    'lte',
    'gt',
    'gte',
    'regex',
    'includes',
    'defined',
    'absent',
    'amountEq',
    'amountLte',
  ]),
  value: z.unknown().optional(),
});
export type ParamMatcher = z.infer<typeof ParamMatcherSchema>;

export const EventRefSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('tool.call'),
    tool: z.string().min(1),
    where: z.array(ParamMatcherSchema).optional(),
  }),
  z.object({ event: z.literal('user.message'), matching: RegexPatternSchema }),
  z.object({ event: z.literal('assistant.message'), matching: RegexPatternSchema }),
]);
export type EventRef = z.infer<typeof EventRefSchema>;

const assertionBase = {
  id: z.string().optional(),
  /**
   * Metric role: `task` assertions measure whether the agent did its job,
   * `security` assertions measure whether an attack succeeded. Attack success
   * rate = any security assertion failed; utility under attack = all task
   * assertions passed.
   */
  role: z.enum(['task', 'security']).default('task'),
};

export const TraceCheckSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('toolCalled'),
    tool: z.string().min(1),
    min: z.number().int().min(1).default(1),
    max: z.number().int().min(0).optional(),
    where: z.array(ParamMatcherSchema).optional(),
  }),
  z.object({
    kind: z.literal('toolNotCalled'),
    tool: z.string().min(1),
    where: z.array(ParamMatcherSchema).optional(),
  }),
  z.object({
    kind: z.literal('order'),
    first: EventRefSchema,
    then: EventRefSchema,
  }),
  z.object({
    kind: z.literal('params'),
    tool: z.string().min(1),
    /** 0-based index among that tool's calls. */
    callIndex: z.number().int().min(0).default(0),
    equals: z.unknown().optional(),
    matchers: z.array(ParamMatcherSchema).optional(),
  }),
]);
export type TraceCheck = z.infer<typeof TraceCheckSchema>;

export const PaymentCheckSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('transfers'),
    mode: z.enum(['exact', 'subset']).default('exact'),
    expected: z.array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        assetId: z.string().min(1),
        value: zAmount,
        invoiceId: z.string().optional(),
      }),
    ),
  }),
  z.object({ kind: z.literal('noTransfers') }),
  z.object({ kind: z.literal('paidEqualsQuoted') }),
  z.object({ kind: z.literal('totalSpendWithinLimit'), assetId: z.string().optional() }),
  z.object({ kind: z.literal('noDuplicatePayment') }),
  z.object({ kind: z.literal('abortedCleanly'), afterError: CanonicalErrorCodeSchema }),
  z.object({ kind: z.literal('idempotentRetries') }),
]);
export type PaymentCheck = z.infer<typeof PaymentCheckSchema>;

const PatternSchema = z.object({
  pattern: RegexPatternSchema,
  flags: RegexFlagsSchema.optional(),
});

export const AssertionSchema = z.discriminatedUnion('type', [
  z.object({ ...assertionBase, type: z.literal('trace'), check: TraceCheckSchema }),
  z.object({ ...assertionBase, type: z.literal('payment'), check: PaymentCheckSchema }),
  z.object({
    ...assertionBase,
    type: z.literal('structuredReferences'),
    /** Regex with capture group 1 = the extracted identifier. */
    extract: PatternSchema,
    /** Groups of acceptable alternatives; each group must be cited. */
    mustCite: z.array(z.array(z.string().min(1)).min(1)).min(1),
    acceptableAdditional: z.array(z.string()).default([]),
    thresholds: z.object({
      precision: z.number().min(0).max(1),
      recall: z.number().min(0).max(1),
    }),
  }),
  z.object({
    ...assertionBase,
    type: z.literal('retrieval'),
    topK: z.number().int().positive(),
    goldSpans: z
      .array(
        z.object({
          docId: z.string().min(1),
          /** Optional regex the doc text must match; omit = docId presence is enough. */
          pattern: RegexPatternSchema.optional(),
        }),
      )
      .min(1),
    minRecall: z.number().min(0).max(1),
  }),
  z.object({
    ...assertionBase,
    type: z.literal('output'),
    requiredPatterns: z.array(PatternSchema).default([]),
    forbiddenPatterns: z.array(PatternSchema).default([]),
    structure: z
      .object({
        mustParseAs: z.enum(['json']).optional(),
        minLength: z.number().int().min(0).optional(),
        maxLength: z.number().int().min(0).optional(),
      })
      .optional(),
  }),
  z.object({
    ...assertionBase,
    type: z.literal('judge'),
    /** Falls back to the case-level judge block when omitted. */
    rubricId: z.string().optional(),
    rubricVersion: z.string().optional(),
    scale: z.enum(['binary', 'ternary']),
    /** Verdict labels that count as a pass, e.g. ["pass"] or ["good","acceptable"]. */
    passOn: z.array(z.string().min(1)).min(1),
    /** Named judge from RunnerConfig.judges; falls back to case judge block, then run default. */
    judgeRef: z.string().optional(),
  }),
]);
export type Assertion = z.infer<typeof AssertionSchema>;

// --- Case --------------------------------------------------------------------

export const CaseJudgeConfigSchema = z.object({
  rubricId: z.string().min(1),
  rubricVersion: z.string().min(1),
  judgeRef: z.string().optional(),
});
export type CaseJudgeConfig = z.infer<typeof CaseJudgeConfigSchema>;

export const CaseMetadataSchema = z.object({
  author: z.string().min(1),
  source: z.string().min(1),
  /** ISO 8601 date, e.g. "2026-07-04". */
  createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'expected an ISO 8601 date'),
  corpusVersion: z.string().optional(),
});
export type CaseMetadata = z.infer<typeof CaseMetadataSchema>;

export const CaseSchema = z.object({
  /** Kebab-case; attacked variants use `<base-id>--<modifier-id>`. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'expected a kebab-case id'),
  version: z.number().int().positive(),
  tags: z.array(z.string().min(1)),
  description: z.string().min(1),
  environment: EnvironmentSchema,
  scenario: ScenarioSchema,
  assertions: z.array(AssertionSchema).min(1),
  judge: CaseJudgeConfigSchema.optional(),
  metadata: CaseMetadataSchema,
});

/** Parsed case - amounts are native bigint. */
export type EvalCase = z.infer<typeof CaseSchema>;
/** Authoring input - amounts may be bigint or digit strings. */
export type EvalCaseInput = z.input<typeof CaseSchema>;

import type { Assertion, CaseJudgeConfig } from '../case-schema.js';
import type { LLMClient } from '../llm-client.js';
import type { Rubric } from '../rubric.js';
import type { TraceEvent } from '../trace.js';
import { evaluateJudge } from './judge.js';
import { evaluateOutput } from './output.js';
import { evaluatePaymentCheck } from './payment.js';
import { evaluateRetrieval } from './retrieval.js';
import { evaluateStructuredReferences } from './structured-references.js';
import { evaluateTraceCheck, type AssertionOutcome } from './trace.js';

export type { AssertionOutcome } from './trace.js';

/**
 * Final payment state snapshot consumed by payment assertions. Structural
 * mirror of the payments module's LedgerState + session limits, defined here
 * type-only so core never loads payment runtime code.
 */
export interface PaymentSnapshot {
  transfers: {
    transferId: string;
    from: string;
    to: string;
    assetId: string;
    value: bigint;
    quoteId?: string;
    invoiceId?: string;
    txRef?: string;
  }[];
  balances: Record<string, Record<string, bigint>>;
  spendLimits: Record<string, bigint>;
}

export interface JudgeContext {
  defaultClient?: LLMClient;
  namedClients: Record<string, LLMClient>;
  /** Keyed by rubricKey(id, version). */
  rubrics?: Record<string, Rubric>;
  caseConfig?: CaseJudgeConfig;
}

/** Everything an assertion may inspect. */
export interface AssertionContext {
  trace: readonly TraceEvent[];
  payment?: PaymentSnapshot;
  judge?: JudgeContext;
}

export interface EvaluatedAssertion extends AssertionOutcome {
  index: number;
  type: Assertion['type'];
  role: 'task' | 'security';
  id?: string;
}

export async function evaluateAssertion(
  assertion: Assertion,
  ctx: AssertionContext,
): Promise<AssertionOutcome> {
  switch (assertion.type) {
    case 'trace':
      return evaluateTraceCheck(assertion.check, ctx.trace);
    case 'output':
      return evaluateOutput(assertion, ctx.trace);
    case 'payment':
      return evaluatePaymentCheck(assertion.check, ctx.trace, ctx.payment);
    case 'structuredReferences':
      return evaluateStructuredReferences(assertion, ctx.trace);
    case 'retrieval':
      return evaluateRetrieval(assertion, ctx.trace);
    case 'judge':
      return evaluateJudge(assertion, ctx.trace, ctx.judge);
  }
}

export async function evaluateAssertions(
  assertions: readonly Assertion[],
  ctx: AssertionContext,
): Promise<EvaluatedAssertion[]> {
  const results: EvaluatedAssertion[] = [];
  for (let i = 0; i < assertions.length; i++) {
    const assertion = assertions[i];
    const outcome = await evaluateAssertion(assertion, ctx);
    results.push({
      ...outcome,
      index: i,
      type: assertion.type,
      role: assertion.role,
      ...(assertion.id !== undefined ? { id: assertion.id } : {}),
    });
  }
  return results;
}

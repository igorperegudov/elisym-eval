import type { Assertion } from '../case-schema.js';
import { EvalConfigError } from '../errors.js';
import type { TraceEvent } from '../trace.js';
import { evaluateOutput } from './output.js';
import { evaluateTraceCheck, type AssertionOutcome } from './trace.js';

export type { AssertionOutcome } from './trace.js';

/** Everything an assertion may inspect. Populated further by later modules. */
export interface AssertionContext {
  trace: readonly TraceEvent[];
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
    case 'structuredReferences':
    case 'retrieval':
    case 'judge':
      throw new EvalConfigError(
        `assertion type "${assertion.type}" is not wired into the runner yet`,
      );
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

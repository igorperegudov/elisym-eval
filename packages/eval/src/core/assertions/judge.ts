import type { Assertion } from '../case-schema.js';
import { runJudge } from '../judge-core.js';
import { findRubric } from '../rubric.js';
import type { TraceEvent } from '../trace.js';
import type { AssertionOutcome } from './trace.js';
import type { JudgeContext } from './index.js';

type JudgeAssertion = Extract<Assertion, { type: 'judge' }>;

function transcript(trace: readonly TraceEvent[]): string {
  const lines: string[] = [];
  for (const event of trace) {
    if (event.type === 'user.message') {
      lines.push(`USER: ${event.content}`);
    } else if (event.type === 'assistant.message') {
      lines.push(`AGENT: ${event.content}`);
    }
  }
  return lines.join('\n\n');
}

/**
 * Quality/completeness judgment via the Judge role over any LLMClient.
 * Resolution order for the judge client: per-assertion judgeRef -> case-level
 * judgeRef -> the run's default judge. Rubric id/version fall back from the
 * assertion to the case-level judge block.
 */
export async function evaluateJudge(
  assertion: JudgeAssertion,
  trace: readonly TraceEvent[],
  ctx: JudgeContext | undefined,
): Promise<AssertionOutcome> {
  if (ctx === undefined) {
    return { pass: false, explanation: 'judge assertion requires a judge in the runner config' };
  }

  const rubricId = assertion.rubricId ?? ctx.caseConfig?.rubricId;
  const rubricVersion = assertion.rubricVersion ?? ctx.caseConfig?.rubricVersion;
  if (rubricId === undefined || rubricVersion === undefined) {
    return {
      pass: false,
      explanation:
        'judge assertion needs rubricId + rubricVersion (on the assertion or the case judge block)',
    };
  }
  const rubric = findRubric(ctx.rubrics, rubricId, rubricVersion);
  if (rubric === undefined) {
    return {
      pass: false,
      explanation: `rubric ${rubricId}@${rubricVersion} is not registered in the runner config`,
    };
  }

  const judgeRef = assertion.judgeRef ?? ctx.caseConfig?.judgeRef;
  const client = judgeRef !== undefined ? ctx.namedClients[judgeRef] : ctx.defaultClient;
  if (client === undefined) {
    return {
      pass: false,
      explanation:
        judgeRef !== undefined
          ? `judge "${judgeRef}" is not registered in the runner config`
          : 'no default judge is configured for this run',
    };
  }

  try {
    const verdict = await runJudge(client, rubric, assertion.scale, transcript(trace));
    const pass = assertion.passOn.includes(verdict.verdict);
    return {
      pass,
      explanation: pass
        ? `judge ${verdict.modelId} ruled "${verdict.verdict}" (rubric ${rubricId}@${rubricVersion}): ${verdict.rationale}`
        : `judge ${verdict.modelId} ruled "${verdict.verdict}", expected one of [${assertion.passOn.join(', ')}] (rubric ${rubricId}@${rubricVersion}): ${verdict.rationale}`,
      details: verdict,
    };
  } catch (err) {
    return {
      pass: false,
      explanation: `judge failed to produce a verdict: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

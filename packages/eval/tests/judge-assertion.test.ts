import { describe, expect, test } from 'vitest';
import type { JudgeContext } from '../src/core/assertions/index.js';
import { evaluateJudge } from '../src/core/assertions/judge.js';
import { AssertionSchema, CaseSchema, type Assertion } from '../src/core/case-schema.js';
import type { LLMClient } from '../src/core/llm-client.js';
import { rubricKey, type Rubric } from '../src/core/rubric.js';
import { runCase } from '../src/core/runner.js';
import { TraceRecorder } from '../src/core/trace.js';
import { makeCaseInput, scriptedAgent, solAsset } from './fixtures.js';

const rubric: Rubric = {
  id: 'clarity',
  version: '1',
  criteria: 'The answer must clearly state whether the payment succeeded.',
};

function judgeClient(replies: string[]): LLMClient & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    modelId: 'fake-judge',
    prompts,
    complete(messages) {
      prompts.push(messages.map((m) => `${m.role}: ${m.content}`).join('\n---\n'));
      const reply = replies.shift();
      if (reply === undefined) {
        throw new Error('judge ran out of replies');
      }
      return Promise.resolve(reply);
    },
  };
}

function judgeAssertion(input: Record<string, unknown> = {}) {
  return AssertionSchema.parse({
    type: 'judge',
    rubricId: 'clarity',
    rubricVersion: '1',
    scale: 'binary',
    passOn: ['pass'],
    ...input,
  }) as Extract<Assertion, { type: 'judge' }>;
}

function ctx(overrides: Partial<JudgeContext> = {}): JudgeContext {
  return {
    defaultClient: judgeClient(['{"verdict":"pass","rationale":"clear"}']),
    namedClients: {},
    rubrics: { [rubricKey('clarity', '1')]: rubric },
    ...overrides,
  };
}

function sampleTrace() {
  const trace = new TraceRecorder();
  trace.record({ type: 'user.message', content: 'Pay the invoice.' });
  trace.record({ type: 'assistant.message', content: 'Payment settled, tx-1.' });
  return trace.events;
}

describe('evaluateJudge', () => {
  test('passing verdict carries model id, rubric id and version in details', async () => {
    const outcome = await evaluateJudge(judgeAssertion(), sampleTrace(), ctx());
    expect(outcome.pass).toBe(true);
    expect(outcome.details).toMatchObject({
      modelId: 'fake-judge',
      rubricId: 'clarity',
      rubricVersion: '1',
      verdict: 'pass',
    });
  });

  test('verdict outside passOn fails with the rationale', async () => {
    const client = judgeClient(['{"verdict":"fail","rationale":"vague answer"}']);
    const outcome = await evaluateJudge(
      judgeAssertion(),
      sampleTrace(),
      ctx({ defaultClient: client }),
    );
    expect(outcome.pass).toBe(false);
    expect(outcome.explanation).toContain('vague answer');
    expect(outcome.explanation).toContain('expected one of [pass]');
  });

  test('judge sees the conversation transcript', async () => {
    const client = judgeClient(['{"verdict":"pass"}']);
    await evaluateJudge(judgeAssertion(), sampleTrace(), ctx({ defaultClient: client }));
    expect(client.prompts[0]).toContain('USER: Pay the invoice.');
    expect(client.prompts[0]).toContain('AGENT: Payment settled, tx-1.');
    expect(client.prompts[0]).toContain(rubric.criteria);
  });

  test('invalid verdict label triggers one corrective retry', async () => {
    const client = judgeClient(['{"verdict":"maybe"}', '{"verdict":"pass"}']);
    const outcome = await evaluateJudge(
      judgeAssertion(),
      sampleTrace(),
      ctx({ defaultClient: client }),
    );
    expect(outcome.pass).toBe(true);
    expect(client.prompts).toHaveLength(2);
  });

  test('rubric fallback to the case-level judge block', async () => {
    const outcome = await evaluateJudge(
      judgeAssertion({ rubricId: undefined, rubricVersion: undefined }),
      sampleTrace(),
      ctx({ caseConfig: { rubricId: 'clarity', rubricVersion: '1' } }),
    );
    expect(outcome.pass).toBe(true);
  });

  test('missing judge / rubric produce explanatory failures, not crashes', async () => {
    const noJudge = await evaluateJudge(
      judgeAssertion(),
      sampleTrace(),
      ctx({ defaultClient: undefined }),
    );
    expect(noJudge.pass).toBe(false);
    expect(noJudge.explanation).toContain('no default judge');

    const namedMissing = await evaluateJudge(
      judgeAssertion({ judgeRef: 'gpt' }),
      sampleTrace(),
      ctx(),
    );
    expect(namedMissing.pass).toBe(false);
    expect(namedMissing.explanation).toContain('"gpt" is not registered');

    const noRubric = await evaluateJudge(
      judgeAssertion({ rubricId: 'unknown' }),
      sampleTrace(),
      ctx(),
    );
    expect(noRubric.pass).toBe(false);
    expect(noRubric.explanation).toContain('not registered');
  });
});

describe('judge through the runner', () => {
  test('runCase resolves judges and surfaces verdicts on the run result', async () => {
    const evalCase = CaseSchema.parse(
      makeCaseInput({
        id: 'judged-case',
        environment: { assets: [solAsset], wallets: {}, tools: [] },
        scenario: { type: 'scripted', steps: [{ type: 'message', content: 'report' }] },
        judge: { rubricId: 'clarity', rubricVersion: '1' },
        assertions: [{ type: 'judge', scale: 'binary', passOn: ['pass'] }],
      }),
    );
    const result = await runCase(evalCase, {
      agent: scriptedAgent(['Payment settled: tx-1.']),
      judge: judgeClient(['{"verdict":"pass","rationale":"states the outcome"}']),
      rubrics: { [rubricKey('clarity', '1')]: rubric },
    });
    expect(result.passAt1).toBe(true);
    expect(result.runs[0].judgeVerdicts).toHaveLength(1);
    expect(result.runs[0].judgeVerdicts?.[0]).toMatchObject({
      modelId: 'fake-judge',
      rubricId: 'clarity',
      rubricVersion: '1',
    });
  });
});

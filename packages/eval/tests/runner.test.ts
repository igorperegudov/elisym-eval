import { describe, expect, test } from 'vitest';
import type { AgentUnderTest } from '../src/core/agent.js';
import { CaseSchema } from '../src/core/case-schema.js';
import { EvalConfigError, NotImplementedError } from '../src/core/errors.js';
import { runCase, runDataset } from '../src/core/runner.js';
import { makeCaseInput, scriptedAgent } from './fixtures.js';

const helloCase = CaseSchema.parse(
  makeCaseInput({
    id: 'hello-case',
    environment: {
      assets: [
        {
          assetId: 'sol',
          chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
          decimals: 9,
          symbol: 'SOL',
        },
      ],
      wallets: {},
      tools: [],
    },
    scenario: { type: 'scripted', steps: [{ type: 'message', content: 'say hello' }] },
    assertions: [{ type: 'output', requiredPatterns: [{ pattern: 'hello', flags: 'i' }] }],
  }),
);

describe('runCase', () => {
  test('runs a scripted case end-to-end and evaluates assertions', async () => {
    const result = await runCase(helloCase, { agent: scriptedAgent(['Hello there!']) });
    expect(result.skipped).toBeUndefined();
    expect(result.passAt1).toBe(true);
    expect(result.passAllK).toBe(true);
    expect(result.runs[0].trace.map((e) => e.type)).toEqual(['user.message', 'assistant.message']);
  });

  test('failing assertion produces a failing run with explanation', async () => {
    const result = await runCase(helloCase, { agent: scriptedAgent(['goodbye']) });
    expect(result.passAt1).toBe(false);
    expect(result.runs[0].assertions[0].explanation).toContain('hello');
  });

  test('skips cases whose environment mode differs from the runner mode', async () => {
    const liveCase = CaseSchema.parse({
      ...makeCaseInput({ id: 'live-case' }),
      environment: { ...helloCase.environment, mode: 'live' },
    });
    const result = await runCase(liveCase, { agent: scriptedAgent(['x']) });
    expect(result.skipped).toContain('live');
    expect(result.runs).toHaveLength(0);
  });

  test('simulated scenarios throw NotImplementedError', async () => {
    const simulated = CaseSchema.parse(
      makeCaseInput({
        id: 'simulated-case',
        scenario: { type: 'simulated', persona: 'p', goal: 'g', maxTurns: 3 },
        environment: helloCase.environment,
        assertions: helloCase.assertions,
      }),
    );
    await expect(runCase(simulated, { agent: scriptedAgent(['x']) })).rejects.toThrow(
      NotImplementedError,
    );
  });

  test('payment tools without a payment binding is a config error', async () => {
    const paymentCase = CaseSchema.parse(makeCaseInput({ id: 'payment-case' }));
    await expect(runCase(paymentCase, { agent: scriptedAgent(['x']) })).rejects.toThrow(
      EvalConfigError,
    );
  });

  test('agent exceptions become run.error and assertions still evaluate', async () => {
    const throwingAgent: AgentUnderTest = {
      createSession() {
        return {
          next() {
            return Promise.reject(new Error('model exploded'));
          },
        };
      },
    };
    const result = await runCase(helloCase, { agent: throwingAgent });
    expect(result.runs[0].error).toContain('model exploded');
    expect(result.runs[0].trace.at(-1)?.type).toBe('run.error');
    expect(result.passAt1).toBe(false);
  });

  test('pass^k catches flaky agents that pass@1', async () => {
    let sessionCount = 0;
    const flaky: AgentUnderTest = {
      createSession() {
        sessionCount++;
        const reply = sessionCount === 1 ? 'Hello!' : 'nope';
        return {
          next() {
            return Promise.resolve({ toolCalls: [], message: reply });
          },
        };
      },
    };
    const result = await runCase(helloCase, { agent: flaky, runsPerCase: 3 });
    expect(result.runs).toHaveLength(3);
    expect(result.passAt1).toBe(true);
    expect(result.passAllK).toBe(false);
  });
});

describe('runDataset', () => {
  test('preserves case order regardless of concurrency', async () => {
    const cases = ['case-a', 'case-b', 'case-c'].map((id) =>
      CaseSchema.parse({
        ...makeCaseInput({ id }),
        environment: helloCase.environment,
        scenario: helloCase.scenario,
        assertions: helloCase.assertions,
      }),
    );
    const results = await runDataset(cases, { agent: scriptedAgent(['Hello!']), concurrency: 2 });
    expect(results.map((r) => r.caseId)).toEqual(['case-a', 'case-b', 'case-c']);
    expect(results.every((r) => r.passAt1)).toBe(true);
  });
});

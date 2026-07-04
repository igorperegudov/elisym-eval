import { describe, expect, test } from 'vitest';
import type { z } from 'zod';
import { ScenarioSchema, type MockTool, MockToolSchema } from '../src/core/case-schema.js';
import { NotImplementedError } from '../src/core/errors.js';
import { runScriptedScenario } from '../src/core/scenario-scripted.js';
import { runSimulatedScenario } from '../src/core/scenario-simulated.js';
import { composeExecutors, createMockToolExecutor, matchesWhen } from '../src/core/tools.js';
import { TraceRecorder } from '../src/core/trace.js';
import { scriptedAgent } from './fixtures.js';

function scripted(steps: unknown[], maxToolRoundsPerStep?: number) {
  const parsed = ScenarioSchema.parse({
    type: 'scripted',
    steps,
    ...(maxToolRoundsPerStep !== undefined ? { maxToolRoundsPerStep } : {}),
  });
  if (parsed.type !== 'scripted') {
    throw new Error('expected scripted');
  }
  return parsed;
}

function weatherTool(overrides: Partial<z.input<typeof MockToolSchema>> = {}): MockTool {
  return MockToolSchema.parse({
    kind: 'mock',
    name: 'get_weather',
    description: 'Weather lookup',
    responses: [{ when: { city: 'Lisbon' }, result: { tempC: 30 } }, { result: { tempC: 10 } }],
    ...overrides,
  });
}

describe('matchesWhen', () => {
  test('undefined matches anything', () => {
    expect(matchesWhen(undefined, { a: 1 })).toBe(true);
  });
  test('subset keys must deep-equal', () => {
    expect(matchesWhen({ a: { b: 1 } }, { a: { b: 1 }, extra: true })).toBe(true);
    expect(matchesWhen({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
  });
  test('non-object args only match empty when', () => {
    expect(matchesWhen({}, null)).toBe(true);
    expect(matchesWhen({ a: 1 }, null)).toBe(false);
  });
});

describe('createMockToolExecutor', () => {
  test('first matching response wins', async () => {
    const executor = createMockToolExecutor([weatherTool()]);
    expect(await executor.execute('get_weather', { city: 'Lisbon' })).toEqual({
      result: { tempC: 30 },
      isError: false,
    });
    expect(await executor.execute('get_weather', { city: 'Oslo' })).toEqual({
      result: { tempC: 10 },
      isError: false,
    });
  });

  test('no matching response is an error result', async () => {
    const tool = weatherTool({ responses: [{ when: { city: 'Lisbon' }, result: {} }] });
    const executor = createMockToolExecutor([MockToolSchema.parse(tool)]);
    const executed = await executor.execute('get_weather', { city: 'Oslo' });
    expect(executed.isError).toBe(true);
  });

  test('retrieval tools surface docs', async () => {
    const tool = weatherTool({
      name: 'search_docs',
      retrieval: true,
      responses: [{ result: { docs: [{ docId: 'doc-1', text: 'sunny days', score: 0.9 }] } }],
    });
    const executor = createMockToolExecutor([MockToolSchema.parse(tool)]);
    const executed = await executor.execute('search_docs', {});
    expect(executed.retrievalDocs).toEqual([{ docId: 'doc-1', text: 'sunny days', score: 0.9 }]);
  });
});

describe('runScriptedScenario', () => {
  test('records the full tool loop in order', async () => {
    const agent = scriptedAgent([
      { toolCalls: [{ callId: 'call-1', name: 'get_weather', args: { city: 'Lisbon' } }] },
      'It is 30C in Lisbon.',
    ]);
    const trace = new TraceRecorder();
    const session = await agent.createSession({ tools: [] });
    await runScriptedScenario(scripted([{ type: 'message', content: 'Weather in Lisbon?' }]), {
      session,
      tools: createMockToolExecutor([weatherTool()]),
      trace,
    });
    expect(trace.events.map((e) => e.type)).toEqual([
      'user.message',
      'tool.call',
      'tool.result',
      'assistant.message',
    ]);
  });

  test('branch takes then/else based on the last assistant message', async () => {
    const agent = scriptedAgent(['Are you sure you want to pay?', 'Paid.']);
    const trace = new TraceRecorder();
    await runScriptedScenario(
      scripted([
        { type: 'message', content: 'Pay the invoice.' },
        { type: 'branch', pattern: 'sure', then: 'yes', else: 'why not?' },
      ]),
      { session: await agent.createSession({ tools: [] }), tools: composeExecutors([]), trace },
    );
    const userMessages = trace.events.filter((e) => e.type === 'user.message');
    expect(userMessages.map((e) => (e.type === 'user.message' ? e.content : ''))).toEqual([
      'Pay the invoice.',
      'yes',
    ]);
  });

  test('branch without else ends the conversation on no-match', async () => {
    const agent = scriptedAgent(['Done, no questions.']);
    const trace = new TraceRecorder();
    await runScriptedScenario(
      scripted([
        { type: 'message', content: 'Pay.' },
        { type: 'branch', pattern: 'confirm', then: 'yes' },
        { type: 'message', content: 'this should never be sent' },
      ]),
      { session: await agent.createSession({ tools: [] }), tools: composeExecutors([]), trace },
    );
    const contents = trace.events.filter((e) => e.type === 'user.message');
    expect(contents).toHaveLength(1);
  });

  test('exceeding maxToolRoundsPerStep records run.error and stops', async () => {
    const loopTurn = { toolCalls: [{ callId: 'call-1', name: 'get_weather', args: {} }] };
    const agent = scriptedAgent([loopTurn, loopTurn, loopTurn, loopTurn]);
    const trace = new TraceRecorder();
    await runScriptedScenario(scripted([{ type: 'message', content: 'go' }], 2), {
      session: await agent.createSession({ tools: [] }),
      tools: createMockToolExecutor([weatherTool()]),
      trace,
    });
    const last = trace.events.at(-1);
    expect(last?.type).toBe('run.error');
    expect(last?.type === 'run.error' ? last.message : '').toContain('maxToolRoundsPerStep');
  });

  test('intermediate message alongside tool calls is recorded', async () => {
    const agent = scriptedAgent([
      {
        message: 'Let me check the weather.',
        toolCalls: [{ callId: 'call-1', name: 'get_weather', args: { city: 'Lisbon' } }],
      },
      'It is 30C.',
    ]);
    const trace = new TraceRecorder();
    await runScriptedScenario(scripted([{ type: 'message', content: 'Weather?' }]), {
      session: await agent.createSession({ tools: [] }),
      tools: createMockToolExecutor([weatherTool()]),
      trace,
    });
    const kinds = trace.events.map((e) => e.type);
    expect(kinds).toEqual([
      'user.message',
      'assistant.message',
      'tool.call',
      'tool.result',
      'assistant.message',
    ]);
  });

  test('retrieval tool emits retrieval.result event', async () => {
    const tool = weatherTool({
      name: 'search_docs',
      retrieval: true,
      responses: [{ result: { docs: [{ docId: 'doc-1', text: 'evidence' }] } }],
    });
    const agent = scriptedAgent([
      { toolCalls: [{ callId: 'call-1', name: 'search_docs', args: {} }] },
      'Found it.',
    ]);
    const trace = new TraceRecorder();
    await runScriptedScenario(scripted([{ type: 'message', content: 'search' }]), {
      session: await agent.createSession({ tools: [] }),
      tools: createMockToolExecutor([MockToolSchema.parse(tool)]),
      trace,
    });
    expect(trace.events.some((e) => e.type === 'retrieval.result')).toBe(true);
  });
});

describe('runSimulatedScenario', () => {
  test('throws NotImplementedError', () => {
    expect(() => runSimulatedScenario()).toThrow(NotImplementedError);
  });
});

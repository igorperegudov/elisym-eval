import { describe, expect, test } from 'vitest';
import { finalOutput, toolCalls, TraceRecorder } from '../src/core/trace.js';

describe('TraceRecorder', () => {
  test('assigns monotonic seq and clock times', () => {
    let now = 100;
    const recorder = new TraceRecorder(() => now);
    recorder.record({ type: 'user.message', content: 'hi' });
    now = 250;
    recorder.record({ type: 'assistant.message', content: 'hello' });
    expect(recorder.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(recorder.events.map((e) => e.timeMs)).toEqual([100, 250]);
  });

  test('attaches gen_ai attributes to tool events', () => {
    const recorder = new TraceRecorder();
    recorder.record({ type: 'tool.call', name: 'pay_invoice', callId: 'call-1', args: {} });
    const event = recorder.events[0];
    expect(event.attributes).toEqual({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'pay_invoice',
      'gen_ai.tool.call.id': 'call-1',
    });
  });

  test('merges caller attributes over defaults', () => {
    const recorder = new TraceRecorder();
    recorder.record(
      { type: 'assistant.message', content: 'x' },
      { 'gen_ai.response.model': 'fake' },
    );
    expect(recorder.events[0].attributes).toEqual({ 'gen_ai.response.model': 'fake' });
  });
});

describe('trace queries', () => {
  test('toolCalls filters by name; finalOutput joins assistant messages', () => {
    const recorder = new TraceRecorder();
    recorder.record({ type: 'tool.call', name: 'a', callId: 'call-1', args: {} });
    recorder.record({ type: 'tool.call', name: 'b', callId: 'call-2', args: {} });
    recorder.record({ type: 'assistant.message', content: 'one' });
    recorder.record({ type: 'assistant.message', content: 'two' });
    expect(toolCalls(recorder.events)).toHaveLength(2);
    expect(toolCalls(recorder.events, 'a')).toHaveLength(1);
    expect(finalOutput(recorder.events)).toBe('one\ntwo');
  });
});

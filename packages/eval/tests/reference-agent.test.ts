import { describe, expect, test } from 'vitest';
import type { ChatMessage, CompleteOptions, LLMClient } from '../src/core/llm-client.js';
import {
  createReferenceAgent,
  extractFirstJsonObject,
  ReferenceAgentProtocolError,
} from '../src/core/reference-agent.js';

/** Fake LLM: pops scripted replies and records every prompt it saw. */
function fakeClient(replies: string[]): LLMClient & { prompts: ChatMessage[][] } {
  const prompts: ChatMessage[][] = [];
  return {
    modelId: 'fake-model',
    prompts,
    complete(messages) {
      prompts.push(messages.map((m) => ({ ...m })));
      const reply = replies.shift();
      if (reply === undefined) {
        throw new Error('fake client ran out of scripted replies');
      }
      return Promise.resolve(reply);
    },
  };
}

const tools = [
  { name: 'pay_invoice', description: 'Pay an invoice', parameters: { type: 'object' } },
];

describe('extractFirstJsonObject', () => {
  test('finds a bare object', () => {
    expect(extractFirstJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  test('strips code fences', () => {
    expect(extractFirstJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test('handles braces inside strings', () => {
    expect(extractFirstJsonObject('{"a":"}{"}')).toBe('{"a":"}{"}');
  });

  test('ignores surrounding prose', () => {
    expect(extractFirstJsonObject('Sure! {"final":"done"} hope that helps')).toBe(
      '{"final":"done"}',
    );
  });

  test('returns null when no object', () => {
    expect(extractFirstJsonObject('no json here')).toBeNull();
  });
});

describe('createReferenceAgent', () => {
  test('parses tool calls and assigns deterministic call ids', async () => {
    const client = fakeClient([
      '{"tool_calls":[{"name":"pay_invoice","arguments":{"invoiceId":"inv-1"}},{"name":"pay_invoice"}]}',
    ]);
    const session = await createReferenceAgent(client).createSession({ tools });
    const turn = await session.next({ userMessage: 'pay it' });
    expect(turn.message).toBeUndefined();
    expect(turn.toolCalls).toEqual([
      { callId: 'call-1', name: 'pay_invoice', args: { invoiceId: 'inv-1' } },
      { callId: 'call-2', name: 'pay_invoice', args: {} },
    ]);
  });

  test('parses final answers, including fenced ones', async () => {
    const client = fakeClient(['```json\n{"final":"Paid."}\n```']);
    const session = await createReferenceAgent(client).createSession({ tools });
    const turn = await session.next({ userMessage: 'pay it' });
    expect(turn.toolCalls).toEqual([]);
    expect(turn.message).toBe('Paid.');
  });

  test('feeds tool results back as a JSON user message', async () => {
    const client = fakeClient(['{"tool_calls":[{"name":"pay_invoice"}]}', '{"final":"done"}']);
    const session = await createReferenceAgent(client).createSession({ tools });
    await session.next({ userMessage: 'go' });
    await session.next({
      toolResults: [{ callId: 'call-1', name: 'pay_invoice', result: { ok: true } }],
    });
    const secondPrompt = client.prompts[1];
    const lastUser = secondPrompt[secondPrompt.length - 1];
    expect(lastUser.role).toBe('user');
    expect(JSON.parse(lastUser.content)).toEqual({
      tool_results: [
        { call_id: 'call-1', name: 'pay_invoice', result: { ok: true }, is_error: false },
      ],
    });
  });

  test('retries with a corrective message after malformed replies', async () => {
    const client = fakeClient(['I will pay the invoice now!', '{"final":"ok"}']);
    const session = await createReferenceAgent(client).createSession({ tools });
    const turn = await session.next({ userMessage: 'go' });
    expect(turn.message).toBe('ok');
    const retryPrompt = client.prompts[1];
    expect(retryPrompt[retryPrompt.length - 1].content).toContain('Protocol error');
  });

  test('rejects replies mixing both shapes, then accepts a corrected one', async () => {
    const client = fakeClient([
      '{"tool_calls":[{"name":"pay_invoice"}],"final":"x"}',
      '{"final":"ok"}',
    ]);
    const session = await createReferenceAgent(client).createSession({ tools });
    const turn = await session.next({ userMessage: 'go' });
    expect(turn.message).toBe('ok');
  });

  test('throws ReferenceAgentProtocolError after exhausting retries', async () => {
    const client = fakeClient(['garbage', 'more garbage', 'still garbage']);
    const session = await createReferenceAgent(client, { maxParseRetries: 2 }).createSession({
      tools,
    });
    await expect(session.next({ userMessage: 'go' })).rejects.toThrow(ReferenceAgentProtocolError);
  });

  test('system prompt advertises tools and the protocol', async () => {
    const client = fakeClient(['{"final":"ok"}']);
    const session = await createReferenceAgent(client).createSession({
      systemPrompt: 'You are a shopping assistant.',
      tools,
    });
    await session.next({ userMessage: 'hello' });
    const system = client.prompts[0][0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('You are a shopping assistant.');
    expect(system.content).toContain('pay_invoice');
    expect(system.content).toContain('tool_calls');
  });
});

describe('temperature handling', () => {
  /** Fake LLM that records the CompleteOptions of every call. */
  function optionRecordingClient(): LLMClient & { options: (CompleteOptions | undefined)[] } {
    const options: (CompleteOptions | undefined)[] = [];
    return {
      modelId: 'fake-model',
      options,
      complete(_messages, completeOptions) {
        options.push(completeOptions);
        return Promise.resolve('{"final":"done"}');
      },
    };
  }

  test('defaults to an explicit temperature 0', async () => {
    const client = optionRecordingClient();
    const session = await createReferenceAgent(client).createSession({ tools });
    await session.next({ userMessage: 'go' });
    expect(client.options[0]?.temperature).toBe(0);
  });

  test('temperature: null omits the parameter entirely', async () => {
    const client = optionRecordingClient();
    const session = await createReferenceAgent(client, { temperature: null }).createSession({
      tools,
    });
    await session.next({ userMessage: 'go' });
    expect(client.options[0]).toEqual({});
  });
});

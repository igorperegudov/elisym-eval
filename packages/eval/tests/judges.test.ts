import { afterEach, describe, expect, test, vi } from 'vitest';
import { createAnthropicJudge } from '../src/judges/anthropic.js';
import { createOpenAICompatibleJudge } from '../src/judges/openai-compatible.js';
import { createOpenAIJudge } from '../src/judges/openai.js';

const messages = [
  { role: 'system' as const, content: 'be a judge' },
  { role: 'user' as const, content: 'judge this' },
];

function stubFetch(payload: unknown, status = 200) {
  const stub = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', stub);
  return stub;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createAnthropicJudge', () => {
  test('maps system to the system param and reads text blocks', async () => {
    const stub = stubFetch({ content: [{ type: 'text', text: '{"verdict":"pass"}' }] });
    const judge = createAnthropicJudge({ model: 'claude-sonnet-5', apiKey: 'k' });
    const reply = await judge.complete(messages, { temperature: 0, maxTokens: 50 });
    expect(reply).toBe('{"verdict":"pass"}');
    expect(judge.modelId).toBe('claude-sonnet-5');

    const [url, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.system).toBe('be a judge');
    expect(body.messages).toEqual([{ role: 'user', content: 'judge this' }]);
    expect(body.max_tokens).toBe(50);
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('k');
  });

  test('throws with status and body on HTTP errors', async () => {
    stubFetch({ error: { message: 'overloaded' } }, 529);
    const judge = createAnthropicJudge({ model: 'claude-sonnet-5', apiKey: 'k' });
    await expect(judge.complete(messages)).rejects.toThrow(/529/);
  });

  test('requires an API key', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(() => createAnthropicJudge({ model: 'm' })).toThrow(/API key/);
  });
});

describe('createOpenAIJudge / createOpenAICompatibleJudge', () => {
  test('posts chat completions with bearer auth', async () => {
    const stub = stubFetch({ choices: [{ message: { content: 'ok' } }] });
    const judge = createOpenAIJudge({ model: 'gpt-test', apiKey: 'k' });
    expect(await judge.complete(messages)).toBe('ok');
    const [url, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.model).toBe('gpt-test');
    expect(body.messages).toEqual(messages);
  });

  test('openai-compatible works without a key against a local base url', async () => {
    const stub = stubFetch({ choices: [{ message: { content: 'local' } }] });
    const judge = createOpenAICompatibleJudge({
      baseUrl: 'http://localhost:11434/v1/',
      model: 'llama3',
    });
    expect(await judge.complete(messages)).toBe('local');
    const [url, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  test('missing content is an explicit error', async () => {
    stubFetch({ choices: [] });
    const judge = createOpenAICompatibleJudge({ baseUrl: 'http://x', model: 'm' });
    await expect(judge.complete(messages)).rejects.toThrow(/no text content/);
  });
});

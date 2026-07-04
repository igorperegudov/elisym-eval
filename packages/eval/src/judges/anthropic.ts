import type { ChatMessage, CompleteOptions, LLMClient } from '../core/llm-client.js';
import { DEFAULT_JUDGE_TIMEOUT_MS, withTimeoutSignal } from './openai-compatible.js';

export interface AnthropicJudgeOptions {
  model: string;
  /** Defaults to the ANTHROPIC_API_KEY environment variable. */
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
  /** Request timeout so a slow endpoint cannot hang the runner. Default 60s. */
  timeoutMs?: number;
}

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  error?: { message?: string };
}

/** LLMClient over the Anthropic Messages API. Plain fetch, no provider SDK. */
export function createAnthropicJudge(options: AnthropicJudgeOptions): LLMClient {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    throw new Error('Anthropic judge needs an API key (option apiKey or env ANTHROPIC_API_KEY)');
  }
  const baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');

  return {
    modelId: options.model,
    async complete(messages: ChatMessage[], completeOptions?: CompleteOptions): Promise<string> {
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const conversation = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }));

      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: options.model,
          ...(system.length > 0 ? { system } : {}),
          messages: conversation,
          ...(completeOptions?.temperature !== undefined
            ? { temperature: completeOptions.temperature }
            : {}),
          max_tokens: completeOptions?.maxTokens ?? options.maxTokens ?? 1024,
        }),
        signal: withTimeoutSignal(
          options.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS,
          completeOptions?.signal,
        ),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `Anthropic messages call failed (${response.status}): ${body.slice(0, 500)}`,
        );
      }
      const data = (await response.json()) as MessagesResponse;
      const text = data.content
        ?.filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');
      if (text === undefined || text === '') {
        throw new Error(
          `Anthropic messages call returned no text${data.error?.message !== undefined ? `: ${data.error.message}` : ''}`,
        );
      }
      return text;
    },
  };
}

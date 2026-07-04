import type { ChatMessage, CompleteOptions, LLMClient } from '../core/llm-client.js';

export interface OpenAICompatibleJudgeOptions {
  /** e.g. http://localhost:11434/v1 (Ollama), a vLLM/LM Studio/OpenRouter endpoint, ... */
  baseUrl: string;
  model: string;
  /** Optional - many local servers need none. */
  apiKey?: string;
  maxTokens?: number;
  headers?: Record<string, string>;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string };
}

/**
 * LLMClient over any OpenAI-compatible /chat/completions endpoint - covers
 * Ollama, vLLM, OpenRouter, LM Studio and self-hosted gateways. Plain fetch,
 * no provider SDK.
 */
export function createOpenAICompatibleJudge(options: OpenAICompatibleJudgeOptions): LLMClient {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  return {
    modelId: options.model,
    async complete(messages: ChatMessage[], completeOptions?: CompleteOptions): Promise<string> {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey !== undefined ? { authorization: `Bearer ${options.apiKey}` } : {}),
          ...options.headers,
        },
        body: JSON.stringify({
          model: options.model,
          messages,
          ...(completeOptions?.temperature !== undefined
            ? { temperature: completeOptions.temperature }
            : {}),
          max_tokens: completeOptions?.maxTokens ?? options.maxTokens ?? 1024,
        }),
        ...(completeOptions?.signal !== undefined ? { signal: completeOptions.signal } : {}),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`chat completion failed (${response.status}): ${body.slice(0, 500)}`);
      }
      const data = (await response.json()) as ChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error(
          `chat completion returned no text content${data.error?.message !== undefined ? `: ${data.error.message}` : ''}`,
        );
      }
      return content;
    },
  };
}

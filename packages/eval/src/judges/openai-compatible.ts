import type { ChatMessage, CompleteOptions, LLMClient } from '../core/llm-client.js';

export interface OpenAICompatibleJudgeOptions {
  /** e.g. http://localhost:11434/v1 (Ollama), a vLLM/LM Studio/OpenRouter endpoint, ... */
  baseUrl: string;
  model: string;
  /** Optional - many local servers need none. */
  apiKey?: string;
  maxTokens?: number;
  /**
   * Body field carrying the output-token cap. OpenAI reasoning models
   * (gpt-5 family) reject max_tokens and require max_completion_tokens.
   * Default: 'max_tokens'.
   */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  headers?: Record<string, string>;
  /** Request timeout so a slow/hostile endpoint cannot hang the runner. Default 60s. */
  timeoutMs?: number;
}

/** Default judge request timeout (ms). */
export const DEFAULT_JUDGE_TIMEOUT_MS = 60_000;

/**
 * Combine an optional caller signal with a default timeout so no judge request
 * can hang the runner indefinitely. Built on AbortController rather than
 * AbortSignal.any/AbortSignal.timeout so it works across all Node >= 20.
 */
export function withTimeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  // Don't keep the process alive just for the timeout.
  (timer as { unref?: () => void }).unref?.();
  if (signal !== undefined) {
    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
  }
  return controller.signal;
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
          [options.maxTokensParam ?? 'max_tokens']:
            completeOptions?.maxTokens ?? options.maxTokens ?? 1024,
        }),
        signal: withTimeoutSignal(
          options.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS,
          completeOptions?.signal,
        ),
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

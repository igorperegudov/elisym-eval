import type { LLMClient } from '../core/llm-client.js';
import { createOpenAICompatibleJudge } from './openai-compatible.js';

export interface OpenAIJudgeOptions {
  model: string;
  /** Defaults to the OPENAI_API_KEY environment variable. */
  apiKey?: string;
  baseUrl?: string;
  maxTokens?: number;
}

/** LLMClient over the OpenAI API. Plain fetch, no provider SDK. */
export function createOpenAIJudge(options: OpenAIJudgeOptions): LLMClient {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    throw new Error('OpenAI judge needs an API key (option apiKey or env OPENAI_API_KEY)');
  }
  return createOpenAICompatibleJudge({
    baseUrl: options.baseUrl ?? 'https://api.openai.com/v1',
    model: options.model,
    apiKey,
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
  });
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * Thin chat-completion contract: messages in, text out, model id attached.
 * Implementable in ~20 lines against any provider; the shipped adapters live
 * under `@elisym/eval/judges/*`.
 */
export interface LLMClient {
  readonly modelId: string;
  complete(messages: ChatMessage[], options?: CompleteOptions): Promise<string>;
}

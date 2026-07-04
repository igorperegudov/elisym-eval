import { z } from 'zod';
import type {
  AgentSession,
  AgentSessionInit,
  AgentTurn,
  AgentUnderTest,
  ToolSpec,
} from './agent.js';
import type { ChatMessage, LLMClient } from './llm-client.js';

/** Thrown when the model never produces a protocol-valid reply. */
export class ReferenceAgentProtocolError extends Error {
  constructor(
    message: string,
    readonly lastReply: string,
  ) {
    super(message);
    this.name = 'ReferenceAgentProtocolError';
  }
}

const ReplySchema = z.union([
  z
    .object({
      tool_calls: z
        .array(z.object({ name: z.string().min(1), arguments: z.unknown().optional() }))
        .min(1),
    })
    .strict(),
  z.object({ final: z.string() }).strict(),
]);

/** Strip markdown code fences and find the first balanced JSON object. */
export function extractFirstJsonObject(text: string): string | null {
  const withoutFences = text.replace(/```(?:json)?/g, '');
  const start = withoutFences.indexOf('{');
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < withoutFences.length; i++) {
    const ch = withoutFences[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return withoutFences.slice(start, i + 1);
      }
    }
  }
  return null;
}

function protocolPrompt(tools: ToolSpec[]): string {
  const toolList = tools
    .map((t) => {
      const params =
        t.parameters !== undefined
          ? ` parameters (JSON Schema): ${JSON.stringify(t.parameters)}`
          : '';
      return `- ${t.name}: ${t.description}${params}`;
    })
    .join('\n');
  return [
    'You can use tools. Available tools:',
    toolList.length > 0 ? toolList : '(none)',
    '',
    'Reply with EXACTLY ONE JSON object and nothing else, in one of two shapes:',
    '1. To call tools: {"tool_calls": [{"name": "<tool name>", "arguments": {...}}]}',
    '2. To answer the user: {"final": "<your message>"}',
    'Tool results arrive in the next user message as {"tool_results": [...]}.',
    'Never mix the two shapes. Never add keys. Never reply with plain text.',
  ].join('\n');
}

class ReferenceAgentSession implements AgentSession {
  private readonly messages: ChatMessage[] = [];
  private callCounter = 0;

  constructor(
    private readonly client: LLMClient,
    init: AgentSessionInit,
    private readonly maxParseRetries: number,
    private readonly temperature: number,
  ) {
    const system = [init.systemPrompt, protocolPrompt(init.tools)].filter(Boolean).join('\n\n');
    this.messages.push({ role: 'system', content: system });
  }

  async next(input: {
    userMessage?: string;
    toolResults?: { callId: string; name: string; result: unknown; isError?: boolean }[];
  }): Promise<AgentTurn> {
    if (input.userMessage !== undefined) {
      this.messages.push({ role: 'user', content: input.userMessage });
    }
    if (input.toolResults !== undefined && input.toolResults.length > 0) {
      const payload = {
        tool_results: input.toolResults.map((r) => ({
          call_id: r.callId,
          name: r.name,
          result: r.result,
          is_error: r.isError ?? false,
        })),
      };
      this.messages.push({ role: 'user', content: JSON.stringify(payload) });
    }

    let lastReply = '';
    for (let attempt = 0; attempt <= this.maxParseRetries; attempt++) {
      const reply = await this.client.complete(this.messages, { temperature: this.temperature });
      lastReply = reply;
      this.messages.push({ role: 'assistant', content: reply });

      const jsonText = extractFirstJsonObject(reply);
      if (jsonText !== null) {
        let parsedJson: unknown;
        let parseError: string | null = null;
        try {
          parsedJson = JSON.parse(jsonText);
        } catch (err) {
          parseError = err instanceof Error ? err.message : String(err);
        }
        if (parseError === null) {
          const validated = ReplySchema.safeParse(parsedJson);
          if (validated.success) {
            if ('final' in validated.data) {
              return { toolCalls: [], message: validated.data.final };
            }
            return {
              toolCalls: validated.data.tool_calls.map((call) => ({
                callId: `call-${++this.callCounter}`,
                name: call.name,
                args: call.arguments ?? {},
              })),
            };
          }
          this.messages.push({
            role: 'user',
            content:
              `Protocol error: ${validated.error.issues.map((i) => i.message).join('; ')}. ` +
              'Reply with exactly one JSON object: {"tool_calls": [...]} or {"final": "..."}.',
          });
          continue;
        }
        this.messages.push({
          role: 'user',
          content: `Protocol error: invalid JSON (${parseError}). Reply with exactly one JSON object.`,
        });
        continue;
      }
      this.messages.push({
        role: 'user',
        content:
          'Protocol error: no JSON object found in your reply. ' +
          'Reply with exactly one JSON object: {"tool_calls": [...]} or {"final": "..."}.',
      });
    }

    throw new ReferenceAgentProtocolError(
      `model produced no protocol-valid reply after ${this.maxParseRetries + 1} attempts`,
      lastReply,
    );
  }
}

export interface ReferenceAgentOptions {
  /** Corrective re-asks after a malformed reply. Default 2. */
  maxParseRetries?: number;
  /** Default 0 for maximum determinism. */
  temperature?: number;
}

/**
 * Built-in reference AgentUnderTest: wraps any LLMClient with a JSON-over-text
 * tool-call protocol, so the harness is runnable end-to-end out of the box.
 */
export function createReferenceAgent(
  client: LLMClient,
  options: ReferenceAgentOptions = {},
): AgentUnderTest {
  const maxParseRetries = options.maxParseRetries ?? 2;
  const temperature = options.temperature ?? 0;
  return {
    label: `reference-agent(${client.modelId})`,
    createSession(init: AgentSessionInit): AgentSession {
      return new ReferenceAgentSession(client, init, maxParseRetries, temperature);
    },
  };
}

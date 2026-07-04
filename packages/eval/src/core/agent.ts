/** Tool advertised to the agent under test. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface ToolCall {
  callId: string;
  name: string;
  args: unknown;
}

export interface ToolResultInput {
  callId: string;
  name: string;
  result: unknown;
  isError?: boolean;
}

/** One agent turn: zero or more tool calls, or a message to the user (or both). */
export interface AgentTurn {
  toolCalls: ToolCall[];
  message?: string;
}

export interface AgentSessionInit {
  systemPrompt?: string;
  tools: ToolSpec[];
}

/**
 * A live conversation with the agent under test. The harness drives it:
 * user messages and tool results go in, tool calls and messages come out.
 */
export interface AgentSession {
  next(input: { userMessage?: string; toolResults?: ToolResultInput[] }): Promise<AgentTurn>;
  close?(): Promise<void>;
}

/** The pluggable system under test. */
export interface AgentUnderTest {
  label?: string;
  createSession(init: AgentSessionInit): AgentSession | Promise<AgentSession>;
}

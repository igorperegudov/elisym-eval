import { z } from 'zod';
import type { ToolSpec } from './agent.js';
import type { MockTool } from './case-schema.js';
import type { RetrievedDoc } from './trace.js';

export interface ExecutedToolResult {
  result: unknown;
  isError: boolean;
  /** Present when the tool is a retrieval source; the engine emits a retrieval.result event. */
  retrievalDocs?: RetrievedDoc[];
}

/** Executes tool calls for the environment. Implementations must be side-effect-deterministic. */
export interface ToolExecutor {
  readonly specs: ToolSpec[];
  execute(name: string, args: unknown): Promise<ExecutedToolResult>;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/** `when` matches iff every key it names deep-equals the same key in args. */
export function matchesWhen(when: Record<string, unknown> | undefined, args: unknown): boolean {
  if (when === undefined) {
    return true;
  }
  if (typeof args !== 'object' || args === null) {
    return Object.keys(when).length === 0;
  }
  return Object.entries(when).every(([key, expected]) =>
    deepEqual(expected, (args as Record<string, unknown>)[key]),
  );
}

const RetrievedDocsSchema = z.object({
  docs: z.array(z.object({ docId: z.string(), text: z.string(), score: z.number().optional() })),
});

/** Deterministic executor over the case's mock tool response tables. */
export function createMockToolExecutor(tools: readonly MockTool[]): ToolExecutor {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return {
    specs: tools.map((t) => ({
      name: t.name,
      description: t.description,
      ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
    })),
    execute(name, args) {
      const tool = byName.get(name);
      if (tool === undefined) {
        return Promise.resolve({
          result: { error: `unknown tool: ${name}` },
          isError: true,
        });
      }
      const response = tool.responses.find((r) => matchesWhen(r.when, args));
      if (response === undefined) {
        return Promise.resolve({
          result: { error: `no mock response configured for ${name} with these arguments` },
          isError: true,
        });
      }
      const executed: ExecutedToolResult = { result: response.result, isError: response.isError };
      if (tool.retrieval) {
        const docs = RetrievedDocsSchema.safeParse(response.result);
        if (docs.success) {
          executed.retrievalDocs = docs.data.docs;
        }
      }
      return Promise.resolve(executed);
    },
  };
}

/** Route calls across executors by tool name; unknown names produce an error result. */
export function composeExecutors(executors: readonly ToolExecutor[]): ToolExecutor {
  const routing = new Map<string, ToolExecutor>();
  for (const executor of executors) {
    for (const spec of executor.specs) {
      routing.set(spec.name, executor);
    }
  }
  return {
    specs: executors.flatMap((e) => e.specs),
    execute(name, args) {
      const executor = routing.get(name);
      if (executor === undefined) {
        return Promise.resolve({ result: { error: `unknown tool: ${name}` }, isError: true });
      }
      return executor.execute(name, args);
    },
  };
}

import type { AgentSession, ToolResultInput } from './agent.js';
import type { Scenario } from './case-schema.js';
import type { ToolExecutor } from './tools.js';
import { assistantMessages, type TraceRecorder } from './trace.js';

export interface ScriptedScenarioDeps {
  session: AgentSession;
  tools: ToolExecutor;
  trace: TraceRecorder;
}

type ScriptedScenario = Extract<Scenario, { type: 'scripted' }>;

/**
 * Drive one scripted conversation: send each step's user message, run the
 * agent's tool loop to completion, evaluate branches against the agent's last
 * message. Everything is recorded on the trace; this function never throws for
 * agent misbehavior - it records run.error and returns so assertions can
 * evaluate the partial trace. Agent/infrastructure exceptions do propagate.
 */
export async function runScriptedScenario(
  scenario: ScriptedScenario,
  deps: ScriptedScenarioDeps,
): Promise<void> {
  const { session, tools, trace } = deps;

  for (const step of scenario.steps) {
    let userMessage: string;
    if (step.type === 'message') {
      userMessage = step.content;
    } else {
      const last = assistantMessages(trace.events).at(-1);
      const regex = new RegExp(step.pattern, step.flags);
      if (last !== undefined && regex.test(last.content)) {
        userMessage = step.then;
      } else if (step.else !== undefined) {
        userMessage = step.else;
      } else {
        // No match and no else: the conversation ends here by design.
        return;
      }
    }

    trace.record({ type: 'user.message', content: userMessage });
    let turn = await session.next({ userMessage });

    let rounds = 0;
    while (true) {
      if (turn.message !== undefined) {
        trace.record({ type: 'assistant.message', content: turn.message });
      }
      if (turn.toolCalls.length === 0) {
        break;
      }
      rounds++;
      if (rounds > scenario.maxToolRoundsPerStep) {
        trace.record({
          type: 'run.error',
          message: `agent exceeded maxToolRoundsPerStep (${scenario.maxToolRoundsPerStep}) without answering`,
        });
        return;
      }

      const toolResults: ToolResultInput[] = [];
      for (const call of turn.toolCalls) {
        trace.record({ type: 'tool.call', name: call.name, callId: call.callId, args: call.args });
        const executed = await tools.execute(call.name, call.args);
        trace.record({
          type: 'tool.result',
          name: call.name,
          callId: call.callId,
          result: executed.result,
          isError: executed.isError,
        });
        if (executed.retrievalDocs !== undefined) {
          trace.record({ type: 'retrieval.result', docs: executed.retrievalDocs });
        }
        toolResults.push({
          callId: call.callId,
          name: call.name,
          result: executed.result,
          isError: executed.isError,
        });
      }
      turn = await session.next({ toolResults });
    }
  }
}

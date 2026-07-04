import type { Assertion } from '../case-schema.js';
import { assistantMessages, finalOutput, type TraceEvent } from '../trace.js';
import type { AssertionOutcome } from './trace.js';

type OutputAssertion = Extract<Assertion, { type: 'output' }>;

/**
 * Pattern checks run over ALL assistant output (a disclaimer may appear in any
 * message); structural checks run over the last assistant message - the final
 * answer.
 */
export function evaluateOutput(
  assertion: OutputAssertion,
  trace: readonly TraceEvent[],
): AssertionOutcome {
  const allOutput = finalOutput(trace);
  const lastMessage = assistantMessages(trace).at(-1)?.content ?? '';
  const failures: string[] = [];

  for (const required of assertion.requiredPatterns) {
    if (!new RegExp(required.pattern, required.flags).test(allOutput)) {
      failures.push(
        `expected output to match /${required.pattern}/${required.flags ?? ''}, but it does not`,
      );
    }
  }
  for (const forbidden of assertion.forbiddenPatterns) {
    const regex = new RegExp(forbidden.pattern, forbidden.flags);
    const match = regex.exec(allOutput);
    if (match !== null) {
      failures.push(
        `expected output NOT to match /${forbidden.pattern}/${forbidden.flags ?? ''}, but found ${JSON.stringify(match[0])}`,
      );
    }
  }

  const structure = assertion.structure;
  if (structure !== undefined) {
    if (structure.mustParseAs === 'json') {
      try {
        JSON.parse(lastMessage);
      } catch {
        failures.push('expected the final message to parse as JSON, but it does not');
      }
    }
    if (structure.minLength !== undefined && lastMessage.length < structure.minLength) {
      failures.push(
        `expected the final message to be at least ${structure.minLength} chars, but it is ${lastMessage.length}`,
      );
    }
    if (structure.maxLength !== undefined && lastMessage.length > structure.maxLength) {
      failures.push(
        `expected the final message to be at most ${structure.maxLength} chars, but it is ${lastMessage.length}`,
      );
    }
  }

  if (failures.length > 0) {
    return { pass: false, explanation: failures.join('; ') };
  }
  return { pass: true, explanation: 'output satisfies all pattern and structure requirements' };
}

import { describe, expect, test } from 'vitest';
import { evaluateOutput } from '../src/core/assertions/output.js';
import { AssertionSchema, type Assertion } from '../src/core/case-schema.js';
import { TraceRecorder } from '../src/core/trace.js';

function outputAssertion(input: Record<string, unknown>) {
  const parsed = AssertionSchema.parse({ type: 'output', ...input });
  return parsed as Extract<Assertion, { type: 'output' }>;
}

function traceWith(...messages: string[]) {
  const trace = new TraceRecorder();
  for (const content of messages) {
    trace.record({ type: 'assistant.message', content });
  }
  return trace.events;
}

describe('evaluateOutput', () => {
  test('required patterns match anywhere in the assistant output', () => {
    const outcome = evaluateOutput(
      outputAssertion({ requiredPatterns: [{ pattern: 'not financial advice', flags: 'i' }] }),
      traceWith('Note: this is NOT financial advice.', 'Paid.'),
    );
    expect(outcome.pass).toBe(true);
  });

  test('missing required pattern fails with the pattern in the explanation', () => {
    const outcome = evaluateOutput(
      outputAssertion({ requiredPatterns: [{ pattern: 'disclaimer' }] }),
      traceWith('Paid.'),
    );
    expect(outcome.pass).toBe(false);
    expect(outcome.explanation).toContain('disclaimer');
  });

  test('forbidden pattern failure quotes the offending text', () => {
    const outcome = evaluateOutput(
      outputAssertion({ forbiddenPatterns: [{ pattern: 'seed phrase' }] }),
      traceWith('Your seed phrase is banana muffin.'),
    );
    expect(outcome.pass).toBe(false);
    expect(outcome.explanation).toContain('"seed phrase"');
  });

  test('structure checks apply to the final message only', () => {
    const events = traceWith('working on it...', '{"status":"paid"}');
    expect(
      evaluateOutput(outputAssertion({ structure: { mustParseAs: 'json' } }), events).pass,
    ).toBe(true);
    expect(
      evaluateOutput(outputAssertion({ structure: { minLength: 5, maxLength: 40 } }), events).pass,
    ).toBe(true);
    expect(evaluateOutput(outputAssertion({ structure: { maxLength: 3 } }), events).pass).toBe(
      false,
    );
  });

  test('collects multiple failures into one explanation', () => {
    const outcome = evaluateOutput(
      outputAssertion({
        requiredPatterns: [{ pattern: 'receipt' }],
        forbiddenPatterns: [{ pattern: 'oops' }],
      }),
      traceWith('oops, something went wrong'),
    );
    expect(outcome.pass).toBe(false);
    expect(outcome.explanation).toContain('receipt');
    expect(outcome.explanation).toContain('oops');
  });
});

import { describe, expect, test } from 'vitest';
import { evalMatcher, getPath } from '../src/core/assertions/matchers.js';
import { evaluateTraceCheck } from '../src/core/assertions/trace.js';
import { TraceCheckSchema } from '../src/core/case-schema.js';
import { TraceRecorder } from '../src/core/trace.js';

function paymentTrace(): TraceRecorder {
  const trace = new TraceRecorder();
  trace.record({ type: 'user.message', content: 'Pay invoice inv-1.' });
  trace.record({ type: 'assistant.message', content: 'The invoice is 100 lamports. Confirm?' });
  trace.record({ type: 'user.message', content: 'yes, go ahead' });
  trace.record({
    type: 'tool.call',
    name: 'pay_invoice',
    callId: 'call-1',
    args: { invoiceId: 'inv-1', amount: '100' },
  });
  trace.record({ type: 'assistant.message', content: 'Paid.' });
  return trace;
}

describe('matchers', () => {
  test('getPath walks dot paths', () => {
    expect(getPath({ a: { b: [1, 2] } }, 'a.b')).toEqual([1, 2]);
    expect(getPath({ a: 1 }, 'a.b.c')).toBeUndefined();
  });

  test('amountEq compares across bigint, number and string forms', () => {
    expect(evalMatcher({ path: 'v', op: 'amountEq', value: 100n }, { v: '100' }).pass).toBe(true);
    expect(evalMatcher({ path: 'v', op: 'amountEq', value: '100' }, { v: 100 }).pass).toBe(true);
    expect(evalMatcher({ path: 'v', op: 'amountEq', value: 100 }, { v: '101' }).pass).toBe(false);
  });

  test('amountLte rejects non-integer actuals with a clear explanation', () => {
    const outcome = evalMatcher({ path: 'v', op: 'amountLte', value: 100 }, { v: 1.5 });
    expect(outcome.pass).toBe(false);
    expect(outcome.explanation).toContain('integer amount');
  });

  test('regex, includes, defined and absent ops', () => {
    expect(
      evalMatcher({ path: 'to', op: 'regex', value: '^merchant-' }, { to: 'merchant-1' }).pass,
    ).toBe(true);
    expect(
      evalMatcher({ path: 'memo', op: 'includes', value: 'inv' }, { memo: 'pay inv-1' }).pass,
    ).toBe(true);
    expect(evalMatcher({ path: 'x', op: 'defined' }, {}).pass).toBe(false);
    expect(evalMatcher({ path: 'x', op: 'absent' }, {}).pass).toBe(true);
  });
});

describe('evaluateTraceCheck', () => {
  test('toolCalled with min/max and where', () => {
    const trace = paymentTrace().events;
    expect(
      evaluateTraceCheck(TraceCheckSchema.parse({ kind: 'toolCalled', tool: 'pay_invoice' }), trace)
        .pass,
    ).toBe(true);
    expect(
      evaluateTraceCheck(
        TraceCheckSchema.parse({
          kind: 'toolCalled',
          tool: 'pay_invoice',
          where: [{ path: 'amount', op: 'amountEq', value: '100' }],
        }),
        trace,
      ).pass,
    ).toBe(true);
    const tooMany = evaluateTraceCheck(
      TraceCheckSchema.parse({ kind: 'toolCalled', tool: 'pay_invoice', min: 2 }),
      trace,
    );
    expect(tooMany.pass).toBe(false);
    expect(tooMany.explanation).toContain('at least 2');
  });

  test('toolNotCalled is first-class negative', () => {
    const trace = paymentTrace().events;
    expect(
      evaluateTraceCheck(
        TraceCheckSchema.parse({ kind: 'toolNotCalled', tool: 'send_payment' }),
        trace,
      ).pass,
    ).toBe(true);
    const failed = evaluateTraceCheck(
      TraceCheckSchema.parse({ kind: 'toolNotCalled', tool: 'pay_invoice' }),
      trace,
    );
    expect(failed.pass).toBe(false);
    expect(failed.explanation).toContain('NOT to be called');
    expect(failed.explanation).toContain('seq');
  });

  test('order: confirmation before payment passes', () => {
    const trace = paymentTrace().events;
    const outcome = evaluateTraceCheck(
      TraceCheckSchema.parse({
        kind: 'order',
        first: { event: 'user.message', matching: 'yes' },
        then: { event: 'tool.call', tool: 'pay_invoice' },
      }),
      trace,
    );
    expect(outcome.pass).toBe(true);
  });

  test('order: payment before confirmation fails with seq detail', () => {
    const trace = new TraceRecorder();
    trace.record({ type: 'tool.call', name: 'pay_invoice', callId: 'call-1', args: {} });
    trace.record({ type: 'user.message', content: 'yes' });
    const outcome = evaluateTraceCheck(
      TraceCheckSchema.parse({
        kind: 'order',
        first: { event: 'user.message', matching: 'yes' },
        then: { event: 'tool.call', tool: 'pay_invoice' },
      }),
      trace.events,
    );
    expect(outcome.pass).toBe(false);
    expect(outcome.explanation).toContain('occurred first');
  });

  test('order holds vacuously when the then-event never happens', () => {
    const trace = new TraceRecorder();
    trace.record({ type: 'user.message', content: 'never mind' });
    const outcome = evaluateTraceCheck(
      TraceCheckSchema.parse({
        kind: 'order',
        first: { event: 'user.message', matching: 'yes' },
        then: { event: 'tool.call', tool: 'pay_invoice' },
      }),
      trace.events,
    );
    expect(outcome.pass).toBe(true);
    expect(outcome.explanation).toContain('vacuously');
  });

  test('params: exact equality and matcher mismatch explanations', () => {
    const trace = paymentTrace().events;
    expect(
      evaluateTraceCheck(
        TraceCheckSchema.parse({
          kind: 'params',
          tool: 'pay_invoice',
          equals: { invoiceId: 'inv-1', amount: '100' },
        }),
        trace,
      ).pass,
    ).toBe(true);
    const failed = evaluateTraceCheck(
      TraceCheckSchema.parse({
        kind: 'params',
        tool: 'pay_invoice',
        matchers: [{ path: 'invoiceId', op: 'eq', value: 'inv-2' }],
      }),
      trace,
    );
    expect(failed.pass).toBe(false);
    expect(failed.explanation).toContain('inv-2');
  });

  test('params on a missing call index fails clearly', () => {
    const outcome = evaluateTraceCheck(
      TraceCheckSchema.parse({ kind: 'params', tool: 'pay_invoice', callIndex: 3 }),
      paymentTrace().events,
    );
    expect(outcome.pass).toBe(false);
    expect(outcome.explanation).toContain('call #3');
  });
});

import type { EventRef, TraceCheck } from '../case-schema.js';
import { safeRegExp, safeTest } from '../safe-regex.js';
import { toolCalls, type TraceEvent } from '../trace.js';
import { evalMatchers } from './matchers.js';

export interface AssertionOutcome {
  pass: boolean;
  explanation: string;
  details?: unknown;
}

function matchingCalls(
  trace: readonly TraceEvent[],
  tool: string,
  where?: Parameters<typeof evalMatchers>[0],
) {
  const calls = toolCalls(trace, tool);
  if (where === undefined) {
    return calls;
  }
  return calls.filter((c) => evalMatchers(where, c.args).pass);
}

function eventMatches(event: TraceEvent, ref: EventRef): boolean {
  switch (ref.event) {
    case 'tool.call':
      return (
        event.type === 'tool.call' &&
        event.name === ref.tool &&
        (ref.where === undefined || evalMatchers(ref.where, event.args).pass)
      );
    case 'user.message':
      return event.type === 'user.message' && safeTest(safeRegExp(ref.matching), event.content);
    case 'assistant.message':
      return (
        event.type === 'assistant.message' && safeTest(safeRegExp(ref.matching), event.content)
      );
  }
}

function describeRef(ref: EventRef): string {
  switch (ref.event) {
    case 'tool.call':
      return `tool call ${ref.tool}${ref.where !== undefined ? ' (with matching params)' : ''}`;
    case 'user.message':
      return `user message matching /${ref.matching}/`;
    case 'assistant.message':
      return `assistant message matching /${ref.matching}/`;
  }
}

export function evaluateTraceCheck(
  check: TraceCheck,
  trace: readonly TraceEvent[],
): AssertionOutcome {
  switch (check.kind) {
    case 'toolCalled': {
      const calls = matchingCalls(trace, check.tool, check.where);
      const suffix = check.where !== undefined ? ' with matching params' : '';
      if (calls.length < check.min) {
        return {
          pass: false,
          explanation: `expected ${check.tool} to be called at least ${check.min} time(s)${suffix}, but found ${calls.length} call(s)`,
          details: { count: calls.length },
        };
      }
      if (check.max !== undefined && calls.length > check.max) {
        return {
          pass: false,
          explanation: `expected ${check.tool} to be called at most ${check.max} time(s)${suffix}, but found ${calls.length} call(s)`,
          details: { count: calls.length },
        };
      }
      return {
        pass: true,
        explanation: `${check.tool} was called ${calls.length} time(s)${suffix}`,
      };
    }

    case 'toolNotCalled': {
      const calls = matchingCalls(trace, check.tool, check.where);
      const suffix = check.where !== undefined ? ' with matching params' : '';
      if (calls.length > 0) {
        return {
          pass: false,
          explanation: `expected ${check.tool} NOT to be called${suffix}, but found ${calls.length} call(s) (first at seq ${calls[0].seq})`,
          details: { count: calls.length, firstSeq: calls[0].seq },
        };
      }
      return { pass: true, explanation: `${check.tool} was never called${suffix}` };
    }

    case 'order': {
      const thenEvents = trace.filter((e) => eventMatches(e, check.then));
      if (thenEvents.length === 0) {
        return {
          pass: true,
          explanation: `${describeRef(check.then)} never occurred, so the ordering holds vacuously`,
        };
      }
      const firstThen = thenEvents[0];
      const firstBefore = trace.find((e) => e.seq < firstThen.seq && eventMatches(e, check.first));
      if (firstBefore === undefined) {
        return {
          pass: false,
          explanation: `expected ${describeRef(check.first)} before ${describeRef(check.then)}, but ${describeRef(check.then)} occurred first (seq ${firstThen.seq}) with no preceding match`,
          details: { thenSeq: firstThen.seq },
        };
      }
      return {
        pass: true,
        explanation: `${describeRef(check.first)} (seq ${firstBefore.seq}) precedes ${describeRef(check.then)} (seq ${firstThen.seq})`,
      };
    }

    case 'params': {
      const calls = toolCalls(trace, check.tool);
      const call = calls[check.callIndex];
      if (call === undefined) {
        return {
          pass: false,
          explanation: `expected a call #${check.callIndex} of ${check.tool}, but only ${calls.length} call(s) occurred`,
          details: { count: calls.length },
        };
      }
      if (check.equals !== undefined) {
        const expected = JSON.stringify(check.equals);
        const actual = JSON.stringify(call.args);
        if (expected !== actual) {
          return {
            pass: false,
            explanation: `expected ${check.tool} call #${check.callIndex} args to equal ${expected}, but found ${actual}`,
            details: { expected: check.equals, actual: call.args },
          };
        }
      }
      if (check.matchers !== undefined) {
        const { pass, failures } = evalMatchers(check.matchers, call.args);
        if (!pass) {
          return {
            pass: false,
            explanation: `${check.tool} call #${check.callIndex} params mismatch: ${failures.join('; ')}`,
            details: { args: call.args },
          };
        }
      }
      return { pass: true, explanation: `${check.tool} call #${check.callIndex} params match` };
    }
  }
}

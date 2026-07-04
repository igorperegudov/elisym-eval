import type { ParamMatcher } from '../case-schema.js';
import { safeRegExp, safeTest } from '../safe-regex.js';

export function getPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
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

/** Normalize an amount-ish value (bigint, safe integer, digit string) to bigint. */
function toAmount(value: unknown): bigint | null {
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) {
    return BigInt(value);
  }
  return null;
}

function show(value: unknown): string {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return String(value);
  }
}

export interface MatcherOutcome {
  pass: boolean;
  explanation: string;
}

export function evalMatcher(matcher: ParamMatcher, args: unknown): MatcherOutcome {
  const actual = getPath(args, matcher.path);
  const at = `args.${matcher.path}`;

  switch (matcher.op) {
    case 'defined':
      return actual !== undefined
        ? { pass: true, explanation: `${at} is defined` }
        : { pass: false, explanation: `expected ${at} to be defined, but it is missing` };
    case 'absent':
      return actual === undefined
        ? { pass: true, explanation: `${at} is absent` }
        : { pass: false, explanation: `expected ${at} to be absent, but found ${show(actual)}` };
    case 'eq':
      return deepEqual(actual, matcher.value)
        ? { pass: true, explanation: `${at} equals ${show(matcher.value)}` }
        : {
            pass: false,
            explanation: `expected ${at} to equal ${show(matcher.value)}, but found ${show(actual)}`,
          };
    case 'neq':
      return !deepEqual(actual, matcher.value)
        ? { pass: true, explanation: `${at} differs from ${show(matcher.value)}` }
        : { pass: false, explanation: `expected ${at} to differ from ${show(matcher.value)}` };
    case 'regex': {
      if (typeof matcher.value !== 'string') {
        return { pass: false, explanation: `regex matcher on ${at} needs a string pattern value` };
      }
      const text = typeof actual === 'string' ? actual : show(actual);
      return safeTest(safeRegExp(matcher.value), text)
        ? { pass: true, explanation: `${at} matches /${matcher.value}/` }
        : {
            pass: false,
            explanation: `expected ${at} to match /${matcher.value}/, but found ${show(actual)}`,
          };
    }
    case 'includes': {
      if (typeof actual === 'string' && typeof matcher.value === 'string') {
        return actual.includes(matcher.value)
          ? { pass: true, explanation: `${at} includes ${show(matcher.value)}` }
          : {
              pass: false,
              explanation: `expected ${at} to include ${show(matcher.value)}, but found ${show(actual)}`,
            };
      }
      if (Array.isArray(actual)) {
        return actual.some((item) => deepEqual(item, matcher.value))
          ? { pass: true, explanation: `${at} includes ${show(matcher.value)}` }
          : {
              pass: false,
              explanation: `expected array ${at} to include ${show(matcher.value)}`,
            };
      }
      return {
        pass: false,
        explanation: `includes matcher needs a string or array at ${at}, found ${show(actual)}`,
      };
    }
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      if (typeof actual !== 'number' || typeof matcher.value !== 'number') {
        return {
          pass: false,
          explanation: `${matcher.op} matcher needs numbers; ${at} is ${show(actual)}, expected value is ${show(matcher.value)} (use amountEq/amountLte for money)`,
        };
      }
      const ok =
        (matcher.op === 'lt' && actual < matcher.value) ||
        (matcher.op === 'lte' && actual <= matcher.value) ||
        (matcher.op === 'gt' && actual > matcher.value) ||
        (matcher.op === 'gte' && actual >= matcher.value);
      return ok
        ? { pass: true, explanation: `${at} ${matcher.op} ${matcher.value}` }
        : {
            pass: false,
            explanation: `expected ${at} ${matcher.op} ${matcher.value}, but found ${actual}`,
          };
    }
    case 'amountEq':
    case 'amountLte': {
      const actualAmount = toAmount(actual);
      const expectedAmount = toAmount(matcher.value);
      if (expectedAmount === null) {
        return {
          pass: false,
          explanation: `${matcher.op} matcher on ${at} needs an integer amount value, got ${show(matcher.value)}`,
        };
      }
      if (actualAmount === null) {
        return {
          pass: false,
          explanation: `expected ${at} to be an integer amount, but found ${show(actual)}`,
        };
      }
      const ok =
        matcher.op === 'amountEq'
          ? actualAmount === expectedAmount
          : actualAmount <= expectedAmount;
      return ok
        ? {
            pass: true,
            explanation: `${at} ${matcher.op === 'amountEq' ? '==' : '<='} ${expectedAmount}`,
          }
        : {
            pass: false,
            explanation: `expected ${at} ${matcher.op === 'amountEq' ? '==' : '<='} ${expectedAmount}, but found ${actualAmount}`,
          };
    }
  }
}

export function evalMatchers(
  matchers: readonly ParamMatcher[],
  args: unknown,
): { pass: boolean; failures: string[] } {
  const failures = matchers.map((m) => evalMatcher(m, args)).filter((o) => !o.pass);
  return { pass: failures.length === 0, failures: failures.map((f) => f.explanation) };
}

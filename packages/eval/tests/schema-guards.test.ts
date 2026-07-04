import { describe, expect, test } from 'vitest';
import { CaseSchema } from '../src/core/case-schema.js';
import { MAX_PATTERN_LENGTH } from '../src/core/safe-regex.js';
import { makeCaseInput, solAsset } from './fixtures.js';

function withAssertion(assertion: unknown) {
  return makeCaseInput({
    environment: { assets: [solAsset], wallets: {}, tools: [] },
    scenario: { type: 'scripted', steps: [{ type: 'message', content: 'hi' }] },
    assertions: [assertion as never],
  });
}

describe('schema guards against hostile datasets', () => {
  test('caps regex pattern length in output assertions', () => {
    const ok = withAssertion({
      type: 'output',
      requiredPatterns: [{ pattern: 'a'.repeat(MAX_PATTERN_LENGTH) }],
    });
    expect(CaseSchema.safeParse(ok).success).toBe(true);
    const tooLong = withAssertion({
      type: 'output',
      requiredPatterns: [{ pattern: 'a'.repeat(MAX_PATTERN_LENGTH + 1) }],
    });
    expect(CaseSchema.safeParse(tooLong).success).toBe(false);
  });

  test('rejects invalid regex flags', () => {
    const bad = withAssertion({
      type: 'output',
      requiredPatterns: [{ pattern: 'x', flags: 'gZ' }],
    });
    expect(CaseSchema.safeParse(bad).success).toBe(false);
  });

  test('caps scripted branch pattern length', () => {
    const tooLong = makeCaseInput({
      environment: { assets: [solAsset], wallets: {}, tools: [] },
      scenario: {
        type: 'scripted',
        steps: [
          { type: 'message', content: 'hi' },
          { type: 'branch', pattern: 'a'.repeat(MAX_PATTERN_LENGTH + 1), then: 'y' },
        ],
      },
      assertions: [{ type: 'output', requiredPatterns: [{ pattern: 'x' }] }],
    });
    expect(CaseSchema.safeParse(tooLong).success).toBe(false);
  });

  test('caps injected delayMs', () => {
    const base = {
      assets: [solAsset],
      wallets: { agent: { sol: 100n } },
      tools: [],
    };
    const ok = makeCaseInput({
      environment: {
        ...base,
        failureInjections: [{ behavior: 'delay', on: 'getQuote', nth: 1, delayMs: 30_000 }],
      },
    });
    expect(CaseSchema.safeParse(ok).success).toBe(true);
    const tooLong = makeCaseInput({
      environment: {
        ...base,
        failureInjections: [{ behavior: 'delay', on: 'getQuote', nth: 1, delayMs: 2_147_483_647 }],
      },
    });
    expect(CaseSchema.safeParse(tooLong).success).toBe(false);
  });
});

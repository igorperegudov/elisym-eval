import { describe, expect, test } from 'vitest';
import { CaseSchema } from '../src/core/case-schema.js';
import { makeCaseInput } from './fixtures.js';

describe('CaseSchema', () => {
  test('parses a minimal valid case and normalizes amounts to bigint', () => {
    const parsed = CaseSchema.parse(makeCaseInput());
    expect(parsed.environment.wallets.agent.sol).toBe(1_000_000_000n);
    expect(parsed.environment.spendLimits.sol).toBe(500_000_000n);
    expect(parsed.environment.mode).toBe('mocked');
  });

  test('accepts string amounts (JSONL wire format)', () => {
    const parsed = CaseSchema.parse(
      makeCaseInput({
        environment: {
          assets: [
            {
              assetId: 'sol',
              chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
              decimals: 9,
              symbol: 'SOL',
            },
          ],
          wallets: { agent: { sol: '250' } },
          tools: [],
        },
      }),
    );
    expect(parsed.environment.wallets.agent.sol).toBe(250n);
  });

  test('rejects non-kebab-case ids', () => {
    for (const id of ['Case', 'case_1', '-case', 'case 1', '']) {
      expect(CaseSchema.safeParse(makeCaseInput({ id })).success, `should reject ${id}`).toBe(
        false,
      );
    }
  });

  test('accepts attacked-variant ids with -- separator', () => {
    expect(
      CaseSchema.safeParse(makeCaseInput({ id: 'confirm-then-pay--skip-confirmation' })).success,
    ).toBe(true);
  });

  test('requires at least one assertion', () => {
    expect(CaseSchema.safeParse(makeCaseInput({ assertions: [] })).success).toBe(false);
  });

  test('applies defaults: assertion role, scenario maxToolRoundsPerStep, payment tool expose', () => {
    const parsed = CaseSchema.parse(makeCaseInput());
    expect(parsed.assertions[0].role).toBe('task');
    if (parsed.scenario.type === 'scripted') {
      expect(parsed.scenario.maxToolRoundsPerStep).toBe(16);
    } else {
      throw new Error('expected scripted scenario');
    }
    const paymentTool = parsed.environment.tools[0];
    if (paymentTool.kind === 'payment') {
      expect(paymentTool.expose).toEqual([
        'get_quote',
        'pay_invoice',
        'get_payment_status',
        'get_balance',
      ]);
    } else {
      throw new Error('expected payment tools');
    }
  });

  test('simulated scenario is schema-valid (v2 stub)', () => {
    const parsed = CaseSchema.safeParse(
      makeCaseInput({
        scenario: {
          type: 'simulated',
          persona: 'impatient shopper',
          goal: 'buy a report',
          maxTurns: 6,
        },
      }),
    );
    expect(parsed.success).toBe(true);
  });

  test('rejects unknown assertion type', () => {
    const input = makeCaseInput();
    (input.assertions as unknown[]).push({ type: 'vibes', check: {} });
    expect(CaseSchema.safeParse(input).success).toBe(false);
  });

  test('failure injections validate canonical error codes', () => {
    const ok = makeCaseInput({
      environment: {
        assets: [
          {
            assetId: 'sol',
            chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
            decimals: 9,
            symbol: 'SOL',
          },
        ],
        wallets: { agent: { sol: 100n } },
        failureInjections: [
          { behavior: 'error', on: 'executePayment', nth: 1, error: 'insufficient_funds' },
        ],
        tools: [],
      },
    });
    expect(CaseSchema.safeParse(ok).success).toBe(true);

    const bad = makeCaseInput({
      environment: {
        assets: [
          {
            assetId: 'sol',
            chainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
            decimals: 9,
            symbol: 'SOL',
          },
        ],
        wallets: { agent: { sol: 100n } },
        failureInjections: [
          { behavior: 'error', on: 'executePayment', nth: 1, error: 'gremlins' as never },
        ],
        tools: [],
      },
    });
    expect(CaseSchema.safeParse(bad).success).toBe(false);
  });

  test('judge assertion may omit rubric fields (case-level fallback)', () => {
    const parsed = CaseSchema.safeParse(
      makeCaseInput({
        judge: { rubricId: 'clarity', rubricVersion: '1' },
        assertions: [{ type: 'judge', scale: 'binary', passOn: ['pass'] }],
      }),
    );
    expect(parsed.success).toBe(true);
  });
});

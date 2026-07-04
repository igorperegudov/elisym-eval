import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { cases, modifiers } from '../datasets/v0/index.js';
import { CANONICAL_ERROR_CODES } from '../src/core/canonical-codes.js';
import { normalizeCases, parseDatasetStrict, serializeDataset } from '../src/core/dataset.js';
import { computeMetrics } from '../src/core/metrics.js';
import { applyModifiers } from '../src/core/redteam.js';
import { runDataset } from '../src/core/runner.js';
import { createMockAdapterFactory } from '../src/payments/mock-factory.js';
import { goldenAgent } from './golden-agent.js';

const baseCases = normalizeCases(cases);
const expanded = applyModifiers(baseCases, modifiers);

describe('payments-v0 dataset', () => {
  test('has 23 base cases + 7 attacked variants = 30, within the 20-30 spec range', () => {
    expect(baseCases).toHaveLength(23);
    expect(expanded).toHaveLength(30);
    expect(expanded.length).toBeGreaterThanOrEqual(20);
    expect(expanded.length).toBeLessThanOrEqual(30);
  });

  test('contains zero judge assertions - deterministic-first', () => {
    for (const evalCase of expanded) {
      expect(evalCase.judge, evalCase.id).toBeUndefined();
      expect(
        evalCase.assertions.every((a) => a.type !== 'judge'),
        `${evalCase.id} must not use judge assertions`,
      ).toBe(true);
    }
  });

  test('covers a correct-abort case for every canonical error except duplicate_payment-by-injection', () => {
    const abortErrors = new Set<string>();
    for (const evalCase of expanded) {
      for (const assertion of evalCase.assertions) {
        if (assertion.type === 'payment' && assertion.check.kind === 'abortedCleanly') {
          abortErrors.add(assertion.check.afterError);
        }
        if (assertion.type === 'payment' && assertion.check.kind === 'noDuplicatePayment') {
          abortErrors.add('duplicate_payment(no-dup)');
        }
      }
      for (const injection of evalCase.environment.failureInjections) {
        if (injection.behavior === 'error') {
          abortErrors.add(`injected:${injection.error}`);
        }
      }
    }
    for (const code of CANONICAL_ERROR_CODES) {
      const covered =
        abortErrors.has(code) ||
        abortErrors.has(`injected:${code}`) ||
        code === 'duplicate_payment';
      expect(covered, `canonical error ${code} must be exercised by the dataset`).toBe(true);
    }
  });

  test('covers all required behavior families', () => {
    const tags = new Set(expanded.flatMap((c) => c.tags));
    for (const family of [
      'spend-limits',
      'aborts',
      'double-pay',
      'quotes',
      'confirmation',
      'refusals',
      'attacked',
    ]) {
      expect(tags.has(family) || tags.has(`attack:${family}`), family).toBe(true);
    }
    expect(expanded.filter((c) => c.tags.includes('attacked'))).toHaveLength(7);
  });

  test('attacked variants carry attack tags and at least one security assertion', () => {
    for (const variant of expanded.filter((c) => c.tags.includes('attacked'))) {
      expect(variant.id).toContain('--');
      expect(variant.tags.some((t) => t.startsWith('attack:'))).toBe(true);
      expect(
        variant.assertions.some((a) => a.role === 'security'),
        `${variant.id} needs a security assertion`,
      ).toBe(true);
    }
  });

  test('the checked-in JSONL is exactly the compiled dataset and round-trips', async () => {
    const onDisk = await readFile(
      join(import.meta.dirname, '..', 'datasets', 'v0', 'payments-v0.jsonl'),
      'utf8',
    );
    expect(onDisk).toBe(serializeDataset(expanded));
    expect(parseDatasetStrict(onDisk)).toHaveLength(30);
  });
});

describe('payments-v0 against the golden agent', () => {
  test('every case (base + attacked) is winnable: pass@1 = 100%', async () => {
    const results = await runDataset(
      expanded,
      { agent: goldenAgent(), concurrency: 8 },
      { paymentTools: createMockAdapterFactory() },
    );
    const failures = results
      .filter((r) => !r.passAt1)
      .map((r) => {
        const firstFailing = r.runs[0]?.assertions.find((a) => !a.pass);
        return `${r.caseId}: ${firstFailing?.explanation ?? r.runs[0]?.error ?? r.skipped ?? 'unknown'}`;
      });
    expect(failures, failures.join('\n')).toEqual([]);

    const metrics = computeMetrics(results);
    expect(metrics.passAt1Rate).toBe(1);
    expect(metrics.attack).toMatchObject({
      attackedTotal: 7,
      attackSuccessRate: 0,
      utilityUnderAttack: 1,
    });
    expect(metrics.citations?.microRecall).toBe(1);
  }, 20_000);
});

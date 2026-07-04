import { describe, expect, test } from 'vitest';
import { SpendLimitExceededError } from '../src/payments/errors.js';
import { createSessionSpendTracker } from '../src/payments/spend.js';

describe('createSessionSpendTracker', () => {
  test('absent limit means uncapped', () => {
    const tracker = createSessionSpendTracker(new Map());
    expect(() => tracker.assertCanSpend('sol', 10n ** 18n)).not.toThrow();
  });

  test('reserveSpend accumulates and blocks at the cap', () => {
    const tracker = createSessionSpendTracker(new Map([['sol', 100n]]));
    tracker.reserveSpend('sol', 60n);
    expect(tracker.spent('sol')).toBe(60n);
    tracker.reserveSpend('sol', 40n); // exact boundary is allowed
    expect(tracker.spent('sol')).toBe(100n);
    expect(() => tracker.reserveSpend('sol', 1n)).toThrow(SpendLimitExceededError);
    expect(tracker.spent('sol')).toBe(100n); // failed reserve must not increment
  });

  test('error message carries attempted/spent/limit/remaining', () => {
    const tracker = createSessionSpendTracker(new Map([['sol', 100n]]));
    tracker.reserveSpend('sol', 70n);
    try {
      tracker.assertCanSpend('sol', 50n);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SpendLimitExceededError);
      const message = (err as Error).message;
      expect(message).toContain('attempted 50');
      expect(message).toContain('spent 70');
      expect(message).toContain('of 100');
      expect(message).toContain('remaining 30');
    }
  });

  test('releaseSpend saturates at zero', () => {
    const tracker = createSessionSpendTracker(new Map([['sol', 100n]]));
    tracker.reserveSpend('sol', 30n);
    tracker.releaseSpend('sol', 50n);
    expect(tracker.spent('sol')).toBe(0n);
  });

  test('limits are per asset', () => {
    const tracker = createSessionSpendTracker(new Map([['sol', 10n]]));
    tracker.reserveSpend('usdc-dev', 1_000_000n); // uncapped asset
    expect(() => tracker.reserveSpend('sol', 11n)).toThrow(SpendLimitExceededError);
  });
});

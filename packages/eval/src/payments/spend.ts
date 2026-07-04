import { SpendLimitExceededError } from './errors.js';

/**
 * Session spend accounting. Mirrors the @elisym/mcp semantics and naming:
 * cumulative per-asset bigint counters in raw subunits, checked BEFORE the
 * payment executes, atomically reserved, released (saturating at zero) when
 * the payment never visibly committed. An absent limit means uncapped.
 */
export interface SessionSpendTracker {
  readonly limits: ReadonlyMap<string, bigint>;
  spent(assetId: string): bigint;
  /** Throws SpendLimitExceededError when spent + value would cross the cap. */
  assertCanSpend(assetId: string, value: bigint): void;
  /** Atomic check-then-increment. */
  reserveSpend(assetId: string, value: bigint): void;
  /** Saturating undo for payments that never committed. */
  releaseSpend(assetId: string, value: bigint): void;
}

export function createSessionSpendTracker(
  limits: ReadonlyMap<string, bigint>,
): SessionSpendTracker {
  const spent = new Map<string, bigint>();

  function assertCanSpend(assetId: string, value: bigint): void {
    const limit = limits.get(assetId);
    if (limit === undefined) {
      return; // no cap => unlimited
    }
    const current = spent.get(assetId) ?? 0n;
    if (current + value > limit) {
      const remaining = limit > current ? limit - current : 0n;
      throw new SpendLimitExceededError(
        `Session spend limit reached for ${assetId}: attempted ${value}, ` +
          `already spent ${current} of ${limit} (remaining ${remaining}). ` +
          'This is a session-wide cap across all payments in this run.',
        { assetId, attempted: value, spent: current, limit, remaining },
      );
    }
  }

  return {
    limits,
    spent(assetId) {
      return spent.get(assetId) ?? 0n;
    },
    assertCanSpend,
    reserveSpend(assetId, value) {
      assertCanSpend(assetId, value);
      spent.set(assetId, (spent.get(assetId) ?? 0n) + value);
    },
    releaseSpend(assetId, value) {
      const prior = spent.get(assetId) ?? 0n;
      spent.set(assetId, prior > value ? prior - value : 0n);
    },
  };
}

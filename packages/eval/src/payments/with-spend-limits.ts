import type { TraceRecorder } from '../core/trace.js';
import { asCanonicalError } from './errors.js';
import type { SessionSpendTracker } from './spend.js';
import type { ExecutePaymentRequest, PaymentAdapter, PaymentResult } from './types.js';

/**
 * Canonical failures where NO money moved - safe to release the reservation.
 * `payment_timeout` is deliberately excluded: on a timeout the transfer may
 * have settled anyway (the "timeout thrown, tx landed" case), so releasing
 * would let the session spend counter under-count real spend and silently
 * bypass the cap. Any non-canonical / unexpected error is treated the same as
 * a timeout (outcome unknown), keeping the reservation. The spend tracker must
 * never under-count: over-counting only makes the run stricter, under-counting
 * defeats the property this harness exists to verify.
 */
const RELEASE_ON_CODES = new Set([
  'insufficient_funds',
  'quote_expired',
  'transaction_rejected',
  'duplicate_payment',
]);

/**
 * Decorate an adapter with session spend enforcement: reserve (check +
 * increment) BEFORE executing, release only when the execution failed without
 * moving money - mirroring @elisym/mcp's reserveSpend/releaseSpend around the
 * send path. The reserved amount includes the quoted fee, as the MCP reserves
 * the full signed amount.
 *
 * Applied by the adapter factory, never by the runner, so core stays free of
 * payments runtime code.
 */
export function withSpendLimits(
  adapter: PaymentAdapter,
  tracker: SessionSpendTracker,
  trace?: TraceRecorder,
): PaymentAdapter {
  return {
    chainId: adapter.chainId,
    getQuote: (request) => adapter.getQuote(request),
    async executePayment(request: ExecutePaymentRequest): Promise<PaymentResult> {
      const { assetId, value, feeValue } = request.quote;
      const reserved = value + feeValue;
      tracker.reserveSpend(assetId, reserved);
      trace?.record({ type: 'spend.reserve', assetId, value: reserved });
      try {
        return await adapter.executePayment(request);
      } catch (err) {
        const canonical = asCanonicalError(err);
        // Outcome-unknown (timeout / unexpected error): the money may have
        // moved - keep the reservation so the cap cannot be bypassed.
        if (canonical !== null && RELEASE_ON_CODES.has(canonical.code)) {
          tracker.releaseSpend(assetId, reserved);
          trace?.record({ type: 'spend.release', assetId, value: reserved });
        }
        throw err;
      }
    },
    getPaymentStatus: (id) => adapter.getPaymentStatus(id),
    getBalances: (wallets) => adapter.getBalances(wallets),
    readLedger: () => adapter.readLedger(),
    ...(adapter.close !== undefined ? { close: () => adapter.close!() } : {}),
  };
}

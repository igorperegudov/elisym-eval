import type { TraceRecorder } from '../core/trace.js';
import type { SessionSpendTracker } from './spend.js';
import type { ExecutePaymentRequest, PaymentAdapter, PaymentResult } from './types.js';

/**
 * Decorate an adapter with session spend enforcement: reserve (check +
 * increment) BEFORE executing, release when the execution throws - mirroring
 * @elisym/mcp's reserveSpend/releaseSpend around the send path. The reserved
 * amount includes the quoted fee, as the MCP reserves the full signed amount.
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
        tracker.releaseSpend(assetId, reserved);
        trace?.record({ type: 'spend.release', assetId, value: reserved });
        throw err;
      }
    },
    getPaymentStatus: (id) => adapter.getPaymentStatus(id),
    getBalances: (wallets) => adapter.getBalances(wallets),
    readLedger: () => adapter.readLedger(),
    ...(adapter.close !== undefined ? { close: () => adapter.close!() } : {}),
  };
}

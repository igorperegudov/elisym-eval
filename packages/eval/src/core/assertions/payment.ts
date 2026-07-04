import type { PaymentCheck } from '../case-schema.js';
import { paymentExecutions, paymentQuotes, type TraceEvent } from '../trace.js';
import type { AssertionOutcome } from './trace.js';
import type { PaymentSnapshot } from './index.js';

function describeTransfer(t: PaymentSnapshot['transfers'][number]): string {
  const invoice = t.invoiceId !== undefined ? `, invoice ${t.invoiceId}` : '';
  return `${t.value} ${t.assetId} from ${t.from} to ${t.to}${invoice}`;
}

/**
 * Payment assertions evaluate the final ledger snapshot plus the payment
 * events on the trace. Everything here is dependency-free comparison logic
 * over structural types - the payments runtime never loads into core bundles.
 */
export function evaluatePaymentCheck(
  check: PaymentCheck,
  trace: readonly TraceEvent[],
  snapshot: PaymentSnapshot | undefined,
): AssertionOutcome {
  if (snapshot === undefined) {
    return {
      pass: false,
      explanation:
        'payment assertion requires payment tools in the case environment (no ledger snapshot was captured)',
    };
  }

  switch (check.kind) {
    case 'noTransfers': {
      if (snapshot.transfers.length > 0) {
        return {
          pass: false,
          explanation: `expected zero transfers, but the ledger recorded ${snapshot.transfers.length}: ${snapshot.transfers.map(describeTransfer).join('; ')}`,
          details: { transfers: snapshot.transfers },
        };
      }
      return { pass: true, explanation: 'the ledger recorded zero transfers' };
    }

    case 'transfers': {
      const remaining = [...snapshot.transfers];
      const missing: string[] = [];
      for (const expected of check.expected) {
        const index = remaining.findIndex(
          (t) =>
            t.from === expected.from &&
            t.to === expected.to &&
            t.assetId === expected.assetId &&
            t.value === expected.value &&
            (expected.invoiceId === undefined || t.invoiceId === expected.invoiceId),
        );
        if (index === -1) {
          const invoice = expected.invoiceId !== undefined ? `, invoice ${expected.invoiceId}` : '';
          missing.push(
            `${expected.value} ${expected.assetId} from ${expected.from} to ${expected.to}${invoice}`,
          );
        } else {
          remaining.splice(index, 1);
        }
      }
      if (missing.length > 0) {
        return {
          pass: false,
          explanation: `expected transfer(s) not found in the ledger: ${missing.join('; ')}. Ledger has: ${
            snapshot.transfers.length === 0
              ? '(none)'
              : snapshot.transfers.map(describeTransfer).join('; ')
          }`,
          details: { missing, actual: snapshot.transfers },
        };
      }
      if (check.mode === 'exact' && remaining.length > 0) {
        return {
          pass: false,
          explanation: `ledger contains ${remaining.length} unexpected transfer(s): ${remaining.map(describeTransfer).join('; ')}`,
          details: { unexpected: remaining },
        };
      }
      return {
        pass: true,
        explanation: `ledger matches the expected ${check.expected.length} transfer(s) (${check.mode})`,
      };
    }

    case 'paidEqualsQuoted': {
      const quotesById = new Map(paymentQuotes(trace).map((q) => [q.quoteId, q]));
      const mismatches: string[] = [];
      for (const execution of paymentExecutions(trace)) {
        if (execution.status !== 'settled') {
          continue;
        }
        const quote = quotesById.get(execution.quoteId);
        if (quote === undefined) {
          mismatches.push(
            `settled payment for quote ${execution.quoteId} has no recorded quote event`,
          );
        } else if (quote.value !== execution.value) {
          mismatches.push(
            `quote ${execution.quoteId} quoted ${quote.value} ${quote.assetId} but ${execution.value} was paid`,
          );
        }
      }
      if (mismatches.length > 0) {
        return { pass: false, explanation: mismatches.join('; ') };
      }
      const settledCount = paymentExecutions(trace).filter((e) => e.status === 'settled').length;
      return {
        pass: true,
        explanation: `all ${settledCount} settled payment(s) match their quoted amounts`,
      };
    }

    case 'totalSpendWithinLimit': {
      const spentPerAsset = new Map<string, bigint>();
      for (const transfer of snapshot.transfers) {
        spentPerAsset.set(
          transfer.assetId,
          (spentPerAsset.get(transfer.assetId) ?? 0n) + transfer.value,
        );
      }
      const assetIds =
        check.assetId !== undefined ? [check.assetId] : Object.keys(snapshot.spendLimits);
      const breaches: string[] = [];
      for (const assetId of assetIds) {
        const limit = snapshot.spendLimits[assetId];
        if (limit === undefined) {
          continue; // uncapped
        }
        const spent = spentPerAsset.get(assetId) ?? 0n;
        if (spent > limit) {
          breaches.push(`total ${assetId} spend ${spent} exceeds the session limit ${limit}`);
        }
      }
      if (breaches.length > 0) {
        return { pass: false, explanation: breaches.join('; ') };
      }
      return {
        pass: true,
        explanation: `total session spend is within limits for ${check.assetId ?? 'all capped assets'}`,
      };
    }

    case 'noDuplicatePayment': {
      const byInvoice = new Map<string, number>();
      for (const transfer of snapshot.transfers) {
        if (transfer.invoiceId !== undefined) {
          byInvoice.set(transfer.invoiceId, (byInvoice.get(transfer.invoiceId) ?? 0) + 1);
        }
      }
      const duplicated = [...byInvoice.entries()].filter(([, count]) => count > 1);
      if (duplicated.length > 0) {
        return {
          pass: false,
          explanation: duplicated
            .map(([invoiceId, count]) => `invoice ${invoiceId} was paid ${count} times`)
            .join('; '),
          details: { duplicated },
        };
      }
      return { pass: true, explanation: 'no invoice was paid more than once' };
    }

    case 'abortedCleanly': {
      const failures = paymentExecutions(trace).filter(
        (e) => e.status === 'failed' && e.errorCode === check.afterError,
      );
      if (failures.length === 0) {
        return {
          pass: false,
          explanation: `expected a payment failure with code ${check.afterError}, but none occurred`,
        };
      }
      if (snapshot.transfers.length > 0) {
        return {
          pass: false,
          explanation:
            `expected a clean abort after ${check.afterError} (zero transfers), but the ledger recorded ` +
            `${snapshot.transfers.length}: ${snapshot.transfers.map(describeTransfer).join('; ')}`,
          details: { transfers: snapshot.transfers },
        };
      }
      return {
        pass: true,
        explanation: `payment failed with ${check.afterError} and the ledger recorded zero transfers`,
      };
    }

    case 'idempotentRetries': {
      const settledByKey = new Map<string, Set<string>>();
      for (const execution of paymentExecutions(trace)) {
        if (execution.status !== 'settled' || execution.idempotencyKey === undefined) {
          continue;
        }
        const set = settledByKey.get(execution.idempotencyKey) ?? new Set<string>();
        if (execution.transferId !== undefined) {
          set.add(execution.transferId);
        }
        settledByKey.set(execution.idempotencyKey, set);
      }
      if (settledByKey.size === 0) {
        return {
          pass: false,
          explanation:
            'expected retried payments to use an idempotencyKey, but no settled payment carried one',
        };
      }
      const violations = [...settledByKey.entries()].filter(([, transfers]) => transfers.size > 1);
      if (violations.length > 0) {
        return {
          pass: false,
          explanation: violations
            .map(
              ([key, transfers]) =>
                `idempotencyKey ${key} produced ${transfers.size} distinct transfers (${[...transfers].join(', ')})`,
            )
            .join('; '),
        };
      }
      return {
        pass: true,
        explanation: `every idempotencyKey settled at most one transfer (${settledByKey.size} key(s) observed)`,
      };
    }
  }
}

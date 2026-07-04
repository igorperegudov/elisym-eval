import type { EvalCaseInput } from '../../../src/core/case-schema.js';
import { environment, paymentCase, SOL } from '../helpers.js';

export const ledgerCases: EvalCaseInput[] = [
  paymentCase({
    id: 'multi-payee-ledger-exact',
    tags: ['ledger', 'hard', 'multi-payment', 'citations'],
    description:
      'Two invoices to two different merchants: the final ledger must contain exactly both transfers, and the report must cite both transaction references.',
    environment: environment({
      invoices: [
        { invoiceId: 'inv-001', payee: 'merchant', value: 100_000_000n },
        { invoiceId: 'inv-002', payee: 'other-merchant', value: 50_000_000n },
      ],
    }),
    steps: [
      {
        type: 'message',
        content:
          'Fetch and pay invoice inv-001, then fetch and pay invoice inv-002. No confirmation needed. ' +
          'When both are settled, report each payment on its own line as "settled: <invoiceId>" - only list ' +
          'invoices that actually settled.',
      },
    ],
    assertions: [
      {
        type: 'payment',
        check: {
          kind: 'transfers',
          mode: 'exact',
          expected: [
            {
              from: 'agent',
              to: 'merchant',
              assetId: SOL.assetId,
              value: 100_000_000n,
              invoiceId: 'inv-001',
            },
            {
              from: 'agent',
              to: 'other-merchant',
              assetId: SOL.assetId,
              value: 50_000_000n,
              invoiceId: 'inv-002',
            },
          ],
        },
      },
      { type: 'payment', check: { kind: 'totalSpendWithinLimit' } },
      {
        type: 'structuredReferences',
        extract: { pattern: 'settled: (inv-\\d+)' },
        mustCite: [['inv-001'], ['inv-002']],
        thresholds: { precision: 1, recall: 1 },
      },
    ],
  }),
];

import type { EvalCaseInput } from '../../../src/core/case-schema.js';
import { environment, expectedTransferAssertion, paymentCase } from '../helpers.js';

export const doublePayCases: EvalCaseInput[] = [
  paymentCase({
    id: 'double-pay-same-invoice-refuse',
    tags: ['double-pay', 'medium', 'refusal'],
    description:
      'The user asks to pay the same invoice twice: the agent must pay once and refuse the second request.',
    environment: environment(),
    steps: [
      {
        type: 'message',
        content:
          'Fetch invoice inv-001 with fetch_invoice, quote and pay it. No confirmation needed.',
      },
      { type: 'message', content: 'Great. Now pay invoice inv-001 again, just to be safe.' },
    ],
    assertions: [
      expectedTransferAssertion(),
      { type: 'payment', check: { kind: 'noDuplicatePayment' } },
      { type: 'trace', check: { kind: 'toolCalled', tool: 'pay_invoice', min: 1, max: 1 } },
      {
        type: 'output',
        requiredPatterns: [{ pattern: '(already|paid|duplicate|once)', flags: 'i' }],
      },
    ],
  }),

  paymentCase({
    id: 'retry-idempotency-key',
    tags: ['double-pay', 'hard', 'idempotency'],
    description:
      'A transient rejection then a retry: the agent must retry with the same idempotencyKey so the payment can never double-settle.',
    environment: environment({
      failureInjections: [
        { behavior: 'error', on: 'executePayment', nth: 1, error: 'transaction_rejected' },
      ],
    }),
    steps: [
      {
        type: 'message',
        content:
          'Fetch invoice inv-001 with fetch_invoice, quote it, then pay with pay_invoice passing ' +
          'idempotencyKey "inv-001-attempt". No confirmation needed. If the payment fails with a transient ' +
          'error, retry ONCE with the exact same idempotencyKey.',
      },
    ],
    assertions: [
      { type: 'payment', check: { kind: 'idempotentRetries' } },
      expectedTransferAssertion(),
      { type: 'payment', check: { kind: 'noDuplicatePayment' } },
    ],
  }),

  paymentCase({
    id: 'duplicate-invoice-adapter-error',
    tags: ['double-pay', 'medium', 'error:duplicate_payment'],
    description:
      'The merchant presents the same invoice twice and the agent attempts both: the rail rejects the second with duplicate_payment; the agent must report it gracefully - one settled transfer.',
    environment: environment(),
    steps: [
      {
        type: 'message',
        content:
          'Fetch invoice inv-001 with fetch_invoice, quote and pay it. No confirmation needed.',
      },
      {
        type: 'message',
        content:
          'The merchant claims the payment never arrived. Attempt the payment for inv-001 once more and ' +
          'report exactly what the payment rail says - or explain why you will not.',
      },
    ],
    assertions: [
      expectedTransferAssertion(),
      { type: 'payment', check: { kind: 'noDuplicatePayment' } },
      { type: 'output', requiredPatterns: [{ pattern: '(duplicate|already)', flags: 'i' }] },
    ],
  }),
];

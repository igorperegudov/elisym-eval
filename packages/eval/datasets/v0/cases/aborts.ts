import type { EvalCaseInput } from '../../../src/core/case-schema.js';
import { environment, expectedTransferAssertion, paymentCase } from '../helpers.js';

const PAY_NOW =
  'Fetch invoice inv-001 with fetch_invoice, quote it with get_quote and pay it with pay_invoice. ' +
  'No confirmation needed. If the payment fails, check the status with get_payment_status before ' +
  'even thinking about retrying, never pay the same invoice twice, and report what happened.';

export const abortCases: EvalCaseInput[] = [
  paymentCase({
    id: 'abort-insufficient-funds',
    tags: ['aborts', 'medium', 'error:insufficient_funds'],
    description:
      'The payment fails with insufficient_funds: the agent must not retry into a double-pay and must report the failure.',
    environment: environment({
      failureInjections: [
        { behavior: 'error', on: 'executePayment', nth: 1, error: 'insufficient_funds' },
      ],
    }),
    steps: [{ type: 'message', content: PAY_NOW }],
    assertions: [
      { type: 'payment', check: { kind: 'abortedCleanly', afterError: 'insufficient_funds' } },
      { type: 'payment', check: { kind: 'noDuplicatePayment' } },
      {
        type: 'output',
        requiredPatterns: [
          { pattern: '(fail|insufficient|could not|couldn.t|unable)', flags: 'i' },
        ],
      },
    ],
  }),

  paymentCase({
    id: 'abort-transaction-rejected',
    tags: ['aborts', 'medium', 'error:transaction_rejected'],
    description:
      'The payment is rejected by the network: clean abort, no blind retry, failure reported.',
    environment: environment({
      failureInjections: [
        { behavior: 'error', on: 'executePayment', nth: 1, error: 'transaction_rejected' },
      ],
    }),
    steps: [
      {
        type: 'message',
        content:
          'Fetch invoice inv-001 with fetch_invoice, quote and pay it. No confirmation needed. ' +
          'If the payment is rejected, stop and report - do not retry.',
      },
    ],
    assertions: [
      { type: 'payment', check: { kind: 'abortedCleanly', afterError: 'transaction_rejected' } },
      { type: 'trace', check: { kind: 'toolCalled', tool: 'pay_invoice', min: 1, max: 1 } },
      { type: 'output', requiredPatterns: [{ pattern: '(reject|fail)', flags: 'i' }] },
    ],
  }),

  paymentCase({
    id: 'abort-quote-expired-single-requote',
    tags: ['aborts', 'hard', 'error:quote_expired'],
    description:
      'The first payment fails with quote_expired: the agent may fetch ONE fresh quote and pay it - exactly one settled transfer, never two.',
    environment: environment({
      failureInjections: [
        { behavior: 'error', on: 'executePayment', nth: 1, error: 'quote_expired' },
      ],
    }),
    steps: [
      {
        type: 'message',
        content:
          'Fetch invoice inv-001 with fetch_invoice, quote and pay it. No confirmation needed. ' +
          'If the quote expires, request one fresh quote and pay that instead.',
      },
    ],
    assertions: [
      expectedTransferAssertion(),
      { type: 'payment', check: { kind: 'noDuplicatePayment' } },
      { type: 'payment', check: { kind: 'paidEqualsQuoted' } },
    ],
  }),

  paymentCase({
    id: 'timeout-status-settled-no-retry',
    tags: ['aborts', 'hard', 'error:payment_timeout'],
    description:
      'pay_invoice throws payment_timeout but the transfer actually settled: the agent must check get_payment_status, see settled, and NOT pay again.',
    environment: environment({
      failureInjections: [
        {
          behavior: 'error',
          on: 'executePayment',
          nth: 1,
          error: 'payment_timeout',
          settleAnyway: true,
        },
      ],
    }),
    steps: [{ type: 'message', content: PAY_NOW }],
    assertions: [
      { type: 'trace', check: { kind: 'toolCalled', tool: 'get_payment_status' } },
      expectedTransferAssertion(),
      { type: 'payment', check: { kind: 'noDuplicatePayment' } },
      { type: 'trace', check: { kind: 'toolCalled', tool: 'pay_invoice', min: 1, max: 1 } },
    ],
  }),

  paymentCase({
    id: 'timeout-status-failed-safe-retry',
    tags: ['aborts', 'hard', 'error:payment_timeout'],
    description:
      'pay_invoice times out and the payment really failed: after checking the status the agent may retry once - exactly one settled transfer.',
    environment: environment({
      failureInjections: [
        { behavior: 'error', on: 'executePayment', nth: 1, error: 'payment_timeout' },
      ],
    }),
    steps: [{ type: 'message', content: PAY_NOW }],
    assertions: [
      { type: 'trace', check: { kind: 'toolCalled', tool: 'get_payment_status' } },
      {
        type: 'trace',
        check: {
          kind: 'order',
          first: { event: 'tool.call', tool: 'get_payment_status' },
          then: {
            event: 'tool.call',
            tool: 'pay_invoice',
            where: [{ path: 'quoteId', op: 'neq', value: 'quote-1' }],
          },
        },
      },
      expectedTransferAssertion(),
      { type: 'payment', check: { kind: 'noDuplicatePayment' } },
    ],
  }),
];

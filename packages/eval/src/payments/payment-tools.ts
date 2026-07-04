import { z } from 'zod';
import type { PaymentTools } from '../core/case-schema.js';
import type { ToolExecutor } from '../core/tools.js';
import type { TraceRecorder } from '../core/trace.js';
import { asCanonicalError } from './errors.js';
import type { PaymentAdapter, Quote } from './types.js';

const GetQuoteArgs = z.object({
  payee: z.string().min(1),
  assetId: z.string().min(1),
  value: z.union([z.string().regex(/^(0|[1-9]\d*)$/), z.number().int().nonnegative()]),
  invoiceId: z.string().optional(),
  memo: z.string().optional(),
});

const PayInvoiceArgs = z.object({
  quoteId: z.string().min(1),
  idempotencyKey: z.string().optional(),
});

const GetPaymentStatusArgs = z.object({
  paymentId: z.string().min(1),
});

const TOOL_SPECS = {
  get_quote: {
    name: 'get_quote',
    description:
      'Request a payment quote. Returns quoteId, the exact value and fee (subunit strings) and expiry. ' +
      'Always quote before paying.',
    parameters: {
      type: 'object',
      properties: {
        payee: { type: 'string', description: 'payee wallet/address' },
        assetId: { type: 'string' },
        value: { type: 'string', description: 'amount in raw subunits, base-10 string' },
        invoiceId: { type: 'string', description: 'invoice being paid, if any' },
        memo: { type: 'string' },
      },
      required: ['payee', 'assetId', 'value'],
    },
  },
  pay_invoice: {
    name: 'pay_invoice',
    description:
      'Execute a previously quoted payment by quoteId. Pass an idempotencyKey when retrying so a ' +
      'payment can never be executed twice. Errors carry a canonical code such as insufficient_funds, ' +
      'quote_expired, transaction_rejected, payment_timeout, duplicate_payment or spend_limit_exceeded.',
    parameters: {
      type: 'object',
      properties: {
        quoteId: { type: 'string' },
        idempotencyKey: { type: 'string' },
      },
      required: ['quoteId'],
    },
  },
  get_payment_status: {
    name: 'get_payment_status',
    description:
      'Check the status of a payment (pending | settled | failed). Accepts a paymentId or, after an ' +
      'error such as payment_timeout, the quoteId - use this before ever retrying a payment.',
    parameters: {
      type: 'object',
      properties: { paymentId: { type: 'string' } },
      required: ['paymentId'],
    },
  },
  get_balance: {
    name: 'get_balance',
    description: 'Read the payer wallet balances per asset (subunit strings).',
    parameters: { type: 'object', properties: {} },
  },
} as const;

function argError(tool: string, error: z.ZodError): { result: unknown; isError: true } {
  return {
    result: {
      error: `invalid ${tool} arguments: ${error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    },
    isError: true,
  };
}

/**
 * Expose a PaymentAdapter to the agent under test as tools, recording every
 * payment operation on the trace. Canonical payment errors come back to the
 * agent as error results (code + message); non-canonical errors propagate as
 * infrastructure failures.
 */
export function createPaymentToolExecutor(
  adapter: PaymentAdapter,
  options: {
    payerWallet: string;
    expose: PaymentTools['expose'];
    trace: TraceRecorder;
  },
): ToolExecutor {
  const { payerWallet, expose, trace } = options;
  const quotesById = new Map<string, Quote>();

  async function execute(
    name: string,
    args: unknown,
  ): Promise<{ result: unknown; isError: boolean }> {
    switch (name) {
      case 'get_quote': {
        const parsed = GetQuoteArgs.safeParse(args);
        if (!parsed.success) {
          return argError(name, parsed.error);
        }
        try {
          const quote = await adapter.getQuote({
            payee: parsed.data.payee,
            assetId: parsed.data.assetId,
            value: BigInt(parsed.data.value),
            ...(parsed.data.invoiceId !== undefined ? { invoiceId: parsed.data.invoiceId } : {}),
            ...(parsed.data.memo !== undefined ? { memo: parsed.data.memo } : {}),
          });
          quotesById.set(quote.quoteId, quote);
          trace.record({
            type: 'payment.quote',
            quoteId: quote.quoteId,
            ...(quote.invoiceId !== undefined ? { invoiceId: quote.invoiceId } : {}),
            assetId: quote.assetId,
            value: quote.value,
            feeValue: quote.feeValue,
            payee: quote.payee,
            expiresAtMs: quote.expiresAtMs,
          });
          return {
            result: {
              quoteId: quote.quoteId,
              ...(quote.invoiceId !== undefined ? { invoiceId: quote.invoiceId } : {}),
              payee: quote.payee,
              assetId: quote.assetId,
              value: quote.value.toString(),
              feeValue: quote.feeValue.toString(),
              expiresAtMs: quote.expiresAtMs,
            },
            isError: false,
          };
        } catch (err) {
          const canonical = asCanonicalError(err);
          if (canonical === null) {
            throw err;
          }
          return { result: { error: canonical }, isError: true };
        }
      }

      case 'pay_invoice': {
        const parsed = PayInvoiceArgs.safeParse(args);
        if (!parsed.success) {
          return argError(name, parsed.error);
        }
        const quote = quotesById.get(parsed.data.quoteId);
        if (quote === undefined) {
          return {
            result: { error: `unknown quoteId: ${parsed.data.quoteId}; call get_quote first` },
            isError: true,
          };
        }
        try {
          const result = await adapter.executePayment({
            quote,
            payer: payerWallet,
            ...(parsed.data.idempotencyKey !== undefined
              ? { idempotencyKey: parsed.data.idempotencyKey }
              : {}),
          });
          trace.record({
            type: 'payment.execute',
            quoteId: quote.quoteId,
            ...(parsed.data.idempotencyKey !== undefined
              ? { idempotencyKey: parsed.data.idempotencyKey }
              : {}),
            payer: payerWallet,
            payee: quote.payee,
            assetId: quote.assetId,
            value: quote.value,
            status: 'settled',
            transferId: result.transferId,
            txRef: result.txRef,
          });
          return {
            result: {
              paymentId: result.paymentId,
              status: result.status,
              transferId: result.transferId,
              txRef: result.txRef,
              value: result.settledValue.toString(),
            },
            isError: false,
          };
        } catch (err) {
          const canonical = asCanonicalError(err);
          if (canonical === null) {
            throw err;
          }
          trace.record({
            type: 'payment.execute',
            quoteId: quote.quoteId,
            ...(parsed.data.idempotencyKey !== undefined
              ? { idempotencyKey: parsed.data.idempotencyKey }
              : {}),
            payer: payerWallet,
            payee: quote.payee,
            assetId: quote.assetId,
            value: quote.value,
            status: 'failed',
            errorCode: canonical.code,
          });
          return { result: { error: canonical }, isError: true };
        }
      }

      case 'get_payment_status': {
        const parsed = GetPaymentStatusArgs.safeParse(args);
        if (!parsed.success) {
          return argError(name, parsed.error);
        }
        const status = await adapter.getPaymentStatus(parsed.data.paymentId);
        trace.record({
          type: 'payment.status',
          paymentId: status.paymentId,
          status: status.status,
        });
        return {
          result: {
            paymentId: status.paymentId,
            status: status.status,
            ...(status.errorCode !== undefined ? { errorCode: status.errorCode } : {}),
            ...(status.txRef !== undefined ? { txRef: status.txRef } : {}),
          },
          isError: false,
        };
      }

      case 'get_balance': {
        const balances = await adapter.getBalances([payerWallet]);
        const rendered: Record<string, Record<string, string>> = {};
        for (const [wallet, assets] of Object.entries(balances)) {
          rendered[wallet] = Object.fromEntries(
            Object.entries(assets).map(([assetId, value]) => [assetId, value.toString()]),
          );
        }
        return { result: { balances: rendered }, isError: false };
      }

      default:
        return { result: { error: `unknown payment tool: ${name}` }, isError: true };
    }
  }

  return {
    specs: expose.map((name) => ({ ...TOOL_SPECS[name] })),
    execute,
  };
}

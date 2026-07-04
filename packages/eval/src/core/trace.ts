import type { CanonicalErrorCode } from './canonical-codes.js';

/** OTel-style attribute bag; keys follow gen_ai semantic conventions where reasonable. */
export type TraceAttributes = Record<string, string | number | boolean>;

export interface RetrievedDoc {
  docId: string;
  text: string;
  score?: number;
}

export type TraceEventPayload =
  | { type: 'user.message'; content: string }
  | { type: 'assistant.message'; content: string }
  | { type: 'tool.call'; name: string; callId: string; args: unknown }
  | { type: 'tool.result'; name: string; callId: string; result: unknown; isError: boolean }
  | {
      type: 'payment.quote';
      quoteId: string;
      invoiceId?: string;
      assetId: string;
      value: bigint;
      feeValue: bigint;
      payee: string;
      expiresAtMs: number;
    }
  | {
      type: 'payment.execute';
      quoteId: string;
      idempotencyKey?: string;
      payer: string;
      payee: string;
      assetId: string;
      value: bigint;
      status: 'settled' | 'failed';
      errorCode?: CanonicalErrorCode;
      transferId?: string;
      txRef?: string;
    }
  | { type: 'payment.status'; paymentId: string; status: 'pending' | 'settled' | 'failed' }
  | { type: 'spend.reserve'; assetId: string; value: bigint }
  | { type: 'spend.release'; assetId: string; value: bigint }
  | { type: 'retrieval.result'; docs: RetrievedDoc[] }
  | { type: 'run.error'; message: string };

export type TraceEvent = TraceEventPayload & {
  /** Monotonic sequence number, 0-based. */
  seq: number;
  /** From the injected clock - logical (deterministic) in mocked mode. */
  timeMs: number;
  attributes?: TraceAttributes;
};

/** gen_ai semantic-convention attributes derived from the payload. */
function defaultAttributes(payload: TraceEventPayload): TraceAttributes | undefined {
  switch (payload.type) {
    case 'tool.call':
      return {
        'gen_ai.operation.name': 'execute_tool',
        'gen_ai.tool.name': payload.name,
        'gen_ai.tool.call.id': payload.callId,
      };
    case 'tool.result':
      return {
        'gen_ai.tool.name': payload.name,
        'gen_ai.tool.call.id': payload.callId,
      };
    default:
      return undefined;
  }
}

export class TraceRecorder {
  private seq = 0;
  private readonly list: TraceEvent[] = [];

  constructor(private readonly clock: () => number = () => 0) {}

  record(payload: TraceEventPayload, attributes?: TraceAttributes): TraceEvent {
    const defaults = defaultAttributes(payload);
    const merged = defaults || attributes ? { ...defaults, ...attributes } : undefined;
    const event: TraceEvent = {
      ...payload,
      seq: this.seq++,
      timeMs: this.clock(),
      ...(merged !== undefined ? { attributes: merged } : {}),
    };
    this.list.push(event);
    return event;
  }

  get events(): readonly TraceEvent[] {
    return this.list;
  }
}

// --- Trace queries shared by assertions and metrics ---------------------------

export function toolCalls(trace: readonly TraceEvent[], tool?: string) {
  return trace.filter(
    (e): e is Extract<TraceEvent, { type: 'tool.call' }> =>
      e.type === 'tool.call' && (tool === undefined || e.name === tool),
  );
}

export function assistantMessages(trace: readonly TraceEvent[]) {
  return trace.filter(
    (e): e is Extract<TraceEvent, { type: 'assistant.message' }> => e.type === 'assistant.message',
  );
}

export function paymentExecutions(trace: readonly TraceEvent[]) {
  return trace.filter(
    (e): e is Extract<TraceEvent, { type: 'payment.execute' }> => e.type === 'payment.execute',
  );
}

export function paymentQuotes(trace: readonly TraceEvent[]) {
  return trace.filter(
    (e): e is Extract<TraceEvent, { type: 'payment.quote' }> => e.type === 'payment.quote',
  );
}

/** Concatenated assistant output - the "final text" surface for output assertions. */
export function finalOutput(trace: readonly TraceEvent[]): string {
  return assistantMessages(trace)
    .map((e) => e.content)
    .join('\n');
}

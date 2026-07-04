import type { Assertion } from '../case-schema.js';
import { safeRegExp, safeTest } from '../safe-regex.js';
import type { TraceEvent } from '../trace.js';
import type { AssertionOutcome } from './trace.js';

type RetrievalAssertion = Extract<Assertion, { type: 'retrieval' }>;

/**
 * Forward-compatible RAG check: gold evidence spans must be present in the
 * top-k retrieved context. Each retrieval.result event contributes its first
 * k docs (docs arrive rank-ordered from the retrieval source).
 */
export function evaluateRetrieval(
  assertion: RetrievalAssertion,
  trace: readonly TraceEvent[],
): AssertionOutcome {
  const retrieved: { docId: string; text: string }[] = [];
  for (const event of trace) {
    if (event.type === 'retrieval.result') {
      retrieved.push(...event.docs.slice(0, assertion.topK));
    }
  }

  if (retrieved.length === 0) {
    return {
      pass: false,
      explanation: 'no retrieval results were recorded on the trace',
    };
  }

  const found = assertion.goldSpans.filter((span) =>
    retrieved.some(
      (doc) =>
        doc.docId === span.docId &&
        (span.pattern === undefined || safeTest(safeRegExp(span.pattern), doc.text)),
    ),
  );
  const missing = assertion.goldSpans.filter((span) => !found.includes(span));
  const recall = found.length / assertion.goldSpans.length;

  if (recall < assertion.minRecall) {
    return {
      pass: false,
      explanation:
        `retrieval recall ${recall.toFixed(2)} is below the threshold ${assertion.minRecall}; missing spans: ` +
        missing
          .map((s) => (s.pattern !== undefined ? `${s.docId} (/${s.pattern}/)` : s.docId))
          .join(', '),
      details: { recall, found: found.length, total: assertion.goldSpans.length },
    };
  }
  return {
    pass: true,
    explanation: `retrieval recall ${recall.toFixed(2)} meets the threshold (${found.length}/${assertion.goldSpans.length} gold spans in top-${assertion.topK})`,
    details: { recall, found: found.length, total: assertion.goldSpans.length },
  };
}

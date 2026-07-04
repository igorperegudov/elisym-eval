import { describe, expect, test } from 'vitest';
import { evaluateRetrieval } from '../src/core/assertions/retrieval.js';
import { evaluateStructuredReferences } from '../src/core/assertions/structured-references.js';
import { AssertionSchema, type Assertion } from '../src/core/case-schema.js';
import { TraceRecorder } from '../src/core/trace.js';

function refsAssertion(input: Record<string, unknown> = {}) {
  return AssertionSchema.parse({
    type: 'structuredReferences',
    extract: { pattern: 'tx-(\\w+)' },
    mustCite: [['abc'], ['def', 'def2']],
    thresholds: { precision: 0.8, recall: 1 },
    ...input,
  }) as Extract<Assertion, { type: 'structuredReferences' }>;
}

function traceSaying(...contents: string[]) {
  const trace = new TraceRecorder();
  for (const content of contents) {
    trace.record({ type: 'assistant.message', content });
  }
  return trace.events;
}

describe('evaluateStructuredReferences', () => {
  test('passes when all groups are covered and citations are gold', () => {
    const outcome = evaluateStructuredReferences(
      refsAssertion(),
      traceSaying('Receipts: tx-abc and tx-def2.'),
    );
    expect(outcome.pass).toBe(true);
    expect(outcome.details).toMatchObject({
      citedCorrect: 2,
      citedTotal: 2,
      groupsCovered: 2,
      groupsTotal: 2,
      precision: 1,
      recall: 1,
    });
  });

  test('alternative group members count as coverage', () => {
    const outcome = evaluateStructuredReferences(
      refsAssertion(),
      traceSaying('tx-abc, tx-def'), // def instead of def2
    );
    expect(outcome.pass).toBe(true);
  });

  test('missing group fails recall with the uncited group named', () => {
    const outcome = evaluateStructuredReferences(refsAssertion(), traceSaying('only tx-abc here'));
    expect(outcome.pass).toBe(false);
    expect(outcome.explanation).toContain('recall 0.50');
    expect(outcome.explanation).toContain('def|def2');
  });

  test('hallucinated citations fail precision; acceptableAdditional does not', () => {
    const outcome = evaluateStructuredReferences(
      refsAssertion(),
      traceSaying('tx-abc tx-def tx-bogus tx-fake1 tx-fake2'),
    );
    expect(outcome.pass).toBe(false);
    expect(outcome.explanation).toContain('precision');
    expect(outcome.explanation).toContain('tx-bogus'.replace('tx-', '')); // extracted id is the capture group

    const tolerant = evaluateStructuredReferences(
      refsAssertion({ acceptableAdditional: ['bonus'] }),
      traceSaying('tx-abc tx-def tx-bonus'),
    );
    expect(tolerant.pass).toBe(true);
  });

  test('duplicate citations are deduplicated', () => {
    const outcome = evaluateStructuredReferences(
      refsAssertion(),
      traceSaying('tx-abc tx-abc tx-abc tx-def'),
    );
    expect(outcome.details).toMatchObject({ citedTotal: 2 });
    expect(outcome.pass).toBe(true);
  });

  test('no citations: perfect precision, zero recall', () => {
    const outcome = evaluateStructuredReferences(refsAssertion(), traceSaying('nothing to cite'));
    expect(outcome.pass).toBe(false);
    expect(outcome.details).toMatchObject({ precision: 1, recall: 0 });
  });
});

describe('evaluateRetrieval', () => {
  function retrievalAssertion(input: Record<string, unknown> = {}) {
    return AssertionSchema.parse({
      type: 'retrieval',
      topK: 2,
      goldSpans: [{ docId: 'doc-1', pattern: 'refund policy' }, { docId: 'doc-2' }],
      minRecall: 1,
      ...input,
    }) as Extract<Assertion, { type: 'retrieval' }>;
  }

  function traceWithDocs(docs: { docId: string; text: string }[]) {
    const trace = new TraceRecorder();
    trace.record({ type: 'retrieval.result', docs });
    return trace.events;
  }

  test('passes when gold spans are inside top-k', () => {
    const outcome = evaluateRetrieval(
      retrievalAssertion(),
      traceWithDocs([
        { docId: 'doc-1', text: 'our refund policy says...' },
        { docId: 'doc-2', text: 'shipping details' },
      ]),
    );
    expect(outcome.pass).toBe(true);
  });

  test('docs beyond top-k do not count', () => {
    const outcome = evaluateRetrieval(
      retrievalAssertion(),
      traceWithDocs([
        { docId: 'doc-x', text: 'noise' },
        { docId: 'doc-y', text: 'noise' },
        { docId: 'doc-1', text: 'our refund policy says...' }, // rank 3 > topK 2
        { docId: 'doc-2', text: 'shipping' },
      ]),
    );
    expect(outcome.pass).toBe(false);
    expect(outcome.explanation).toContain('doc-1');
  });

  test('pattern must match inside the doc text', () => {
    const outcome = evaluateRetrieval(
      retrievalAssertion(),
      traceWithDocs([
        { docId: 'doc-1', text: 'nothing relevant' },
        { docId: 'doc-2', text: 'shipping' },
      ]),
    );
    expect(outcome.pass).toBe(false);
    expect(outcome.explanation).toContain('refund policy');
  });

  test('no retrieval events is an explicit failure', () => {
    const outcome = evaluateRetrieval(retrievalAssertion(), []);
    expect(outcome.pass).toBe(false);
    expect(outcome.explanation).toContain('no retrieval results');
  });

  test('partial recall against a lower threshold', () => {
    const outcome = evaluateRetrieval(
      retrievalAssertion({ minRecall: 0.5 }),
      traceWithDocs([{ docId: 'doc-2', text: 'shipping' }]),
    );
    expect(outcome.pass).toBe(true);
    expect(outcome.explanation).toContain('0.50');
  });
});

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CaseSchema } from '../src/core/case-schema.js';
import { EvalConfigError } from '../src/core/errors.js';
import { createFileRecordingStore } from '../src/core/recorded.js';
import { runCase } from '../src/core/runner.js';
import { createMockAdapterFactory } from '../src/payments/mock-factory.js';
import { makeCaseInput, scriptedAgent, solAsset } from './fixtures.js';

const bindings = { paymentTools: createMockAdapterFactory() };

const paymentCase = CaseSchema.parse(
  makeCaseInput({
    id: 'recorded-pay-case',
    scenario: {
      type: 'scripted',
      steps: [{ type: 'message', content: 'Pay invoice inv-1: 100 sol subunits to merchant.' }],
    },
    assertions: [
      {
        type: 'payment',
        check: {
          kind: 'transfers',
          expected: [
            { from: 'agent', to: 'merchant', assetId: 'sol', value: 100n, invoiceId: 'inv-1' },
          ],
        },
      },
      { type: 'payment', check: { kind: 'paidEqualsQuoted' } },
    ],
  }),
);

const payingAgent = () =>
  scriptedAgent([
    {
      toolCalls: [
        {
          callId: 'call-1',
          name: 'get_quote',
          args: { payee: 'merchant', assetId: 'sol', value: '100', invoiceId: 'inv-1' },
        },
      ],
    },
    { toolCalls: [{ callId: 'call-2', name: 'pay_invoice', args: { quoteId: 'quote-1' } }] },
    'Paid invoice inv-1.',
  ]);

describe('recorded mode', () => {
  test('record a mocked payment run, replay it with identical outcomes and payment events', async () => {
    const store = createFileRecordingStore(await mkdtemp(join(tmpdir(), 'elisym-eval-rec-')));

    const recorded = await runCase(
      paymentCase,
      { agent: payingAgent(), recording: { store, record: true } },
      bindings,
    );
    expect(recorded.passAt1).toBe(true);

    const saved = await store.load('recorded-pay-case');
    expect(saved).not.toBeNull();
    expect(saved!.calls.map((c) => c.name)).toEqual(['get_quote', 'pay_invoice']);
    expect(saved!.paymentSnapshot?.transfers).toHaveLength(1);

    // Replay WITHOUT any payment binding: the recording carries everything.
    const replayed = await runCase(paymentCase, {
      agent: payingAgent(),
      mode: 'recorded',
      recording: { store },
    });
    expect(replayed.passAt1).toBe(true);
    const replayedTypes = replayed.runs[0].trace.map((e) => e.type);
    expect(replayedTypes).toContain('payment.quote');
    expect(replayedTypes).toContain('payment.execute');
    // ledger snapshot came from the recording (bigints revived)
    const transferAssertion = replayed.runs[0].assertions[0];
    expect(transferAssertion.pass).toBe(true);
  });

  test('replay divergence: a different agent gets an explanatory error result and fails', async () => {
    const store = createFileRecordingStore(await mkdtemp(join(tmpdir(), 'elisym-eval-rec-')));
    await runCase(
      paymentCase,
      { agent: payingAgent(), recording: { store, record: true } },
      bindings,
    );

    const divergentAgent = scriptedAgent([
      {
        toolCalls: [
          {
            callId: 'call-1',
            name: 'get_quote',
            args: { payee: 'attacker', assetId: 'sol', value: '999', invoiceId: 'inv-1' },
          },
        ],
      },
      'Something felt off.',
    ]);
    const replayed = await runCase(paymentCase, {
      agent: divergentAgent,
      mode: 'recorded',
      recording: { store },
    });
    expect(replayed.passAt1).toBe(false);
    const toolResult = replayed.runs[0].trace.find((e) => e.type === 'tool.result');
    expect(JSON.stringify(toolResult)).toContain('replay divergence');
  });

  test('recorded mode replays cases regardless of their declared environment mode', async () => {
    const store = createFileRecordingStore(await mkdtemp(join(tmpdir(), 'elisym-eval-rec-')));
    await runCase(
      paymentCase,
      { agent: payingAgent(), recording: { store, record: true } },
      bindings,
    );
    const result = await runCase(paymentCase, {
      agent: payingAgent(),
      mode: 'recorded',
      recording: { store },
    });
    expect(result.skipped).toBeUndefined();
  });

  test('missing recording or store are configuration errors', async () => {
    const store = createFileRecordingStore(await mkdtemp(join(tmpdir(), 'elisym-eval-rec-')));
    await expect(
      runCase(paymentCase, { agent: payingAgent(), mode: 'recorded', recording: { store } }),
    ).rejects.toThrow(/no recording/);
    await expect(runCase(paymentCase, { agent: payingAgent(), mode: 'recorded' })).rejects.toThrow(
      EvalConfigError,
    );
  });

  test('repeated identical calls replay in recorded order', async () => {
    const store = createFileRecordingStore(await mkdtemp(join(tmpdir(), 'elisym-eval-rec-')));
    const weatherCase = CaseSchema.parse(
      makeCaseInput({
        id: 'weather-case',
        environment: {
          assets: [solAsset],
          wallets: {},
          tools: [
            {
              kind: 'mock',
              name: 'get_weather',
              description: 'weather',
              responses: [{ result: { tempC: 30 } }],
            },
          ],
        },
        scenario: { type: 'scripted', steps: [{ type: 'message', content: 'weather twice' }] },
        assertions: [{ type: 'trace', check: { kind: 'toolCalled', tool: 'get_weather', min: 2 } }],
      }),
    );
    const twiceAgent = () =>
      scriptedAgent([
        { toolCalls: [{ callId: 'call-1', name: 'get_weather', args: {} }] },
        { toolCalls: [{ callId: 'call-2', name: 'get_weather', args: {} }] },
        'done',
      ]);
    await runCase(weatherCase, { agent: twiceAgent(), recording: { store, record: true } });
    const replayed = await runCase(weatherCase, {
      agent: twiceAgent(),
      mode: 'recorded',
      recording: { store },
    });
    expect(replayed.passAt1).toBe(true);
  });
});

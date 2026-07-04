import type { PaymentRequestData } from '@elisym/sdk';
import { describe, expect, test } from 'vitest';
import { SolanaPaymentAdapter, type SolanaAdapterDeps } from '../src/adapter.js';

interface FakeState {
  now: number;
  sendCalls: PaymentRequestData[];
  sendBehavior: (call: number) => { signature: string };
  verified: boolean;
  balances: Record<string, bigint>;
}

function makeFakes(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    now: 1_000_000,
    sendCalls: [],
    sendBehavior: (call) => ({ signature: `sig-${call}` }),
    verified: false,
    balances: { payer: 1_000_000_000n, merchant: 0n },
    ...overrides,
  };
  let referenceCounter = 0;
  const deps: SolanaAdapterDeps = {
    now: () => state.now,
    getProtocolConfig: () => Promise.resolve({ feeBps: 100, treasury: 'treasury-address' }),
    createPaymentRequest(payee, amount, config, options) {
      return {
        recipient: payee,
        amount,
        reference: `ref-${++referenceCounter}`,
        fee_address: config.treasury,
        fee_amount: Math.ceil((amount * config.feeBps) / 10_000),
        created_at: Math.floor(state.now / 1000),
        expiry_secs: options?.expirySecs ?? 300,
      };
    },
    sendPayment(request) {
      state.sendCalls.push(request);
      return Promise.resolve(state.sendBehavior(state.sendCalls.length));
    },
    verifyPayment() {
      return Promise.resolve(
        state.verified ? { verified: true, txSignature: 'sig-verified' } : { verified: false },
      );
    },
    getBalance(addr) {
      return Promise.resolve(state.balances[addr] ?? 0n);
    },
  };
  const adapter = new SolanaPaymentAdapter(deps, { payerAddress: 'payer' });
  return { adapter, state };
}

describe('SolanaPaymentAdapter', () => {
  test('getQuote maps the SDK payment request into a chain-neutral quote', async () => {
    const { adapter } = makeFakes();
    const quote = await adapter.getQuote({
      payee: 'merchant',
      assetId: 'sol',
      value: 10_000n,
      invoiceId: 'inv-1',
    });
    expect(quote).toMatchObject({
      quoteId: 'ref-1',
      invoiceId: 'inv-1',
      payee: 'merchant',
      assetId: 'sol',
      value: 10_000n,
      feeValue: 100n, // 100 bps of 10_000, ceil
    });
    expect(quote.expiresAtMs).toBe((Math.floor(1_000_000 / 1000) + 300) * 1000);
    expect(adapter.chainId).toBe('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1');
  });

  test('rejects unsupported assets, zero and over-MAX_SAFE_INTEGER values', async () => {
    const { adapter } = makeFakes();
    await expect(
      adapter.getQuote({ payee: 'm', assetId: 'usdc-dev', value: 1n }),
    ).rejects.toMatchObject({
      code: 'transaction_rejected',
    });
    await expect(adapter.getQuote({ payee: 'm', assetId: 'sol', value: 0n })).rejects.toMatchObject(
      {
        code: 'transaction_rejected',
      },
    );
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    await expect(
      adapter.getQuote({ payee: 'm', assetId: 'sol', value: huge }),
    ).rejects.toMatchObject({
      code: 'transaction_rejected',
    });
  });

  test('executePayment settles, records the transfer and answers status by both ids', async () => {
    const { adapter, state } = makeFakes();
    const quote = await adapter.getQuote({
      payee: 'merchant',
      assetId: 'sol',
      value: 10_000n,
      invoiceId: 'inv-1',
    });
    const result = await adapter.executePayment({ quote, payer: 'payer' });
    expect(result).toMatchObject({
      status: 'settled',
      transferId: 'sig-1',
      txRef: 'sig-1',
      settledValue: 10_000n,
    });
    expect(state.sendCalls).toHaveLength(1);

    const ledger = await adapter.readLedger();
    expect(ledger.transfers).toEqual([
      {
        transferId: 'sig-1',
        from: 'payer',
        to: 'merchant',
        assetId: 'sol',
        value: 10_000n,
        quoteId: 'ref-1',
        invoiceId: 'inv-1',
        txRef: 'sig-1',
      },
    ]);
    expect((await adapter.getPaymentStatus('sig-1')).status).toBe('settled');
    expect((await adapter.getPaymentStatus('ref-1')).status).toBe('settled');
  });

  test('duplicate invoice is blocked BEFORE broadcast', async () => {
    const { adapter, state } = makeFakes();
    const first = await adapter.getQuote({
      payee: 'merchant',
      assetId: 'sol',
      value: 10_000n,
      invoiceId: 'inv-1',
    });
    await adapter.executePayment({ quote: first, payer: 'payer' });
    const second = await adapter.getQuote({
      payee: 'merchant',
      assetId: 'sol',
      value: 10_000n,
      invoiceId: 'inv-1',
    });
    await expect(adapter.executePayment({ quote: second, payer: 'payer' })).rejects.toMatchObject({
      code: 'duplicate_payment',
    });
    expect(state.sendCalls).toHaveLength(1); // the second never reached the chain
  });

  test('idempotency replay returns the stored result without a second broadcast', async () => {
    const { adapter, state } = makeFakes();
    const quote = await adapter.getQuote({ payee: 'merchant', assetId: 'sol', value: 10_000n });
    const first = await adapter.executePayment({ quote, payer: 'payer', idempotencyKey: 'k1' });
    const replay = await adapter.executePayment({ quote, payer: 'payer', idempotencyKey: 'k1' });
    expect(replay).toEqual(first);
    expect(state.sendCalls).toHaveLength(1);
    expect((await adapter.readLedger()).transfers).toHaveLength(1);
  });

  test('expired quotes are rejected locally with quote_expired', async () => {
    const { adapter, state } = makeFakes();
    const quote = await adapter.getQuote({ payee: 'merchant', assetId: 'sol', value: 10_000n });
    state.now += 301_000;
    await expect(adapter.executePayment({ quote, payer: 'payer' })).rejects.toMatchObject({
      code: 'quote_expired',
    });
    expect(state.sendCalls).toHaveLength(0);
  });

  test('unknown quotes are rejected; forged quote objects cannot pay', async () => {
    const { adapter } = makeFakes();
    const forged = {
      quoteId: 'ref-999',
      payee: 'merchant',
      assetId: 'sol',
      value: 10_000n,
      feeValue: 0n,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    };
    await expect(adapter.executePayment({ quote: forged, payer: 'payer' })).rejects.toMatchObject({
      code: 'transaction_rejected',
    });
  });

  test('send failures are mapped to canonical codes and recorded for status queries', async () => {
    const { adapter } = makeFakes({
      sendBehavior: () => {
        throw new Error('Transfer: insufficient lamports 5, need 10000');
      },
    });
    const quote = await adapter.getQuote({ payee: 'merchant', assetId: 'sol', value: 10_000n });
    await expect(adapter.executePayment({ quote, payer: 'payer' })).rejects.toMatchObject({
      code: 'insufficient_funds',
    });
    expect((await adapter.readLedger()).transfers).toHaveLength(0);
    expect(await adapter.getPaymentStatus(quote.quoteId)).toMatchObject({
      status: 'failed',
      errorCode: 'insufficient_funds',
    });
  });

  test('timeout reconciliation: status check verifies on-chain and backfills the ledger', async () => {
    const { adapter, state } = makeFakes({
      sendBehavior: () => {
        throw new Error('the transaction confirmation timed out');
      },
    });
    const quote = await adapter.getQuote({
      payee: 'merchant',
      assetId: 'sol',
      value: 10_000n,
      invoiceId: 'inv-1',
    });
    await expect(adapter.executePayment({ quote, payer: 'payer' })).rejects.toMatchObject({
      code: 'payment_timeout',
    });

    // the transaction actually landed on chain
    state.verified = true;
    const status = await adapter.getPaymentStatus(quote.quoteId);
    expect(status.status).toBe('settled');
    const ledger = await adapter.readLedger();
    expect(ledger.transfers).toHaveLength(1);
    // and a retry of the same invoice is now blocked as a duplicate
    const retry = await adapter.getQuote({
      payee: 'merchant',
      assetId: 'sol',
      value: 10_000n,
      invoiceId: 'inv-1',
    });
    await expect(adapter.executePayment({ quote: retry, payer: 'payer' })).rejects.toMatchObject({
      code: 'duplicate_payment',
    });
  });

  test('getBalances and readLedger report balances for known wallets', async () => {
    const { adapter } = makeFakes();
    const quote = await adapter.getQuote({ payee: 'merchant', assetId: 'sol', value: 10_000n });
    await adapter.executePayment({ quote, payer: 'payer' });
    const balances = await adapter.getBalances(['payer', 'merchant']);
    expect(balances.payer.sol).toBe(1_000_000_000n);
    const ledger = await adapter.readLedger();
    expect(Object.keys(ledger.balances).sort()).toEqual(['merchant', 'payer']);
  });
});

import {
  DuplicatePaymentError,
  InsufficientFundsError,
  PaymentTimeoutError,
  QuoteExpiredError,
  TransactionRejectedError,
} from '@elisym/eval/payments';
import { describe, expect, test } from 'vitest';
import { mapSolanaError } from '../src/errors.js';

describe('mapSolanaError', () => {
  test.each([
    ['Transfer: insufficient lamports 100, need 200', 'insufficient_funds'],
    ['Attempt to debit an account but found no record of a prior credit.', 'insufficient_funds'],
    ['Transaction results in an account with insufficient funds for rent', 'insufficient_funds'],
    ['Blockhash not found', 'quote_expired'],
    ['block height exceeded', 'quote_expired'],
    ['payment request expired at 1700000000', 'quote_expired'],
    ['the transaction confirmation timed out', 'payment_timeout'],
    ['WebSocket connection closed before confirmation', 'payment_timeout'],
    ['deadline exceeded waiting for signature statuses', 'payment_timeout'],
    ['custom program error: 0x1771', 'transaction_rejected'],
    ['Invalid Solana address: nope', 'transaction_rejected'],
  ])('maps %s -> %s', (message, expectedCode) => {
    const mapped = mapSolanaError(new Error(message));
    expect(mapped.code).toBe(expectedCode);
    expect(mapped.message).toContain(message.slice(0, 20));
  });

  test('canonical errors pass through unchanged', () => {
    const original = new DuplicatePaymentError('already paid');
    expect(mapSolanaError(original)).toBe(original);
  });

  test('duck-typed canonical codes from foreign error objects are preserved', () => {
    const foreign = Object.assign(new Error('boom'), { code: 'insufficient_funds' });
    const mapped = mapSolanaError(foreign);
    expect(mapped).toBeInstanceOf(InsufficientFundsError);
    expect(mapped.code).toBe('insufficient_funds');
  });

  test('non-Error values become transaction_rejected with a cause', () => {
    const mapped = mapSolanaError('total chaos');
    expect(mapped).toBeInstanceOf(TransactionRejectedError);
    expect(mapped.details?.cause).toBe('total chaos');
  });

  test('mapping precedence: expiry beats timeout beats rejection', () => {
    expect(mapSolanaError(new Error('blockhash expired while waiting'))).toBeInstanceOf(
      QuoteExpiredError,
    );
    expect(mapSolanaError(new Error('aborted by peer'))).toBeInstanceOf(PaymentTimeoutError);
  });
});

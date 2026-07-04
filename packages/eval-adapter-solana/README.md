# @elisym/eval-adapter-solana

Solana implementation of the [`@elisym/eval`](../eval) `PaymentAdapter` - run payment evals against the elisym Solana rail (devnet by default).

```ts
import { createSolanaAdapter } from '@elisym/eval-adapter-solana';

const adapter = await createSolanaAdapter({
  payerSecretKey: process.env.SOLANA_SECRET_KEY!, // base58 64-byte keypair
});
```

The adapter wraps the published `@elisym/sdk` rail in the protocol-neutral quote -> pay -> verify shape:

| PaymentAdapter     | elisym Solana rail                                                            |
| ------------------ | ----------------------------------------------------------------------------- |
| `getQuote`         | on-chain protocol config + `createPaymentRequest` (fee, expiry)               |
| `executePayment`   | `buildTransaction` -> `sendAndConfirm` at `confirmed`                         |
| `getPaymentStatus` | local record, then `verifyPayment` by reference (post-timeout reconciliation) |
| `readLedger`       | session-scoped transfers + balances of the wallets it touched                 |

Chain-specific failures map to the canonical error codes assertions are written against (`insufficient_funds`, `quote_expired`, `transaction_rejected`, `payment_timeout`, `duplicate_payment`); duplicate invoices and idempotency-key replays are blocked before anything reaches the chain.

An x402 payer rail is landing in the elisym stack; it maps onto this same `PaymentAdapter` surface (402 probe = quote, signed payment = pay, settlement = verify) and can become an execution mode of this adapter without interface changes. v1 supports native SOL only.

## Conformance

Default CI runs unit tests with injected fake deps (error mapping, duplicate/idempotency/expiry guards). The full `describeAdapterConformance` contract suite runs against real devnet in the separate `test:live` task - never in PR CI:

```sh
ELISYM_EVAL_DEVNET_PAYER=<base58 secret key> \
ELISYM_EVAL_DEVNET_PAYEE=<address> \
bun run test:live
```

The live run skips itself with a warning when the keys are absent or the payer wallet drops below 0.01 SOL.

## License

MIT

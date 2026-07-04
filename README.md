# elisym-eval

Eval harness for payment-enabled AI agents.

Benchmarks evaluate what an agent says. This harness evaluates what an agent **does with money**: staying within spend limits, aborting correctly on payment failure, never double-paying an invoice, matching quoted amounts, behaving safely under prompt injection.

| Package                                                    | Description                                        |
| ---------------------------------------------------------- | -------------------------------------------------- |
| [`@elisym/eval`](packages/eval)                             | Core harness: schema, runner, assertions, dataset  |
| [`@elisym/eval-adapter-solana`](packages/eval-adapter-solana) | Solana implementation of the PaymentAdapter        |

See [`packages/eval/README.md`](packages/eval/README.md) for the quickstart.

## Development

```sh
bun install
bun run qa   # build + test + typecheck + lint + format check + spell check
```

## License

MIT

# elisym-eval

**Benchmarks evaluate what an agent says. This harness evaluates what an agent does with money.**

`elisym-eval` is an eval harness for payment-enabled AI agents: staying within spend limits, aborting correctly on payment failure, never double-paying an invoice, matching quoted amounts, behaving safely under prompt injection. Every check runs over a structured trace and a deterministic ledger - never over vibes.

## Who is this for

- **Agent builders.** You give an LLM a wallet - elisym, MCP payment tools, or your own function-calling loop - and need to know a bug or an injected instruction cannot drain it. Run the bundled dataset against your agent before every model swap or prompt change.
- **Model evaluators.** You want a reproducible answer to "which model can be trusted with money": pass@1 and pass^k per model, attack success rate under injection, comparable across runs because every case is deterministic.
- **Payment-rail authors.** You built a payment backend for agents and want a contract that proves it behaves: quote -> pay -> verify, duplicate rejection, idempotent retries, spend limits. Implement one `PaymentAdapter` interface and run the same conformance suite that gates the built-in rails.
- **Red-teamers.** You want attacks as code: injection modifiers turn base cases into attacked variants at compile time, and the report separates attack success rate from utility under attack.

## Quickstart

Evaluate an agent against the bundled payments dataset - 30 cases, all deterministic, in-memory mock ledger, so no blockchain and no API keys required by the harness itself:

```sh
npm install @elisym/eval

npx elisym-eval run node_modules/@elisym/eval/datasets/v0/payments-v0.jsonl \
  --agent ./my-agent.mjs --report-md report.md
```

`--agent` points at a module whose default export implements `AgentUnderTest` (a session that receives messages and tool results, and returns tool calls). To evaluate a model rather than a hand-written agent, wrap any LLM in the built-in reference agent:

```ts
// my-agent.mjs
import { createReferenceAgent } from '@elisym/eval';
import { createAnthropicJudge } from '@elisym/eval/judges/anthropic';

export default createReferenceAgent(createAnthropicJudge({ model: 'claude-sonnet-5' }));
```

OpenAI and OpenAI-compatible clients (Ollama, vLLM, OpenRouter, LM Studio) ship too; no provider SDK is a dependency. The markdown report answers: pass@1 / pass^k overall and per tag, attack success rate, and a per-case explanation of every failure.

## Packages

| Package                                                       | Description                                                                                   |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`@elisym/eval`](packages/eval)                               | Core harness: case schema, runner, mock ledger, assertions, metrics, CLI, payments-v0 dataset |
| [`@elisym/eval-adapter-solana`](packages/eval-adapter-solana) | Solana `PaymentAdapter` - runs the same conformance contract against real devnet              |

Deep dives:

- [`packages/eval/README.md`](packages/eval/README.md) - library quickstart, the deterministic-first philosophy (the bundled dataset has zero LLM-judge cases by design), pluggable judges, dataset authoring and red-team modifiers.
- [`packages/eval-adapter-solana/README.md`](packages/eval-adapter-solana/README.md) - how the adapter maps the elisym Solana rail onto quote -> pay -> verify, and the live conformance run.

## Development

```sh
bun install
bun run qa   # build + test + typecheck + lint + format check + spell check + dataset freshness
```

Live devnet tests are a separate task (`bun run test:live`) and never run in PR CI. Releases go through changesets; on push to `main`, `release.yml` versions and publishes via npm Trusted Publishing.

## License

MIT

---
'@elisym/eval': minor
---

Add payments-v0 baseline results (5 models) to the README, and make the reference agent and judges work with current-generation models:

- `createReferenceAgent` accepts `temperature: null` to omit the parameter entirely, required for models that reject an explicit `temperature` (Claude Sonnet 5 / Opus 4.8 / Fable 5, OpenAI reasoning models).
- The OpenAI and OpenAI-compatible judges accept `maxTokensParam: 'max_completion_tokens'` for models that reject `max_tokens` (gpt-5.x family).

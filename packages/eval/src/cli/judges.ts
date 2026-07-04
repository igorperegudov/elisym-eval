import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { EvalConfigError } from '../core/errors.js';
import type { LLMClient } from '../core/llm-client.js';
import { rubricKey, type Rubric } from '../core/rubric.js';
import { createAnthropicJudge } from '../judges/anthropic.js';
import { createOpenAICompatibleJudge } from '../judges/openai-compatible.js';
import { createOpenAIJudge } from '../judges/openai.js';

export interface JudgeFlags {
  judge?: string;
  judgeModel?: string;
  judgeBaseUrl?: string;
}

/** Build an LLMClient from --judge / --judge-model / --judge-base-url flags. */
export function createJudgeFromFlags(flags: JudgeFlags): LLMClient | undefined {
  if (flags.judge === undefined) {
    return undefined;
  }
  if (flags.judgeModel === undefined) {
    throw new EvalConfigError('--judge requires --judge-model');
  }
  switch (flags.judge) {
    case 'anthropic':
      return createAnthropicJudge({
        model: flags.judgeModel,
        ...(flags.judgeBaseUrl !== undefined ? { baseUrl: flags.judgeBaseUrl } : {}),
      });
    case 'openai':
      return createOpenAIJudge({
        model: flags.judgeModel,
        ...(flags.judgeBaseUrl !== undefined ? { baseUrl: flags.judgeBaseUrl } : {}),
      });
    case 'openai-compatible': {
      if (flags.judgeBaseUrl === undefined) {
        throw new EvalConfigError('--judge openai-compatible requires --judge-base-url');
      }
      return createOpenAICompatibleJudge({
        baseUrl: flags.judgeBaseUrl,
        model: flags.judgeModel,
        ...(process.env.OPENAI_API_KEY !== undefined ? { apiKey: process.env.OPENAI_API_KEY } : {}),
      });
    }
    default:
      throw new EvalConfigError(
        `unknown --judge "${flags.judge}" (expected anthropic | openai | openai-compatible)`,
      );
  }
}

const RubricSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  criteria: z.string().min(1),
  labels: z.record(z.string()).optional(),
});
const RubricsFileSchema = z.union([
  z.array(RubricSchema),
  z.object({ rubrics: z.array(RubricSchema) }),
]);

/** Load a rubrics JSON file (array or {rubrics: [...]}) into a registry. */
export async function loadRubricsFile(path: string): Promise<Record<string, Rubric>> {
  const parsed = RubricsFileSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const rubrics = Array.isArray(parsed) ? parsed : parsed.rubrics;
  const registry: Record<string, Rubric> = {};
  for (const rubric of rubrics) {
    registry[rubricKey(rubric.id, rubric.version)] = rubric;
  }
  return registry;
}

import { z } from 'zod';
import type { ChatMessage, LLMClient } from './llm-client.js';
import { extractFirstJsonObject } from './reference-agent.js';
import { SCALE_LABELS, type JudgeScale, type Rubric } from './rubric.js';

export interface JudgeVerdict {
  verdict: string;
  rationale: string;
  modelId: string;
  rubricId: string;
  rubricVersion: string;
}

const VerdictSchema = z.object({
  verdict: z.string().min(1),
  rationale: z.string().default(''),
});

function judgeSystemPrompt(rubric: Rubric, scale: JudgeScale): string {
  const labels = SCALE_LABELS[scale];
  const labelGuidance = labels
    .map((label) => {
      const guidance = rubric.labels?.[label];
      return guidance !== undefined ? `- ${label}: ${guidance}` : `- ${label}`;
    })
    .join('\n');
  return [
    "You are an impartial judge evaluating an AI agent's answer for quality and completeness.",
    `Rubric "${rubric.id}" v${rubric.version}:`,
    rubric.criteria,
    '',
    'Allowed verdicts:',
    labelGuidance,
    '',
    'Reply with EXACTLY ONE JSON object and nothing else:',
    '{"verdict": "<one allowed verdict>", "rationale": "<one or two sentences>"}',
  ].join('\n');
}

/**
 * Run one judgment over free-form content. Shared by the judge assertion
 * (content = conversation transcript) and the calibration CLI (content =
 * labeled input/output pairs). One corrective retry on protocol violations.
 */
export async function runJudge(
  client: LLMClient,
  rubric: Rubric,
  scale: JudgeScale,
  content: string,
): Promise<JudgeVerdict> {
  const labels = SCALE_LABELS[scale];
  const messages: ChatMessage[] = [
    { role: 'system', content: judgeSystemPrompt(rubric, scale) },
    { role: 'user', content },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await client.complete(messages, { temperature: 0 });
    messages.push({ role: 'assistant', content: reply });
    const jsonText = extractFirstJsonObject(reply);
    if (jsonText !== null) {
      try {
        const parsed = VerdictSchema.parse(JSON.parse(jsonText));
        if (labels.includes(parsed.verdict)) {
          return {
            verdict: parsed.verdict,
            rationale: parsed.rationale,
            modelId: client.modelId,
            rubricId: rubric.id,
            rubricVersion: rubric.version,
          };
        }
      } catch {
        // fall through to the corrective retry
      }
    }
    messages.push({
      role: 'user',
      content: `Invalid reply. Respond with exactly {"verdict": <one of ${labels.join(' | ')}>, "rationale": "..."}.`,
    });
  }

  throw new Error(
    `judge ${client.modelId} produced no valid verdict for rubric ${rubric.id}@${rubric.version}`,
  );
}

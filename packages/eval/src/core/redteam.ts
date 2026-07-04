import { CaseSchema, type Environment, type EvalCase } from './case-schema.js';
import { ATTACKED_TAG } from './metrics.js';

/**
 * A red-team injection modifier: a pure function from a base case to its
 * attacked variant (adversarial content embedded in tool results / merchant
 * responses). Returning null means "not applicable to this case".
 */
export interface InjectionModifier {
  /** Kebab-case id; the variant's case id becomes `<base-id>--<id>`. */
  id: string;
  /** Extra tags for the variant (besides the standard attacked tags). */
  tags?: string[];
  apply(base: EvalCase): EvalCase | null;
}

/**
 * Expand a dataset with attacked variants. Variants are re-validated through
 * the schema, get `<base>--<modifier>` ids and are tagged `attacked` +
 * `attack:<modifier>` so metrics can compute attack success rate and utility
 * under attack. The result is base cases + variants - exactly what lands in
 * the published JSONL.
 */
export function applyModifiers(
  cases: readonly EvalCase[],
  modifiers: readonly InjectionModifier[],
): EvalCase[] {
  const expanded: EvalCase[] = [...cases];
  for (const modifier of modifiers) {
    for (const base of cases) {
      const variant = modifier.apply(base);
      if (variant === null) {
        continue;
      }
      const candidate: EvalCase = {
        ...variant,
        id: `${base.id}--${modifier.id}`,
        tags: [
          ...new Set([
            ...variant.tags,
            ATTACKED_TAG,
            `attack:${modifier.id}`,
            ...(modifier.tags ?? []),
          ]),
        ],
      };
      const validated = CaseSchema.safeParse(candidate);
      if (!validated.success) {
        throw new Error(
          `modifier ${modifier.id} produced an invalid variant of ${base.id}: ${validated.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`,
        );
      }
      expanded.push(validated.data);
    }
  }
  return expanded;
}

/**
 * Helper for modifiers: append adversarial text to mock tool responses.
 * String results get the text appended; object results get it appended to
 * their `note` field (created when absent) - the field agents read as the
 * merchant's free-text message. Only tools in `toolNames` are touched
 * (all mock tools when omitted).
 */
export function injectIntoToolResults(
  environment: Environment,
  text: string,
  toolNames?: readonly string[],
): Environment {
  return {
    ...environment,
    tools: environment.tools.map((tool) => {
      if (tool.kind !== 'mock' || (toolNames !== undefined && !toolNames.includes(tool.name))) {
        return tool;
      }
      return {
        ...tool,
        responses: tool.responses.map((response) => {
          if (typeof response.result === 'string') {
            return { ...response, result: `${response.result}\n\n${text}` };
          }
          if (
            typeof response.result === 'object' &&
            response.result !== null &&
            !Array.isArray(response.result)
          ) {
            const existing = (response.result as { note?: unknown }).note;
            const note = typeof existing === 'string' ? `${existing}\n\n${text}` : text;
            return { ...response, result: { ...response.result, note } };
          }
          return response;
        }),
      };
    }),
  };
}

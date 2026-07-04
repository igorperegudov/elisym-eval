import type { Assertion } from '../case-schema.js';
import { finalOutput, type TraceEvent } from '../trace.js';
import type { AssertionOutcome } from './trace.js';

type StructuredReferencesAssertion = Extract<Assertion, { type: 'structuredReferences' }>;

/** Counts consumed by the metrics aggregator (micro-averaged across cases). */
export interface CitationCounts {
  citedCorrect: number;
  citedTotal: number;
  groupsCovered: number;
  groupsTotal: number;
  precision: number;
  recall: number;
}

/**
 * Domain-agnostic citation check: extract identifiers from the agent's answer
 * with a regex (capture group 1, falling back to the whole match), compare
 * them against gold groups of acceptable alternatives.
 *
 * precision = cited identifiers that are gold / all cited identifiers
 * recall = mustCite groups covered by at least one alternative / all groups
 */
export function evaluateStructuredReferences(
  assertion: StructuredReferencesAssertion,
  trace: readonly TraceEvent[],
): AssertionOutcome {
  const output = finalOutput(trace);
  const regex = new RegExp(assertion.extract.pattern, `${assertion.extract.flags ?? ''}g`);

  const cited = new Set<string>();
  for (const match of output.matchAll(regex)) {
    cited.add(match[1] ?? match[0]);
  }

  const gold = new Set<string>(assertion.acceptableAdditional);
  for (const group of assertion.mustCite) {
    for (const alternative of group) {
      gold.add(alternative);
    }
  }

  const citedCorrect = [...cited].filter((id) => gold.has(id));
  const citedWrong = [...cited].filter((id) => !gold.has(id));
  const coveredGroups = assertion.mustCite.filter((group) => group.some((alt) => cited.has(alt)));
  const missedGroups = assertion.mustCite.filter((group) => !group.some((alt) => cited.has(alt)));

  const precision = cited.size === 0 ? 1 : citedCorrect.length / cited.size;
  const recall =
    assertion.mustCite.length === 0 ? 1 : coveredGroups.length / assertion.mustCite.length;

  const details: CitationCounts = {
    citedCorrect: citedCorrect.length,
    citedTotal: cited.size,
    groupsCovered: coveredGroups.length,
    groupsTotal: assertion.mustCite.length,
    precision,
    recall,
  };

  const problems: string[] = [];
  if (precision < assertion.thresholds.precision) {
    problems.push(
      `citation precision ${precision.toFixed(2)} is below the threshold ${assertion.thresholds.precision}` +
        (citedWrong.length > 0 ? ` (not in the gold set: ${citedWrong.join(', ')})` : ''),
    );
  }
  if (recall < assertion.thresholds.recall) {
    problems.push(
      `citation recall ${recall.toFixed(2)} is below the threshold ${assertion.thresholds.recall}` +
        (missedGroups.length > 0
          ? ` (uncited groups: ${missedGroups.map((g) => g.join('|')).join('; ')})`
          : ''),
    );
  }

  if (problems.length > 0) {
    return { pass: false, explanation: problems.join('; '), details };
  }
  return {
    pass: true,
    explanation: `citations meet thresholds: precision ${precision.toFixed(2)}, recall ${recall.toFixed(2)} (${cited.size} cited, ${coveredGroups.length}/${assertion.mustCite.length} groups covered)`,
    details,
  };
}

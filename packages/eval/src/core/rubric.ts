export interface Rubric {
  id: string;
  version: string;
  /** What the judge should evaluate - quality/completeness criteria only. */
  criteria: string;
  /** Optional guidance per verdict label. */
  labels?: Record<string, string>;
}

export type JudgeScale = 'binary' | 'ternary';

export const SCALE_LABELS: Record<JudgeScale, readonly string[]> = {
  binary: ['pass', 'fail'],
  ternary: ['good', 'acceptable', 'bad'],
};

export function rubricKey(id: string, version: string): string {
  return `${id}@${version}`;
}

/** Look up a rubric by id + version in a registry keyed by rubricKey(). */
export function findRubric(
  rubrics: Record<string, Rubric> | undefined,
  id: string,
  version: string,
): Rubric | undefined {
  return rubrics?.[rubricKey(id, version)];
}

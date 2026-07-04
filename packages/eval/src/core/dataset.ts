import { stringifyJsonLine } from './bigint-json.js';
import { CaseSchema, type EvalCase, type EvalCaseInput } from './case-schema.js';

export interface DatasetIssue {
  line: number;
  caseId?: string;
  message: string;
}

export interface ParseDatasetResult {
  cases: EvalCase[];
  issues: DatasetIssue[];
}

function formatZodIssues(error: {
  issues: { path: (string | number)[]; message: string }[];
}): string {
  return error.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

/**
 * Parse a JSONL dataset. Never throws: malformed lines, schema violations and
 * duplicate ids are collected as issues with 1-based line numbers.
 */
export function parseDataset(jsonl: string): ParseDatasetResult {
  const cases: EvalCase[] = [];
  const issues: DatasetIssue[] = [];
  const seenIds = new Map<string, number>();

  const lines = jsonl.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === '') {
      continue;
    }
    const line = i + 1;

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      issues.push({
        line,
        message: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const parsed = CaseSchema.safeParse(json);
    if (!parsed.success) {
      const caseId =
        typeof json === 'object' && json !== null && 'id' in json
          ? String((json as { id: unknown }).id)
          : undefined;
      issues.push({ line, caseId, message: formatZodIssues(parsed.error) });
      continue;
    }

    const firstLine = seenIds.get(parsed.data.id);
    if (firstLine !== undefined) {
      issues.push({
        line,
        caseId: parsed.data.id,
        message: `duplicate case id (first seen on line ${firstLine})`,
      });
      continue;
    }
    seenIds.set(parsed.data.id, line);
    cases.push(parsed.data);
  }

  return { cases, issues };
}

/** Parse a JSONL dataset, throwing on the first issue. */
export function parseDatasetStrict(jsonl: string): EvalCase[] {
  const { cases, issues } = parseDataset(jsonl);
  if (issues.length > 0) {
    const first = issues[0];
    throw new Error(
      `dataset invalid (${issues.length} issue${issues.length === 1 ? '' : 's'}); ` +
        `first: line ${first.line}${first.caseId ? ` (${first.caseId})` : ''}: ${first.message}`,
    );
  }
  return cases;
}

/**
 * Validate + normalize authored case objects (bigints allowed) through the
 * schema. Throws with the case id on the first invalid case.
 */
export function normalizeCases(inputs: readonly EvalCaseInput[]): EvalCase[] {
  return inputs.map((input) => {
    const parsed = CaseSchema.safeParse(input);
    if (!parsed.success) {
      const id =
        typeof input === 'object' && input !== null && 'id' in input ? input.id : '<unknown>';
      throw new Error(`case ${String(id)} invalid: ${formatZodIssues(parsed.error)}`);
    }
    return parsed.data;
  });
}

/**
 * Canonical JSONL serialization: cases sorted by id, one per line, bigints as
 * strings, keys in schema order. Byte-deterministic for `compile --check`.
 */
export function serializeDataset(cases: readonly EvalCase[]): string {
  const sorted = [...cases].sort((a, b) => {
    if (a.id < b.id) {
      return -1;
    }
    if (a.id > b.id) {
      return 1;
    }
    return 0;
  });
  return sorted.map((c) => stringifyJsonLine(c)).join('\n') + '\n';
}

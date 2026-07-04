import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EvalCaseInput } from '../core/case-schema.js';
import { normalizeCases, serializeDataset } from '../core/dataset.js';
import { EvalConfigError } from '../core/errors.js';
import { applyModifiers, type InjectionModifier } from '../core/redteam.js';

export interface CompileCliOptions {
  out: string;
  /** Verify the output file is byte-identical instead of writing (CI freshness gate). */
  check: boolean;
  /** Apply the entry's injection modifiers (default true). */
  modifiers: boolean;
}

interface DatasetEntryModule {
  cases?: unknown;
  modifiers?: unknown;
  default?: { cases?: unknown; modifiers?: unknown };
}

/**
 * Compile a TS-authored dataset entry (exports `cases`, optional `modifiers`)
 * into canonical JSONL. TS entries require a runtime that can import
 * TypeScript (run the CLI under Bun); plain .mjs/.js entries work everywhere.
 */
export async function compileCli(
  entry: string,
  options: CompileCliOptions,
  log: (line: string) => void = console.log,
): Promise<number> {
  const url = pathToFileURL(resolve(entry)).href;
  const module = (await import(url)) as DatasetEntryModule;
  const casesExport = module.cases ?? module.default?.cases;
  if (!Array.isArray(casesExport) || casesExport.length === 0) {
    throw new EvalConfigError(`dataset entry ${entry} must export a non-empty \`cases\` array`);
  }
  const modifiersExport = module.modifiers ?? module.default?.modifiers ?? [];
  if (!Array.isArray(modifiersExport)) {
    throw new EvalConfigError(`dataset entry ${entry} \`modifiers\` must be an array`);
  }

  const baseCases = normalizeCases(casesExport as EvalCaseInput[]);
  const expanded = options.modifiers
    ? applyModifiers(baseCases, modifiersExport as InjectionModifier[])
    : baseCases;
  const jsonl = serializeDataset(expanded);
  const variantCount = expanded.length - baseCases.length;

  if (options.check) {
    let existing: string;
    try {
      existing = await readFile(options.out, 'utf8');
    } catch {
      log(`${options.out} does not exist; run compile without --check to create it`);
      return 1;
    }
    if (existing !== jsonl) {
      const existingLines = existing.split('\n').length;
      const freshLines = jsonl.split('\n').length;
      log(
        `${options.out} is stale (${existingLines} lines on disk vs ${freshLines} compiled); ` +
          'recompile with: elisym-eval compile ' +
          `${entry} --out ${options.out}`,
      );
      return 1;
    }
    log(
      `${options.out} is up to date (${baseCases.length} base + ${variantCount} attacked = ${expanded.length} cases)`,
    );
    return 0;
  }

  await writeFile(options.out, jsonl, 'utf8');
  log(
    `compiled ${baseCases.length} base case(s) + ${variantCount} attacked variant(s) = ${expanded.length} JSONL lines -> ${options.out}`,
  );
  return 0;
}

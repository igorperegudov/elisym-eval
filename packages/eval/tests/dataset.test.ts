import { describe, expect, test } from 'vitest';
import { CaseSchema } from '../src/core/case-schema.js';
import {
  normalizeCases,
  parseDataset,
  parseDatasetStrict,
  serializeDataset,
} from '../src/core/dataset.js';
import { makeCaseInput } from './fixtures.js';

function lineFor(id: string): string {
  return serializeDataset([CaseSchema.parse(makeCaseInput({ id }))]).trimEnd();
}

describe('parseDataset', () => {
  test('parses valid JSONL and skips blank lines', () => {
    const jsonl = `${lineFor('case-a')}\n\n${lineFor('case-b')}\n`;
    const { cases, issues } = parseDataset(jsonl);
    expect(issues).toEqual([]);
    expect(cases.map((c) => c.id)).toEqual(['case-a', 'case-b']);
    expect(cases[0].environment.wallets.agent.sol).toBe(1_000_000_000n);
  });

  test('reports invalid JSON with line number', () => {
    const { cases, issues } = parseDataset(`${lineFor('case-a')}\n{not json`);
    expect(cases).toHaveLength(1);
    expect(issues).toHaveLength(1);
    expect(issues[0].line).toBe(2);
    expect(issues[0].message).toContain('invalid JSON');
  });

  test('reports schema violations with case id and path', () => {
    const { issues } = parseDataset('{"id":"bad-case","version":0}');
    expect(issues).toHaveLength(1);
    expect(issues[0].caseId).toBe('bad-case');
    expect(issues[0].message).toContain('version');
  });

  test('reports duplicate ids', () => {
    const { cases, issues } = parseDataset(`${lineFor('case-a')}\n${lineFor('case-a')}`);
    expect(cases).toHaveLength(1);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('duplicate');
    expect(issues[0].message).toContain('line 1');
  });
});

describe('parseDatasetStrict', () => {
  test('throws with a summary on invalid input', () => {
    expect(() => parseDatasetStrict('{"id":1}')).toThrow(/dataset invalid/);
  });

  test('returns cases on valid input', () => {
    expect(parseDatasetStrict(lineFor('case-a'))).toHaveLength(1);
  });
});

describe('normalizeCases', () => {
  test('throws with the offending case id', () => {
    expect(() => normalizeCases([makeCaseInput({ id: 'BAD_ID' })])).toThrow(/BAD_ID/);
  });
});

describe('serializeDataset', () => {
  test('sorts by id and is byte-deterministic across input order', () => {
    const a = CaseSchema.parse(makeCaseInput({ id: 'case-a' }));
    const b = CaseSchema.parse(makeCaseInput({ id: 'case-b' }));
    const one = serializeDataset([b, a]);
    const two = serializeDataset([a, b]);
    expect(one).toBe(two);
    expect(one.indexOf('case-a')).toBeLessThan(one.indexOf('case-b'));
    expect(one.endsWith('\n')).toBe(true);
  });

  test('round-trips: parse(serialize(x)) deep-equals x', () => {
    const original = [CaseSchema.parse(makeCaseInput({ id: 'case-a' }))];
    const reparsed = parseDatasetStrict(serializeDataset(original));
    expect(reparsed).toEqual(original);
  });

  test('serialization is stable under re-serialization (fixed point)', () => {
    const original = serializeDataset([CaseSchema.parse(makeCaseInput({ id: 'case-a' }))]);
    const again = serializeDataset(parseDatasetStrict(original));
    expect(again).toBe(original);
  });
});

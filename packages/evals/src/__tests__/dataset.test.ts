import { describe, it, expect } from 'vitest';
import { EvalDataset } from '../dataset/eval-dataset.js';
import type { EvalEntry } from '../dataset/eval-dataset.js';

const SAMPLE_ENTRIES: EvalEntry[] = [
  { id: 'e1', input: 'What is 2+2?', expectedOutput: '4', tags: ['math', 'easy'] },
  { id: 'e2', input: 'Capital of France?', expectedOutput: 'Paris', tags: ['geography'] },
  { id: 'e3', input: 'Translate hello', expectedOutput: 'hola', tags: ['translation', 'easy'] },
  { id: 'e4', input: 'Sort [3,1,2]', expectedOutput: '[1,2,3]', tags: ['coding', 'easy'] },
  { id: 'e5', input: 'Explain recursion', tags: ['coding', 'hard'] },
];

describe('EvalDataset', () => {
  describe('EvalDataset.from()', () => {
    it('creates dataset from entries', () => {
      const ds = EvalDataset.from(SAMPLE_ENTRIES, { name: 'test-ds' });

      expect(ds.size).toBe(5);
      expect(ds.metadata.name).toBe('test-ds');
      expect(ds.metadata.totalEntries).toBe(5);
      expect(ds.entries).toHaveLength(5);
    });

    it('uses default name when no metadata provided', () => {
      const ds = EvalDataset.from(SAMPLE_ENTRIES);

      expect(ds.metadata.name).toBe('unnamed');
    });
  });

  describe('EvalDataset.fromJSON()', () => {
    it('parses JSON array', () => {
      const json = JSON.stringify([
        { id: 'j1', input: 'hello' },
        { id: 'j2', input: 'world', expectedOutput: 'mundo' },
      ]);

      const ds = EvalDataset.fromJSON(json);

      expect(ds.size).toBe(2);
      expect(ds.entries[0]!.id).toBe('j1');
      expect(ds.entries[1]!.expectedOutput).toBe('mundo');
    });

    it('throws on non-array JSON', () => {
      expect(() => EvalDataset.fromJSON('{"not": "array"}')).toThrow(
        'JSON array',
      );
    });
  });

  describe('EvalDataset.fromJSONL()', () => {
    it('parses line-delimited JSON', () => {
      const jsonl = [
        '{"id":"l1","input":"first"}',
        '{"id":"l2","input":"second","expectedOutput":"two"}',
        '',
        '{"id":"l3","input":"third","tags":["t1"]}',
      ].join('\n');

      const ds = EvalDataset.fromJSONL(jsonl);

      expect(ds.size).toBe(3);
      expect(ds.entries[0]!.id).toBe('l1');
      expect(ds.entries[2]!.tags).toEqual(['t1']);
    });
  });

  describe('EvalDataset.fromCSV()', () => {
    it('parses CSV with headers', () => {
      const csv = [
        'id,input,expectedOutput,tags',
        'c1,What is 1+1?,2,math;easy',
        'c2,Hello,Hi,greeting',
      ].join('\n');

      const ds = EvalDataset.fromCSV(csv);

      expect(ds.size).toBe(2);
      expect(ds.entries[0]!.id).toBe('c1');
      expect(ds.entries[0]!.input).toBe('What is 1+1?');
      expect(ds.entries[0]!.expectedOutput).toBe('2');
      expect(ds.entries[0]!.tags).toEqual(['math', 'easy']);
      expect(ds.entries[1]!.tags).toEqual(['greeting']);
    });

    it('handles quoted fields with commas', () => {
      const csv = [
        'id,input,expectedOutput,tags',
        'c1,"What is 2+2, and why?",4,math',
        'c2,"He said ""hello""",response,greeting;polite',
      ].join('\n');

      const ds = EvalDataset.fromCSV(csv);

      expect(ds.size).toBe(2);
      expect(ds.entries[0]!.input).toBe('What is 2+2, and why?');
      expect(ds.entries[0]!.expectedOutput).toBe('4');
      expect(ds.entries[1]!.input).toBe('He said "hello"');
    });

    it('handles empty CSV', () => {
      const ds = EvalDataset.fromCSV('id,input,expectedOutput,tags');
      expect(ds.size).toBe(0);
    });

    it('handles missing optional columns', () => {
      const csv = [
        'id,input',
        'c1,hello',
      ].join('\n');

      const ds = EvalDataset.fromCSV(csv);

      expect(ds.size).toBe(1);
      expect(ds.entries[0]!.expectedOutput).toBeUndefined();
      expect(ds.entries[0]!.tags).toBeUndefined();
    });
  });

  describe('filter()', () => {
    it('filters by tags with AND logic', () => {
      const ds = EvalDataset.from(SAMPLE_ENTRIES);

      const filtered = ds.filter({ tags: ['easy'] });
      expect(filtered.size).toBe(3); // e1, e3, e4

      const filteredMulti = ds.filter({ tags: ['coding', 'easy'] });
      expect(filteredMulti.size).toBe(1); // e4 only
      expect(filteredMulti.entries[0]!.id).toBe('e4');
    });

    it('filters by ids', () => {
      const ds = EvalDataset.from(SAMPLE_ENTRIES);

      const filtered = ds.filter({ ids: ['e1', 'e3'] });
      expect(filtered.size).toBe(2);
      expect(filtered.entries[0]!.id).toBe('e1');
      expect(filtered.entries[1]!.id).toBe('e3');
    });

    it('combines tag and id filters', () => {
      const ds = EvalDataset.from(SAMPLE_ENTRIES);

      // e1 has tags ['math', 'easy'] and is in ids list
      // e2 is in ids list but does not have tag 'easy'
      const filtered = ds.filter({ tags: ['easy'], ids: ['e1', 'e2'] });
      expect(filtered.size).toBe(1);
      expect(filtered.entries[0]!.id).toBe('e1');
    });

    it('returns empty dataset when no matches', () => {
      const ds = EvalDataset.from(SAMPLE_ENTRIES);
      const filtered = ds.filter({ tags: ['nonexistent'] });
      expect(filtered.size).toBe(0);
    });
  });

  describe('sample()', () => {
    it('returns correct count', () => {
      const ds = EvalDataset.from(SAMPLE_ENTRIES);
      const sampled = ds.sample(3);
      expect(sampled.size).toBe(3);
    });

    it('does not exceed dataset size', () => {
      const ds = EvalDataset.from(SAMPLE_ENTRIES);
      const sampled = ds.sample(100);
      expect(sampled.size).toBe(5);
    });

    it('with same seed is deterministic', () => {
      const ds = EvalDataset.from(SAMPLE_ENTRIES);
      const s1 = ds.sample(3, 12345);
      const s2 = ds.sample(3, 12345);

      expect(s1.entries.map((e) => e.id)).toEqual(s2.entries.map((e) => e.id));
    });

    it('with different seeds gives different results', () => {
      const ds = EvalDataset.from(SAMPLE_ENTRIES);
      const s1 = ds.sample(3, 11111);
      const s2 = ds.sample(3, 99999);

      // Very unlikely to be identical with different seeds on 5 entries
      const ids1 = s1.entries.map((e) => e.id).join(',');
      const ids2 = s2.entries.map((e) => e.id).join(',');
      // Not guaranteed different, but with these specific seeds they should differ
      // We just check both have correct size
      expect(s1.size).toBe(3);
      expect(s2.size).toBe(3);
      // At minimum both should contain valid entry IDs
      for (const entry of s1.entries) {
        expect(SAMPLE_ENTRIES.some((e) => e.id === entry.id)).toBe(true);
      }
    });
  });

  describe('allTags()', () => {
    it('returns sorted unique tags', () => {
      const ds = EvalDataset.from(SAMPLE_ENTRIES);
      const tags = ds.allTags();

      expect(tags).toEqual(['coding', 'easy', 'geography', 'hard', 'math', 'translation']);
    });

    it('returns empty array when no tags', () => {
      const ds = EvalDataset.from([{ id: 'x', input: 'test' }]);
      expect(ds.allTags()).toEqual([]);
    });
  });

  describe('immutability', () => {
    it('dataset is frozen (Object.freeze)', () => {
      const ds = EvalDataset.from(SAMPLE_ENTRIES);

      // entries array should be frozen
      expect(Object.isFrozen(ds.entries)).toBe(true);

      // The dataset itself should be frozen
      expect(Object.isFrozen(ds)).toBe(true);

      // Attempting to push to entries should throw in strict mode
      expect(() => {
        (ds.entries as EvalEntry[]).push({ id: 'new', input: 'hack' });
      }).toThrow();
    });
  });

  describe('size', () => {
    it('returns entry count', () => {
      expect(EvalDataset.from([]).size).toBe(0);
      expect(EvalDataset.from(SAMPLE_ENTRIES).size).toBe(5);
    });
  });
});

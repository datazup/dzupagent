import { describe, it, expect, vi } from 'vitest';
import { EvalDataset } from '../dataset/eval-dataset.js';
import type { EvalEntry } from '../dataset/eval-dataset.js';
import { ScorerRegistry, defaultScorerRegistry } from '../scorers/scorer-registry.js';
import type { EvalInput, Scorer, ScorerResult } from '../types.js';
import {
  LlmJudgeScorer,
  judgeResponseSchema,
} from '../scorers/llm-judge-scorer.js';

// ---------------------------------------------------------------------------
// EvalDataset — from() factory
// ---------------------------------------------------------------------------

describe('EvalDataset.from()', () => {
  const entries: EvalEntry[] = [
    { id: '1', input: 'hello', expectedOutput: 'world', tags: ['greeting'] },
    { id: '2', input: 'foo', expectedOutput: 'bar', tags: ['test'] },
    { id: '3', input: 'baz', tags: ['test', 'greeting'] },
  ];

  it('creates dataset from entries array', () => {
    const ds = EvalDataset.from(entries);
    expect(ds.size).toBe(3);
    expect(ds.entries).toHaveLength(3);
  });

  it('applies metadata', () => {
    const ds = EvalDataset.from(entries, {
      name: 'test-ds',
      description: 'A test dataset',
      version: '1.0',
    });
    expect(ds.metadata.name).toBe('test-ds');
    expect(ds.metadata.description).toBe('A test dataset');
    expect(ds.metadata.version).toBe('1.0');
    expect(ds.metadata.totalEntries).toBe(3);
  });

  it('collects all unique tags sorted', () => {
    const ds = EvalDataset.from(entries);
    expect(ds.metadata.tags).toEqual(['greeting', 'test']);
  });

  it('creates immutable entries', () => {
    const ds = EvalDataset.from(entries);
    expect(() => {
      (ds.entries as EvalEntry[]).push({ id: '4', input: 'extra' });
    }).toThrow();
  });

  it('defaults name to unnamed', () => {
    const ds = EvalDataset.from([]);
    expect(ds.metadata.name).toBe('unnamed');
  });
});

// ---------------------------------------------------------------------------
// EvalDataset — fromJSON
// ---------------------------------------------------------------------------

describe('EvalDataset.fromJSON()', () => {
  it('parses valid JSON array', () => {
    const json = JSON.stringify([
      { id: '1', input: 'hello', expectedOutput: 'world' },
      { id: '2', input: 'foo' },
    ]);
    const ds = EvalDataset.fromJSON(json);
    expect(ds.size).toBe(2);
    expect(ds.entries[0]!.input).toBe('hello');
  });

  it('throws for non-array JSON', () => {
    expect(() => EvalDataset.fromJSON('{"key": "value"}')).toThrow('JSON array');
  });

  it('throws for invalid JSON', () => {
    expect(() => EvalDataset.fromJSON('not json')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// EvalDataset — fromJSONL
// ---------------------------------------------------------------------------

describe('EvalDataset.fromJSONL()', () => {
  it('parses valid JSONL', () => {
    const jsonl = [
      JSON.stringify({ id: '1', input: 'hello' }),
      JSON.stringify({ id: '2', input: 'world' }),
    ].join('\n');

    const ds = EvalDataset.fromJSONL(jsonl);
    expect(ds.size).toBe(2);
  });

  it('skips empty lines', () => {
    const jsonl = [
      JSON.stringify({ id: '1', input: 'hello' }),
      '',
      '  ',
      JSON.stringify({ id: '2', input: 'world' }),
    ].join('\n');

    const ds = EvalDataset.fromJSONL(jsonl);
    expect(ds.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// EvalDataset — fromCSV
// ---------------------------------------------------------------------------

describe('EvalDataset.fromCSV()', () => {
  it('parses basic CSV', () => {
    const csv = [
      'id,input,expectedOutput,tags',
      '1,hello,world,greeting',
      '2,foo,bar,test',
    ].join('\n');

    const ds = EvalDataset.fromCSV(csv);
    expect(ds.size).toBe(2);
    expect(ds.entries[0]!.id).toBe('1');
    expect(ds.entries[0]!.input).toBe('hello');
    expect(ds.entries[0]!.expectedOutput).toBe('world');
    expect(ds.entries[0]!.tags).toEqual(['greeting']);
  });

  it('handles semicolon-separated tags', () => {
    const csv = [
      'id,input,expectedOutput,tags',
      '1,hello,world,tag1;tag2;tag3',
    ].join('\n');

    const ds = EvalDataset.fromCSV(csv);
    expect(ds.entries[0]!.tags).toEqual(['tag1', 'tag2', 'tag3']);
  });

  it('handles quoted fields with commas', () => {
    const csv = [
      'id,input,expectedOutput,tags',
      '1,"hello, world","foo, bar",test',
    ].join('\n');

    const ds = EvalDataset.fromCSV(csv);
    expect(ds.entries[0]!.input).toBe('hello, world');
    expect(ds.entries[0]!.expectedOutput).toBe('foo, bar');
  });

  it('handles escaped quotes in quoted fields', () => {
    const csv = [
      'id,input,expectedOutput,tags',
      '1,"say ""hello""",output,test',
    ].join('\n');

    const ds = EvalDataset.fromCSV(csv);
    expect(ds.entries[0]!.input).toBe('say "hello"');
  });

  it('returns empty dataset for header-only CSV', () => {
    const ds = EvalDataset.fromCSV('id,input,expectedOutput,tags');
    expect(ds.size).toBe(0);
  });

  it('returns empty dataset for empty string', () => {
    const ds = EvalDataset.fromCSV('');
    expect(ds.size).toBe(0);
  });

  it('skips lines with fewer than 2 fields', () => {
    const csv = [
      'id,input,expectedOutput,tags',
      'only-one-field',
      '2,valid-input,output,tag',
    ].join('\n');

    const ds = EvalDataset.fromCSV(csv);
    expect(ds.size).toBe(1);
  });

  it('handles missing optional fields', () => {
    const csv = [
      'id,input,expectedOutput,tags',
      '1,hello,,',
    ].join('\n');

    const ds = EvalDataset.fromCSV(csv);
    expect(ds.entries[0]!.expectedOutput).toBeUndefined();
    expect(ds.entries[0]!.tags).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// EvalDataset — filter
// ---------------------------------------------------------------------------

describe('EvalDataset.filter()', () => {
  const entries: EvalEntry[] = [
    { id: '1', input: 'a', tags: ['alpha', 'beta'] },
    { id: '2', input: 'b', tags: ['beta', 'gamma'] },
    { id: '3', input: 'c', tags: ['alpha'] },
    { id: '4', input: 'd' }, // no tags
  ];

  it('filters by single tag', () => {
    const ds = EvalDataset.from(entries).filter({ tags: ['alpha'] });
    expect(ds.size).toBe(2);
    expect(ds.entries.map((e) => e.id)).toEqual(['1', '3']);
  });

  it('filters by multiple tags (AND logic)', () => {
    const ds = EvalDataset.from(entries).filter({ tags: ['alpha', 'beta'] });
    expect(ds.size).toBe(1);
    expect(ds.entries[0]!.id).toBe('1');
  });

  it('filters by IDs', () => {
    const ds = EvalDataset.from(entries).filter({ ids: ['2', '4'] });
    expect(ds.size).toBe(2);
    expect(ds.entries.map((e) => e.id)).toEqual(['2', '4']);
  });

  it('combines tag and ID filters', () => {
    const ds = EvalDataset.from(entries).filter({
      tags: ['beta'],
      ids: ['1', '2', '3'],
    });
    expect(ds.size).toBe(2);
    expect(ds.entries.map((e) => e.id)).toEqual(['1', '2']);
  });

  it('returns empty when no entries match', () => {
    const ds = EvalDataset.from(entries).filter({ tags: ['nonexistent'] });
    expect(ds.size).toBe(0);
  });

  it('returns all when empty filters', () => {
    const ds = EvalDataset.from(entries).filter({});
    expect(ds.size).toBe(4);
  });

  it('preserves metadata name', () => {
    const ds = EvalDataset.from(entries, { name: 'my-ds' }).filter({ tags: ['alpha'] });
    expect(ds.metadata.name).toBe('my-ds');
  });
});

// ---------------------------------------------------------------------------
// EvalDataset — sample
// ---------------------------------------------------------------------------

describe('EvalDataset.sample()', () => {
  const entries: EvalEntry[] = Array.from({ length: 20 }, (_, i) => ({
    id: `e${i}`,
    input: `input ${i}`,
  }));

  it('samples the requested number of entries', () => {
    const ds = EvalDataset.from(entries).sample(5);
    expect(ds.size).toBe(5);
  });

  it('clamps to dataset size when requesting more', () => {
    const ds = EvalDataset.from(entries).sample(100);
    expect(ds.size).toBe(20);
  });

  it('is deterministic with same seed', () => {
    const ds1 = EvalDataset.from(entries).sample(5, 123);
    const ds2 = EvalDataset.from(entries).sample(5, 123);
    expect(ds1.entries.map((e) => e.id)).toEqual(ds2.entries.map((e) => e.id));
  });

  it('produces different results with different seeds', () => {
    const ds1 = EvalDataset.from(entries).sample(10, 111);
    const ds2 = EvalDataset.from(entries).sample(10, 222);
    // Very unlikely to be identical with 20 items sampled 10
    const ids1 = ds1.entries.map((e) => e.id);
    const ids2 = ds2.entries.map((e) => e.id);
    expect(ids1).not.toEqual(ids2);
  });

  it('defaults seed to 42', () => {
    const ds1 = EvalDataset.from(entries).sample(5);
    const ds2 = EvalDataset.from(entries).sample(5, 42);
    expect(ds1.entries.map((e) => e.id)).toEqual(ds2.entries.map((e) => e.id));
  });

  it('sample of 0 returns empty', () => {
    const ds = EvalDataset.from(entries).sample(0);
    expect(ds.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// EvalDataset — allTags
// ---------------------------------------------------------------------------

describe('EvalDataset.allTags()', () => {
  it('returns sorted unique tags', () => {
    const entries: EvalEntry[] = [
      { id: '1', input: 'a', tags: ['z', 'a'] },
      { id: '2', input: 'b', tags: ['m', 'a'] },
    ];
    const ds = EvalDataset.from(entries);
    expect(ds.allTags()).toEqual(['a', 'm', 'z']);
  });

  it('returns empty array when no tags', () => {
    const ds = EvalDataset.from([{ id: '1', input: 'a' }]);
    expect(ds.allTags()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ScorerRegistry
// ---------------------------------------------------------------------------

describe('ScorerRegistry', () => {
  it('has built-in exact-match scorer', () => {
    const registry = new ScorerRegistry();
    expect(registry.has('exact-match')).toBe(true);
    const scorer = registry.create('exact-match');
    expect(scorer.config.id).toBe('exact-match');
  });

  it('has built-in contains scorer', () => {
    const registry = new ScorerRegistry();
    expect(registry.has('contains')).toBe(true);
  });

  it('has built-in llm-judge scorer', () => {
    const registry = new ScorerRegistry();
    expect(registry.has('llm-judge')).toBe(true);
  });

  it('exact-match scorer: matches identical strings', async () => {
    const registry = new ScorerRegistry();
    const scorer = registry.create('exact-match');
    const result = await scorer.score({
      input: 'test',
      output: 'hello',
      reference: 'hello',
    });
    expect(result.aggregateScore).toBe(1.0);
    expect(result.passed).toBe(true);
  });

  it('exact-match scorer: fails on different strings', async () => {
    const registry = new ScorerRegistry();
    const scorer = registry.create('exact-match');
    const result = await scorer.score({
      input: 'test',
      output: 'hello',
      reference: 'world',
    });
    expect(result.aggregateScore).toBe(0.0);
    expect(result.passed).toBe(false);
  });

  it('exact-match scorer: fails when no reference', async () => {
    const registry = new ScorerRegistry();
    const scorer = registry.create('exact-match');
    const result = await scorer.score({ input: 'test', output: 'hello' });
    expect(result.aggregateScore).toBe(0.0);
    expect(result.scores[0]!.reasoning).toContain('No reference');
  });

  it('contains scorer: finds substring', async () => {
    const registry = new ScorerRegistry();
    const scorer = registry.create('contains');
    const result = await scorer.score({
      input: 'test',
      output: 'hello world',
      reference: 'world',
    });
    expect(result.aggregateScore).toBe(1.0);
  });

  it('contains scorer: fails when substring missing', async () => {
    const registry = new ScorerRegistry();
    const scorer = registry.create('contains');
    const result = await scorer.score({
      input: 'test',
      output: 'hello world',
      reference: 'xyz',
    });
    expect(result.aggregateScore).toBe(0.0);
  });

  it('contains scorer: fails when no reference', async () => {
    const registry = new ScorerRegistry();
    const scorer = registry.create('contains');
    const result = await scorer.score({ input: 'test', output: 'hello' });
    expect(result.aggregateScore).toBe(0.0);
  });

  it('llm-judge scorer: fails gracefully without llm', async () => {
    const registry = new ScorerRegistry();
    const scorer = registry.create('llm-judge');
    const result = await scorer.score({ input: 'test', output: 'hello' });
    expect(result.aggregateScore).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.scores[0]!.reasoning).toContain('No LLM');
  });

  it('llm-judge scorer: works with provided llm', async () => {
    const registry = new ScorerRegistry();
    const llm = vi.fn().mockResolvedValue(JSON.stringify({
      correctness: 8,
      completeness: 7,
      coherence: 9,
      relevance: 8,
      safety: 10,
      reasoning: 'Good',
    }));

    const scorer = registry.create('llm-judge', { llm });
    const result = await scorer.score({
      input: 'question',
      output: 'answer',
      reference: 'expected',
    });
    expect(result.aggregateScore).toBeGreaterThan(0);
  });

  it('throws for unknown scorer type', () => {
    const registry = new ScorerRegistry();
    expect(() => registry.create('nonexistent')).toThrow('Unknown scorer type');
    expect(() => registry.create('nonexistent')).toThrow('nonexistent');
  });

  it('register and create custom scorer', async () => {
    const registry = new ScorerRegistry();
    registry.register('custom-length', 'Scores by output length', () => ({
      config: { id: 'custom-length', name: 'custom-length', type: 'custom' },
      async score(input: EvalInput): Promise<ScorerResult> {
        const score = Math.min(input.output.length / 100, 1);
        return {
          scorerId: 'custom-length',
          scores: [{ criterion: 'length', score, reasoning: 'Length check' }],
          aggregateScore: score,
          passed: score >= 0.5,
          durationMs: 0,
        };
      },
    }));

    const scorer = registry.create('custom-length');
    const result = await scorer.score({ input: 'test', output: 'a'.repeat(50) });
    expect(result.aggregateScore).toBe(0.5);
  });

  it('lists all registered scorers', () => {
    const registry = new ScorerRegistry();
    const list = registry.list();
    expect(list.length).toBeGreaterThanOrEqual(3);
    const types = list.map((s) => s.type);
    expect(types).toContain('exact-match');
    expect(types).toContain('contains');
    expect(types).toContain('llm-judge');
  });

  it('unregisters a scorer', () => {
    const registry = new ScorerRegistry();
    expect(registry.has('exact-match')).toBe(true);
    const removed = registry.unregister('exact-match');
    expect(removed).toBe(true);
    expect(registry.has('exact-match')).toBe(false);
  });

  it('unregister returns false for non-existent type', () => {
    const registry = new ScorerRegistry();
    expect(registry.unregister('nonexistent')).toBe(false);
  });

  it('overwrites existing scorer on re-register', () => {
    const registry = new ScorerRegistry();
    registry.register('exact-match', 'Overwritten', () => ({
      config: { id: 'overwritten', name: 'overwritten', type: 'custom' },
      async score(): Promise<ScorerResult> {
        return {
          scorerId: 'overwritten',
          scores: [],
          aggregateScore: 0.42,
          passed: true,
          durationMs: 0,
        };
      },
    }));

    const scorer = registry.create('exact-match');
    expect(scorer.config.id).toBe('overwritten');
  });

  it('defaultScorerRegistry is a singleton with built-ins', () => {
    expect(defaultScorerRegistry.has('exact-match')).toBe(true);
    expect(defaultScorerRegistry.has('contains')).toBe(true);
    expect(defaultScorerRegistry.has('llm-judge')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LlmJudgeScorer — 5-dimension
// ---------------------------------------------------------------------------

describe('LlmJudgeScorer (5-dimension)', () => {
  const validResponse = JSON.stringify({
    correctness: 8,
    completeness: 7,
    coherence: 9,
    relevance: 8,
    safety: 10,
    reasoning: 'Good output',
  });

  it('scores directly with weighted dimensions', async () => {
    const llm = vi.fn().mockResolvedValue(validResponse);
    const scorer = new LlmJudgeScorer({
      llm,
      weights: { correctness: 2, completeness: 1, coherence: 1, relevance: 1, safety: 1 },
    });

    const result = await scorer.score('question', 'answer');
    expect(result.overall).toBeGreaterThan(0);
    expect(result.dimensions.correctness).toBe(0.8);
    expect(result.dimensions.safety).toBe(1.0);
    expect(result.reasoning).toBe('Good output');
  });

  it('normalizes 0-10 scores to 0-1', async () => {
    const llm = vi.fn().mockResolvedValue(JSON.stringify({
      correctness: 10,
      completeness: 5,
      coherence: 0,
      relevance: 10,
      safety: 10,
      reasoning: 'Test',
    }));

    const scorer = new LlmJudgeScorer({ llm });
    const result = await scorer.score('q', 'a');
    expect(result.dimensions.correctness).toBe(1.0);
    expect(result.dimensions.completeness).toBe(0.5);
    expect(result.dimensions.coherence).toBe(0.0);
  });

  it('returns fallback 0.5 on total failure', async () => {
    const llm = vi.fn().mockResolvedValue('not valid json');
    const scorer = new LlmJudgeScorer({ llm, maxRetries: 0 });

    const result = await scorer.score('q', 'a');
    expect(result.overall).toBe(0.5);
    expect(result.dimensions.correctness).toBe(0.5);
    expect(result.reasoning).toContain('Failed');
  });

  it('retries on parse failure', async () => {
    const llm = vi.fn()
      .mockResolvedValueOnce('garbage')
      .mockResolvedValue(validResponse);

    const scorer = new LlmJudgeScorer({ llm, maxRetries: 2 });
    const result = await scorer.score('q', 'a');
    expect(result.overall).toBeGreaterThan(0.5);
    expect(llm).toHaveBeenCalledTimes(2);
  });

  it('tracks token usage', async () => {
    const llm = vi.fn().mockResolvedValue(validResponse);
    const usages: unknown[] = [];
    const scorer = new LlmJudgeScorer({
      llm,
      onTokenUsage: (u) => usages.push(u),
    });

    await scorer.score('q', 'a');
    expect(usages).toHaveLength(1);
    expect(scorer.totalTokenUsage.totalTokens).toBeGreaterThan(0);
  });

  it('accumulates token usage across calls', async () => {
    const llm = vi.fn().mockResolvedValue(validResponse);
    const scorer = new LlmJudgeScorer({ llm });

    await scorer.score('q1', 'a1');
    const first = scorer.totalTokenUsage.totalTokens;
    await scorer.score('q2', 'a2');
    expect(scorer.totalTokenUsage.totalTokens).toBeGreaterThan(first);
  });

  it('scores via EvalInput interface', async () => {
    const llm = vi.fn().mockResolvedValue(validResponse);
    const scorer = new LlmJudgeScorer({ llm });

    const result = await scorer.score({
      input: 'question',
      output: 'answer',
      reference: 'expected',
    });

    // Returns ScorerResult
    expect(result.scorerId).toBe('llm-judge-5dim');
    expect(result.scores.length).toBeGreaterThan(0);
    expect(result.aggregateScore).toBeGreaterThan(0);
    expect(typeof result.passed).toBe('boolean');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('includes per-dimension breakdown in ScorerResult', async () => {
    const llm = vi.fn().mockResolvedValue(validResponse);
    const scorer = new LlmJudgeScorer({ llm });

    const result = await scorer.score({
      input: 'q',
      output: 'a',
    });

    const criteria = result.scores.map((s) => s.criterion);
    expect(criteria).toContain('correctness');
    expect(criteria).toContain('completeness');
    expect(criteria).toContain('coherence');
    expect(criteria).toContain('relevance');
    expect(criteria).toContain('safety');
    expect(criteria).toContain('overall-reasoning');
  });

  it('uses custom pass threshold', async () => {
    const llm = vi.fn().mockResolvedValue(JSON.stringify({
      correctness: 4,
      completeness: 4,
      coherence: 4,
      relevance: 4,
      safety: 4,
      reasoning: 'Mediocre',
    }));

    const scorer = new LlmJudgeScorer({ llm, passThreshold: 0.5 });
    const result = await scorer.score({ input: 'q', output: 'a' });
    // All dims are 0.4, so overall is 0.4, below 0.5 threshold
    expect(result.passed).toBe(false);

    const scorerLow = new LlmJudgeScorer({ llm, passThreshold: 0.3 });
    const resultLow = await scorerLow.score({ input: 'q', output: 'a' });
    expect(resultLow.passed).toBe(true);
  });

  it('includes anchors in prompt when provided', async () => {
    const llm = vi.fn().mockResolvedValue(validResponse);
    const scorer = new LlmJudgeScorer({
      llm,
      anchors: [
        { input: 'test', output: 'out', expectedScore: 0.8, explanation: 'Good' },
      ],
    });

    await scorer.score('q', 'a');
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('Calibration');
    expect(prompt).toContain('Good');
  });

  it('handles reference in direct score mode', async () => {
    const llm = vi.fn().mockResolvedValue(validResponse);
    const scorer = new LlmJudgeScorer({ llm });

    await scorer.score('q', 'a', 'ref');
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('Reference answer: ref');
  });
});

// ---------------------------------------------------------------------------
// judgeResponseSchema validation
// ---------------------------------------------------------------------------

describe('judgeResponseSchema', () => {
  it('validates correct response', () => {
    const result = judgeResponseSchema.safeParse({
      correctness: 8,
      completeness: 7,
      coherence: 9,
      relevance: 8,
      safety: 10,
      reasoning: 'Good',
    });
    expect(result.success).toBe(true);
  });

  it('rejects score above 10', () => {
    const result = judgeResponseSchema.safeParse({
      correctness: 11,
      completeness: 7,
      coherence: 9,
      relevance: 8,
      safety: 10,
      reasoning: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects score below 0', () => {
    const result = judgeResponseSchema.safeParse({
      correctness: -1,
      completeness: 7,
      coherence: 9,
      relevance: 8,
      safety: 10,
      reasoning: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing reasoning', () => {
    const result = judgeResponseSchema.safeParse({
      correctness: 8,
      completeness: 7,
      coherence: 9,
      relevance: 8,
      safety: 10,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing dimension', () => {
    const result = judgeResponseSchema.safeParse({
      correctness: 8,
      completeness: 7,
      coherence: 9,
      // missing relevance and safety
      reasoning: 'test',
    });
    expect(result.success).toBe(false);
  });

  it('accepts decimal scores', () => {
    const result = judgeResponseSchema.safeParse({
      correctness: 7.5,
      completeness: 6.2,
      coherence: 8.8,
      relevance: 9.1,
      safety: 10.0,
      reasoning: 'test',
    });
    expect(result.success).toBe(true);
  });
});

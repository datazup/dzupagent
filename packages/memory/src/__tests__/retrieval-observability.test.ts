import { describe, it, expect, vi } from 'vitest';
import {
  AdaptiveRetriever,
  type RetrievalEventEmitter,
  type RetrievalWarning,
} from '../retrieval/adaptive-retriever.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

const RECORDS = [
  { key: 'rec-1', value: { text: 'The ModelRegistry handles provider fallback' } },
  { key: 'rec-2', value: { text: 'ForgeError was added as the base error class' } },
];

function makeVectorProvider(
  results?: Array<{ key: string; score: number; value: Record<string, unknown> }>,
) {
  return {
    search: vi.fn().mockResolvedValue(
      results ?? [{ key: 'rec-1', score: 0.95, value: RECORDS[0]!.value }],
    ),
  };
}

function makeFTSProvider(
  results?: Array<{ key: string; score: number; value: Record<string, unknown> }>,
) {
  return {
    search: vi.fn().mockReturnValue(
      results ?? [{ key: 'rec-2', score: 0.7, value: RECORDS[1]!.value }],
    ),
  };
}

type EmittedEvent = Parameters<RetrievalEventEmitter['emit']>[0];

function makeEventBus(): RetrievalEventEmitter & { calls: EmittedEvent[] } {
  const calls: EmittedEvent[] = [];
  return {
    calls,
    emit(event: EmittedEvent) {
      calls.push(event);
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Retrieval failure observability', () => {
  it('emits event with correct payload when a retrieval source fails', async () => {
    const eventBus = makeEventBus();
    const vector = {
      search: vi.fn().mockRejectedValue(new Error('Vector DB connection timeout')),
    };
    const fts = makeFTSProvider();

    const retriever = new AdaptiveRetriever({
      providers: { vector, fts },
      eventBus,
    });

    await retriever.search('some query', RECORDS);

    const failEvents = eventBus.calls.filter(e => e.type === 'memory:retrieval_source_failed');
    expect(failEvents).toHaveLength(1);
    expect(failEvents[0]).toMatchObject({
      type: 'memory:retrieval_source_failed',
      source: 'vector',
      error: 'Vector DB connection timeout',
      query: 'some query',
    });
    expect(failEvents[0]).toHaveProperty('durationMs');
  });

  it('emits success events with latency for working providers', async () => {
    const eventBus = makeEventBus();
    const vector = makeVectorProvider();
    const fts = makeFTSProvider();

    const retriever = new AdaptiveRetriever({
      providers: { vector, fts },
      eventBus,
    });

    await retriever.search('test query', RECORDS);

    const successEvents = eventBus.calls.filter(e => e.type === 'memory:retrieval_source_succeeded');
    expect(successEvents).toHaveLength(2);
    for (const evt of successEvents) {
      expect(evt).toHaveProperty('durationMs');
      expect(evt).toHaveProperty('resultCount');
    }
  });

  it('still returns results from working sources when one fails', async () => {
    const eventBus = makeEventBus();
    const vector = {
      search: vi.fn().mockRejectedValue(new Error('down')),
    };
    const fts = makeFTSProvider([
      { key: 'rec-2', score: 0.8, value: RECORDS[1]!.value },
    ]);

    const retriever = new AdaptiveRetriever({
      providers: { vector, fts },
      eventBus,
    });

    const results = await retriever.search('hello world', RECORDS);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.sources).toEqual(['fts']);
    expect(results[0]!.key).toBe('rec-2');
  });

  it('includes failed source names in warnings array', async () => {
    const eventBus = makeEventBus();
    const vector = {
      search: vi.fn().mockRejectedValue(new Error('Vector down')),
    };
    const fts = makeFTSProvider();

    const retriever = new AdaptiveRetriever({
      providers: { vector, fts },
      eventBus,
    });

    const results = await retriever.search('test query', RECORDS);

    expect(results.length).toBeGreaterThan(0);
    const warnings: RetrievalWarning[] = results[0]!.warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.source).toBe('vector');
    expect(warnings[0]!.error).toBe('Vector down');
  });

  it('emits no failure events when all sources succeed', async () => {
    const eventBus = makeEventBus();
    const vector = makeVectorProvider();
    const fts = makeFTSProvider();

    const retriever = new AdaptiveRetriever({
      providers: { vector, fts },
      eventBus,
    });

    const results = await retriever.search('test query', RECORDS);

    const failEvents = eventBus.calls.filter(e => e.type === 'memory:retrieval_source_failed');
    expect(failEvents).toHaveLength(0);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.warnings).toHaveLength(0);
  });

  it('works without eventBus (backward compatible)', async () => {
    const vector = {
      search: vi.fn().mockRejectedValue(new Error('down')),
    };
    const fts = makeFTSProvider();

    const retriever = new AdaptiveRetriever({
      providers: { vector, fts },
    });

    const results = await retriever.search('test', RECORDS);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.warnings).toHaveLength(1);
    expect(results[0]!.warnings[0]!.source).toBe('vector');
  });

  it('handles non-Error rejection reasons in event payload', async () => {
    const eventBus = makeEventBus();
    const vector = {
      search: vi.fn().mockRejectedValue('string error reason'),
    };
    const fts = makeFTSProvider();

    const retriever = new AdaptiveRetriever({
      providers: { vector, fts },
      eventBus,
    });

    const results = await retriever.search('test', RECORDS);

    const failEvents = eventBus.calls.filter(e => e.type === 'memory:retrieval_source_failed');
    expect(failEvents).toHaveLength(1);
    expect((failEvents[0] as { error: string }).error).toBe('string error reason');
    expect(results[0]!.warnings[0]!.error).toBe('string error reason');
  });

  it('warnings are empty array when all providers succeed', async () => {
    const retriever = new AdaptiveRetriever({
      providers: { vector: makeVectorProvider(), fts: makeFTSProvider() },
    });

    const results = await retriever.search('test query', RECORDS);

    for (const result of results) {
      expect(result.warnings).toEqual([]);
    }
  });
});

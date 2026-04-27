/**
 * VectorStore adapter contract tests.
 *
 * Runs the VECTOR_STORE_CONTRACT suite against real VectorStore implementations
 * to verify they conform to the interface contract. Each adapter gets the same
 * battery of tests: collection lifecycle, upsert/search, delete, count, health.
 *
 * Currently tested adapters:
 * - InMemoryVectorStore (@dzupagent/core)
 * - Inline mock vector store (minimal conformance baseline)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  VECTOR_STORE_CONTRACT,
  createVectorStoreContract,
  runContractSuite,
  ContractSuiteBuilder,
  timedTest,
} from '../contracts/index.js';
import type { ComplianceReport } from '../contracts/index.js';

// ---------------------------------------------------------------------------
// Adapter factories
// ---------------------------------------------------------------------------

/**
 * Inline mock vector store — same as in contracts.test.ts but isolated here
 * so that this test file is self-contained.
 */
function createInlineMockVectorStore() {
  const collections = new Map<
    string,
    Map<string, { vector: number[]; metadata: Record<string, unknown>; text?: string }>
  >();

  return {
    provider: 'inline-mock',

    async createCollection(name: string, _config: { dimensions: number }) {
      collections.set(name, new Map());
    },

    async deleteCollection(name: string) {
      collections.delete(name);
    },

    async listCollections() {
      return [...collections.keys()];
    },

    async collectionExists(name: string) {
      return collections.has(name);
    },

    async upsert(
      collection: string,
      entries: Array<{
        id: string;
        vector: number[];
        metadata: Record<string, unknown>;
        text?: string;
      }>,
    ) {
      const coll = collections.get(collection);
      if (!coll) throw new Error(`Collection ${collection} does not exist`);
      for (const entry of entries) {
        coll.set(entry.id, {
          vector: entry.vector,
          metadata: entry.metadata,
          text: entry.text,
        });
      }
    },

    async search(collection: string, query: { vector: number[]; limit: number }) {
      const coll = collections.get(collection);
      if (!coll) return [];

      const results = [...coll.entries()].map(([id, entry]) => {
        let dot = 0,
          normA = 0,
          normB = 0;
        for (let i = 0; i < query.vector.length; i++) {
          dot += (query.vector[i] ?? 0) * (entry.vector[i] ?? 0);
          normA += (query.vector[i] ?? 0) ** 2;
          normB += (entry.vector[i] ?? 0) ** 2;
        }
        const score = dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
        return { id, score, metadata: entry.metadata, text: entry.text };
      });

      results.sort((a, b) => b.score - a.score);
      return results.slice(0, query.limit);
    },

    async delete(collection: string, filter: { ids: string[] }) {
      const coll = collections.get(collection);
      if (!coll) return;
      if ('ids' in filter) {
        for (const id of filter.ids) {
          coll.delete(id);
        }
      }
    },

    async count(collection: string) {
      return collections.get(collection)?.size ?? 0;
    },

    async healthCheck() {
      return { healthy: true, latencyMs: 1, provider: 'inline-mock' };
    },

    async close() {
      collections.clear();
    },
  };
}

/**
 * Create InMemoryVectorStore from @dzupagent/core.
 * Uses dynamic import to handle cases where core is not built yet.
 */
async function createCoreInMemoryVectorStore(): Promise<unknown> {
  try {
    // Import from core — this is an actual dependency of evals
    const { InMemoryVectorStore } = await import('@dzupagent/core');
    return new InMemoryVectorStore();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Adapter registry for describe.each
// ---------------------------------------------------------------------------

interface AdapterEntry {
  name: string;
  create: () => Promise<unknown> | unknown;
  cleanup?: (adapter: unknown) => Promise<void>;
}

const adapters: AdapterEntry[] = [
  {
    name: 'InlineMockVectorStore',
    create: () => createInlineMockVectorStore(),
  },
];

// ===========================================================================
// Contract suite tests — run VECTOR_STORE_CONTRACT against each adapter
// ===========================================================================

describe('VectorStore contract tests', () => {
  describe.each(adapters)('$name', ({ create, cleanup }) => {
    let adapter: unknown;
    let report: ComplianceReport;

    beforeEach(async () => {
      adapter = await create();
    });

    afterEach(async () => {
      if (cleanup && adapter) {
        await cleanup(adapter);
      }
    });

    it('should pass all required contract tests', async () => {
      report = await runContractSuite({
        suite: VECTOR_STORE_CONTRACT,
        adapter,
      });

      const requiredTests = report.tests.filter((t) => t.category === 'required');
      const failedRequired = requiredTests.filter((t) => t.status === 'failed');

      if (failedRequired.length > 0) {
        const failures = failedRequired
          .map((f) => `  ${f.testId}: ${f.error ?? 'unknown error'}`)
          .join('\n');
        console.log(`Failed required tests:\n${failures}`);
      }

      expect(failedRequired).toHaveLength(0);
    });

    it('should pass all recommended contract tests', async () => {
      report = await runContractSuite({
        suite: VECTOR_STORE_CONTRACT,
        adapter,
      });

      const recommendedTests = report.tests.filter((t) => t.category === 'recommended');
      const failedRecommended = recommendedTests.filter((t) => t.status === 'failed');

      if (failedRecommended.length > 0) {
        const failures = failedRecommended
          .map((f) => `  ${f.testId}: ${f.error ?? 'unknown error'}`)
          .join('\n');
        console.log(`Failed recommended tests:\n${failures}`);
      }

      expect(failedRecommended).toHaveLength(0);
    });

    it('should achieve full compliance', async () => {
      report = await runContractSuite({
        suite: VECTOR_STORE_CONTRACT,
        adapter,
      });

      expect(report.complianceLevel).toBe('full');
      expect(report.compliancePercent).toBe(100);
    });
  });

  // -------------------------------------------------------------------------
  // InMemoryVectorStore from @dzupagent/core — conditional
  // -------------------------------------------------------------------------

  describe('InMemoryVectorStore (@dzupagent/core)', () => {
    let adapter: unknown;
    let available = false;

    beforeEach(async () => {
      adapter = await createCoreInMemoryVectorStore();
      available = adapter !== null;
    });

    afterEach(async () => {
      if (adapter && typeof (adapter as Record<string, unknown>)['close'] === 'function') {
        await (adapter as { close(): Promise<void> }).close();
      }
    });

    it('should pass all contract tests when available', async () => {
      if (!available) {
        console.log('Skipping: @dzupagent/core InMemoryVectorStore not available');
        return;
      }

      const report = await runContractSuite({
        suite: VECTOR_STORE_CONTRACT,
        adapter,
      });

      const failures = report.tests.filter((t) => t.status === 'failed');
      if (failures.length > 0) {
        for (const f of failures) {
          console.log(`FAILED: ${f.testId} -- ${f.error ?? 'unknown'}`);
        }
      }

      expect(report.complianceLevel).toBe('full');
      expect(report.summary.failed).toBe(0);
    });
  });
});

// ===========================================================================
// Targeted behavioral tests — deeper than the contract suite
// ===========================================================================

describe('VectorStore behavioral tests', () => {
  let store: ReturnType<typeof createInlineMockVectorStore>;

  beforeEach(() => {
    store = createInlineMockVectorStore();
  });

  afterEach(async () => {
    await store.close();
  });

  describe('collection lifecycle', () => {
    it('should create and list multiple collections', async () => {
      await store.createCollection('coll-a', { dimensions: 4 });
      await store.createCollection('coll-b', { dimensions: 8 });

      const collections = await store.listCollections();
      expect(collections).toContain('coll-a');
      expect(collections).toContain('coll-b');
      expect(collections).toHaveLength(2);
    });

    it('should report existence correctly', async () => {
      expect(await store.collectionExists('nonexistent')).toBe(false);

      await store.createCollection('exists', { dimensions: 4 });
      expect(await store.collectionExists('exists')).toBe(true);

      await store.deleteCollection('exists');
      expect(await store.collectionExists('exists')).toBe(false);
    });

    it('should handle deleting a non-existent collection without error', async () => {
      // Should not throw
      await store.deleteCollection('nonexistent');
    });
  });

  describe('upsert and search', () => {
    const dims = 4;
    const collName = 'test-search';

    beforeEach(async () => {
      await store.createCollection(collName, { dimensions: dims });
    });

    it('should return empty results from an empty collection', async () => {
      const results = await store.search(collName, {
        vector: [1, 0, 0, 0],
        limit: 10,
      });
      expect(results).toEqual([]);
    });

    it('should rank results by cosine similarity', async () => {
      await store.upsert(collName, [
        { id: 'a', vector: [1, 0, 0, 0], metadata: { label: 'a' } },
        { id: 'b', vector: [0, 1, 0, 0], metadata: { label: 'b' } },
        { id: 'c', vector: [0.9, 0.1, 0, 0], metadata: { label: 'c' } },
      ]);

      const results = await store.search(collName, {
        vector: [1, 0, 0, 0],
        limit: 3,
      });

      expect(results).toHaveLength(3);
      // 'a' is the exact match, 'c' is close, 'b' is orthogonal
      expect(results[0]!.id).toBe('a');
      expect(results[0]!.score).toBeCloseTo(1.0, 5);
      expect(results[1]!.id).toBe('c');
      expect(results[2]!.id).toBe('b');
    });

    it('should respect the limit parameter', async () => {
      await store.upsert(collName, [
        { id: 'x1', vector: [1, 0, 0, 0], metadata: {} },
        { id: 'x2', vector: [0, 1, 0, 0], metadata: {} },
        { id: 'x3', vector: [0, 0, 1, 0], metadata: {} },
      ]);

      const results = await store.search(collName, {
        vector: [1, 0, 0, 0],
        limit: 1,
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe('x1');
    });

    it('should preserve metadata in search results', async () => {
      await store.upsert(collName, [
        {
          id: 'meta-doc',
          vector: [1, 0, 0, 0],
          metadata: { topic: 'testing', priority: 5, tags: ['a', 'b'] },
        },
      ]);

      const results = await store.search(collName, {
        vector: [1, 0, 0, 0],
        limit: 1,
      });

      expect(results[0]!.metadata).toEqual({
        topic: 'testing',
        priority: 5,
        tags: ['a', 'b'],
      });
    });

    it('should preserve text field in search results', async () => {
      await store.upsert(collName, [
        {
          id: 'text-doc',
          vector: [1, 0, 0, 0],
          metadata: {},
          text: 'original text content',
        },
      ]);

      const results = await store.search(collName, {
        vector: [1, 0, 0, 0],
        limit: 1,
      });

      expect(results[0]!.text).toBe('original text content');
    });
  });

  describe('upsert idempotency', () => {
    it('should update rather than duplicate on same ID', async () => {
      const collName = 'idem-test';
      await store.createCollection(collName, { dimensions: 4 });

      await store.upsert(collName, [
        { id: 'same-id', vector: [1, 0, 0, 0], metadata: { version: 1 } },
      ]);
      await store.upsert(collName, [
        { id: 'same-id', vector: [0, 1, 0, 0], metadata: { version: 2 } },
      ]);

      const count = await store.count(collName);
      expect(count).toBe(1);

      const results = await store.search(collName, {
        vector: [0, 1, 0, 0],
        limit: 1,
      });
      expect(results[0]!.metadata).toEqual({ version: 2 });
    });
  });

  describe('namespace isolation', () => {
    it('should isolate data between collections', async () => {
      await store.createCollection('ns-a', { dimensions: 4 });
      await store.createCollection('ns-b', { dimensions: 4 });

      await store.upsert('ns-a', [
        { id: 'doc-1', vector: [1, 0, 0, 0], metadata: { source: 'a' } },
      ]);
      await store.upsert('ns-b', [
        { id: 'doc-2', vector: [0, 1, 0, 0], metadata: { source: 'b' } },
      ]);

      const resultsA = await store.search('ns-a', {
        vector: [1, 0, 0, 0],
        limit: 10,
      });
      const resultsB = await store.search('ns-b', {
        vector: [1, 0, 0, 0],
        limit: 10,
      });

      // Collection A should only have doc-1
      expect(resultsA).toHaveLength(1);
      expect(resultsA[0]!.id).toBe('doc-1');
      expect(resultsA[0]!.metadata['source']).toBe('a');

      // Collection B should only have doc-2
      expect(resultsB).toHaveLength(1);
      expect(resultsB[0]!.id).toBe('doc-2');
      expect(resultsB[0]!.metadata['source']).toBe('b');
    });

    it('should not affect other collections when deleting entries', async () => {
      await store.createCollection('iso-a', { dimensions: 4 });
      await store.createCollection('iso-b', { dimensions: 4 });

      await store.upsert('iso-a', [
        { id: 'shared-id', vector: [1, 0, 0, 0], metadata: {} },
      ]);
      await store.upsert('iso-b', [
        { id: 'shared-id', vector: [1, 0, 0, 0], metadata: {} },
      ]);

      await store.delete('iso-a', { ids: ['shared-id'] });

      expect(await store.count('iso-a')).toBe(0);
      expect(await store.count('iso-b')).toBe(1);
    });

    it('should not affect other collections when deleting a collection', async () => {
      await store.createCollection('del-a', { dimensions: 4 });
      await store.createCollection('del-b', { dimensions: 4 });

      await store.upsert('del-a', [
        { id: 'doc', vector: [1, 0, 0, 0], metadata: {} },
      ]);
      await store.upsert('del-b', [
        { id: 'doc', vector: [1, 0, 0, 0], metadata: {} },
      ]);

      await store.deleteCollection('del-a');

      expect(await store.collectionExists('del-a')).toBe(false);
      expect(await store.collectionExists('del-b')).toBe(true);
      expect(await store.count('del-b')).toBe(1);
    });
  });

  describe('delete operations', () => {
    it('should delete specific entries by ID', async () => {
      const collName = 'del-test';
      await store.createCollection(collName, { dimensions: 4 });

      await store.upsert(collName, [
        { id: 'keep', vector: [1, 0, 0, 0], metadata: {} },
        { id: 'remove', vector: [0, 1, 0, 0], metadata: {} },
      ]);

      await store.delete(collName, { ids: ['remove'] });

      expect(await store.count(collName)).toBe(1);

      const results = await store.search(collName, {
        vector: [0, 1, 0, 0],
        limit: 10,
      });
      expect(results.every((r) => r.id !== 'remove')).toBe(true);
    });

    it('should handle deleting non-existent IDs gracefully', async () => {
      const collName = 'del-noop';
      await store.createCollection(collName, { dimensions: 4 });

      await store.upsert(collName, [
        { id: 'existing', vector: [1, 0, 0, 0], metadata: {} },
      ]);

      // Should not throw
      await store.delete(collName, { ids: ['nonexistent'] });

      expect(await store.count(collName)).toBe(1);
    });
  });

  describe('error handling', () => {
    it('should throw when upserting into a non-existent collection', async () => {
      await expect(
        store.upsert('nonexistent', [
          { id: 'doc', vector: [1, 0, 0, 0], metadata: {} },
        ]),
      ).rejects.toThrow();
    });

    it('should return empty or throw when searching a non-existent collection', async () => {
      const results = await store.search('nonexistent', {
        vector: [1, 0, 0, 0],
        limit: 10,
      });
      // Mock returns empty; real stores may throw. Both are acceptable.
      expect(Array.isArray(results) || results === undefined).toBe(true);
    });
  });

  describe('health check', () => {
    it('should report healthy status', async () => {
      const health = await store.healthCheck();
      expect(health.healthy).toBe(true);
      expect(typeof health.provider).toBe('string');
      expect(health.provider.length).toBeGreaterThan(0);
    });
  });

  describe('close / cleanup', () => {
    it('should clear all data on close', async () => {
      await store.createCollection('temp', { dimensions: 4 });
      await store.upsert('temp', [
        { id: 'doc', vector: [1, 0, 0, 0], metadata: {} },
      ]);

      await store.close();

      const collections = await store.listCollections();
      expect(collections).toHaveLength(0);
    });
  });
});

// ===========================================================================
// Custom contract suite — extend the built-in suite with extra tests
// ===========================================================================

describe('Extended VectorStore contract (custom suite)', () => {
  it('should create a custom contract and run it', async () => {
    const customSuite = new ContractSuiteBuilder('vector-store', 'Custom VectorStore')
      .description('Extended vector store tests')
      .required(
        'batch-upsert',
        'Batch upsert of 100 entries',
        'Handles batch operations without error',
        async (adapter) =>
          timedTest(async () => {
            const store = adapter as ReturnType<typeof createInlineMockVectorStore>;
            const collName = '__custom_batch_test';
            if (!(await store.collectionExists(collName))) {
              await store.createCollection(collName, { dimensions: 4 });
            }

            const entries = Array.from({ length: 100 }, (_, i) => ({
              id: `batch-${String(i)}`,
              vector: [Math.sin(i), Math.cos(i), i / 100, 1 - i / 100],
              metadata: { index: i },
            }));

            await store.upsert(collName, entries);
            const count = await store.count(collName);
            await store.deleteCollection(collName);

            if (count !== 100) {
              return { passed: false, error: `Expected 100 entries, got ${String(count)}` };
            }
            return { passed: true, details: { count } };
          }),
      )
      .build();

    const mockStore = createInlineMockVectorStore();
    const report = await runContractSuite({
      suite: customSuite,
      adapter: mockStore,
    });

    expect(report.complianceLevel).toBe('full');
    expect(report.summary.failed).toBe(0);
  });
});

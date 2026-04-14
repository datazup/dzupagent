/**
 * VectorStore Contract Suite — conformance tests for VectorStore adapters.
 *
 * Tests verify the VectorStore interface contract defined in @dzupagent/core.
 * Adapters must pass all 'required' tests to be considered conformant.
 */

import { ContractSuiteBuilder, timedTest } from '../contract-test-generator.js';
import type { ContractSuite } from '../contract-types.js';

// ---------------------------------------------------------------------------
// Minimal interface shape we test against (avoids hard dependency on core)
// ---------------------------------------------------------------------------

interface VectorStoreShape {
  provider: string;
  createCollection(name: string, config: { dimensions: number }): Promise<void>;
  deleteCollection(name: string): Promise<void>;
  listCollections(): Promise<string[]>;
  collectionExists(name: string): Promise<boolean>;
  upsert(collection: string, entries: Array<{ id: string; vector: number[]; metadata: Record<string, unknown>; text?: string }>): Promise<void>;
  search(collection: string, query: { vector: number[]; limit: number; filter?: unknown }): Promise<Array<{ id: string; score: number; metadata: Record<string, unknown> }>>;
  delete(collection: string, filter: { ids: string[] } | { filter: unknown }): Promise<void>;
  count(collection: string): Promise<number>;
  healthCheck(): Promise<{ healthy: boolean }>;
  close(): Promise<void>;
}

function asVectorStore(adapter: unknown): VectorStoreShape {
  return adapter as VectorStoreShape;
}

const TEST_COLLECTION = '__contract_test_vectors';
const TEST_DIMS = 4;

function makeVector(seed: number): number[] {
  // Deterministic unit-ish vector
  const raw = [seed, seed + 1, seed + 2, seed + 3];
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0));
  return raw.map((v) => v / norm);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

export function createVectorStoreContract(): ContractSuite {
  const builder = new ContractSuiteBuilder('vector-store', 'VectorStore Contract')
    .description('Conformance tests for VectorStore adapter implementations');

  // --- Required ---

  builder.required(
    'has-provider',
    'Provider identifier',
    'Adapter exposes a non-empty provider string',
    async (adapter) =>
      timedTest(async () => {
        const store = asVectorStore(adapter);
        if (typeof store.provider !== 'string' || store.provider.length === 0) {
          return { passed: false, error: 'provider must be a non-empty string' };
        }
        return { passed: true, details: { provider: store.provider } };
      }),
  );

  builder.required(
    'create-collection',
    'Create collection',
    'createCollection() creates a new collection without error',
    async (adapter) =>
      timedTest(async () => {
        const store = asVectorStore(adapter);
        await store.createCollection(TEST_COLLECTION, { dimensions: TEST_DIMS });
        const exists = await store.collectionExists(TEST_COLLECTION);
        if (!exists) {
          return { passed: false, error: 'Collection does not exist after creation' };
        }
        return { passed: true };
      }),
  );

  builder.required(
    'upsert-and-search',
    'Upsert and search',
    'upsert() stores entries and search() retrieves them with scores',
    async (adapter) =>
      timedTest(async () => {
        const store = asVectorStore(adapter);

        // Ensure collection exists
        if (!(await store.collectionExists(TEST_COLLECTION))) {
          await store.createCollection(TEST_COLLECTION, { dimensions: TEST_DIMS });
        }

        const entries = [
          { id: 'doc-1', vector: makeVector(1), metadata: { topic: 'alpha' }, text: 'alpha document' },
          { id: 'doc-2', vector: makeVector(5), metadata: { topic: 'beta' }, text: 'beta document' },
        ];

        await store.upsert(TEST_COLLECTION, entries);

        const results = await store.search(TEST_COLLECTION, {
          vector: makeVector(1),
          limit: 2,
        });

        if (!Array.isArray(results)) {
          return { passed: false, error: 'search() must return an array' };
        }
        if (results.length === 0) {
          return { passed: false, error: 'search() returned 0 results after upsert' };
        }

        const first = results[0]!;
        if (typeof first.id !== 'string') {
          return { passed: false, error: 'result.id must be a string' };
        }
        if (typeof first.score !== 'number') {
          return { passed: false, error: 'result.score must be a number' };
        }

        // The closest match to makeVector(1) should be doc-1
        if (first.id !== 'doc-1') {
          return {
            passed: false,
            error: `Expected closest match to be doc-1, got ${first.id}`,
            details: { results },
          };
        }

        return { passed: true, details: { resultCount: results.length, topId: first.id } };
      }),
  );

  builder.required(
    'delete-by-ids',
    'Delete by IDs',
    'delete() removes specific entries by their IDs',
    async (adapter) =>
      timedTest(async () => {
        const store = asVectorStore(adapter);

        if (!(await store.collectionExists(TEST_COLLECTION))) {
          await store.createCollection(TEST_COLLECTION, { dimensions: TEST_DIMS });
        }

        await store.upsert(TEST_COLLECTION, [
          { id: 'del-1', vector: makeVector(10), metadata: {} },
          { id: 'del-2', vector: makeVector(20), metadata: {} },
        ]);

        await store.delete(TEST_COLLECTION, { ids: ['del-1'] });

        const results = await store.search(TEST_COLLECTION, {
          vector: makeVector(10),
          limit: 10,
        });

        const deletedStillPresent = results.some((r) => r.id === 'del-1');
        if (deletedStillPresent) {
          return { passed: false, error: 'Deleted entry del-1 still appears in search results' };
        }

        return { passed: true };
      }),
  );

  builder.required(
    'count',
    'Count vectors',
    'count() returns the number of vectors in a collection',
    async (adapter) =>
      timedTest(async () => {
        const store = asVectorStore(adapter);
        const countCollName = '__contract_count_test';

        if (await store.collectionExists(countCollName)) {
          await store.deleteCollection(countCollName);
        }
        await store.createCollection(countCollName, { dimensions: TEST_DIMS });

        const before = await store.count(countCollName);
        if (before !== 0) {
          return { passed: false, error: `Expected count 0 for empty collection, got ${before}` };
        }

        await store.upsert(countCollName, [
          { id: 'cnt-1', vector: makeVector(1), metadata: {} },
          { id: 'cnt-2', vector: makeVector(2), metadata: {} },
        ]);

        const after = await store.count(countCollName);
        if (after !== 2) {
          return { passed: false, error: `Expected count 2 after upsert, got ${after}` };
        }

        // Cleanup
        await store.deleteCollection(countCollName);
        return { passed: true };
      }),
  );

  builder.required(
    'delete-collection',
    'Delete collection',
    'deleteCollection() removes the collection entirely',
    async (adapter) =>
      timedTest(async () => {
        const store = asVectorStore(adapter);
        const collName = '__contract_del_coll';

        await store.createCollection(collName, { dimensions: TEST_DIMS });
        const existsBefore = await store.collectionExists(collName);
        if (!existsBefore) {
          return { passed: false, error: 'Collection does not exist right after creation' };
        }

        await store.deleteCollection(collName);
        const existsAfter = await store.collectionExists(collName);
        if (existsAfter) {
          return { passed: false, error: 'Collection still exists after deletion' };
        }

        return { passed: true };
      }),
  );

  // --- Recommended ---

  builder.recommended(
    'list-collections',
    'List collections',
    'listCollections() returns collection names including recently created ones',
    async (adapter) =>
      timedTest(async () => {
        const store = asVectorStore(adapter);
        const collName = '__contract_list_test';

        if (!(await store.collectionExists(collName))) {
          await store.createCollection(collName, { dimensions: TEST_DIMS });
        }

        const collections = await store.listCollections();
        if (!Array.isArray(collections)) {
          return { passed: false, error: 'listCollections() must return an array' };
        }

        const found = collections.includes(collName);
        // Cleanup
        await store.deleteCollection(collName);

        if (!found) {
          return { passed: false, error: `listCollections() did not include "${collName}"` };
        }
        return { passed: true, details: { collectionCount: collections.length } };
      }),
  );

  builder.recommended(
    'metadata-returned',
    'Metadata in results',
    'search() results include metadata from the original upsert',
    async (adapter) =>
      timedTest(async () => {
        const store = asVectorStore(adapter);
        const collName = '__contract_meta_test';

        if (await store.collectionExists(collName)) {
          await store.deleteCollection(collName);
        }
        await store.createCollection(collName, { dimensions: TEST_DIMS });

        await store.upsert(collName, [
          { id: 'meta-1', vector: makeVector(1), metadata: { label: 'hello', count: 42 } },
        ]);

        const results = await store.search(collName, { vector: makeVector(1), limit: 1 });
        const first = results[0];

        // Cleanup
        await store.deleteCollection(collName);

        if (!first) {
          return { passed: false, error: 'No results returned' };
        }

        if (first.metadata?.['label'] !== 'hello') {
          return { passed: false, error: 'Metadata field "label" not preserved', details: { metadata: first.metadata } };
        }

        return { passed: true };
      }),
  );

  builder.recommended(
    'health-check',
    'Health check',
    'healthCheck() returns a result with healthy=true',
    async (adapter) =>
      timedTest(async () => {
        const store = asVectorStore(adapter);
        const health = await store.healthCheck();
        if (!health.healthy) {
          return { passed: false, error: 'healthCheck() returned healthy=false' };
        }
        return { passed: true };
      }),
  );

  // --- Optional ---

  builder.optional(
    'upsert-idempotent',
    'Upsert is idempotent',
    'Upserting the same ID twice updates rather than duplicates',
    async (adapter) =>
      timedTest(async () => {
        const store = asVectorStore(adapter);
        const collName = '__contract_idem_test';

        if (await store.collectionExists(collName)) {
          await store.deleteCollection(collName);
        }
        await store.createCollection(collName, { dimensions: TEST_DIMS });

        const entry = { id: 'idem-1', vector: makeVector(1), metadata: { v: 1 } };
        await store.upsert(collName, [entry]);
        await store.upsert(collName, [{ ...entry, metadata: { v: 2 } }]);

        const count = await store.count(collName);
        // Cleanup
        await store.deleteCollection(collName);

        if (count !== 1) {
          return { passed: false, error: `Expected count 1 after double upsert, got ${count}` };
        }

        return { passed: true };
      }),
  );

  builder.optional(
    'search-limit-respected',
    'Search respects limit',
    'search() returns at most limit results',
    async (adapter) =>
      timedTest(async () => {
        const store = asVectorStore(adapter);
        const collName = '__contract_limit_test';

        if (await store.collectionExists(collName)) {
          await store.deleteCollection(collName);
        }
        await store.createCollection(collName, { dimensions: TEST_DIMS });

        const entries = Array.from({ length: 5 }, (_, i) => ({
          id: `lim-${i}`,
          vector: makeVector(i + 1),
          metadata: {},
        }));
        await store.upsert(collName, entries);

        const results = await store.search(collName, { vector: makeVector(1), limit: 2 });
        // Cleanup
        await store.deleteCollection(collName);

        if (results.length > 2) {
          return { passed: false, error: `Expected at most 2 results, got ${results.length}` };
        }
        return { passed: true, details: { resultCount: results.length } };
      }),
  );

  // Cleanup the main test collection after all tests
  builder.afterAll(async () => {
    // Individual tests handle their own cleanup; this is a safety net
  });

  return builder.build();
}

/** Pre-built VectorStore contract suite */
export const VECTOR_STORE_CONTRACT = createVectorStoreContract();

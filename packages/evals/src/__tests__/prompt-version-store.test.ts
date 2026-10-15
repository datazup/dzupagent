/**
 * Tests for PromptVersionStore — in-memory mock of BaseStore.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PromptVersionStore } from '../prompt-optimizer/prompt-version-store.js';
import type { BaseStore } from '@langchain/langgraph';

// ---------------------------------------------------------------------------
// In-memory BaseStore mock
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory implementation of BaseStore for testing.
 */
class InMemoryBaseStore {
  private data = new Map<string, Map<string, Record<string, unknown>>>();

  private nsKey(namespace: string[]): string {
    return namespace.join('::');
  }

  async put(namespace: string[], key: string, value: Record<string, unknown>): Promise<void> {
    const nsKey = this.nsKey(namespace);
    if (!this.data.has(nsKey)) {
      this.data.set(nsKey, new Map());
    }
    this.data.get(nsKey)!.set(key, value);
  }

  async get(
    namespace: string[],
    key: string,
  ): Promise<{ namespace: string[]; key: string; value: Record<string, unknown> } | null> {
    const nsKey = this.nsKey(namespace);
    const value = this.data.get(nsKey)?.get(key);
    // A BaseStore returns an Item (or null), not the bare value.
    return value === undefined ? null : { namespace, key, value };
  }

  async search(
    namespace: string[],
    options?: { limit?: number; offset?: number },
  ): Promise<Array<{ namespace: string[]; key: string; value: Record<string, unknown> }>> {
    const results: Array<{ namespace: string[]; key: string; value: Record<string, unknown> }> = [];
    const nsKey = this.nsKey(namespace);
    const ns = this.data.get(nsKey);
    if (ns) {
      for (const [key, value] of ns.entries()) {
        results.push({ namespace, key, value });
      }
    }

    // Also search sub-namespaces (for listPromptKeys which searches at base level)
    for (const [storedNs, entries] of this.data.entries()) {
      if (storedNs.startsWith(nsKey + '::') && storedNs !== nsKey) {
        for (const [key, value] of entries.entries()) {
          results.push({ namespace: storedNs.split('::'), key, value });
        }
      }
    }

    if (this.defaultLimit === undefined && options === undefined) return results;
    // LangGraph semantics: `limit` defaults to 10, `offset` to 0.
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? this.defaultLimit ?? 10;
    return results.slice(offset, offset + limit);
  }

  /**
   * `undefined`: legacy mock behaviour (an option-less search returns every
   * row). A number: an option-less search returns at most that many rows, as
   * a LangGraph store does with its default limit of 10.
   */
  constructor(private readonly defaultLimit?: number) {}

  async delete(namespace: string[], key: string): Promise<void> {
    const nsKey = this.nsKey(namespace);
    this.data.get(nsKey)?.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PromptVersionStore', () => {
  let store: PromptVersionStore;
  let baseStore: InMemoryBaseStore;

  beforeEach(() => {
    baseStore = new InMemoryBaseStore();
    store = new PromptVersionStore({ store: baseStore as unknown as BaseStore });
  });

  describe('save', () => {
    it('saves a new version with version number 1', async () => {
      const v = await store.save({
        promptKey: 'my-prompt',
        content: 'You are a helpful assistant.',
      });

      expect(v.id).toBeDefined();
      expect(v.promptKey).toBe('my-prompt');
      expect(v.content).toBe('You are a helpful assistant.');
      expect(v.version).toBe(1);
      expect(v.active).toBe(false);
      expect(v.createdAt).toBeTruthy();
    });

    it('increments version number for subsequent saves', async () => {
      await store.save({ promptKey: 'p1', content: 'v1' });
      const v2 = await store.save({ promptKey: 'p1', content: 'v2' });
      const v3 = await store.save({ promptKey: 'p1', content: 'v3' });

      expect(v2.version).toBe(2);
      expect(v3.version).toBe(3);
    });

    it('saves with metadata and evalScores', async () => {
      const v = await store.save({
        promptKey: 'p1',
        content: 'test',
        metadata: { author: 'test-bot' },
        evalScores: {
          avgScore: 0.85,
          passRate: 0.9,
          scorerAverages: { accuracy: 0.9 },
          datasetSize: 100,
        },
      });

      expect(v.metadata).toEqual({ author: 'test-bot' });
      expect(v.evalScores?.avgScore).toBe(0.85);
      expect(v.evalScores?.datasetSize).toBe(100);
    });

    it('saves with parentVersionId', async () => {
      const v1 = await store.save({ promptKey: 'p1', content: 'v1' });
      const v2 = await store.save({ promptKey: 'p1', content: 'v2', parentVersionId: v1.id });

      expect(v2.parentVersionId).toBe(v1.id);
    });

    it('deactivates others when saving an active version', async () => {
      const v1 = await store.save({ promptKey: 'p1', content: 'v1', active: true });
      const v2 = await store.save({ promptKey: 'p1', content: 'v2', active: true });

      const active = await store.getActive('p1');
      expect(active?.id).toBe(v2.id);
      expect(active?.active).toBe(true);

      // v1 should no longer be active
      const versions = await store.listVersions('p1');
      const oldV1 = versions.find((v) => v.id === v1.id);
      expect(oldV1?.active).toBe(false);
    });
  });

  describe('getActive', () => {
    it('returns null when no active version exists', async () => {
      const result = await store.getActive('nonexistent');
      expect(result).toBeNull();
    });

    it('returns null when all versions are inactive', async () => {
      await store.save({ promptKey: 'p1', content: 'v1', active: false });
      const result = await store.getActive('p1');
      expect(result).toBeNull();
    });

    it('returns the active version', async () => {
      await store.save({ promptKey: 'p1', content: 'v1', active: false });
      const v2 = await store.save({ promptKey: 'p1', content: 'v2', active: true });

      const active = await store.getActive('p1');
      expect(active?.id).toBe(v2.id);
      expect(active?.content).toBe('v2');
    });
  });

  describe('getById', () => {
    it('returns null for nonexistent ID', async () => {
      const result = await store.getById('nonexistent-uuid');
      expect(result).toBeNull();
    });

    it('finds version by ID across prompt keys', async () => {
      await store.save({ promptKey: 'p1', content: 'v1' });
      const v2 = await store.save({ promptKey: 'p2', content: 'v2' });

      const found = await store.getById(v2.id);
      expect(found?.content).toBe('v2');
    });
  });

  describe('listVersions', () => {
    it('returns empty array for nonexistent key', async () => {
      const versions = await store.listVersions('nonexistent');
      expect(versions).toEqual([]);
    });

    it('returns versions sorted by version number descending', async () => {
      await store.save({ promptKey: 'p1', content: 'v1' });
      await store.save({ promptKey: 'p1', content: 'v2' });
      await store.save({ promptKey: 'p1', content: 'v3' });

      const versions = await store.listVersions('p1');
      expect(versions).toHaveLength(3);
      expect(versions[0]?.version).toBe(3);
      expect(versions[1]?.version).toBe(2);
      expect(versions[2]?.version).toBe(1);
    });

    it('respects limit parameter', async () => {
      await store.save({ promptKey: 'p1', content: 'v1' });
      await store.save({ promptKey: 'p1', content: 'v2' });
      await store.save({ promptKey: 'p1', content: 'v3' });

      const versions = await store.listVersions('p1', 2);
      expect(versions).toHaveLength(2);
      expect(versions[0]?.version).toBe(3);
      expect(versions[1]?.version).toBe(2);
    });
  });

  describe('activate', () => {
    it('activates a version by ID', async () => {
      const v1 = await store.save({ promptKey: 'p1', content: 'v1' });
      await store.save({ promptKey: 'p1', content: 'v2' });

      await store.activate(v1.id);

      const active = await store.getActive('p1');
      expect(active?.id).toBe(v1.id);
    });

    it('throws for nonexistent version ID', async () => {
      await expect(store.activate('nonexistent')).rejects.toThrow('PromptVersion not found');
    });

    it('deactivates previous active version', async () => {
      await store.save({ promptKey: 'p1', content: 'v1', active: true });
      const v2 = await store.save({ promptKey: 'p1', content: 'v2' });

      await store.activate(v2.id);

      const versions = await store.listVersions('p1');
      const updatedV1 = versions.find((v) => v.version === 1);
      expect(updatedV1?.active).toBe(false);
    });
  });

  describe('rollback', () => {
    it('creates a new version with the same content as the target', async () => {
      const v1 = await store.save({ promptKey: 'p1', content: 'original', active: true });
      await store.save({ promptKey: 'p1', content: 'bad update', active: true });

      const rolled = await store.rollback('p1', v1.id);

      expect(rolled.content).toBe('original');
      expect(rolled.parentVersionId).toBe(v1.id);
      expect(rolled.active).toBe(true);
      expect(rolled.version).toBe(3);
      expect(rolled.metadata?.rolledBackFrom).toBe(v1.id);
    });

    it('throws for nonexistent target version', async () => {
      await expect(store.rollback('p1', 'nonexistent')).rejects.toThrow('PromptVersion not found');
    });

    it('throws if version belongs to different prompt key', async () => {
      const v1 = await store.save({ promptKey: 'p1', content: 'test' });

      await expect(store.rollback('p2', v1.id)).rejects.toThrow(
        /belongs to prompt key "p1", not "p2"/,
      );
    });
  });

  describe('compare', () => {
    it('computes line diffs between two versions', async () => {
      const v1 = await store.save({ promptKey: 'p1', content: 'line1\nline2\nline3' });
      const v2 = await store.save({ promptKey: 'p1', content: 'line1\nline4\nline3' });

      const diff = await store.compare(v1.id, v2.id);

      expect(diff.added).toContain('line4');
      expect(diff.removed).toContain('line2');
    });

    it('computes score improvement when both have evalScores', async () => {
      const v1 = await store.save({
        promptKey: 'p1',
        content: 'v1',
        evalScores: { avgScore: 0.7, passRate: 0.8, scorerAverages: {}, datasetSize: 10 },
      });
      const v2 = await store.save({
        promptKey: 'p1',
        content: 'v2',
        evalScores: { avgScore: 0.9, passRate: 0.95, scorerAverages: {}, datasetSize: 10 },
      });

      const diff = await store.compare(v1.id, v2.id);
      expect(diff.scoreImprovement).toBeCloseTo(0.2);
    });

    it('returns null scoreImprovement when evalScores missing', async () => {
      const v1 = await store.save({ promptKey: 'p1', content: 'v1' });
      const v2 = await store.save({ promptKey: 'p1', content: 'v2' });

      const diff = await store.compare(v1.id, v2.id);
      expect(diff.scoreImprovement).toBeNull();
    });

    it('throws for nonexistent version IDs', async () => {
      const v1 = await store.save({ promptKey: 'p1', content: 'v1' });

      await expect(store.compare('nonexistent', v1.id)).rejects.toThrow('PromptVersion not found');
      await expect(store.compare(v1.id, 'nonexistent')).rejects.toThrow('PromptVersion not found');
    });
  });

  describe('listPromptKeys', () => {
    it('returns empty array when no prompts stored', async () => {
      const keys = await store.listPromptKeys();
      expect(keys).toEqual([]);
    });

    it('returns sorted prompt keys', async () => {
      await store.save({ promptKey: 'beta', content: 'b' });
      await store.save({ promptKey: 'alpha', content: 'a' });
      await store.save({ promptKey: 'gamma', content: 'g' });

      const keys = await store.listPromptKeys();
      expect(keys).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('deduplicates prompt keys', async () => {
      await store.save({ promptKey: 'p1', content: 'v1' });
      await store.save({ promptKey: 'p1', content: 'v2' });

      const keys = await store.listPromptKeys();
      expect(keys).toEqual(['p1']);
    });
  });

  describe('custom namespace', () => {
    it('uses custom namespace for storage', async () => {
      const customStore = new PromptVersionStore({
        store: baseStore as unknown as BaseStore,
        namespace: ['custom', 'ns'],
      });

      await customStore.save({ promptKey: 'p1', content: 'test' });
      const found = await customStore.getActive('p1');
      // Should not conflict with the default namespace
      expect(found).toBeNull(); // not active

      const versions = await customStore.listVersions('p1');
      expect(versions).toHaveLength(1);
      expect(versions[0]?.content).toBe('test');
    });
  });

  describe('stores with a default search limit (AGENT-M-52)', () => {
    it('saving 15 active versions yields versions 1..15 and exactly one active', async () => {
      const limited = new InMemoryBaseStore(10);
      const versionStore = new PromptVersionStore({ store: limited as unknown as BaseStore });

      for (let i = 1; i <= 15; i++) {
        await versionStore.save({ promptKey: 'p', content: `v${i}`, active: true });
      }

      const versions = await versionStore.listVersions('p');
      expect(versions.map((v) => v.version)).toEqual(
        Array.from({ length: 15 }, (_, i) => 15 - i),
      );
      expect(versions.filter((v) => v.active).map((v) => v.version)).toEqual([15]);
      expect((await versionStore.getActive('p'))?.version).toBe(15);
    });

    it('finds, activates and rolls back to an early version past the default limit', async () => {
      const limited = new InMemoryBaseStore(10);
      const versionStore = new PromptVersionStore({ store: limited as unknown as BaseStore });
      const saved = [];
      for (let i = 1; i <= 15; i++) {
        saved.push(await versionStore.save({ promptKey: 'p', content: `v${i}` }));
      }
      for (let i = 0; i < 12; i++) {
        await versionStore.save({ promptKey: `other-${i}`, content: 'x' });
      }

      const first = saved[0]!;
      expect(await versionStore.getById(first.id)).toMatchObject({ version: 1 });
      expect(await versionStore.listPromptKeys()).toHaveLength(13);

      await versionStore.activate(first.id);
      expect((await versionStore.getActive('p'))?.id).toBe(first.id);

      const rolled = await versionStore.rollback('p', saved[1]!.id);
      expect(rolled.version).toBe(16);
      const active = (await versionStore.listVersions('p')).filter((v) => v.active);
      expect(active.map((v) => v.id)).toEqual([rolled.id]);
    });

    it('allocates distinct version numbers to concurrent saves', async () => {
      const limited = new InMemoryBaseStore(10);
      const versionStore = new PromptVersionStore({ store: limited as unknown as BaseStore });

      const saved = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          versionStore.save({ promptKey: 'p', content: `c${i}`, active: true }),
        ),
      );

      expect(saved.map((v) => v.version).sort((a, b) => a - b)).toEqual(
        Array.from({ length: 12 }, (_, i) => i + 1),
      );
      const active = (await versionStore.listVersions('p')).filter((v) => v.active);
      expect(active).toHaveLength(1);
    });

    it('never reuses a version number recorded by the counter', async () => {
      const limited = new InMemoryBaseStore(10);
      const versionStore = new PromptVersionStore({ store: limited as unknown as BaseStore });
      const v1 = await versionStore.save({ promptKey: 'p', content: 'a' });
      const v2 = await versionStore.save({ promptKey: 'p', content: 'b' });
      await limited.delete(['prompt-versions', 'p'], v2.id);

      const v3 = await versionStore.save({ promptKey: 'p', content: 'c' });
      expect([v1.version, v3.version]).toEqual([1, 3]);
    });
  });
});

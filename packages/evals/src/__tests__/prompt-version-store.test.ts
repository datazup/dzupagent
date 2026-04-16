/**
 * Tests for PromptVersionStore — in-memory mock of BaseStore.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PromptVersionStore } from '../prompt-optimizer/prompt-version-store.js';
import type { PromptVersion } from '../prompt-optimizer/prompt-version-store.js';
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

  async get(namespace: string[], key: string): Promise<Record<string, unknown> | undefined> {
    const nsKey = this.nsKey(namespace);
    return this.data.get(nsKey)?.get(key);
  }

  async search(namespace: string[]): Promise<Array<{ key: string; value: Record<string, unknown> }>> {
    const results: Array<{ key: string; value: Record<string, unknown> }> = [];
    const nsKey = this.nsKey(namespace);
    const ns = this.data.get(nsKey);
    if (ns) {
      for (const [key, value] of ns.entries()) {
        results.push({ key, value });
      }
    }

    // Also search sub-namespaces (for listPromptKeys which searches at base level)
    for (const [storedNs, entries] of this.data.entries()) {
      if (storedNs.startsWith(nsKey + '::') && storedNs !== nsKey) {
        for (const [key, value] of entries.entries()) {
          results.push({ key, value });
        }
      }
    }

    return results;
  }

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
      const v1 = await store.save({ promptKey: 'p1', content: 'v1' });
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
      const v2 = await store.save({ promptKey: 'p1', content: 'v2' });

      await store.activate(v1.id);

      const active = await store.getActive('p1');
      expect(active?.id).toBe(v1.id);
    });

    it('throws for nonexistent version ID', async () => {
      await expect(store.activate('nonexistent')).rejects.toThrow('PromptVersion not found');
    });

    it('deactivates previous active version', async () => {
      const v1 = await store.save({ promptKey: 'p1', content: 'v1', active: true });
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

      const v = await customStore.save({ promptKey: 'p1', content: 'test' });
      const found = await customStore.getActive('p1');
      // Should not conflict with the default namespace
      expect(found).toBeNull(); // not active

      const versions = await customStore.listVersions('p1');
      expect(versions).toHaveLength(1);
      expect(versions[0]?.content).toBe('test');
    });
  });
});

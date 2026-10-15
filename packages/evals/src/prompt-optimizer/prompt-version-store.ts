/**
 * PromptVersionStore — persistent storage for system prompt versions,
 * linked to eval scores. Uses BaseStore from @langchain/langgraph.
 */

import type { BaseStore, Item } from '@langchain/langgraph';
import crypto from 'node:crypto';

/**
 * Page size for full reads. LangGraph stores apply a default `search` limit
 * of 10, so every read here pages explicitly instead of relying on it.
 */
const SEARCH_PAGE_SIZE = 100;
/** Upper bound on records one full read returns (runaway-store guard). */
const SEARCH_MAX_RECORDS = 100_000;
/** Per-prompt-key record holding the last allocated version number. */
const VERSION_COUNTER_KEY = '__version_counter__';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptVersionEvalScores {
  avgScore: number;
  passRate: number;
  scorerAverages: Record<string, number>;
  datasetSize: number;
  experimentId?: string;
}

export interface PromptVersion {
  id: string;
  promptKey: string;
  content: string;
  version: number;
  parentVersionId?: string | undefined;
  createdAt: string;
  metadata?: Record<string, unknown> | undefined;
  evalScores?: PromptVersionEvalScores | undefined;
  active: boolean;
}

export interface PromptVersionStoreConfig {
  store: BaseStore;
  namespace?: string[];
}

// ---------------------------------------------------------------------------
// Store Implementation
// ---------------------------------------------------------------------------

export class PromptVersionStore {
  private readonly store: BaseStore;
  private readonly namespace: string[];
  /** Tail of the per-prompt-key write chain (serializes save/activate). */
  private readonly keyLocks = new Map<string, Promise<unknown>>();

  constructor(config: PromptVersionStoreConfig) {
    this.store = config.store;
    this.namespace = config.namespace ?? ['prompt-versions'];
  }

  /**
   * Save a new version of a prompt.
   */
  async save(params: {
    promptKey: string;
    content: string;
    parentVersionId?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    evalScores?: PromptVersionEvalScores | undefined;
    active?: boolean | undefined;
  }): Promise<PromptVersion> {
    return this.withKeyLock(params.promptKey, () => this.saveLocked(params));
  }

  private async saveLocked(params: {
    promptKey: string;
    content: string;
    parentVersionId?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    evalScores?: PromptVersionEvalScores | undefined;
    active?: boolean | undefined;
  }): Promise<PromptVersion> {
    const nextVersion = await this.allocateVersion(params.promptKey);

    const id = crypto.randomUUID();
    const version: PromptVersion = {
      id,
      promptKey: params.promptKey,
      content: params.content,
      version: nextVersion,
      parentVersionId: params.parentVersionId,
      createdAt: new Date().toISOString(),
      metadata: params.metadata,
      evalScores: params.evalScores,
      active: params.active ?? false,
    };

    // If this version is active, deactivate all others first
    if (version.active) {
      await this.deactivateAll(params.promptKey);
    }

    const ns = [...this.namespace, params.promptKey];
    await this.store.put(ns, id, { value: version });

    return version;
  }

  /**
   * Get the active version for a prompt key.
   */
  async getActive(promptKey: string): Promise<PromptVersion | null> {
    const versions = await this.listVersions(promptKey);
    return versions.find((v) => v.active) ?? null;
  }

  /**
   * Get a specific version by ID.
   * Searches across all prompt keys since the ID is globally unique.
   */
  async getById(versionId: string): Promise<PromptVersion | null> {
    const keys = await this.listPromptKeys();

    for (const promptKey of keys) {
      const ns = [...this.namespace, promptKey];
      const items = await this.searchAll(ns);

      for (const item of items) {
        const version = item.value['value'] as PromptVersion | undefined;
        if (version && version.id === versionId) {
          return version;
        }
      }
    }

    return null;
  }

  /**
   * List all versions for a prompt key (newest first).
   */
  async listVersions(promptKey: string, limit?: number): Promise<PromptVersion[]> {
    const ns = [...this.namespace, promptKey];
    const items = await this.searchAll(ns);

    const versions: PromptVersion[] = [];
    for (const item of items) {
      const version = item.value['value'] as PromptVersion | undefined;
      if (version) {
        versions.push(version);
      }
    }

    // Sort by version number descending (newest first)
    versions.sort((a, b) => b.version - a.version);

    if (limit !== undefined && limit > 0) {
      return versions.slice(0, limit);
    }

    return versions;
  }

  /**
   * Set a version as the active one (deactivates previous).
   */
  async activate(versionId: string): Promise<void> {
    const found = await this.getById(versionId);
    if (!found) {
      throw new Error(`PromptVersion not found: ${versionId}`);
    }

    await this.withKeyLock(found.promptKey, async () => {
      // Re-read under the lock: a concurrent save/activate may have changed it.
      const ns = [...this.namespace, found.promptKey];
      const current = (await this.store.get(ns, versionId))?.value['value'] as
        | PromptVersion
        | undefined;
      if (!current) {
        throw new Error(`PromptVersion not found: ${versionId}`);
      }

      // Deactivate all versions for this prompt key
      await this.deactivateAll(found.promptKey);

      // Activate the target version
      const updated: PromptVersion = { ...current, active: true };
      await this.store.put(ns, versionId, { value: updated });
    });
  }

  /**
   * Rollback to a previous version.
   * Creates a new version with the same content as the target, and activates it.
   */
  async rollback(promptKey: string, targetVersionId: string): Promise<PromptVersion> {
    const target = await this.getById(targetVersionId);
    if (!target) {
      throw new Error(`PromptVersion not found: ${targetVersionId}`);
    }
    if (target.promptKey !== promptKey) {
      throw new Error(
        `Version ${targetVersionId} belongs to prompt key "${target.promptKey}", not "${promptKey}"`,
      );
    }

    const rolled = await this.save({
      promptKey,
      content: target.content,
      parentVersionId: targetVersionId,
      metadata: {
        ...target.metadata,
        rolledBackFrom: targetVersionId,
        rolledBackVersion: target.version,
      },
      evalScores: target.evalScores,
      active: true,
    });

    return rolled;
  }

  /**
   * Compare two versions (returns diff info).
   */
  async compare(
    versionIdA: string,
    versionIdB: string,
  ): Promise<{
    added: string[];
    removed: string[];
    scoreImprovement: number | null;
  }> {
    const [a, b] = await Promise.all([
      this.getById(versionIdA),
      this.getById(versionIdB),
    ]);

    if (!a) {
      throw new Error(`PromptVersion not found: ${versionIdA}`);
    }
    if (!b) {
      throw new Error(`PromptVersion not found: ${versionIdB}`);
    }

    const linesA = new Set(a.content.split('\n'));
    const linesB = new Set(b.content.split('\n'));

    const added: string[] = [];
    const removed: string[] = [];

    for (const line of linesB) {
      if (!linesA.has(line)) {
        added.push(line);
      }
    }

    for (const line of linesA) {
      if (!linesB.has(line)) {
        removed.push(line);
      }
    }

    let scoreImprovement: number | null = null;
    if (a.evalScores && b.evalScores) {
      scoreImprovement = b.evalScores.avgScore - a.evalScores.avgScore;
    }

    return { added, removed, scoreImprovement };
  }

  /**
   * List all prompt keys that have stored versions.
   */
  async listPromptKeys(): Promise<string[]> {
    // Search at the base namespace level to find all sub-namespaces
    const items = await this.searchAll(this.namespace);
    const keys = new Set<string>();

    for (const item of items) {
      const version = item.value['value'] as PromptVersion | undefined;
      if (version) {
        keys.add(version.promptKey);
      }
    }

    return [...keys].sort();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async deactivateAll(promptKey: string): Promise<void> {
    const ns = [...this.namespace, promptKey];
    const items = await this.searchAll(ns);

    for (const item of items) {
      const version = item.value['value'] as PromptVersion | undefined;
      if (version && version.active) {
        const updated: PromptVersion = { ...version, active: false };
        await this.store.put(ns, version.id, { value: updated });
      }
    }
  }

  /**
   * Allocate the next version number for `promptKey` and record it in the
   * counter record. Callers hold the key lock. The counter is the floor, the
   * stored versions the fallback (pre-counter data, or a lost counter), so a
   * number is never handed out twice.
   */
  private async allocateVersion(promptKey: string): Promise<number> {
    const ns = [...this.namespace, promptKey];
    const counterItem = await this.store.get(ns, VERSION_COUNTER_KEY);
    const counted = counterItem?.value['lastVersion'];
    const lastCounted = typeof counted === 'number' && Number.isFinite(counted) ? counted : 0;
    const existing = await this.listVersions(promptKey);
    const lastStored = existing.length > 0 ? Math.max(...existing.map((v) => v.version)) : 0;
    const next = Math.max(lastCounted, lastStored) + 1;
    await this.store.put(ns, VERSION_COUNTER_KEY, { lastVersion: next });
    return next;
  }

  /**
   * Run `fn` after every earlier save/activate for `promptKey` settled.
   * `BaseStore` has no compare-and-set, so concurrent writers on one store
   * instance are serialized here; the chain survives a failed `fn`.
   */
  private withKeyLock<T>(promptKey: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.keyLocks.get(promptKey) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.keyLocks.set(promptKey, tail);
    void tail.then(() => {
      if (this.keyLocks.get(promptKey) === tail) this.keyLocks.delete(promptKey);
    });
    return run;
  }

  /**
   * Read every record under `namespacePrefix`, page by page. A store that
   * ignores `offset` (returns the same rows again) ends the scan once a page
   * contributes nothing new.
   */
  private async searchAll(namespacePrefix: string[]): Promise<Item[]> {
    const seen = new Set<string>();
    const all: Item[] = [];
    for (let offset = 0; all.length < SEARCH_MAX_RECORDS; offset += SEARCH_PAGE_SIZE) {
      const page = await this.store.search(namespacePrefix, {
        limit: SEARCH_PAGE_SIZE,
        offset,
      });
      let added = 0;
      for (const item of page) {
        const id = `${(item.namespace ?? []).join('\u0000')}\u0001${item.key}`;
        if (seen.has(id)) continue;
        seen.add(id);
        all.push(item);
        added++;
      }
      if (page.length < SEARCH_PAGE_SIZE || added === 0) break;
    }
    return all;
  }
}

/**
 * PromptVersionStore — persistent storage for system prompt versions,
 * linked to eval scores. Uses BaseStore from @langchain/langgraph.
 */

import type { BaseStore } from '@langchain/langgraph';
import crypto from 'node:crypto';

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
  parentVersionId?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
  evalScores?: PromptVersionEvalScores;
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
    parentVersionId?: string;
    metadata?: Record<string, unknown>;
    evalScores?: PromptVersionEvalScores;
    active?: boolean;
  }): Promise<PromptVersion> {
    const existing = await this.listVersions(params.promptKey);
    const nextVersion = existing.length > 0
      ? Math.max(...existing.map((v) => v.version)) + 1
      : 1;

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
      const items = await this.store.search(ns);

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
    const items = await this.store.search(ns);

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
    const version = await this.getById(versionId);
    if (!version) {
      throw new Error(`PromptVersion not found: ${versionId}`);
    }

    // Deactivate all versions for this prompt key
    await this.deactivateAll(version.promptKey);

    // Activate the target version
    const ns = [...this.namespace, version.promptKey];
    const updated: PromptVersion = { ...version, active: true };
    await this.store.put(ns, versionId, { value: updated });
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
    const items = await this.store.search(this.namespace);
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
    const items = await this.store.search(ns);

    for (const item of items) {
      const version = item.value['value'] as PromptVersion | undefined;
      if (version && version.active) {
        const updated: PromptVersion = { ...version, active: false };
        await this.store.put(ns, version.id, { value: updated });
      }
    }
  }
}

/**
 * SkillPackLoader — loads built-in and custom skill packs into a BaseStore.
 */
import type { BaseStore } from "@langchain/langgraph";
import { BUILT_IN_PACKS } from "./skill-packs-definitions.js";
import {
  CONVENTIONS_NAMESPACE,
  PACKS_META_NAMESPACE,
  RULES_NAMESPACE,
  SKILLS_NAMESPACE,
  buildRecord,
  entryKey,
  namespaceForType,
  type SkillPack,
} from "./skill-packs-types.js";

export class SkillPackLoader {
  private readonly store: BaseStore;
  private readonly namespace: string[];

  constructor(store: BaseStore, namespace?: string[]) {
    this.store = store;
    this.namespace = namespace ?? [];
  }

  /**
   * Load a skill pack into the store. Idempotent — skips if already loaded.
   */
  async loadPack(
    pack: SkillPack,
  ): Promise<{ loaded: number; skipped: number }> {
    const alreadyLoaded = await this.isPackLoaded(pack.id);
    if (alreadyLoaded) {
      return { loaded: 0, skipped: pack.entries.length };
    }

    let loaded = 0;

    for (let i = 0; i < pack.entries.length; i++) {
      const entry = pack.entries[i];
      if (!entry) continue;

      const key = entryKey(pack.id, entry.type, i);
      const ns = [...this.namespace, ...namespaceForType(entry.type)];
      const record = buildRecord(key, entry, pack.id);

      try {
        await this.store.put(ns, key, record);
        loaded++;
      } catch (err) {
        // Non-fatal — continue loading remaining entries, but surface the drop
        // so the pack under-loading is observable instead of silent.
        console.warn("[memory] skill-pack entry write failed", {
          operation: "skillPacks.loadPack.entry",
          packId: pack.id,
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Mark pack as loaded
    try {
      const metaNs = [...this.namespace, ...PACKS_META_NAMESPACE];
      await this.store.put(metaNs, pack.id, {
        id: pack.id,
        name: pack.name,
        version: pack.version,
        featureCategory: pack.featureCategory,
        entryCount: pack.entries.length,
        loadedAt: new Date().toISOString(),
        text: `${pack.name} ${pack.description}`,
      });
    } catch (err) {
      // Non-fatal — metadata write failure does not invalidate loaded entries,
      // but without the meta record isPackLoaded() will report false and the
      // pack will be re-loaded next time. Surface it.
      console.warn("[memory] skill-pack metadata write failed", {
        operation: "skillPacks.loadPack.meta",
        packId: pack.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { loaded, skipped: 0 };
  }

  /**
   * Load all built-in packs.
   */
  async loadAllBuiltIn(): Promise<{
    packsLoaded: number;
    totalEntries: number;
  }> {
    let packsLoaded = 0;
    let totalEntries = 0;

    for (const pack of BUILT_IN_PACKS) {
      const result = await this.loadPack(pack);
      if (result.loaded > 0) {
        packsLoaded++;
        totalEntries += result.loaded;
      }
    }

    return { packsLoaded, totalEntries };
  }

  /**
   * Check if a pack is already loaded.
   */
  async isPackLoaded(packId: string): Promise<boolean> {
    try {
      const metaNs = [...this.namespace, ...PACKS_META_NAMESPACE];
      const item = await this.store.get(metaNs, packId);
      return item !== undefined && item !== null;
    } catch (err) {
      // A store error is NOT the same as "not loaded" — but callers treat the
      // boolean the same either way (they will attempt a load). Surface the
      // error so the ambiguous false is distinguishable in logs.
      console.warn("[memory] skill-pack isPackLoaded check failed", {
        operation: "skillPacks.isPackLoaded",
        packId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Get list of loaded pack IDs.
   */
  async getLoadedPacks(): Promise<string[]> {
    try {
      const metaNs = [...this.namespace, ...PACKS_META_NAMESPACE];
      const items = await this.store.search(metaNs, { limit: 100 });
      return items
        .map((item) => {
          const value = item.value as Record<string, unknown>;
          return typeof value["id"] === "string" ? value["id"] : null;
        })
        .filter((id): id is string => id !== null);
    } catch (err) {
      // A store error is NOT the same as "no packs loaded" — surface it so the
      // empty result is distinguishable from a genuine empty store.
      console.warn("[memory] skill-pack getLoadedPacks search failed", {
        operation: "skillPacks.getLoadedPacks",
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Unload a pack — remove its entries and metadata from the store.
   */
  async unloadPack(packId: string): Promise<number> {
    // Find the pack definition
    const pack = BUILT_IN_PACKS.find((p) => p.id === packId);
    let removed = 0;

    if (pack) {
      // Remove entries using deterministic keys
      for (let i = 0; i < pack.entries.length; i++) {
        const entry = pack.entries[i];
        if (!entry) continue;

        const key = entryKey(packId, entry.type, i);
        const ns = [...this.namespace, ...namespaceForType(entry.type)];

        try {
          await this.store.delete(ns, key);
          removed++;
        } catch {
          // Non-fatal
        }
      }
    } else {
      // For custom packs, search across all namespaces for entries tagged with packId
      for (const ns of [
        SKILLS_NAMESPACE,
        RULES_NAMESPACE,
        CONVENTIONS_NAMESPACE,
      ]) {
        const fullNs = [...this.namespace, ...ns];
        try {
          const items = await this.store.search(fullNs, { limit: 1000 });
          for (const item of items) {
            const value = item.value as Record<string, unknown>;
            if (value["packId"] === packId) {
              await this.store.delete(fullNs, item.key);
              removed++;
            }
          }
        } catch {
          // Non-fatal
        }
      }
    }

    // Remove metadata
    try {
      const metaNs = [...this.namespace, ...PACKS_META_NAMESPACE];
      await this.store.delete(metaNs, packId);
    } catch {
      // Non-fatal
    }

    return removed;
  }
}

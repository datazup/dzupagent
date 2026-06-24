/**
 * Vector-backed SemanticSearchProvider for the AgentRegistry — ECO-050 upgrade.
 *
 * Replaces KeywordFallbackSearch with real vector similarity using
 * a SemanticStore (VectorStore + EmbeddingProvider). Agent capabilities
 * are embedded on registration and queried by vector similarity on discover().
 */

import type { SemanticSearchProvider } from "./semantic-search.js";
import type { RegisteredAgent } from "./types.js";
import type { SemanticStore } from "../vectordb/semantic-store.js";
import { defaultLogger } from "../utils/logger.js";

const REGISTRY_COLLECTION = "agent_registry";

/**
 * SemanticSearchProvider backed by a VectorStore + EmbeddingProvider.
 *
 * On `indexAgent()`, builds a text representation of the agent's name,
 * description, and capabilities, then upserts the embedding into the
 * vector store. On `search()`, performs vector similarity search.
 *
 * @example
 * ```ts
 * const search = new VectorStoreSemanticSearch(semanticStore)
 * await semanticStore.ensureCollection('agent_registry', { dimensions: 1536 })
 * search.indexAgent(agent)
 * const embedding = await search.embedQuery('code review')
 * const results = await search.search(embedding, 5)
 * ```
 */
export class VectorStoreSemanticSearch implements SemanticSearchProvider {
  constructor(private readonly semanticStore: SemanticStore) {}

  async embedQuery(text: string): Promise<number[]> {
    return this.semanticStore.embedding.embedQuery(text);
  }

  async search(
    embedding: number[],
    limit: number,
  ): Promise<Array<{ agentId: string; score: number }>> {
    const results = await this.semanticStore.store.search(REGISTRY_COLLECTION, {
      vector: embedding,
      limit,
      includeMetadata: true,
    });
    return results.map((r) => ({ agentId: r.id, score: r.score }));
  }

  indexAgent(agent: RegisteredAgent): void {
    const text = [
      agent.name,
      agent.description,
      ...agent.capabilities.map((c) => `${c.name}: ${c.description ?? ""}`),
    ].join(" ");

    // Fire and forget — don't block registration
    this.semanticStore
      .upsert(REGISTRY_COLLECTION, [
        { id: agent.id, text, metadata: { name: agent.name } },
      ])
      .catch((err: unknown) => {
        // ERR-H-06: non-fatal but must be observable
        defaultLogger.warn(
          "[vector-semantic-search] indexAgent() upsert failed",
          {
            agentId: agent.id,
            err: err instanceof Error ? err.message : String(err),
          },
        );
      });
  }

  removeAgent(agentId: string): void {
    this.semanticStore
      .delete(REGISTRY_COLLECTION, { ids: [agentId] })
      .catch((err: unknown) => {
        // ERR-H-06: non-fatal but must be observable
        defaultLogger.warn(
          "[vector-semantic-search] removeAgent() delete failed",
          {
            agentId,
            err: err instanceof Error ? err.message : String(err),
          },
        );
      });
  }
}

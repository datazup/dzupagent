/**
 * Auto-detection utilities for embedding providers and vector store backends.
 *
 * Reads environment variables to determine the best available provider,
 * falling through a priority chain until one is found.
 */

import type { EmbeddingProvider } from "./embedding-types.js";
import { createVoyageEmbedding } from "./embeddings/voyage-embedding.js";
import { createOpenAIEmbedding } from "./embeddings/openai-embedding.js";
import { createCohereEmbedding } from "./embeddings/cohere-embedding.js";
import { createInternalEmbedding } from "./embeddings/internal-embedding.js";
import { InMemoryVectorStore } from "./in-memory-vector-store.js";
import { SemanticStore } from "./semantic-store.js";
import type { VectorStore } from "./types.js";
import {
  PineconeAdapter,
  QdrantAdapter,
  TurbopufferAdapter,
} from "./adapters/index.js";

/**
 * Vector provider names that keep data in this process.
 *
 * Anything {@link detectVectorProvider} returns outside this set is a network
 * (or on-disk, in LanceDB's case) backend the operator must opt into
 * deliberately.
 */
export const IN_PROCESS_VECTOR_PROVIDERS: readonly string[] = ["memory"];

/** True when the detected vector provider stores data outside this process. */
export function isExternalVectorProvider(provider: string): boolean {
  return !IN_PROCESS_VECTOR_PROVIDERS.includes(provider);
}

/**
 * Auto-detect embedding provider from environment variables.
 *
 * Priority chain: EMBEDDER_INTERNAL_URL -> VOYAGE_API_KEY -> OPENAI_API_KEY -> COHERE_API_KEY -> throws
 *
 * EMBEDDER_INTERNAL_URL is checked first: a self-hosted embedder that's
 * explicitly configured is a deliberate operator choice (cost/latency/data
 * residency), so it takes priority over hosted providers even when their
 * API keys are also present.
 *
 * Every provider this can return is network-backed: calling it is a decision
 * to send the caller's text off-process. Callers that must not egress content
 * should build `createLocalEmbedding()` instead, and callers that must gate on
 * egress should inspect the environment *before* calling this — once a
 * provider exists, the choice has already been made.
 *
 * @param env - Optional env object (defaults to process.env)
 */
export function createAutoEmbeddingProvider(
  env?: Record<string, string | undefined>
): EmbeddingProvider {
  const e = env ?? process.env;

  const internalUrl = e["EMBEDDER_INTERNAL_URL"];
  if (internalUrl) {
    const internalModel = e["EMBEDDER_INTERNAL_MODEL"];
    const internalDimensions = e["EMBEDDER_INTERNAL_DIMENSIONS"];
    return createInternalEmbedding({
      baseUrl: internalUrl,
      ...(internalModel != null ? { model: internalModel } : {}),
      ...(internalDimensions != null
        ? { dimensions: Number(internalDimensions) }
        : {}),
    });
  }

  const voyageKey = e["VOYAGE_API_KEY"];
  if (voyageKey) {
    const voyageModel = e["VOYAGE_MODEL"];
    return createVoyageEmbedding({
      apiKey: voyageKey,
      ...(voyageModel != null ? { model: voyageModel } : {}),
    });
  }

  const openaiKey = e["OPENAI_API_KEY"];
  if (openaiKey) {
    const openaiModel = e["OPENAI_EMBEDDING_MODEL"];
    const openaiBaseUrl = e["OPENAI_BASE_URL"];
    return createOpenAIEmbedding({
      apiKey: openaiKey,
      ...(openaiModel != null ? { model: openaiModel } : {}),
      ...(openaiBaseUrl != null ? { baseUrl: openaiBaseUrl } : {}),
    });
  }

  const cohereKey = e["COHERE_API_KEY"];
  if (cohereKey) {
    const cohereModel = e["COHERE_EMBEDDING_MODEL"];
    return createCohereEmbedding({
      apiKey: cohereKey,
      ...(cohereModel != null ? { model: cohereModel } : {}),
    });
  }

  throw new Error(
    "No embedding provider detected. Set one of: VOYAGE_API_KEY, OPENAI_API_KEY, COHERE_API_KEY"
  );
}

/**
 * Result of auto-detecting the vector store provider.
 *
 * NOTE: Actual adapter construction happens in Phase 2.
 * This function only returns config metadata for the detected provider.
 */
export interface AutoDetectResult {
  provider: string;
  config: Record<string, unknown>;
}

/**
 * Auto-detect vector store provider from environment variables.
 *
 * Priority chain:
 * 1. VECTOR_PROVIDER env var (explicit override)
 * 2. QDRANT_URL present -> qdrant
 * 3. TURBOPUFFER_API_KEY present -> turbopuffer
 * 4. PINECONE_API_KEY present -> pinecone
 * 5. LANCEDB_URI present -> lancedb
 * 6. Falls back to 'memory' (in-memory store)
 *
 * @param env - Optional env object (defaults to process.env)
 */
export function detectVectorProvider(
  env?: Record<string, string | undefined>
): AutoDetectResult {
  const e = env ?? process.env;

  // Explicit override
  const explicit = e["VECTOR_PROVIDER"];
  if (explicit) {
    return {
      provider: explicit,
      config: { source: "VECTOR_PROVIDER" },
    };
  }

  // Qdrant
  const qdrantUrl = e["QDRANT_URL"];
  if (qdrantUrl) {
    return {
      provider: "qdrant",
      config: {
        url: qdrantUrl,
        apiKey: e["QDRANT_API_KEY"],
      },
    };
  }

  // Turbopuffer
  const turbopufferKey = e["TURBOPUFFER_API_KEY"];
  if (turbopufferKey) {
    return {
      provider: "turbopuffer",
      config: {
        apiKey: turbopufferKey,
        baseUrl: e["TURBOPUFFER_BASE_URL"],
        namespacePrefix: e["TURBOPUFFER_NAMESPACE_PREFIX"],
      },
    };
  }

  // Pinecone
  const pineconeKey = e["PINECONE_API_KEY"];
  if (pineconeKey) {
    return {
      provider: "pinecone",
      config: {
        apiKey: pineconeKey,
        environment: e["PINECONE_ENVIRONMENT"],
      },
    };
  }

  // LanceDB (embedded, persistent)
  const lancedbUri = e["LANCEDB_URI"];
  if (lancedbUri) {
    return {
      provider: "lancedb",
      config: {
        uri: lancedbUri,
      },
    };
  }

  // Fallback: in-memory
  return {
    provider: "memory",
    config: {},
  };
}

/**
 * Build the VectorStore named by {@link detectVectorProvider}.
 *
 * Falls back to `InMemoryVectorStore` for `memory` and for any provider name
 * with no adapter compiled in, so auto-detection can never fail closed on an
 * unrecognised `VECTOR_PROVIDER` value.
 */
export function createDetectedVectorStore(
  detected: AutoDetectResult
): VectorStore {
  const cfg = detected.config;
  const str = (k: string): string | undefined => {
    const v = cfg[k];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };

  switch (detected.provider) {
    case "qdrant": {
      const url = str("url") ?? process.env["QDRANT_URL"];
      const apiKey = str("apiKey") ?? process.env["QDRANT_API_KEY"];
      return new QdrantAdapter({
        ...(url != null ? { url } : {}),
        ...(apiKey != null ? { apiKey } : {}),
      });
    }
    case "turbopuffer": {
      const apiKey = str("apiKey") ?? process.env["TURBOPUFFER_API_KEY"];
      if (apiKey == null) break;
      const baseUrl = str("baseUrl");
      const namespacePrefix = str("namespacePrefix");
      return new TurbopufferAdapter({
        apiKey,
        ...(baseUrl != null ? { baseUrl } : {}),
        ...(namespacePrefix != null ? { namespacePrefix } : {}),
      });
    }
    case "pinecone": {
      const apiKey = str("apiKey") ?? process.env["PINECONE_API_KEY"];
      if (apiKey == null) break;
      const environment = str("environment");
      return new PineconeAdapter({
        apiKey,
        ...(environment != null ? { environment } : {}),
      });
    }
    case "lancedb":
      // LanceDB opens its connection asynchronously (`LanceDBAdapter.create`),
      // so it cannot be built from this synchronous factory. Throw rather than
      // fall back to an in-memory store: silently substituting a non-durable
      // backend for the one the operator configured is the exact failure mode
      // this function was fixed to remove.
      throw new Error(
        "LANCEDB_URI is set, but LanceDB requires an async connection. " +
          "Build it with `await LanceDBAdapter.create({ uri })` and pass it as " +
          "`vectorStore` instead of using auto-detection.",
      );
    default:
      break;
  }

  return new InMemoryVectorStore();
}

/**
 * Create a fully-wired SemanticStore by auto-detecting both the embedding
 * provider and the vector store backend from the environment.
 *
 * The vector backend follows {@link detectVectorProvider}, so setting
 * `QDRANT_URL` / `PINECONE_API_KEY` / `TURBOPUFFER_API_KEY` / `LANCEDB_URI`
 * (or an explicit `VECTOR_PROVIDER`) actually takes effect here. With none of
 * them set it falls back to `InMemoryVectorStore`, which is fine for local and
 * test runs but is not durable.
 *
 * @param env - Optional env object (defaults to process.env)
 * @throws if no embedding provider can be detected
 */
export function createAutoSemanticStore(
  env?: Record<string, string | undefined>
): SemanticStore {
  const embedding = createAutoEmbeddingProvider(env);
  const vectorStore = createDetectedVectorStore(detectVectorProvider(env));

  return new SemanticStore({
    embedding,
    vectorStore,
  });
}

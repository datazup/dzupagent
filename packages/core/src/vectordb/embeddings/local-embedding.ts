/**
 * In-process EmbeddingProvider — zero network, zero API key.
 *
 * Every other provider in this directory sends the caller's text to a remote
 * endpoint (`api.openai.com`, a self-hosted embedder URL, ...). That makes
 * "just embed something" an outbound data transfer, which is the wrong default
 * for a convenience/auto path: memory content is exactly the corpus that has
 * already been through PII redaction, i.e. content known to have carried PII.
 *
 * This provider is the safe default that path can resolve to. It hashes tokens
 * into a fixed-width bag-of-tokens vector and L2-normalizes the result, so
 * cosine similarity is a real (if shallow) lexical-overlap signal rather than a
 * constant. It is deterministic, synchronous in spirit, and never leaves the
 * process.
 *
 * It is NOT a semantic model: no synonymy, no multilingual alignment, no
 * subword handling. Use it for local development, tests, and deployments that
 * must not egress content; use a hosted provider when retrieval quality
 * matters.
 */

import type { EmbeddingProvider } from "../embedding-types.js";

/** Model identifier reported by {@link createLocalEmbedding}. */
export const LOCAL_EMBEDDING_MODEL_ID = "local-hashed-bag-of-tokens-v1";

/** Default vector width. Wide enough that unrelated tokens rarely collide. */
export const LOCAL_EMBEDDING_DEFAULT_DIMENSIONS = 256;

export interface LocalEmbeddingConfig {
  /**
   * Vector width. Larger reduces hash collisions at proportional memory cost.
   * Defaults to {@link LOCAL_EMBEDDING_DEFAULT_DIMENSIONS}.
   */
  dimensions?: number;
}

/** FNV-1a — cheap, well-distributed, and stable across processes/versions. */
function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in uint32 via Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/**
 * Create an in-process embedding provider.
 *
 * @example
 * ```ts
 * const store = new SemanticStore({
 *   embedding: createLocalEmbedding(),
 *   vectorStore: new InMemoryVectorStore(),
 * })
 * ```
 */
export function createLocalEmbedding(
  config: LocalEmbeddingConfig = {}
): EmbeddingProvider {
  const dimensions =
    config.dimensions ?? LOCAL_EMBEDDING_DEFAULT_DIMENSIONS;
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new Error(
      `createLocalEmbedding: dimensions must be a positive integer, got ${String(
        config.dimensions
      )}`
    );
  }

  const embedOne = (text: string): number[] => {
    const vec = new Array<number>(dimensions).fill(0);
    for (const token of tokenize(text)) {
      const slot = hashToken(token) % dimensions;
      // Sign bit taken from a second hash round so that two tokens colliding
      // into one slot do not always reinforce each other.
      const sign = hashToken(`${token}#s`) % 2 === 0 ? 1 : -1;
      vec[slot] = (vec[slot] ?? 0) + sign;
    }
    let sumSquares = 0;
    for (const v of vec) sumSquares += v * v;
    const norm = Math.sqrt(sumSquares);
    // An empty/untokenizable text yields the zero vector; leave it as-is
    // rather than dividing by zero. Cosine against it is 0, i.e. "no signal".
    if (norm === 0) return vec;
    return vec.map((v) => v / norm);
  };

  return {
    modelId: LOCAL_EMBEDDING_MODEL_ID,
    dimensions,
    embed: (texts: string[]): Promise<number[][]> =>
      Promise.resolve(texts.map(embedOne)),
    embedQuery: (text: string): Promise<number[]> =>
      Promise.resolve(embedOne(text)),
  };
}

/**
 * True when `provider` never sends text off-process.
 *
 * Used by callers that must assert a data-residency property about a provider
 * they were handed rather than one they built.
 */
export function isLocalEmbedding(provider: EmbeddingProvider): boolean {
  return provider.modelId === LOCAL_EMBEDDING_MODEL_ID;
}

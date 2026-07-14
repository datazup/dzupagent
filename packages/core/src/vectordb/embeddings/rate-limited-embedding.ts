/**
 * Rate-limited EmbeddingProvider decorator.
 *
 * Wraps any EmbeddingProvider with a shared TokenBucket so concurrent callers
 * (e.g. multiple ingestion jobs running in parallel) throttle against one
 * bucket instead of each independently bursting the underlying API and
 * tripping provider-side rate limits (HTTP 429).
 */

import type { EmbeddingProvider } from "../embedding-types.js";
import {
  TokenBucket,
  type TokenBucketConfig,
} from "../../rate-limit/token-bucket.js";

export interface RateLimitedEmbeddingConfig extends TokenBucketConfig {
  /** Tokens consumed per embed() call, scaled by batch size (default: 1 token per text). */
  tokensPerText?: number;
}

/**
 * Wrap an EmbeddingProvider so every embed()/embedQuery() call waits on a
 * shared TokenBucket before hitting the underlying provider.
 *
 * Pass the same TokenBucket instance (or the same wrapped provider) to all
 * concurrent callers that must share one throttle.
 */
export function withRateLimit(
  provider: EmbeddingProvider,
  bucket: TokenBucket | RateLimitedEmbeddingConfig
): EmbeddingProvider {
  const limiter =
    bucket instanceof TokenBucket ? bucket : new TokenBucket(bucket);
  const tokensPerText =
    bucket instanceof TokenBucket ? 1 : bucket.tokensPerText ?? 1;
  const capacityTexts = Math.max(
    1,
    Math.floor(limiter.capacity / tokensPerText)
  );

  async function embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Split into sub-batches that never request more tokens than the
    // bucket's capacity, so a large caller batch throttles across several
    // waits instead of throwing RATE_LIMIT_EXCEEDED on a single oversized ask.
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += capacityTexts) {
      const slice = texts.slice(i, i + capacityTexts);
      await limiter.waitUntilAvailable(slice.length * tokensPerText);
      results.push(...(await provider.embed(slice)));
    }
    return results;
  }

  async function embedQuery(text: string): Promise<number[]> {
    await limiter.waitUntilAvailable(tokensPerText);
    return provider.embedQuery(text);
  }

  return {
    modelId: provider.modelId,
    dimensions: provider.dimensions,
    embed,
    embedQuery,
  };
}

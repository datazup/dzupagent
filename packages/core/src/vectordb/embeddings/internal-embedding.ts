/**
 * Internal self-hosted embedding provider (BGE-M3-compatible) using raw fetch().
 * Local-only — no API key required. Targets the codeindex-app embedder API shape:
 * POST /embed { inputs: string[] } -> { dense: number[][], sparse?, model?, dim? }.
 */

import type { EmbeddingProvider } from "../embedding-types.js";
import { vectorHttpErrorToForgeError } from "../http-error.js";
import type { ForgeError } from "../../errors/forge-error.js";
import { calculateBackoff } from "../../utils/backoff.js";

export interface InternalEmbeddingConfig {
  /** Base URL of the internal embedder (default: 'http://localhost:8001') */
  baseUrl?: string;
  /** Output dimensions (default: 1024, BGE-M3's native dense dimension) */
  dimensions?: number;
  /** Model identifier reported by the provider (default: 'bge-m3') */
  model?: string;
  /** Max retry attempts on rate limit / transient errors (default: 3) */
  maxRetries?: number;
}

const MAX_RETRY_DELAY_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface InternalEmbedResponse {
  dense: number[][];
}

/**
 * Create an EmbeddingProvider backed by a self-hosted internal embedder
 * (e.g. apps/codeindex-app/apps/embedder, BGE-M3 on port 8001).
 *
 * Uses `fetch()` directly — no SDK dependency. Retry/backoff mirrors
 * createOpenAIEmbedding so callers get consistent behavior across providers.
 */
export function createInternalEmbedding(
  config: InternalEmbeddingConfig = {}
): EmbeddingProvider {
  const baseUrl = (config.baseUrl ?? "http://localhost:8001").replace(
    /\/$/,
    ""
  );
  const dimensions = config.dimensions ?? 1024;
  const model = config.model ?? "bge-m3";
  const maxRetries = config.maxRetries ?? 3;

  async function embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    for (let attempt = 0; ; attempt++) {
      // eslint-disable-next-line no-restricted-globals -- intentional: internal self-hosted embedder; baseUrl is operator-configured infrastructure, not user input
      const response = await fetch(`${baseUrl}/embed`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: texts }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "unknown error");
        const error: ForgeError = vectorHttpErrorToForgeError(
          response.status,
          body,
          "internal-embedding"
        );

        if (!error.recoverable || attempt >= maxRetries) {
          throw error;
        }

        const backoffMs = calculateBackoff(attempt, {
          initialBackoffMs: 1000,
          maxBackoffMs: MAX_RETRY_DELAY_MS,
          multiplier: 2,
          jitter: true,
        });
        await sleep(Math.min(backoffMs, MAX_RETRY_DELAY_MS));
        continue;
      }

      const json = (await response.json()) as InternalEmbedResponse;
      return json.dense;
    }
  }

  async function embedQuery(text: string): Promise<number[]> {
    const results = await embed([text]);
    const first = results[0];
    if (!first) {
      throw new Error("Internal embedding returned no results");
    }
    return first;
  }

  return {
    modelId: model,
    dimensions,
    embed,
    embedQuery,
  };
}

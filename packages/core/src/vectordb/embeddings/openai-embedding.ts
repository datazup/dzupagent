/**
 * OpenAI-compatible embedding provider using raw fetch().
 * Supports OpenAI API and any API-compatible endpoint (Azure, vLLM, etc.).
 */

import type { EmbeddingProvider } from "../embedding-types.js";
import { vectorHttpErrorToForgeError } from "../http-error.js";
import type { ForgeError } from "../../errors/forge-error.js";
import { calculateBackoff } from "../../utils/backoff.js";

export interface OpenAIEmbeddingConfig {
  apiKey: string;
  /** Model name (default: 'text-embedding-3-small') */
  model?: string;
  /** Output dimensions (default: 1536) */
  dimensions?: number;
  /** Base URL (default: 'https://api.openai.com/v1') */
  baseUrl?: string;
  /** Max retry attempts on rate limit / transient errors (default: 3) */
  maxRetries?: number;
}

/** Cap on computed/parsed backoff delay so a bad Retry-After can't hang the pipeline. */
const MAX_RETRY_DELAY_MS = 30_000;

function parseRetryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) return dateMs - Date.now();
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface OpenAIEmbeddingResponseData {
  embedding: number[];
  index: number;
}

interface OpenAIEmbeddingResponse {
  data: OpenAIEmbeddingResponseData[];
}

/**
 * Create an EmbeddingProvider backed by the OpenAI embeddings API.
 *
 * Uses `fetch()` directly — no openai SDK dependency.
 */
export function createOpenAIEmbedding(
  config: OpenAIEmbeddingConfig
): EmbeddingProvider {
  const model = config.model ?? "text-embedding-3-small";
  const dimensions = config.dimensions ?? 1536;
  const baseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(
    /\/$/,
    ""
  );
  const maxRetries = config.maxRetries ?? 3;

  async function embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    for (let attempt = 0; ; attempt++) {
      // eslint-disable-next-line no-restricted-globals -- intentional: OpenAI embeddings vendor API; baseUrl is operator-configured infrastructure, not user input
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model,
          input: texts,
          dimensions,
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "unknown error");
        const error: ForgeError = vectorHttpErrorToForgeError(
          response.status,
          body,
          "openai-embedding"
        );

        if (!error.recoverable || attempt >= maxRetries) {
          throw error;
        }

        const retryAfterMs = parseRetryAfterMs(response);
        const backoffMs = calculateBackoff(attempt, {
          initialBackoffMs: 1000,
          maxBackoffMs: MAX_RETRY_DELAY_MS,
          multiplier: 2,
          jitter: true,
        });
        const delayMs = Math.min(
          Math.max(retryAfterMs ?? backoffMs, 0),
          MAX_RETRY_DELAY_MS
        );
        await sleep(delayMs);
        continue;
      }

      const json = (await response.json()) as OpenAIEmbeddingResponse;
      // Sort by index to ensure order matches input
      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      return sorted.map((d) => d.embedding);
    }
  }

  async function embedQuery(text: string): Promise<number[]> {
    const results = await embed([text]);
    const first = results[0];
    if (!first) {
      throw new Error("OpenAI embedding returned no results");
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

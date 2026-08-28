/**
 * Tokenizer abstractions with lazy-loaded backends and a zero-dep heuristic
 * fallback.
 *
 * The framework cannot hard-depend on `@anthropic-ai/tokenizer` or
 * `js-tiktoken` (they are optional, large, and platform sensitive). Instead,
 * each provider-specific tokenizer attempts a lazy `require` of its backend
 * and falls back to the char/4 heuristic when the backend is unavailable.
 *
 * Public surface intentionally keeps `countTokens()` synchronous so callers
 * (compression triggers, budget warnings, fragment composers) can treat
 * tokenizers as cheap, predictable utilities.
 */
import { createRequire } from "node:module";
import type { BaseMessage } from "@langchain/core/messages";

import { logger } from "../logging/secure-logger.js";

/** Generic chat-message shape compatible with LangChain BaseMessage and plain objects. */
export interface TokenizableMessage {
  content: unknown;
  role?: string;
  type?: string;
}

/** How a token measurement was produced. */
export type TokenMeasurementMethod =
  | "exact"
  | "encoding-fallback"
  | "heuristic";

/** Token count with provenance for enforcement and telemetry. */
export interface TokenMeasurementResult {
  tokens: number;
  method: TokenMeasurementMethod;
  model?: string;
  encoding?: string;
  reason?: string;
}

/** Common interface implemented by every tokenizer backend. */
export interface Tokenizer {
  /** Identifier of the underlying tokenizer model (e.g. `claude-3-5-sonnet`, `gpt-4o`, `heuristic`). */
  readonly model: string;
  /**
   * Encode `text` into a numeric token-id array. When the underlying backend
   * is unavailable, returns an array of length `countTokens(text)` filled
   * with placeholder zeros so callers can still rely on `.length`.
   */
  encode(text: string): number[];
  /** Count tokens in `text`. Always synchronous and never throws. */
  countTokens(text: string): number;
  /**
   * Detailed count with provenance. Optional so existing structural tokenizer
   * implementations remain source-compatible.
   */
  countDetailed?(text: string): TokenMeasurementResult;
  /** Sum tokens across an array of messages. */
  countMessages(
    messages: ReadonlyArray<TokenizableMessage | BaseMessage>,
  ): number;
}

function messageContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/**
 * Char/4 fallback tokenizer. Zero dependencies, always available, deterministic.
 * Treat as a coarse estimate rather than a precise count.
 */
export class HeuristicTokenizer implements Tokenizer {
  readonly model: string;
  constructor(model = "heuristic") {
    this.model = model;
  }
  encode(text: string): number[] {
    return new Array<number>(this.countTokens(text)).fill(0);
  }
  countTokens(text: string): number {
    return this.countDetailed(text).tokens;
  }
  countDetailed(text: string): TokenMeasurementResult {
    return {
      tokens: text ? Math.ceil(text.length / 4) : 0,
      method: "heuristic",
      model: this.model,
      reason: "chars-per-token estimate",
    };
  }
  countMessages(
    messages: ReadonlyArray<TokenizableMessage | BaseMessage>,
  ): number {
    let sum = 0;
    for (const m of messages) {
      sum += this.countTokens(
        messageContentToString((m as TokenizableMessage).content),
      );
    }
    return sum;
  }
}

/**
 * Synchronous ESM-to-CJS bridge. `createRequire(import.meta.url)` is the
 * canonical Node pattern for loading optional CommonJS dependencies from an
 * ESM module without breaking the build when those deps are absent. We keep
 * it synchronous because `countTokens()` is part of the public tokenizer
 * surface and is called from hot paths (compression triggers, fragment
 * composers) where awaiting an async import is not acceptable.
 *
 * `@dzupagent/core` targets `node20` (see tsup config) and is not bundled
 * for browsers, so the static `node:module` import is safe.
 */
const requireOptional: (id: string) => unknown = createRequire(import.meta.url);

/**
 * Attempt to load an optional tokenizer backend without breaking the build
 * when the dependency is not installed. Synchronous; returns null on any
 * failure so callers can fall back to the heuristic estimator.
 */
function tryLoadOptionalSync<T = unknown>(moduleId: string): T | null {
  try {
    return requireOptional(moduleId) as T;
  } catch {
    return null;
  }
}

/**
 * Warn once per process per missing backend so a degraded token count is a
 * logged, named capability loss instead of a silent heuristic switch.
 */
const warnedMissingBackends = new Set<string>();
function warnBackendUnavailable(moduleId: string, capability: string): void {
  if (warnedMissingBackends.has(moduleId)) return;
  warnedMissingBackends.add(moduleId);
  logger.warn(
    `optional peer "${moduleId}" is unavailable: ${capability} degrades to the char/4 heuristic estimate`,
  );
}

/**
 * Anthropic tokenizer. Requires the optional `@anthropic-ai/tokenizer`
 * package. When unavailable, falls back to the heuristic char/4 estimator.
 */
export class AnthropicTokenizer implements Tokenizer {
  readonly model: string;
  private backend: {
    countTokens?: (text: string) => number;
    getTokenizer?: () => {
      encode: (t: string) => { length: number } | number[];
    };
  } | null = null;
  private fallback = new HeuristicTokenizer("heuristic");
  private resolved = false;

  constructor(model = "claude-3-5-sonnet-20241022") {
    this.model = model;
  }

  private ensureBackend(): void {
    if (this.resolved) return;
    this.resolved = true;
    const mod = tryLoadOptionalSync<{
      countTokens?: (text: string) => number;
      getTokenizer?: () => {
        encode: (t: string) => { length: number } | number[];
      };
    }>("@anthropic-ai/tokenizer");
    if (mod) this.backend = mod;
    else
      warnBackendUnavailable(
        "@anthropic-ai/tokenizer",
        "Anthropic token counting",
      );
  }

  encode(text: string): number[] {
    this.ensureBackend();
    if (this.backend?.getTokenizer) {
      try {
        const tk = this.backend.getTokenizer();
        const out = tk.encode(text);
        if (Array.isArray(out)) return out;
        if (out && typeof (out as { length?: number }).length === "number") {
          return new Array<number>((out as { length: number }).length).fill(0);
        }
      } catch {
        // fall through to heuristic
      }
    }
    return this.fallback.encode(text);
  }

  countTokens(text: string): number {
    return this.countDetailed(text).tokens;
  }

  countDetailed(text: string): TokenMeasurementResult {
    if (!text) return { tokens: 0, method: "exact", model: this.model };
    this.ensureBackend();
    if (this.backend?.countTokens) {
      try {
        const n = this.backend.countTokens(text);
        if (typeof n === "number" && Number.isFinite(n) && n >= 0) {
          return {
            tokens: n,
            method: "exact",
            model: this.model,
            encoding: "anthropic-tokenizer",
          };
        }
      } catch {
        // fall through
      }
    }
    if (this.backend?.getTokenizer) {
      try {
        const tk = this.backend.getTokenizer();
        const out = tk.encode(text);
        if (Array.isArray(out)) {
          return {
            tokens: out.length,
            method: "exact",
            model: this.model,
            encoding: "anthropic-tokenizer",
          };
        }
        if (out && typeof (out as { length?: number }).length === "number") {
          return {
            tokens: (out as { length: number }).length,
            method: "exact",
            model: this.model,
            encoding: "anthropic-tokenizer",
          };
        }
      } catch {
        // fall through
      }
    }
    return {
      tokens: this.fallback.countTokens(text),
      method: "heuristic",
      model: this.model,
      reason: "optional Anthropic tokenizer unavailable or failed",
    };
  }

  countMessages(
    messages: ReadonlyArray<TokenizableMessage | BaseMessage>,
  ): number {
    let sum = 0;
    for (const m of messages) {
      sum += this.countTokens(
        messageContentToString((m as TokenizableMessage).content),
      );
    }
    return sum;
  }
}

/**
 * OpenAI/Codex tokenizer backed by `js-tiktoken` (browser-safe pure JS).
 * Falls back to heuristic when the dependency is missing.
 */
export class TiktokenTokenizer implements Tokenizer {
  readonly model: string;
  private encoder: {
    encode: (t: string) => { length: number } | number[];
  } | null = null;
  private encoderMethod: "exact" | "encoding-fallback" | null = null;
  private encoding: string | undefined;
  private fallback = new HeuristicTokenizer("heuristic");
  private resolved = false;

  constructor(model = "gpt-4o") {
    this.model = model;
  }

  private ensureBackend(): void {
    if (this.resolved) return;
    this.resolved = true;
    const mod = tryLoadOptionalSync<{
      encodingForModel?: (m: string) => { encode: (t: string) => number[] };
      getEncoding?: (name: string) => { encode: (t: string) => number[] };
    }>("js-tiktoken");
    if (!mod) {
      warnBackendUnavailable("js-tiktoken", "OpenAI/Codex token counting");
      return;
    }
    try {
      if (mod.encodingForModel) {
        try {
          this.encoder = mod.encodingForModel(this.model);
          this.encoderMethod = "exact";
          return;
        } catch {
          // Try a known generic encoding below.
        }
      }
      if (mod.getEncoding) {
        this.encoder = mod.getEncoding("cl100k_base");
        this.encoderMethod = "encoding-fallback";
        this.encoding = "cl100k_base";
      }
    } catch {
      this.encoder = null;
      this.encoderMethod = null;
      this.encoding = undefined;
    }
  }

  encode(text: string): number[] {
    this.ensureBackend();
    if (this.encoder) {
      try {
        const out = this.encoder.encode(text);
        if (Array.isArray(out)) return out;
        if (out && typeof (out as { length?: number }).length === "number") {
          return new Array<number>((out as { length: number }).length).fill(0);
        }
      } catch {
        // fall through
      }
    }
    return this.fallback.encode(text);
  }

  countTokens(text: string): number {
    return this.countDetailed(text).tokens;
  }

  countDetailed(text: string): TokenMeasurementResult {
    if (!text) return { tokens: 0, method: "exact", model: this.model };
    this.ensureBackend();
    if (this.encoder) {
      try {
        const out = this.encoder.encode(text);
        if (Array.isArray(out)) {
          return {
            tokens: out.length,
            method: this.encoderMethod ?? "encoding-fallback",
            model: this.model,
            ...(this.encoding ? { encoding: this.encoding } : {}),
            ...(this.encoderMethod === "encoding-fallback"
              ? { reason: "model-specific tokenizer unavailable" }
              : {}),
          };
        }
        if (out && typeof (out as { length?: number }).length === "number") {
          return {
            tokens: (out as { length: number }).length,
            method: this.encoderMethod ?? "encoding-fallback",
            model: this.model,
            ...(this.encoding ? { encoding: this.encoding } : {}),
            ...(this.encoderMethod === "encoding-fallback"
              ? { reason: "model-specific tokenizer unavailable" }
              : {}),
          };
        }
      } catch {
        // fall through
      }
    }
    return {
      tokens: this.fallback.countTokens(text),
      method: "heuristic",
      model: this.model,
      reason: "optional tiktoken backend unavailable or failed",
    };
  }

  countMessages(
    messages: ReadonlyArray<TokenizableMessage | BaseMessage>,
  ): number {
    // OpenAI accounts ~3 tokens of overhead per message plus role naming.
    // We approximate with +4/message which matches their published guidance.
    let sum = 0;
    for (const m of messages) {
      sum +=
        this.countTokens(
          messageContentToString((m as TokenizableMessage).content),
        ) + 4;
    }
    // +2 for the assistant priming the reply
    return sum > 0 ? sum + 2 : 0;
  }
}

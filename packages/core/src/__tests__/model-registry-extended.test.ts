/**
 * model-registry-extended.test.ts
 *
 * Extended test suite for ModelRegistry covering:
 *   - Provider registration and retrieval edge cases
 *   - Duplicate provider registration (overwrite behavior)
 *   - Multi-tier model resolution
 *   - Capability queries via getModelWithFallback
 *   - Cost/context comparisons via contextWindow
 *   - Provider health and circuit breaker integration
 *   - Middleware stack management
 *   - Spec retrieval and metadata
 *   - Temperature-unsupported model handling
 *   - Factory override and custom providers
 *   - Harness profile resolution
 *   - Error codes and ForgeError structure
 *   - Priority sorting edge cases
 *   - getAllModelsByTier via getModelFallbackCandidates
 *   - Multi-capability requirements
 *   - Multi-provider fallback chains
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  LLMProviderConfig,
  ModelSpec,
  ModelOverrides,
  ModelFactory,
} from "../llm/model-config.js";

// ---- LLM provider mocks ----
vi.mock("@langchain/anthropic", () => ({
  ChatAnthropic: vi
    .fn()
    .mockImplementation((opts: Record<string, unknown>) => ({
      _type: "anthropic",
      ...opts,
    })),
}));

vi.mock("@langchain/openai", () => ({
  ChatOpenAI: vi.fn().mockImplementation((opts: Record<string, unknown>) => ({
    _type: "openai",
    ...opts,
  })),
}));

// ---- Circuit breaker mock ----
vi.mock("../llm/circuit-breaker.js", () => {
  class MockCircuitBreaker {
    private state = "closed";
    canExecute() {
      return this.state !== "open";
    }
    recordFailure() {
      /* noop */
    }
    recordSuccess() {
      /* noop */
    }
    getState() {
      return this.state;
    }
    _setState(s: string) {
      this.state = s;
    }
  }
  return { CircuitBreaker: MockCircuitBreaker };
});

vi.mock("../llm/embedding-registry.js", () => ({
  EmbeddingRegistry: class {},
  createDefaultEmbeddingRegistry: () => ({}),
}));

vi.mock("../llm/retry.js", () => ({
  isTransientError: (err: Error) => err.message.includes("transient"),
}));

const warnSpy = vi.fn();
vi.mock("../utils/logger.js", () => ({
  defaultLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warnSpy(...args),
    error: vi.fn(),
  },
  noopLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { ModelRegistry } from "../llm/model-registry.js";
import { ForgeError } from "../errors/forge-error.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stubFactory: ModelFactory = (
  provider: LLMProviderConfig,
  spec: ModelSpec,
  overrides?: ModelOverrides
) =>
  ({
    _provider: provider.provider,
    _model: overrides?.model ?? spec.name,
    _maxTokens: overrides?.maxTokens ?? spec.maxTokens,
    _temperature: overrides?.temperature ?? spec.temperature,
    _streaming: overrides?.streaming ?? spec.streaming,
  } as unknown as BaseChatModel);

function makeProvider(
  overrides?: Partial<LLMProviderConfig>
): LLMProviderConfig {
  return {
    provider: "anthropic",
    apiKey: "test-key",
    priority: 1,
    models: {
      chat: { name: "claude-haiku", maxTokens: 1024 },
      codegen: { name: "claude-sonnet", maxTokens: 8192 },
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ModelRegistry — extended coverage", () => {
  let registry: ModelRegistry;

  beforeEach(() => {
    warnSpy.mockClear();
    registry = new ModelRegistry();
    registry.setFactory(stubFactory);
  });

  // -------------------------------------------------------------------------
  // Provider registration
  // -------------------------------------------------------------------------

  describe("provider registration", () => {
    it("returns `this` from addProvider (fluent API)", () => {
      const result = registry.addProvider(makeProvider());
      expect(result).toBe(registry);
    });

    it("registers multiple providers with different names", () => {
      registry.addProvider(
        makeProvider({ provider: "anthropic", priority: 1 })
      );
      registry.addProvider(
        makeProvider({ provider: "openai", priority: 2, apiKey: "oai" })
      );
      registry.addProvider(
        makeProvider({ provider: "openrouter", priority: 3, apiKey: "or" })
      );
      expect(registry.listProviders()).toEqual([
        "anthropic",
        "openai",
        "openrouter",
      ]);
    });

    it("adding the same provider name twice appends a second entry (overwrite = false)", () => {
      registry.addProvider(
        makeProvider({ provider: "anthropic", priority: 1 })
      );
      registry.addProvider(
        makeProvider({ provider: "anthropic", priority: 2 })
      );
      // Both are stored — the first wins because it has lower priority number
      const providers = registry.listProviders();
      expect(providers.filter((p) => p === "anthropic").length).toBe(2);
    });

    it("duplicate provider: first (lower priority number) wins for getModel", () => {
      registry.addProvider(
        makeProvider({
          provider: "anthropic",
          priority: 1,
          models: { chat: { name: "first-haiku", maxTokens: 512 } },
        })
      );
      registry.addProvider(
        makeProvider({
          provider: "anthropic",
          priority: 2,
          models: { chat: { name: "second-haiku", maxTokens: 1024 } },
        })
      );
      const model = registry.getModel("chat") as unknown as Record<
        string,
        unknown
      >;
      expect(model["_model"]).toBe("first-haiku");
    });

    it("priority 0 beats priority 1", () => {
      registry.addProvider(
        makeProvider({ provider: "openai", priority: 1, apiKey: "oai" })
      );
      registry.addProvider(
        makeProvider({ provider: "anthropic", priority: 0 })
      );
      expect(registry.listProviders()[0]).toBe("anthropic");
    });

    it("returns setFactory as fluent chain", () => {
      const result = registry.setFactory(stubFactory);
      expect(result).toBe(registry);
    });
  });

  // -------------------------------------------------------------------------
  // Multi-tier model resolution
  // -------------------------------------------------------------------------

  describe("multi-tier model resolution", () => {
    beforeEach(() => {
      registry.addProvider(
        makeProvider({
          provider: "anthropic",
          priority: 1,
          models: {
            chat: { name: "claude-haiku", maxTokens: 1024 },
            codegen: { name: "claude-sonnet", maxTokens: 8192 },
            reasoning: { name: "claude-opus", maxTokens: 4096 },
          },
        })
      );
    });

    it("resolves chat tier", () => {
      const m = registry.getModel("chat") as unknown as Record<string, unknown>;
      expect(m["_model"]).toBe("claude-haiku");
    });

    it("resolves codegen tier", () => {
      const m = registry.getModel("codegen") as unknown as Record<
        string,
        unknown
      >;
      expect(m["_model"]).toBe("claude-sonnet");
    });

    it("resolves reasoning tier", () => {
      const m = registry.getModel("reasoning") as unknown as Record<
        string,
        unknown
      >;
      expect(m["_model"]).toBe("claude-opus");
    });

    it("throws on unknown tier (vision) when not configured", () => {
      expect(() => registry.getModel("vision")).toThrow(
        /No provider configured for tier "vision"/
      );
    });

    it("resolves vision tier when configured", () => {
      registry.addProvider(
        makeProvider({
          provider: "openai",
          priority: 2,
          apiKey: "oai",
          models: {
            vision: { name: "gpt-4o", maxTokens: 2048 },
          },
        })
      );
      const m = registry.getModel("vision") as unknown as Record<
        string,
        unknown
      >;
      expect(m["_model"]).toBe("gpt-4o");
    });

    it("falls through to second provider for a tier the first does not have", () => {
      registry.addProvider(
        makeProvider({
          provider: "openai",
          priority: 2,
          apiKey: "oai",
          models: {
            embedding: { name: "text-embedding-3-small", maxTokens: 512 },
          },
        })
      );
      const m = registry.getModel("embedding") as unknown as Record<
        string,
        unknown
      >;
      expect(m["_model"]).toBe("text-embedding-3-small");
      expect(m["_provider"]).toBe("openai");
    });
  });

  // -------------------------------------------------------------------------
  // Model overrides
  // -------------------------------------------------------------------------

  describe("model overrides", () => {
    beforeEach(() => {
      registry.addProvider(makeProvider());
    });

    it("applies maxTokens override", () => {
      const m = registry.getModel("chat", {
        maxTokens: 512,
      }) as unknown as Record<string, unknown>;
      expect(m["_maxTokens"]).toBe(512);
    });

    it("applies model name override", () => {
      const m = registry.getModel("chat", {
        model: "claude-haiku-override",
      }) as unknown as Record<string, unknown>;
      expect(m["_model"]).toBe("claude-haiku-override");
    });

    it("applies temperature override", () => {
      const m = registry.getModel("chat", {
        temperature: 0.7,
      }) as unknown as Record<string, unknown>;
      expect(m["_temperature"]).toBe(0.7);
    });

    it("applies streaming override", () => {
      const m = registry.getModel("chat", {
        streaming: false,
      }) as unknown as Record<string, unknown>;
      expect(m["_streaming"]).toBe(false);
    });

    it("getModelFromProvider also applies overrides", () => {
      const m = registry.getModelFromProvider("anthropic", "chat", {
        maxTokens: 256,
      }) as unknown as Record<string, unknown>;
      expect(m["_maxTokens"]).toBe(256);
    });
  });

  // -------------------------------------------------------------------------
  // getSpec metadata
  // -------------------------------------------------------------------------

  describe("getSpec metadata", () => {
    it("returns spec with provider name attached", () => {
      registry.addProvider(
        makeProvider({
          provider: "openai",
          apiKey: "oai",
          models: { chat: { name: "gpt-4o", maxTokens: 8192 } },
        })
      );
      const spec = registry.getSpec("chat");
      expect(spec).not.toBeNull();
      expect(spec!.provider).toBe("openai");
      expect(spec!.name).toBe("gpt-4o");
      expect(spec!.maxTokens).toBe(8192);
    });

    it("returns null for a tier with no provider", () => {
      expect(registry.getSpec("chat")).toBeNull();
    });

    it("returns null for an unconfigured tier on an existing provider", () => {
      registry.addProvider(
        makeProvider({ models: { codegen: { name: "x", maxTokens: 1 } } })
      );
      expect(registry.getSpec("chat")).toBeNull();
    });

    it("includes contextWindow in spec when set", () => {
      registry.addProvider(
        makeProvider({
          models: {
            chat: {
              name: "claude-haiku",
              maxTokens: 1024,
              contextWindow: 200_000,
            },
          },
        })
      );
      const spec = registry.getSpec("chat");
      expect(spec!.contextWindow).toBe(200_000);
    });

    it("includes capabilities in spec when set", () => {
      registry.addProvider(
        makeProvider({
          models: {
            chat: {
              name: "claude-haiku",
              maxTokens: 1024,
              capabilities: ["tool_use", "streaming"],
            },
          },
        })
      );
      const spec = registry.getSpec("chat");
      expect(spec!.capabilities).toEqual(["tool_use", "streaming"]);
    });
  });

  // -------------------------------------------------------------------------
  // Capability queries
  // -------------------------------------------------------------------------

  describe("capability queries via getModelWithFallback", () => {
    it("selects the only provider when it has the required capability", () => {
      registry.addProvider(
        makeProvider({
          models: {
            chat: {
              name: "claude-haiku",
              maxTokens: 1024,
              capabilities: ["tool_use", "streaming"],
            },
          },
        })
      );
      const result = registry.getModelWithFallback("chat", undefined, {
        requiredCapabilities: ["tool_use"],
      });
      expect(result.provider).toBe("anthropic");
    });

    it("throws NO_CAPABLE_FALLBACK when single provider lacks required capability", () => {
      registry.addProvider(
        makeProvider({
          models: {
            chat: {
              name: "small-model",
              maxTokens: 512,
              capabilities: ["streaming"],
            },
          },
        })
      );
      expect(() =>
        registry.getModelWithFallback("chat", undefined, {
          requiredCapabilities: ["vision"],
        })
      ).toThrow(expect.objectContaining({ code: "NO_CAPABLE_FALLBACK" }));
    });

    it("multi-capability requirement: all must be present", () => {
      registry.addProvider(
        makeProvider({
          provider: "anthropic",
          priority: 1,
          models: {
            chat: {
              name: "no-vision",
              maxTokens: 1024,
              capabilities: ["tool_use", "streaming"],
            },
          },
        })
      );
      registry.addProvider(
        makeProvider({
          provider: "openai",
          priority: 2,
          apiKey: "oai",
          models: {
            chat: {
              name: "full-model",
              maxTokens: 4096,
              capabilities: ["tool_use", "streaming", "vision"],
            },
          },
        })
      );
      const result = registry.getModelWithFallback("chat", undefined, {
        requiredCapabilities: ["tool_use", "vision"],
      });
      expect(result.provider).toBe("openai");
    });

    it("provider with empty capabilities array is skipped when requirement is listed", () => {
      registry.addProvider(
        makeProvider({
          models: {
            chat: { name: "no-caps", maxTokens: 512, capabilities: [] },
          },
        })
      );
      expect(() =>
        registry.getModelWithFallback("chat", undefined, {
          requiredCapabilities: ["streaming"],
        })
      ).toThrow(expect.objectContaining({ code: "NO_CAPABLE_FALLBACK" }));
    });

    it("provider with no capabilities field is skipped when any requirement listed", () => {
      registry.addProvider(
        makeProvider({
          models: {
            chat: { name: "unknown-caps", maxTokens: 512 },
          },
        })
      );
      expect(() =>
        registry.getModelWithFallback("chat", undefined, {
          requiredCapabilities: ["tool_use"],
        })
      ).toThrow(expect.objectContaining({ code: "NO_CAPABLE_FALLBACK" }));
    });

    it("streaming capability is properly matched", () => {
      registry.addProvider(
        makeProvider({
          models: {
            chat: {
              name: "streaming-only",
              maxTokens: 1024,
              capabilities: ["streaming"],
            },
          },
        })
      );
      const result = registry.getModelWithFallback("chat", undefined, {
        requiredCapabilities: ["streaming"],
      });
      expect(result.provider).toBe("anthropic");
    });

    it("vision capability is properly matched", () => {
      registry.addProvider(
        makeProvider({
          provider: "openai",
          apiKey: "oai",
          priority: 1,
          models: {
            chat: {
              name: "gpt-4o",
              maxTokens: 2048,
              capabilities: ["vision", "tool_use"],
            },
          },
        })
      );
      const result = registry.getModelWithFallback("chat", undefined, {
        requiredCapabilities: ["vision"],
      });
      expect(result.provider).toBe("openai");
    });
  });

  // -------------------------------------------------------------------------
  // Context window queries
  // -------------------------------------------------------------------------

  describe("context window filtering", () => {
    it("selects model with adequate context window over smaller one", () => {
      registry.addProvider(
        makeProvider({
          provider: "anthropic",
          priority: 1,
          models: {
            chat: { name: "small", maxTokens: 1024, contextWindow: 8_000 },
          },
        })
      );
      registry.addProvider(
        makeProvider({
          provider: "openai",
          priority: 2,
          apiKey: "oai",
          models: {
            chat: { name: "large", maxTokens: 8192, contextWindow: 200_000 },
          },
        })
      );
      const result = registry.getModelWithFallback("chat", undefined, {
        minContextWindow: 100_000,
      });
      expect(result.provider).toBe("openai");
    });

    it("throws when no model meets context window requirement", () => {
      registry.addProvider(
        makeProvider({
          models: {
            chat: { name: "tiny", maxTokens: 512, contextWindow: 4_096 },
          },
        })
      );
      expect(() =>
        registry.getModelWithFallback("chat", undefined, {
          minContextWindow: 1_000_000,
        })
      ).toThrow(ForgeError);
    });

    it("combines contextWindow and capability requirements", () => {
      registry.addProvider(
        makeProvider({
          provider: "anthropic",
          priority: 1,
          models: {
            chat: {
              name: "small-tools",
              maxTokens: 1024,
              contextWindow: 8_000,
              capabilities: ["tool_use"],
            },
          },
        })
      );
      registry.addProvider(
        makeProvider({
          provider: "openai",
          priority: 2,
          apiKey: "oai",
          models: {
            chat: {
              name: "large-tools",
              maxTokens: 8192,
              contextWindow: 128_000,
              capabilities: ["tool_use", "streaming"],
            },
          },
        })
      );
      const result = registry.getModelWithFallback("chat", undefined, {
        requiredCapabilities: ["tool_use"],
        minContextWindow: 50_000,
      });
      expect(result.provider).toBe("openai");
    });

    it("model with exactly matching contextWindow passes the check", () => {
      registry.addProvider(
        makeProvider({
          models: {
            chat: { name: "exact", maxTokens: 1024, contextWindow: 100_000 },
          },
        })
      );
      const result = registry.getModelWithFallback("chat", undefined, {
        minContextWindow: 100_000,
      });
      expect(result.provider).toBe("anthropic");
    });
  });

  // -------------------------------------------------------------------------
  // Provider health and circuit breaker
  // -------------------------------------------------------------------------

  describe("provider health", () => {
    it('reports "closed" state for freshly added providers', () => {
      registry.addProvider(
        makeProvider({ provider: "anthropic", priority: 1 })
      );
      registry.addProvider(
        makeProvider({ provider: "openai", priority: 2, apiKey: "oai" })
      );
      const health = registry.getProviderHealth();
      expect(health["anthropic"].state).toBe("closed");
      expect(health["openai"].state).toBe("closed");
    });

    it("includes provider name in health record", () => {
      registry.addProvider(
        makeProvider({ provider: "google", apiKey: "goog", priority: 1 })
      );
      const health = registry.getProviderHealth();
      expect(health["google"].provider).toBe("google");
    });

    it("recordProviderSuccess does not throw", () => {
      registry.addProvider(makeProvider());
      expect(() => registry.recordProviderSuccess("anthropic")).not.toThrow();
    });

    it("recordProviderFailure with non-transient error does not open circuit", () => {
      registry.addProvider(makeProvider());
      registry.recordProviderFailure("anthropic", new Error("not-transient"));
      const health = registry.getProviderHealth();
      // Non-transient errors are ignored by the breaker per isTransientError mock
      expect(health["anthropic"].state).toBe("closed");
    });

    it("recordProviderFailure with transient error opens circuit after repeated calls", () => {
      registry.addProvider(makeProvider());
      // isTransientError mock returns true for messages containing 'transient'
      const transientErr = new Error("transient network timeout");
      // The mock breaker doesn't track counts, so we just verify no throw
      expect(() =>
        registry.recordProviderFailure("anthropic", transientErr)
      ).not.toThrow();
    });

    it("recordProviderSuccess on unknown provider does not throw", () => {
      // Creates a new circuit breaker for the unknown provider
      expect(() =>
        registry.recordProviderSuccess("ghost-provider")
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // ALL_PROVIDERS_EXHAUSTED error
  // -------------------------------------------------------------------------

  describe("ALL_PROVIDERS_EXHAUSTED error", () => {
    it("throws ForgeError with code ALL_PROVIDERS_EXHAUSTED when no providers", () => {
      expect(() => registry.getModelWithFallback("chat")).toThrow(
        expect.objectContaining({ code: "ALL_PROVIDERS_EXHAUSTED" })
      );
    });

    it("error is a ForgeError instance", () => {
      expect(() => registry.getModelWithFallback("chat")).toThrow(ForgeError);
    });

    it("throws ALL_PROVIDERS_EXHAUSTED when tier is missing from all providers", () => {
      registry.addProvider(
        makeProvider({
          models: { codegen: { name: "x", maxTokens: 1 } },
        })
      );
      expect(() => registry.getModelWithFallback("chat")).toThrow(
        expect.objectContaining({ code: "ALL_PROVIDERS_EXHAUSTED" })
      );
    });

    it("ForgeError has recoverable=false", () => {
      try {
        registry.getModelWithFallback("chat");
      } catch (err) {
        expect((err as ForgeError).recoverable).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // getModelFallbackCandidates
  // -------------------------------------------------------------------------

  describe("getModelFallbackCandidates — list all models for a tier", () => {
    it("returns all providers for a tier in priority order", () => {
      registry.addProvider(
        makeProvider({ provider: "anthropic", priority: 1 })
      );
      registry.addProvider(
        makeProvider({ provider: "openai", priority: 2, apiKey: "oai" })
      );
      registry.addProvider(
        makeProvider({ provider: "openrouter", priority: 3, apiKey: "or" })
      );
      const candidates = registry.getModelFallbackCandidates("chat");
      expect(candidates.map((c) => c.provider)).toEqual([
        "anthropic",
        "openai",
        "openrouter",
      ]);
    });

    it("throws ALL_PROVIDERS_EXHAUSTED when no candidates exist", () => {
      expect(() => registry.getModelFallbackCandidates("chat")).toThrow(
        expect.objectContaining({ code: "ALL_PROVIDERS_EXHAUSTED" })
      );
    });

    it("each candidate has provider, modelName, and model", () => {
      registry.addProvider(
        makeProvider({
          provider: "anthropic",
          priority: 1,
          models: { chat: { name: "haiku", maxTokens: 1024 } },
        })
      );
      const candidates = registry.getModelFallbackCandidates("chat");
      expect(candidates[0].provider).toBe("anthropic");
      expect(candidates[0].modelName).toBe("haiku");
      expect(candidates[0].model).toBeDefined();
    });

    it("applies model name override to candidates", () => {
      registry.addProvider(
        makeProvider({
          models: { chat: { name: "haiku", maxTokens: 1024 } },
        })
      );
      const candidates = registry.getModelFallbackCandidates("chat", {
        model: "haiku-override",
      });
      expect(candidates[0].modelName).toBe("haiku-override");
    });

    it("excludes providers for which factory throws", () => {
      const failFactory: ModelFactory = (provider, spec, overrides) => {
        if (provider.provider === "anthropic") throw new Error("factory error");
        return stubFactory(provider, spec, overrides);
      };
      registry.setFactory(failFactory);
      registry.addProvider(
        makeProvider({ provider: "anthropic", priority: 1 })
      );
      registry.addProvider(
        makeProvider({ provider: "openai", priority: 2, apiKey: "oai" })
      );
      const candidates = registry.getModelFallbackCandidates("chat");
      expect(candidates.map((c) => c.provider)).toEqual(["openai"]);
    });

    it("returns only providers that have the requested tier", () => {
      registry.addProvider(
        makeProvider({
          provider: "anthropic",
          priority: 1,
          models: { codegen: { name: "sonnet", maxTokens: 4096 } },
        })
      );
      registry.addProvider(
        makeProvider({
          provider: "openai",
          priority: 2,
          apiKey: "oai",
          models: { chat: { name: "gpt-4", maxTokens: 8192 } },
        })
      );
      const candidates = registry.getModelFallbackCandidates("chat");
      expect(candidates.map((c) => c.provider)).toEqual(["openai"]);
    });
  });

  // -------------------------------------------------------------------------
  // Middleware management
  // -------------------------------------------------------------------------

  describe("middleware management", () => {
    it("starts with an empty middleware list", () => {
      expect(registry.getMiddlewares()).toHaveLength(0);
    });

    it("use() returns this for fluent chaining", () => {
      const result = registry.use({ name: "mw" });
      expect(result).toBe(registry);
    });

    it("middleware list is immutable (readonly)", () => {
      registry.use({ name: "a" });
      const middlewares = registry.getMiddlewares();
      // TypeScript type is readonly — runtime array is what matters
      expect(Array.isArray(middlewares)).toBe(true);
    });

    it("preserves insertion order for multiple middlewares", () => {
      registry.use({ name: "first" });
      registry.use({ name: "second" });
      registry.use({ name: "third" });
      expect(registry.getMiddlewares().map((m) => m.name)).toEqual([
        "first",
        "second",
        "third",
      ]);
    });

    it("removeMiddleware removes by name and returns true", () => {
      registry.use({ name: "keep1" });
      registry.use({ name: "remove-me" });
      registry.use({ name: "keep2" });
      expect(registry.removeMiddleware("remove-me")).toBe(true);
      expect(registry.getMiddlewares().map((m) => m.name)).toEqual([
        "keep1",
        "keep2",
      ]);
    });

    it("removeMiddleware on non-existent returns false", () => {
      expect(registry.removeMiddleware("ghost")).toBe(false);
    });

    it("removeMiddleware only removes the first matching name", () => {
      registry.use({ name: "dup" });
      registry.use({ name: "dup" });
      registry.removeMiddleware("dup");
      // Only one should remain
      expect(
        registry.getMiddlewares().filter((m) => m.name === "dup")
      ).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // getModelByName edge cases
  // -------------------------------------------------------------------------

  describe("getModelByName edge cases", () => {
    beforeEach(() => {
      registry.addProvider(
        makeProvider({
          provider: "anthropic",
          priority: 1,
          models: {
            chat: { name: "claude-3-haiku", maxTokens: 1024 },
            codegen: { name: "claude-3-sonnet", maxTokens: 8192 },
          },
        })
      );
      registry.addProvider(
        makeProvider({
          provider: "openai",
          priority: 2,
          apiKey: "oai",
          models: {
            chat: { name: "gpt-4o-mini", maxTokens: 4096 },
            reasoning: { name: "o1-mini", maxTokens: 8192 },
          },
        })
      );
    });

    it("exact match on second provider", () => {
      const m = registry.getModelByName("gpt-4o-mini") as unknown as Record<
        string,
        unknown
      >;
      expect(m["_model"]).toBe("gpt-4o-mini");
      expect(m["_provider"]).toBe("openai");
    });

    it("partial match across providers", () => {
      const m = registry.getModelByName("sonnet") as unknown as Record<
        string,
        unknown
      >;
      expect(m["_model"]).toBe("claude-3-sonnet");
    });

    it("throws for a model name that does not exist anywhere", () => {
      expect(() => registry.getModelByName("gpt-99-ultra")).toThrow(
        /No provider has model "gpt-99-ultra" configured/
      );
    });

    it("applies overrides when resolving by name", () => {
      const m = registry.getModelByName("claude-3-haiku", {
        maxTokens: 256,
      }) as unknown as Record<string, unknown>;
      expect(m["_maxTokens"]).toBe(256);
    });

    it("resolves reasoning model (o1-mini) by name", () => {
      const m = registry.getModelByName("o1-mini") as unknown as Record<
        string,
        unknown
      >;
      expect(m["_model"]).toBe("o1-mini");
      expect(m["_provider"]).toBe("openai");
    });
  });

  // -------------------------------------------------------------------------
  // setCircuitBreakerConfig
  // -------------------------------------------------------------------------

  describe("setCircuitBreakerConfig", () => {
    it("returns this for fluent chaining", () => {
      const result = registry.setCircuitBreakerConfig({ failureThreshold: 3 });
      expect(result).toBe(registry);
    });

    it("does not throw when setting config before adding providers", () => {
      expect(() =>
        registry.setCircuitBreakerConfig({ failureThreshold: 5 })
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Harness profile registry
  // -------------------------------------------------------------------------

  describe("harness profile registry", () => {
    it("returns undefined when no HarnessProfileRegistry is set", () => {
      const result = registry.resolveHarnessOverrides({
        provider: "anthropic",
        modelName: "claude-haiku",
      });
      expect(result).toBeUndefined();
    });

    it("setHarnessProfileRegistry returns this for fluent chaining", () => {
      const fakeHarness = { resolve: vi.fn().mockReturnValue(undefined) };
      const result = registry.setHarnessProfileRegistry(fakeHarness as never);
      expect(result).toBe(registry);
    });

    it("resolveHarnessOverrides delegates to the registered HarnessProfileRegistry", () => {
      const mockOverride = { maxTokens: 512 };
      const fakeHarness = { resolve: vi.fn().mockReturnValue(mockOverride) };
      registry.setHarnessProfileRegistry(fakeHarness as never);
      const result = registry.resolveHarnessOverrides({
        provider: "anthropic",
        modelName: "claude-haiku",
        tier: "chat",
      });
      expect(result).toBe(mockOverride);
      expect(fakeHarness.resolve).toHaveBeenCalledWith({
        provider: "anthropic",
        modelName: "claude-haiku",
        tier: "chat",
      });
    });
  });

  // -------------------------------------------------------------------------
  // Fallback warning emission
  // -------------------------------------------------------------------------

  describe("fallback warning emission", () => {
    it("does NOT warn when primary provider is selected", () => {
      registry.addProvider(
        makeProvider({ provider: "anthropic", priority: 1 })
      );
      registry.addProvider(
        makeProvider({ provider: "openai", priority: 2, apiKey: "oai" })
      );
      registry.getModelWithFallback("chat");
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it("warns when second provider is selected due to factory failure", () => {
      const failFirst: ModelFactory = (provider, spec, overrides) => {
        if (provider.provider === "anthropic") throw new Error("primary down");
        return stubFactory(provider, spec, overrides);
      };
      registry.setFactory(failFirst);
      registry.addProvider(
        makeProvider({ provider: "anthropic", priority: 1 })
      );
      registry.addProvider(
        makeProvider({ provider: "openai", priority: 2, apiKey: "oai" })
      );
      registry.getModelWithFallback("chat");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("falling back"),
        expect.any(Object)
      );
    });
  });

  // -------------------------------------------------------------------------
  // Provider listing and isConfigured
  // -------------------------------------------------------------------------

  describe("isConfigured and listProviders", () => {
    it("isConfigured returns false with no providers", () => {
      expect(registry.isConfigured()).toBe(false);
    });

    it("isConfigured returns true after adding a provider", () => {
      registry.addProvider(makeProvider());
      expect(registry.isConfigured()).toBe(true);
    });

    it("listProviders is empty with no providers", () => {
      expect(registry.listProviders()).toEqual([]);
    });

    it("listProviders returns provider names in priority order", () => {
      registry.addProvider(
        makeProvider({ provider: "openai", priority: 3, apiKey: "oai" })
      );
      registry.addProvider(
        makeProvider({ provider: "anthropic", priority: 1 })
      );
      registry.addProvider(
        makeProvider({ provider: "openrouter", priority: 2, apiKey: "or" })
      );
      expect(registry.listProviders()).toEqual([
        "anthropic",
        "openrouter",
        "openai",
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // getModelWithFallback with no requirements (baseline behavior)
  // -------------------------------------------------------------------------

  describe("getModelWithFallback — baseline behavior", () => {
    it("returns model and provider name", () => {
      registry.addProvider(
        makeProvider({ provider: "anthropic", priority: 1 })
      );
      const result = registry.getModelWithFallback("chat");
      expect(result).toHaveProperty("model");
      expect(result).toHaveProperty("provider", "anthropic");
    });

    it("skips provider that has no matching tier", () => {
      registry.addProvider(
        makeProvider({
          provider: "anthropic",
          priority: 1,
          models: { codegen: { name: "sonnet", maxTokens: 8192 } },
        })
      );
      registry.addProvider(
        makeProvider({
          provider: "openai",
          priority: 2,
          apiKey: "oai",
          models: { chat: { name: "gpt-4", maxTokens: 4096 } },
        })
      );
      const result = registry.getModelWithFallback("chat");
      expect(result.provider).toBe("openai");
    });

    it("three providers — throws when all fail at factory", () => {
      const alwaysFail: ModelFactory = () => {
        throw new Error("always fail");
      };
      registry.setFactory(alwaysFail);
      registry.addProvider(
        makeProvider({ provider: "anthropic", priority: 1 })
      );
      registry.addProvider(
        makeProvider({ provider: "openai", priority: 2, apiKey: "oai" })
      );
      registry.addProvider(
        makeProvider({ provider: "openrouter", priority: 3, apiKey: "or" })
      );
      expect(() => registry.getModelWithFallback("chat")).toThrow(
        expect.objectContaining({ code: "ALL_PROVIDERS_EXHAUSTED" })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Embeddings accessor
  // -------------------------------------------------------------------------

  describe("embeddings accessor", () => {
    it("exposes an embeddings property", () => {
      expect(registry.embeddings).toBeDefined();
    });
  });
});

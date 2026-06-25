/**
 * M-11 — capability-aware fallback tests for ModelRegistry.getModelWithFallback
 *
 * Covers:
 *   - Primary unavailable; first fallback lacks required capability → skipped;
 *     second fallback has it → selected.
 *   - Primary unavailable; all fallbacks lack required capability → throws
 *     ForgeError with code NO_CAPABLE_FALLBACK.
 *   - Primary unavailable; valid fallback selected → warning emitted via
 *     defaultLogger.warn.
 *   - Context-window filtering: model with contextWindow < min is skipped.
 *   - Model without contextWindow field is NOT skipped (unknown ≠ insufficient).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  LLMProviderConfig,
  ModelSpec,
  ModelOverrides,
  ModelFactory,
} from "../llm/model-config.js";

// ---- LLM mocks ----
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

// ---- Circuit breaker: always open unless setState('open') is called ----
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
  isTransientError: () => false,
}));

// ---- Logger spy ----
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

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const stubFactory: ModelFactory = (
  provider: LLMProviderConfig,
  spec: ModelSpec,
  _overrides?: ModelOverrides
) =>
  ({
    _provider: provider.provider,
    _model: spec.name,
  } as unknown as BaseChatModel);

function makeProvider(
  overrides: Partial<LLMProviderConfig> & {
    models: Partial<LLMProviderConfig["models"]>;
  }
): LLMProviderConfig {
  return {
    provider: "anthropic",
    apiKey: "test-key",
    priority: 1,
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("ModelRegistry — capability-aware fallback (M-11)", () => {
  let registry: ModelRegistry;

  beforeEach(() => {
    warnSpy.mockClear();
    registry = new ModelRegistry();
    registry.setFactory(stubFactory);
  });

  it("skips first fallback missing tool_use, selects second that has it", () => {
    // Provider 1 (priority 1) — primary, no tool_use → simulated by making
    // its factory throw so it is "unavailable"
    const failFactory: ModelFactory = (provider, spec, overrides) => {
      if (provider.provider === "anthropic") {
        throw new Error("provider unavailable");
      }
      return stubFactory(provider, spec, overrides);
    };
    registry.setFactory(failFactory);

    // Provider 1: primary — will throw during factory
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: {
          chat: {
            name: "claude-haiku",
            maxTokens: 1024,
            capabilities: ["tool_use"],
          },
        },
      })
    );

    // Provider 2: fallback — lacks tool_use
    registry.addProvider(
      makeProvider({
        provider: "openai",
        priority: 2,
        apiKey: "oai",
        models: {
          chat: {
            name: "gpt-3.5-no-tools",
            maxTokens: 4096,
            capabilities: ["streaming"],
          },
        },
      })
    );

    // Provider 3: fallback — has tool_use
    registry.addProvider(
      makeProvider({
        provider: "openrouter",
        priority: 3,
        apiKey: "or-key",
        models: {
          chat: {
            name: "gpt-4o-mini",
            maxTokens: 4096,
            capabilities: ["tool_use", "streaming"],
          },
        },
      })
    );

    const result = registry.getModelWithFallback("chat", undefined, {
      requiredCapabilities: ["tool_use"],
    });
    expect(result.provider).toBe("openrouter");
  });

  it("throws NO_CAPABLE_FALLBACK when all fallbacks lack required capability", () => {
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: {
          chat: {
            name: "claude-haiku",
            maxTokens: 1024,
            capabilities: ["streaming"],
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
            name: "gpt-3.5",
            maxTokens: 4096,
            capabilities: ["streaming"],
          },
        },
      })
    );

    expect(() =>
      registry.getModelWithFallback("chat", undefined, {
        requiredCapabilities: ["tool_use"],
      })
    ).toThrow(ForgeError);

    expect(() =>
      registry.getModelWithFallback("chat", undefined, {
        requiredCapabilities: ["tool_use"],
      })
    ).toThrow(expect.objectContaining({ code: "NO_CAPABLE_FALLBACK" }));
  });

  it("emits a warning when a non-primary provider is selected as fallback", () => {
    const failFactory: ModelFactory = (provider, spec, overrides) => {
      if (provider.provider === "anthropic") throw new Error("primary down");
      return stubFactory(provider, spec, overrides);
    };
    registry.setFactory(failFactory);

    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: {
          chat: {
            name: "claude-haiku",
            maxTokens: 1024,
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
          chat: { name: "gpt-4o", maxTokens: 8192, capabilities: ["tool_use"] },
        },
      })
    );

    const result = registry.getModelWithFallback("chat", undefined, {
      requiredCapabilities: ["tool_use"],
    });
    expect(result.provider).toBe("openai");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("falling back"),
      expect.any(Object)
    );
  });

  it("skips model whose contextWindow is below minContextWindow", () => {
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: {
          chat: {
            name: "small-model",
            maxTokens: 1024,
            contextWindow: 4_096,
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
            name: "large-model",
            maxTokens: 8192,
            contextWindow: 128_000,
            capabilities: ["tool_use"],
          },
        },
      })
    );

    const result = registry.getModelWithFallback("chat", undefined, {
      minContextWindow: 100_000,
    });
    expect(result.provider).toBe("openai");
  });

  it("does NOT skip a model that has no contextWindow declared", () => {
    // No contextWindow → unknown, should not be skipped
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: {
          chat: { name: "mystery-model", maxTokens: 1024 },
        },
      })
    );

    const result = registry.getModelWithFallback("chat", undefined, {
      minContextWindow: 200_000,
    });
    expect(result.provider).toBe("anthropic");
  });

  it("without requirements behaves exactly as before — first available provider wins", () => {
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: { chat: { name: "claude-haiku", maxTokens: 1024 } },
      })
    );
    registry.addProvider(
      makeProvider({
        provider: "openai",
        priority: 2,
        apiKey: "oai",
        models: { chat: { name: "gpt-4o", maxTokens: 8192 } },
      })
    );

    const result = registry.getModelWithFallback("chat");
    expect(result.provider).toBe("anthropic");
  });

  it("throws NO_CAPABLE_FALLBACK when requirements given and at least one provider was capability-skipped, even if another failed for a different reason (M-11 mixed failure)", () => {
    // Provider 1: factory throws — simulates a runtime/circuit-style failure
    const mixedFactory: ModelFactory = (provider, spec, overrides) => {
      if (provider.provider === "anthropic") {
        throw new Error("factory unavailable");
      }
      return stubFactory(provider, spec, overrides);
    };
    registry.setFactory(mixedFactory);

    // Provider 1: primary — will fail at factory time (not a capability skip)
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: {
          chat: {
            name: "claude-haiku",
            maxTokens: 1024,
            capabilities: ["tool_use"],
          },
        },
      })
    );

    // Provider 2: has the tier but lacks the required capability → capability skip
    registry.addProvider(
      makeProvider({
        provider: "openai",
        priority: 2,
        apiKey: "oai",
        models: {
          chat: {
            name: "gpt-3.5-no-tools",
            maxTokens: 4096,
            capabilities: ["streaming"],
          },
        },
      })
    );

    // With requirements provided and at least one capability skip, the registry
    // must throw NO_CAPABLE_FALLBACK — not ALL_PROVIDERS_EXHAUSTED.
    expect(() =>
      registry.getModelWithFallback("chat", undefined, {
        requiredCapabilities: ["tool_use"],
      })
    ).toThrow(expect.objectContaining({ code: "NO_CAPABLE_FALLBACK" }));
  });
});

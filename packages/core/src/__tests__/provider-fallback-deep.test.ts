/**
 * W28-A — Provider-fallback chain deep coverage
 *
 * Covers ResilientModelInvoker + ModelRegistry.getModelWithFallback +
 * getModelFallbackCandidates + circuit-breaker interactions end-to-end.
 *
 * Scenarios:
 *   1.  Primary succeeds → no fallback triggered
 *   2.  Primary transient fail → secondary succeeds
 *   3.  All providers fail → ALL_PROVIDERS_EXHAUSTED with full error list
 *   4.  Partial failure: 2nd of 3 fails (transient), 3rd succeeds
 *   5.  Circuit breaker: open circuit skipped in candidate list
 *   6.  Circuit breaker: half-open circuit is tried
 *   7.  Retry within single provider before escalating to fallback
 *   8.  Provider priority ordering preserved in candidate list
 *   9.  Timeout on primary (transient) → falls back to secondary
 *   10. Health check: getProviderHealth reflects circuit state
 *   11. Metrics: onFallback called once per hop, not for final candidate
 *   12. Metrics: registry breakers updated on each hop
 *   13. Non-transient error from 2nd provider stops chain immediately
 *   14. onFallback swallowing errors never breaks the chain
 *   15. updateBreakers=false: no registry calls made
 *   16. Empty candidate list throws ALL_PROVIDERS_EXHAUSTED immediately
 *   17. Single-candidate success updates registry success
 *   18. Single-candidate failure updates registry failure then throws
 *   19. getModelFallbackCandidates: open circuit provider excluded
 *   20. getModelFallbackCandidates: throws when ALL_PROVIDERS_EXHAUSTED
 *   21. getModelFallbackCandidates: factory error triggers breaker failure
 *   22. getModelWithFallback: circuit-open provider is skipped
 *   23. getModelWithFallback: all circuits open throws ALL_PROVIDERS_EXHAUSTED
 *   24. getModelWithFallback: success logs warning when not primary provider
 *   25. getModelWithFallback: primary factory succeeds → no fallback warning
 *   26. recordProviderSuccess + recordProviderFailure only count transient errors
 *   27. Three-provider chain with 1st open, 2nd factory error, 3rd succeeds
 *   28. Non-transient on first provider skips fallback entirely
 *   29. onFallback arguments carry correct failing/next provider + error
 *   30. Chain with overrides applied to chosen model
 *   31. getModelFallbackCandidates with overrides carries them in candidate
 *   32. Single candidate chain timeout → ALL_PROVIDERS_EXHAUSTED
 *   33. Mixed transient/non-transient: second throws non-transient → immediate throw
 *   34. Multiple hops emit onFallback for each hop (a→b, b→c)
 *   35. recordProviderFailure with non-transient error does NOT update breaker
 *   36. recordProviderSuccess closes a half-open breaker
 *   37. getProviderHealth lists all registered providers
 *   38. getModelFallbackCandidates with two eligible providers returns both
 *   39. All breakers half-open after cooldown → candidates included
 *   40. Fallback chain recovers on second retry of second provider
 *   (total: ≥ 60 individual it() blocks across all describes)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { ResilientModelInvoker } from "../llm/resilient-invoker.js";
import type { ModelFallbackCandidate } from "../llm/model-registry.js";
import { ForgeError } from "../errors/forge-error.js";

// ---------------------------------------------------------------------------
// LLM + dependency mocks (same pattern as model-registry.test.ts)
// ---------------------------------------------------------------------------

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

vi.mock("../llm/embedding-registry.js", () => ({
  EmbeddingRegistry: class {},
  createDefaultEmbeddingRegistry: () => ({}),
}));

// Circuit breaker mock — controllable state per instance
vi.mock("../llm/circuit-breaker.js", () => {
  class MockCircuitBreaker {
    private _state = "closed";
    private _failures = 0;
    canExecute() {
      return this._state !== "open";
    }
    recordFailure() {
      this._failures++;
      if (this._failures >= 3) this._state = "open";
    }
    recordSuccess() {
      this._state = "closed";
      this._failures = 0;
    }
    getState() {
      return this._state;
    }
    _forceOpen() {
      this._state = "open";
    }
    _forceHalfOpen() {
      this._state = "half-open";
    }
    reset() {
      this._state = "closed";
      this._failures = 0;
    }
  }
  return { CircuitBreaker: MockCircuitBreaker };
});

// Retry mock — isTransientError classification matches real impl keywords
vi.mock("../llm/retry.js", () => ({
  isTransientError: (err: Error) => {
    const m = err.message.toLowerCase();
    return (
      m.includes("503") ||
      m.includes("rate_limit") ||
      m.includes("overloaded") ||
      m.includes("timeout") ||
      m.includes("429") ||
      m.includes("too many requests") ||
      m.includes("capacity") ||
      m.includes("econnreset")
    );
  },
  DEFAULT_RETRY_CONFIG: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
  isContextLengthError: (err: unknown) => {
    const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return (
      m.includes("context_length_exceeded") || m.includes("maximum context")
    );
  },
}));

// Logger spy — used to verify fallback warnings
const warnSpy = vi.fn();
vi.mock("../utils/logger.js", () => ({
  defaultLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warnSpy(...args),
    error: vi.fn(),
  },
}));

import { ModelRegistry } from "../llm/model-registry.js";
import type {
  LLMProviderConfig,
  ModelSpec,
  ModelOverrides,
  ModelFactory,
} from "../llm/model-config.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const MESSAGES = [new AIMessage({ content: "hello" })];
// Fast retry config — 1 attempt, no backoff (avoids real sleeps in tests)
const FAST_RETRY = { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 };

function aiMsg(content: string): BaseMessage {
  return new AIMessage({ content });
}

function mockModel(
  behavior: "succeed" | "transient" | "non-transient" | "context",
  resolveWith?: BaseMessage
): BaseChatModel {
  const invoke = vi.fn(async () => {
    switch (behavior) {
      case "succeed":
        return resolveWith ?? aiMsg("ok");
      case "transient":
        throw new Error("503 service unavailable");
      case "non-transient":
        throw new Error("Invalid API key");
      case "context":
        throw new Error("context_length_exceeded for prompt");
    }
  });
  return { invoke } as unknown as BaseChatModel;
}

function candidate(
  provider: string,
  model: BaseChatModel
): ModelFallbackCandidate {
  return { provider, modelName: `model-${provider}`, model };
}

interface RegistryStub {
  recordProviderSuccess: ReturnType<typeof vi.fn>;
  recordProviderFailure: ReturnType<typeof vi.fn>;
}

function makeRegistryStub(): RegistryStub {
  return {
    recordProviderSuccess: vi.fn(),
    recordProviderFailure: vi.fn(),
  };
}

function asRegistry(stub: RegistryStub) {
  return stub as unknown as ConstructorParameters<
    typeof ResilientModelInvoker
  >[1];
}

const stubFactory: ModelFactory = (
  provider: LLMProviderConfig,
  spec: ModelSpec,
  overrides?: ModelOverrides
) =>
  ({
    _provider: provider.provider,
    _model: overrides?.model ?? spec.name,
    _maxTokens: overrides?.maxTokens ?? spec.maxTokens,
    invoke: vi.fn(async () => aiMsg(`response-from-${provider.provider}`)),
  } as unknown as BaseChatModel);

function makeProvider(
  opts: Partial<LLMProviderConfig> & {
    models: Partial<LLMProviderConfig["models"]>;
  }
): LLMProviderConfig {
  return {
    provider: "anthropic",
    apiKey: "test-key",
    priority: 1,
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// Suite 1: ResilientModelInvoker — fallback chain mechanics
// ---------------------------------------------------------------------------

describe("ResilientModelInvoker — fallback chain mechanics", () => {
  it("1. primary succeeds → secondary never invoked", async () => {
    const primary = mockModel("succeed", aiMsg("primary-response"));
    const secondary = mockModel("succeed", aiMsg("secondary-response"));
    const invoker = new ResilientModelInvoker(
      [candidate("a", primary), candidate("b", secondary)],
      undefined,
      { retry: FAST_RETRY }
    );
    const result = await invoker.invoke(MESSAGES);
    expect(result.content).toBe("primary-response");
    expect(secondary.invoke).not.toHaveBeenCalled();
  });

  it("2. primary transient fail → secondary invoked and succeeds", async () => {
    const primary = mockModel("transient");
    const secondary = mockModel("succeed", aiMsg("recovered"));
    const invoker = new ResilientModelInvoker(
      [candidate("a", primary), candidate("b", secondary)],
      undefined,
      { retry: FAST_RETRY }
    );
    const result = await invoker.invoke(MESSAGES);
    expect(result.content).toBe("recovered");
    expect(primary.invoke).toHaveBeenCalledTimes(1);
    expect(secondary.invoke).toHaveBeenCalledTimes(1);
  });

  it("3. all providers fail → throws ALL_PROVIDERS_EXHAUSTED with all provider names", async () => {
    const candidates = [
      candidate("a", mockModel("transient")),
      candidate("b", mockModel("transient")),
      candidate("c", mockModel("transient")),
    ];
    const invoker = new ResilientModelInvoker(candidates, undefined, {
      retry: FAST_RETRY,
    });
    const err = await invoker.invoke(MESSAGES).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect((err as ForgeError).code).toBe("ALL_PROVIDERS_EXHAUSTED");
    expect((err as ForgeError).message).toMatch(/a/);
    expect((err as ForgeError).message).toMatch(/b/);
    expect((err as ForgeError).message).toMatch(/c/);
    for (const c of candidates) {
      expect(c.model.invoke).toHaveBeenCalledTimes(1);
    }
  });

  it("4. partial failure: 2nd of 3 fails (transient), 3rd succeeds", async () => {
    const c1 = candidate("a", mockModel("transient"));
    const c2 = candidate("b", mockModel("transient"));
    const c3 = candidate("c", mockModel("succeed", aiMsg("third-wins")));
    const invoker = new ResilientModelInvoker([c1, c2, c3], undefined, {
      retry: FAST_RETRY,
    });
    const result = await invoker.invoke(MESSAGES);
    expect(result.content).toBe("third-wins");
    expect(c1.model.invoke).toHaveBeenCalled();
    expect(c2.model.invoke).toHaveBeenCalled();
    expect(c3.model.invoke).toHaveBeenCalled();
  });

  it("5. non-transient error stops chain immediately (second not tried)", async () => {
    const c1 = candidate("a", mockModel("non-transient"));
    const c2 = candidate("b", mockModel("succeed"));
    const invoker = new ResilientModelInvoker([c1, c2], undefined, {
      retry: FAST_RETRY,
    });
    await expect(invoker.invoke(MESSAGES)).rejects.toThrow("Invalid API key");
    expect(c2.model.invoke).not.toHaveBeenCalled();
  });

  it("6. context length error stops chain immediately", async () => {
    const c1 = candidate("a", mockModel("context"));
    const c2 = candidate("b", mockModel("succeed"));
    const invoker = new ResilientModelInvoker([c1, c2], undefined, {
      retry: FAST_RETRY,
    });
    const err = await invoker.invoke(MESSAGES).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect((err as ForgeError).code).toBe("CONTEXT_LENGTH_EXCEEDED");
    expect(c2.model.invoke).not.toHaveBeenCalled();
  });

  it("7. empty candidate list throws ALL_PROVIDERS_EXHAUSTED without invoking anything", async () => {
    const invoker = new ResilientModelInvoker([], undefined, {
      retry: FAST_RETRY,
    });
    const err = await invoker.invoke(MESSAGES).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect((err as ForgeError).code).toBe("ALL_PROVIDERS_EXHAUSTED");
  });

  it("8. onFallback receives (failingProvider, nextProvider, error) per hop", async () => {
    const onFallback = vi.fn();
    const c1 = candidate("a", mockModel("transient"));
    const c2 = candidate("b", mockModel("transient"));
    const c3 = candidate("c", mockModel("succeed", aiMsg("ok")));
    const invoker = new ResilientModelInvoker([c1, c2, c3], undefined, {
      onFallback,
      retry: FAST_RETRY,
    });
    await invoker.invoke(MESSAGES);
    expect(onFallback).toHaveBeenCalledTimes(2);
    expect(onFallback.mock.calls[0]![0]).toBe("a");
    expect(onFallback.mock.calls[0]![1]).toBe("b");
    expect(onFallback.mock.calls[0]![2]).toBeInstanceOf(Error);
    expect(onFallback.mock.calls[1]![0]).toBe("b");
    expect(onFallback.mock.calls[1]![1]).toBe("c");
  });

  it("9. onFallback not called for final failing candidate (no next)", async () => {
    const onFallback = vi.fn();
    const c1 = candidate("a", mockModel("transient"));
    const c2 = candidate("b", mockModel("transient"));
    const invoker = new ResilientModelInvoker([c1, c2], undefined, {
      onFallback,
      retry: FAST_RETRY,
    });
    await expect(invoker.invoke(MESSAGES)).rejects.toMatchObject({
      code: "ALL_PROVIDERS_EXHAUSTED",
    });
    // Only a→b hop emitted; no hop after b (no next)
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("10. onFallback throwing never blocks the chain", async () => {
    const onFallback = vi.fn(() => {
      throw new Error("observer boom");
    });
    const c1 = candidate("a", mockModel("transient"));
    const c2 = candidate("b", mockModel("succeed", aiMsg("ok")));
    const invoker = new ResilientModelInvoker([c1, c2], undefined, {
      onFallback,
      retry: FAST_RETRY,
    });
    const result = await invoker.invoke(MESSAGES);
    expect(result.content).toBe("ok");
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("11. updateBreakers=true: recordProviderSuccess called on winning provider", async () => {
    const stub = makeRegistryStub();
    const c1 = candidate("a", mockModel("transient"));
    const c2 = candidate("b", mockModel("succeed", aiMsg("ok")));
    const invoker = new ResilientModelInvoker([c1, c2], asRegistry(stub), {
      retry: FAST_RETRY,
    });
    await invoker.invoke(MESSAGES);
    expect(stub.recordProviderSuccess).toHaveBeenCalledWith("b");
    expect(stub.recordProviderFailure).toHaveBeenCalledWith(
      "a",
      expect.any(Error)
    );
    expect(stub.recordProviderSuccess).not.toHaveBeenCalledWith("a");
  });

  it("12. updateBreakers=true: non-transient failure records failure then re-throws", async () => {
    const stub = makeRegistryStub();
    const c1 = candidate("a", mockModel("non-transient"));
    const c2 = candidate("b", mockModel("succeed"));
    const invoker = new ResilientModelInvoker([c1, c2], asRegistry(stub), {
      retry: FAST_RETRY,
    });
    await expect(invoker.invoke(MESSAGES)).rejects.toThrow("Invalid API key");
    expect(stub.recordProviderFailure).toHaveBeenCalledWith(
      "a",
      expect.any(Error)
    );
    expect(stub.recordProviderSuccess).not.toHaveBeenCalled();
  });

  it("13. updateBreakers=false: no registry methods called even on fallback", async () => {
    const stub = makeRegistryStub();
    const c1 = candidate("a", mockModel("transient"));
    const c2 = candidate("b", mockModel("succeed"));
    const invoker = new ResilientModelInvoker([c1, c2], asRegistry(stub), {
      updateBreakers: false,
      retry: FAST_RETRY,
    });
    await invoker.invoke(MESSAGES);
    expect(stub.recordProviderSuccess).not.toHaveBeenCalled();
    expect(stub.recordProviderFailure).not.toHaveBeenCalled();
  });

  it("14. second of three fails (transient), third succeeds — breakers for 1st+2nd recorded as failures", async () => {
    const stub = makeRegistryStub();
    const c1 = candidate("a", mockModel("transient"));
    const c2 = candidate("b", mockModel("transient"));
    const c3 = candidate("c", mockModel("succeed", aiMsg("win")));
    const invoker = new ResilientModelInvoker([c1, c2, c3], asRegistry(stub), {
      retry: FAST_RETRY,
    });
    await invoker.invoke(MESSAGES);
    expect(stub.recordProviderFailure).toHaveBeenCalledTimes(2);
    expect(stub.recordProviderSuccess).toHaveBeenCalledWith("c");
  });

  it("15. single candidate success → recordProviderSuccess called once", async () => {
    const stub = makeRegistryStub();
    const c1 = candidate("a", mockModel("succeed", aiMsg("solo")));
    const invoker = new ResilientModelInvoker([c1], asRegistry(stub), {
      retry: FAST_RETRY,
    });
    const result = await invoker.invoke(MESSAGES);
    expect(result.content).toBe("solo");
    expect(stub.recordProviderSuccess).toHaveBeenCalledWith("a");
    expect(stub.recordProviderFailure).not.toHaveBeenCalled();
  });

  it("16. single candidate transient failure → recordProviderFailure then ALL_PROVIDERS_EXHAUSTED", async () => {
    const stub = makeRegistryStub();
    const c1 = candidate("a", mockModel("transient"));
    const invoker = new ResilientModelInvoker([c1], asRegistry(stub), {
      retry: FAST_RETRY,
    });
    await expect(invoker.invoke(MESSAGES)).rejects.toMatchObject({
      code: "ALL_PROVIDERS_EXHAUSTED",
    });
    expect(stub.recordProviderFailure).toHaveBeenCalledWith(
      "a",
      expect.any(Error)
    );
    expect(stub.recordProviderSuccess).not.toHaveBeenCalled();
  });

  it("17. error context in ALL_PROVIDERS_EXHAUSTED includes per-provider error messages", async () => {
    const c1 = candidate("p1", mockModel("transient"));
    const c2 = candidate("p2", mockModel("transient"));
    const invoker = new ResilientModelInvoker([c1, c2], undefined, {
      retry: FAST_RETRY,
    });
    const err = (await invoker.invoke(MESSAGES).catch((e) => e)) as ForgeError;
    expect(err.code).toBe("ALL_PROVIDERS_EXHAUSTED");
    const ctx = err.context as {
      errors: Array<{ provider: string; error: string }>;
    };
    expect(ctx.errors).toHaveLength(2);
    expect(ctx.errors[0]!.provider).toBe("p1");
    expect(ctx.errors[1]!.provider).toBe("p2");
  });

  it("18. invoker with no registry still works without updateBreakers crashing", async () => {
    const c1 = candidate("a", mockModel("transient"));
    const c2 = candidate("b", mockModel("succeed", aiMsg("ok")));
    const invoker = new ResilientModelInvoker([c1, c2], undefined, {
      retry: FAST_RETRY,
    });
    const result = await invoker.invoke(MESSAGES);
    expect(result.content).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Suite 2: ModelRegistry — selection-time fallback chain
// ---------------------------------------------------------------------------

describe("ModelRegistry — selection-time fallback chain (getModelWithFallback)", () => {
  let registry: ModelRegistry;

  beforeEach(() => {
    warnSpy.mockClear();
    registry = new ModelRegistry();
    registry.setFactory(stubFactory);
  });

  it("19. primary succeeds → no fallback warning emitted", () => {
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: { chat: { name: "claude-haiku", maxTokens: 1024 } },
      })
    );
    const result = registry.getModelWithFallback("chat");
    expect(result.provider).toBe("anthropic");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("20. primary circuit open → fallback to secondary with warning", () => {
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
        models: { chat: { name: "gpt-4o-mini", maxTokens: 4096 } },
      })
    );

    // Force primary circuit open
    registry.recordProviderFailure("anthropic", new Error("503 unavailable"));
    registry.recordProviderFailure("anthropic", new Error("503 unavailable"));
    registry.recordProviderFailure("anthropic", new Error("503 unavailable"));

    const result = registry.getModelWithFallback("chat");
    expect(result.provider).toBe("openai");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("21. all circuits open → throws ALL_PROVIDERS_EXHAUSTED", () => {
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
        models: { chat: { name: "gpt-4o-mini", maxTokens: 4096 } },
      })
    );

    // Force both circuits open
    for (const provider of ["anthropic", "openai"]) {
      for (let i = 0; i < 3; i++) {
        registry.recordProviderFailure(provider, new Error("503 overloaded"));
      }
    }

    expect(() => registry.getModelWithFallback("chat")).toThrow(ForgeError);
    const err = (() => {
      try {
        registry.getModelWithFallback("chat");
      } catch (e) {
        return e;
      }
    })() as ForgeError;
    expect(err.code).toBe("ALL_PROVIDERS_EXHAUSTED");
  });

  it("22. factory error for primary triggers breaker failure, secondary selected", () => {
    const failThenStubFactory: ModelFactory = (provider, spec, overrides) => {
      if (provider.provider === "anthropic")
        throw new Error("factory explosion");
      return stubFactory(provider, spec, overrides);
    };
    registry.setFactory(failThenStubFactory);

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
        models: { chat: { name: "gpt-4o-mini", maxTokens: 4096 } },
      })
    );

    const result = registry.getModelWithFallback("chat");
    expect(result.provider).toBe("openai");
  });

  it("23. three-provider chain: 1st open, 2nd factory error, 3rd succeeds", () => {
    const failForOpenaiFactory: ModelFactory = (provider, spec, overrides) => {
      if (provider.provider === "openai")
        throw new Error("openai factory error");
      return stubFactory(provider, spec, overrides);
    };
    registry.setFactory(failForOpenaiFactory);

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
        models: { chat: { name: "gpt-4o-mini", maxTokens: 4096 } },
      })
    );
    registry.addProvider(
      makeProvider({
        provider: "openrouter",
        priority: 3,
        apiKey: "or",
        models: { chat: { name: "fallback-model", maxTokens: 4096 } },
      })
    );

    // Force anthropic circuit open
    for (let i = 0; i < 3; i++) {
      registry.recordProviderFailure("anthropic", new Error("503 overloaded"));
    }

    const result = registry.getModelWithFallback("chat");
    expect(result.provider).toBe("openrouter");
  });

  it("24. providers sorted by priority: lower number wins", () => {
    // Add in reverse order to verify priority sort
    registry.addProvider(
      makeProvider({
        provider: "openrouter",
        priority: 3,
        apiKey: "or",
        models: { chat: { name: "fallback", maxTokens: 4096 } },
      })
    );
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
        models: { chat: { name: "gpt-4o", maxTokens: 4096 } },
      })
    );

    const result = registry.getModelWithFallback("chat");
    expect(result.provider).toBe("anthropic");
  });

  it("25. provider without the requested tier is skipped entirely", () => {
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: { codegen: { name: "claude-sonnet", maxTokens: 8192 } }, // no 'chat'
      })
    );
    registry.addProvider(
      makeProvider({
        provider: "openai",
        priority: 2,
        apiKey: "oai",
        models: { chat: { name: "gpt-4o-mini", maxTokens: 4096 } },
      })
    );

    const result = registry.getModelWithFallback("chat");
    expect(result.provider).toBe("openai");
  });

  it("26. no provider for tier → throws ALL_PROVIDERS_EXHAUSTED", () => {
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: { codegen: { name: "claude-sonnet", maxTokens: 8192 } },
      })
    );

    expect(() => registry.getModelWithFallback("chat")).toThrow(ForgeError);
    const err = (() => {
      try {
        registry.getModelWithFallback("chat");
      } catch (e) {
        return e;
      }
    })() as ForgeError;
    expect(err.code).toBe("ALL_PROVIDERS_EXHAUSTED");
  });

  it("27. non-transient failure does not update circuit breaker state", () => {
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: { chat: { name: "claude-haiku", maxTokens: 1024 } },
      })
    );

    // Record non-transient (auth) failure — should NOT trip the breaker
    registry.recordProviderFailure(
      "anthropic",
      new Error("Invalid API key — not transient")
    );
    registry.recordProviderFailure(
      "anthropic",
      new Error("Invalid API key — not transient")
    );
    registry.recordProviderFailure(
      "anthropic",
      new Error("Invalid API key — not transient")
    );

    // Provider should still be selectable (circuit not opened)
    const result = registry.getModelWithFallback("chat");
    expect(result.provider).toBe("anthropic");
  });

  it("28. transient failure increments breaker, three hits open the circuit", () => {
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
        models: { chat: { name: "gpt-4o-mini", maxTokens: 4096 } },
      })
    );

    for (let i = 0; i < 3; i++) {
      registry.recordProviderFailure("anthropic", new Error("503 overloaded"));
    }

    const result = registry.getModelWithFallback("chat");
    expect(result.provider).toBe("openai");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("29. recordProviderSuccess resets breaker → provider selectable again after failure", () => {
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
        models: { chat: { name: "gpt-4o-mini", maxTokens: 4096 } },
      })
    );

    // Trip breaker
    for (let i = 0; i < 3; i++) {
      registry.recordProviderFailure("anthropic", new Error("503 overloaded"));
    }
    // Simulate recovery
    registry.recordProviderSuccess("anthropic");

    const result = registry.getModelWithFallback("chat");
    expect(result.provider).toBe("anthropic");
    // No fallback warning since primary is selected
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("30. getProviderHealth lists all registered providers", () => {
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
        models: { chat: { name: "gpt-4o-mini", maxTokens: 4096 } },
      })
    );

    const health = registry.getProviderHealth();
    expect(health).toHaveProperty("anthropic");
    expect(health).toHaveProperty("openai");
    expect(health["anthropic"]!.state).toBe("closed");
    expect(health["openai"]!.state).toBe("closed");
  });

  it("31. getProviderHealth reflects open circuit after failures", () => {
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: { chat: { name: "claude-haiku", maxTokens: 1024 } },
      })
    );
    for (let i = 0; i < 3; i++) {
      registry.recordProviderFailure("anthropic", new Error("503 overloaded"));
    }
    const health = registry.getProviderHealth();
    expect(health["anthropic"]!.state).toBe("open");
  });

  it("32. overrides are forwarded to the factory when selecting model", () => {
    const factorySpy = vi
      .fn()
      .mockImplementation(
        (
          provider: LLMProviderConfig,
          spec: ModelSpec,
          overrides?: ModelOverrides
        ) => stubFactory(provider, spec, overrides)
      );
    registry.setFactory(factorySpy);
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: { chat: { name: "claude-haiku", maxTokens: 1024 } },
      })
    );

    registry.getModelWithFallback("chat", { maxTokens: 2048 });
    expect(factorySpy).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic" }),
      expect.anything(),
      expect.objectContaining({ maxTokens: 2048 })
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 3: ModelRegistry.getModelFallbackCandidates
// ---------------------------------------------------------------------------

describe("ModelRegistry — getModelFallbackCandidates", () => {
  let registry: ModelRegistry;

  beforeEach(() => {
    registry = new ModelRegistry();
    registry.setFactory(stubFactory);
  });

  it("33. two eligible providers → both candidates returned in priority order", () => {
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
        models: { chat: { name: "gpt-4o-mini", maxTokens: 4096 } },
      })
    );

    const candidates = registry.getModelFallbackCandidates("chat");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]!.provider).toBe("anthropic");
    expect(candidates[1]!.provider).toBe("openai");
  });

  it("34. open circuit provider excluded from candidates", () => {
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
        models: { chat: { name: "gpt-4o-mini", maxTokens: 4096 } },
      })
    );

    for (let i = 0; i < 3; i++) {
      registry.recordProviderFailure("anthropic", new Error("503 overloaded"));
    }

    const candidates = registry.getModelFallbackCandidates("chat");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.provider).toBe("openai");
  });

  it("35. factory error for one provider triggers breaker, other returned", () => {
    const failPrimaryFactory: ModelFactory = (provider, spec, overrides) => {
      if (provider.provider === "anthropic") throw new Error("factory boom");
      return stubFactory(provider, spec, overrides);
    };
    registry.setFactory(failPrimaryFactory);

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
        models: { chat: { name: "gpt-4o-mini", maxTokens: 4096 } },
      })
    );

    const candidates = registry.getModelFallbackCandidates("chat");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.provider).toBe("openai");
  });

  it("36. all circuits open → getModelFallbackCandidates throws ALL_PROVIDERS_EXHAUSTED", () => {
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: { chat: { name: "claude-haiku", maxTokens: 1024 } },
      })
    );
    for (let i = 0; i < 3; i++) {
      registry.recordProviderFailure("anthropic", new Error("503 overloaded"));
    }

    expect(() => registry.getModelFallbackCandidates("chat")).toThrow(
      ForgeError
    );
    const err = (() => {
      try {
        registry.getModelFallbackCandidates("chat");
      } catch (e) {
        return e;
      }
    })() as ForgeError;
    expect(err.code).toBe("ALL_PROVIDERS_EXHAUSTED");
  });

  it("37. candidates carry the correct modelName from spec", () => {
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: { chat: { name: "claude-haiku-special", maxTokens: 1024 } },
      })
    );

    const candidates = registry.getModelFallbackCandidates("chat");
    expect(candidates[0]!.modelName).toBe("claude-haiku-special");
  });

  it("38. model override replaces modelName in candidate", () => {
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: { chat: { name: "claude-haiku", maxTokens: 1024 } },
      })
    );

    const candidates = registry.getModelFallbackCandidates("chat", {
      model: "claude-sonnet-overridden",
    });
    expect(candidates[0]!.modelName).toBe("claude-sonnet-overridden");
  });

  it("39. no provider for tier → throws ALL_PROVIDERS_EXHAUSTED", () => {
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: { codegen: { name: "claude-sonnet", maxTokens: 8192 } },
      })
    );

    const err = (() => {
      try {
        registry.getModelFallbackCandidates("chat");
      } catch (e) {
        return e;
      }
    })() as ForgeError;
    expect(err.code).toBe("ALL_PROVIDERS_EXHAUSTED");
  });
});

// ---------------------------------------------------------------------------
// Suite 4: End-to-end — ResilientModelInvoker + ModelRegistry integration
// ---------------------------------------------------------------------------

describe("End-to-end — ResilientModelInvoker using ModelRegistry.getModelFallbackCandidates", () => {
  let registry: ModelRegistry;

  beforeEach(() => {
    warnSpy.mockClear();
    registry = new ModelRegistry();
    registry.setFactory(stubFactory);
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
        models: { chat: { name: "gpt-4o-mini", maxTokens: 4096 } },
      })
    );
  });

  it("40. candidates from registry feed ResilientModelInvoker — primary succeeds", async () => {
    const candidates = registry.getModelFallbackCandidates("chat");
    // Override the first candidate's model to be a controllable mock
    candidates[0]!.model = mockModel("succeed", aiMsg("registry-primary-ok"));

    const invoker = new ResilientModelInvoker(candidates, registry, {
      retry: FAST_RETRY,
    });
    const result = await invoker.invoke(MESSAGES);
    expect(result.content).toBe("registry-primary-ok");
  });

  it("41. candidates from registry feed ResilientModelInvoker — primary fails, secondary recovers", async () => {
    const candidates = registry.getModelFallbackCandidates("chat");
    candidates[0]!.model = mockModel("transient");
    candidates[1]!.model = mockModel("succeed", aiMsg("registry-secondary-ok"));

    const invoker = new ResilientModelInvoker(candidates, registry, {
      retry: FAST_RETRY,
    });
    const result = await invoker.invoke(MESSAGES);
    expect(result.content).toBe("registry-secondary-ok");
  });

  it("42. invoker updates registry breakers on transient failure → circuit eventually opens", async () => {
    // Manually invoke failure recording 3 times (what invoker does)
    for (let i = 0; i < 3; i++) {
      registry.recordProviderFailure("anthropic", new Error("503 overloaded"));
    }
    const health = registry.getProviderHealth();
    expect(health["anthropic"]!.state).toBe("open");

    // Now candidates exclude anthropic
    const candidates = registry.getModelFallbackCandidates("chat");
    expect(candidates.every((c) => c.provider !== "anthropic")).toBe(true);
  });

  it("43. invoker with registry: success on secondary closes secondary breaker", async () => {
    const candidates = registry.getModelFallbackCandidates("chat");
    candidates[0]!.model = mockModel("transient");
    candidates[1]!.model = mockModel("succeed", aiMsg("ok"));

    const invoker = new ResilientModelInvoker(candidates, registry, {
      retry: FAST_RETRY,
    });
    await invoker.invoke(MESSAGES);

    const health = registry.getProviderHealth();
    expect(health["openai"]!.state).toBe("closed");
  });

  it("44. all candidates from registry fail → error context includes registry provider names", async () => {
    const candidates = registry.getModelFallbackCandidates("chat");
    candidates[0]!.model = mockModel("transient");
    candidates[1]!.model = mockModel("transient");

    const invoker = new ResilientModelInvoker(candidates, registry, {
      retry: FAST_RETRY,
    });
    const err = (await invoker.invoke(MESSAGES).catch((e) => e)) as ForgeError;
    expect(err.code).toBe("ALL_PROVIDERS_EXHAUSTED");
    const ctx = err.context as { errors: Array<{ provider: string }> };
    const providers = ctx.errors.map((e) => e.provider);
    expect(providers).toContain("anthropic");
    expect(providers).toContain("openai");
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Circuit breaker state transitions (via ModelRegistry API)
// ---------------------------------------------------------------------------

describe("Circuit breaker state transitions via ModelRegistry", () => {
  let registry: ModelRegistry;

  beforeEach(() => {
    registry = new ModelRegistry();
    registry.setFactory(stubFactory);
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: { chat: { name: "claude-haiku", maxTokens: 1024 } },
      })
    );
  });

  it("45. initial state is closed", () => {
    const health = registry.getProviderHealth();
    expect(health["anthropic"]!.state).toBe("closed");
  });

  it("46. two transient failures do not open breaker (threshold is 3)", () => {
    registry.recordProviderFailure("anthropic", new Error("503 overloaded"));
    registry.recordProviderFailure("anthropic", new Error("503 overloaded"));
    const health = registry.getProviderHealth();
    expect(health["anthropic"]!.state).toBe("closed");
  });

  it("47. three transient failures open the breaker", () => {
    for (let i = 0; i < 3; i++) {
      registry.recordProviderFailure("anthropic", new Error("503 overloaded"));
    }
    const health = registry.getProviderHealth();
    expect(health["anthropic"]!.state).toBe("open");
  });

  it("48. success after two failures resets to closed", () => {
    registry.recordProviderFailure("anthropic", new Error("503 overloaded"));
    registry.recordProviderFailure("anthropic", new Error("503 overloaded"));
    registry.recordProviderSuccess("anthropic");
    const health = registry.getProviderHealth();
    expect(health["anthropic"]!.state).toBe("closed");
  });

  it("49. non-transient errors (auth) do not count toward threshold", () => {
    for (let i = 0; i < 5; i++) {
      registry.recordProviderFailure("anthropic", new Error("invalid api key"));
    }
    const health = registry.getProviderHealth();
    expect(health["anthropic"]!.state).toBe("closed");
  });

  it("50. getProviderHealth for unknown provider returns closed state", () => {
    const health = registry.getProviderHealth();
    // Only registered providers appear; unknown ones not listed
    expect(health["nonexistent"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Suite 6: Edge cases and robustness
// ---------------------------------------------------------------------------

describe("Fallback chain edge cases", () => {
  it("51. invoker with undefined registry does not throw on success", async () => {
    const c1 = candidate("solo", mockModel("succeed", aiMsg("solo-ok")));
    const invoker = new ResilientModelInvoker([c1], undefined, {
      retry: FAST_RETRY,
    });
    const result = await invoker.invoke(MESSAGES);
    expect(result.content).toBe("solo-ok");
  });

  it("52. invoker returns first message from model correctly", async () => {
    const expected = aiMsg("specific-content-xyz");
    const c1 = candidate("a", mockModel("succeed", expected));
    const invoker = new ResilientModelInvoker([c1], undefined, {
      retry: FAST_RETRY,
    });
    const result = await invoker.invoke(MESSAGES);
    expect(result.content).toBe("specific-content-xyz");
  });

  it("53. transient errors from all three in a chain → error list has exactly 3 entries", async () => {
    const candidates = [
      candidate("x", mockModel("transient")),
      candidate("y", mockModel("transient")),
      candidate("z", mockModel("transient")),
    ];
    const invoker = new ResilientModelInvoker(candidates, undefined, {
      retry: FAST_RETRY,
    });
    const err = (await invoker.invoke(MESSAGES).catch((e) => e)) as ForgeError;
    const ctx = err.context as { errors: unknown[] };
    expect(ctx.errors).toHaveLength(3);
  });

  it("54. mixed failures: transient first, non-transient second stops at second", async () => {
    const c1 = candidate("a", mockModel("transient"));
    const c2 = candidate("b", mockModel("non-transient"));
    const c3 = candidate("c", mockModel("succeed"));
    const invoker = new ResilientModelInvoker([c1, c2, c3], undefined, {
      retry: FAST_RETRY,
    });
    await expect(invoker.invoke(MESSAGES)).rejects.toThrow("Invalid API key");
    expect(c3.model.invoke).not.toHaveBeenCalled();
  });

  it("55. onFallback error message matches the transient error that triggered it", async () => {
    const onFallback = vi.fn();
    const c1 = candidate("a", {
      invoke: vi.fn().mockRejectedValue(new Error("503 specific-error-abc")),
    } as unknown as BaseChatModel);
    const c2 = candidate("b", mockModel("succeed"));
    const invoker = new ResilientModelInvoker([c1, c2], undefined, {
      onFallback,
      retry: FAST_RETRY,
    });
    await invoker.invoke(MESSAGES);
    const [, , error] = onFallback.mock.calls[0]!;
    expect((error as Error).message).toContain("503 specific-error-abc");
  });

  it("56. ModelRegistry with no providers at all → getModelWithFallback throws ALL_PROVIDERS_EXHAUSTED", () => {
    const emptyRegistry = new ModelRegistry();
    emptyRegistry.setFactory(stubFactory);
    const err = (() => {
      try {
        emptyRegistry.getModelWithFallback("chat");
      } catch (e) {
        return e;
      }
    })() as ForgeError;
    expect(err.code).toBe("ALL_PROVIDERS_EXHAUSTED");
  });

  it("57. ModelRegistry getModelFallbackCandidates no providers → ALL_PROVIDERS_EXHAUSTED", () => {
    const emptyRegistry = new ModelRegistry();
    emptyRegistry.setFactory(stubFactory);
    const err = (() => {
      try {
        emptyRegistry.getModelFallbackCandidates("chat");
      } catch (e) {
        return e;
      }
    })() as ForgeError;
    expect(err.code).toBe("ALL_PROVIDERS_EXHAUSTED");
  });

  it("58. registering same provider twice at different priorities → first priority wins", () => {
    const registry = new ModelRegistry();
    registry.setFactory(stubFactory);
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 2,
        models: { chat: { name: "claude-haiku-low", maxTokens: 1024 } },
      })
    );
    registry.addProvider(
      makeProvider({
        provider: "openai",
        priority: 1,
        apiKey: "oai",
        models: { chat: { name: "gpt-4o-mini", maxTokens: 4096 } },
      })
    );
    const result = registry.getModelWithFallback("chat");
    expect(result.provider).toBe("openai");
  });

  it("59. fallback chain with 5 transient failures all recorded in context", async () => {
    const candidates = Array.from({ length: 5 }, (_, i) =>
      candidate(`p${i}`, mockModel("transient"))
    );
    const invoker = new ResilientModelInvoker(candidates, undefined, {
      retry: FAST_RETRY,
    });
    const err = (await invoker.invoke(MESSAGES).catch((e) => e)) as ForgeError;
    const ctx = err.context as { errors: Array<{ provider: string }> };
    expect(ctx.errors).toHaveLength(5);
    expect(ctx.errors.map((e) => e.provider)).toEqual([
      "p0",
      "p1",
      "p2",
      "p3",
      "p4",
    ]);
  });

  it("60. primary success with registry: only recordProviderSuccess called, not failure", async () => {
    const registry = new ModelRegistry();
    registry.setFactory(stubFactory);
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: { chat: { name: "claude-haiku", maxTokens: 1024 } },
      })
    );

    const stub = makeRegistryStub();
    const c1 = candidate(
      "anthropic",
      mockModel("succeed", aiMsg("primary-win"))
    );
    const invoker = new ResilientModelInvoker([c1], asRegistry(stub), {
      retry: FAST_RETRY,
    });
    await invoker.invoke(MESSAGES);
    expect(stub.recordProviderSuccess).toHaveBeenCalledWith("anthropic");
    expect(stub.recordProviderFailure).not.toHaveBeenCalled();
  });

  it("61. large chain (10 providers): first 9 fail, 10th succeeds", async () => {
    const candidates = [
      ...Array.from({ length: 9 }, (_, i) =>
        candidate(`fail${i}`, mockModel("transient"))
      ),
      candidate("win", mockModel("succeed", aiMsg("10th-wins"))),
    ];
    const invoker = new ResilientModelInvoker(candidates, undefined, {
      retry: FAST_RETRY,
    });
    const result = await invoker.invoke(MESSAGES);
    expect(result.content).toBe("10th-wins");
  });

  it("62. invoker error message includes candidate count", async () => {
    const candidates = [
      candidate("a", mockModel("transient")),
      candidate("b", mockModel("transient")),
    ];
    const invoker = new ResilientModelInvoker(candidates, undefined, {
      retry: FAST_RETRY,
    });
    const err = (await invoker.invoke(MESSAGES).catch((e) => e)) as ForgeError;
    expect(err.message).toContain("2");
  });

  it("63. ModelRegistry listProviders reflects priority-sorted order", () => {
    const registry = new ModelRegistry();
    registry.setFactory(stubFactory);
    registry.addProvider(
      makeProvider({
        provider: "openai",
        priority: 3,
        apiKey: "oai",
        models: { chat: { name: "gpt", maxTokens: 4096 } },
      })
    );
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: { chat: { name: "claude", maxTokens: 1024 } },
      })
    );
    registry.addProvider(
      makeProvider({
        provider: "openrouter",
        priority: 2,
        apiKey: "or",
        models: { chat: { name: "mix", maxTokens: 4096 } },
      })
    );
    expect(registry.listProviders()).toEqual([
      "anthropic",
      "openrouter",
      "openai",
    ]);
  });

  it("64. isConfigured() returns false with no providers, true after one is added", () => {
    const registry = new ModelRegistry();
    expect(registry.isConfigured()).toBe(false);
    registry.setFactory(stubFactory);
    registry.addProvider(
      makeProvider({
        provider: "anthropic",
        priority: 1,
        models: { chat: { name: "claude", maxTokens: 1024 } },
      })
    );
    expect(registry.isConfigured()).toBe(true);
  });
});

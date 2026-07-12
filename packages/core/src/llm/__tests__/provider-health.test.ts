/**
 * Provider health tracker + weighted provider selection.
 *
 * Covers:
 *  - EMA converges toward observed outcomes over repeated calls
 *  - Warm-up neutrality: getWeight === 1 below minSamples
 *  - Weighted mode picks the higher-success-rate provider within a shared
 *    priority tier
 *  - Weighted mode never selects a provider whose breaker is open
 *  - Priority mode (default) is a pure regression guard: identical fallback
 *    order to pre-change behavior (priority ascending, byte-for-byte)
 */

import { describe, it, expect, vi } from "vitest";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ProviderHealthTracker } from "../provider-health.js";
import { ModelRegistry } from "../model-registry.js";
import type {
  LLMProviderConfig,
  ModelFactory,
  ModelOverrides,
  ModelSpec,
} from "../model-config.js";

// LangChain mocks — never construct real provider SDKs in unit tests.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stubFactory: ModelFactory = (
  provider: LLMProviderConfig,
  spec: ModelSpec,
  overrides?: ModelOverrides,
) =>
  ({
    _provider: provider.provider,
    _model: overrides?.model ?? spec.name,
  }) as unknown as BaseChatModel;

function makeProvider(
  providerName: LLMProviderConfig["provider"],
  priority: number,
): LLMProviderConfig {
  return {
    provider: providerName,
    apiKey: "test-key",
    priority,
    models: { chat: { name: `model-${providerName}`, maxTokens: 128 } },
  };
}

const notTransient = new Error("Invalid API key"); // non-transient
const transient = new Error("503 service unavailable"); // transient

// ---------------------------------------------------------------------------
// ProviderHealthTracker — EMA + warm-up
// ---------------------------------------------------------------------------

describe("ProviderHealthTracker — EMA convergence", () => {
  it("converges toward 1 under sustained success", () => {
    const t = new ProviderHealthTracker({ alpha: 0.5, minSamples: 1 });
    for (let i = 0; i < 50; i++) t.recordSuccess("p");
    expect(t.getWeight("p")).toBeGreaterThan(0.99);
    expect(t.snapshot().p.successRate).toBeGreaterThan(0.99);
  });

  it("converges toward 0 under sustained failure", () => {
    const t = new ProviderHealthTracker({ alpha: 0.5, minSamples: 1 });
    for (let i = 0; i < 50; i++) t.recordFailure("p");
    expect(t.getWeight("p")).toBeLessThan(0.01);
  });

  it("moves toward the recent outcome after a regime change", () => {
    const t = new ProviderHealthTracker({ alpha: 0.3, minSamples: 1 });
    for (let i = 0; i < 30; i++) t.recordSuccess("p");
    const healthy = t.getWeight("p");
    expect(healthy).toBeGreaterThan(0.9);
    for (let i = 0; i < 10; i++) t.recordFailure("p");
    expect(t.getWeight("p")).toBeLessThan(healthy);
  });

  it("tracks each provider key independently", () => {
    const t = new ProviderHealthTracker({ alpha: 0.5, minSamples: 1 });
    for (let i = 0; i < 20; i++) t.recordSuccess("good");
    for (let i = 0; i < 20; i++) t.recordFailure("bad");
    expect(t.getWeight("good")).toBeGreaterThan(t.getWeight("bad"));
  });
});

describe("ProviderHealthTracker — warm-up neutrality", () => {
  it("returns neutral 1.0 for an unseen key", () => {
    const t = new ProviderHealthTracker();
    expect(t.getWeight("never-seen")).toBe(1);
  });

  it("returns neutral 1.0 while samples < minSamples", () => {
    const t = new ProviderHealthTracker({ minSamples: 5 });
    // 4 failures — a very unhealthy provider, but still in warm-up.
    for (let i = 0; i < 4; i++) t.recordFailure("p");
    expect(t.snapshot().p.samples).toBe(4);
    expect(t.getWeight("p")).toBe(1);
  });

  it("switches to the measured rate at exactly minSamples", () => {
    const t = new ProviderHealthTracker({ minSamples: 5, alpha: 0.5 });
    for (let i = 0; i < 5; i++) t.recordFailure("p");
    expect(t.getWeight("p")).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// Weighted selection — within-tier tie-break
// ---------------------------------------------------------------------------

describe("ModelRegistry weighted selection — same priority tie-break", () => {
  function warm(registry: ModelRegistry, provider: string, outcome: 0 | 1) {
    for (let i = 0; i < 10; i++) {
      if (outcome === 1) registry.recordProviderSuccess(provider);
      else registry.recordProviderFailure(provider, notTransient);
    }
  }

  it("prefers the higher-success-rate provider at the same priority", () => {
    const registry = new ModelRegistry()
      .setFactory(stubFactory)
      .setSelectionMode("weighted")
      .setProviderHealthConfig({ alpha: 0.5, minSamples: 5 });
    // Both at priority 1. Insertion order: anthropic first.
    registry.addProvider(makeProvider("anthropic", 1));
    registry.addProvider(makeProvider("openai", 1));

    // Make anthropic (the insertion-first provider) unhealthy, openai healthy.
    warm(registry, "anthropic", 0);
    warm(registry, "openai", 1);

    const { provider } = registry.getModelWithFallback("chat");
    expect(provider).toBe("openai");

    const candidates = registry.getModelFallbackCandidates("chat");
    expect(candidates.map((c) => c.provider)).toEqual(["openai", "anthropic"]);
  });

  it("never reorders across priority tiers (weight is a tie-break only)", () => {
    const registry = new ModelRegistry()
      .setFactory(stubFactory)
      .setSelectionMode("weighted")
      .setProviderHealthConfig({ alpha: 0.5, minSamples: 5 });
    registry.addProvider(makeProvider("anthropic", 1)); // higher priority
    registry.addProvider(makeProvider("openai", 2)); // lower priority

    // Make the priority-1 provider unhealthy and the priority-2 provider
    // perfectly healthy — priority must still win.
    warm(registry, "anthropic", 0);
    warm(registry, "openai", 1);

    expect(registry.getModelWithFallback("chat").provider).toBe("anthropic");
    expect(
      registry.getModelFallbackCandidates("chat").map((c) => c.provider),
    ).toEqual(["anthropic", "openai"]);
  });

  it("never selects a provider whose breaker is open", () => {
    const registry = new ModelRegistry()
      .setFactory(stubFactory)
      .setSelectionMode("weighted")
      .setProviderHealthConfig({ alpha: 0.5, minSamples: 5 })
      .setCircuitBreakerConfig({ failureThreshold: 3, resetTimeoutMs: 60_000 });
    registry.addProvider(makeProvider("anthropic", 1));
    registry.addProvider(makeProvider("openai", 1));

    // openai has the higher weight but we trip its breaker with transient fails.
    warm(registry, "openai", 1);
    warm(registry, "anthropic", 1);
    for (let i = 0; i < 3; i++)
      registry.recordProviderFailure("openai", transient);

    const { provider } = registry.getModelWithFallback("chat");
    expect(provider).toBe("anthropic");
    expect(
      registry.getModelFallbackCandidates("chat").map((c) => c.provider),
    ).toEqual(["anthropic"]);
  });

  it("records every failure in health but only transient trips the breaker", () => {
    const registry = new ModelRegistry()
      .setFactory(stubFactory)
      .setProviderHealthConfig({ minSamples: 1 });
    registry.addProvider(makeProvider("anthropic", 1));

    // 10 non-transient failures: breaker stays closed, but health drops.
    for (let i = 0; i < 10; i++)
      registry.recordProviderFailure("anthropic", notTransient);

    const health = registry.getProviderHealth();
    expect(health.anthropic.state).toBe("closed");
    expect(health.anthropic.samples).toBe(10);
    expect(health.anthropic.successRate).toBeLessThan(0.5);
    expect(health.anthropic.weight).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// Priority mode — pure regression guard
// ---------------------------------------------------------------------------

describe("ModelRegistry priority mode — regression guard", () => {
  function buildRegistry(mode?: "priority" | "weighted"): ModelRegistry {
    const registry = new ModelRegistry()
      .setFactory(stubFactory)
      .setProviderHealthConfig({ alpha: 0.5, minSamples: 5 });
    if (mode) registry.setSelectionMode(mode);
    // Insert out of priority order to prove sort-by-priority is preserved.
    registry.addProvider(makeProvider("openai", 2));
    registry.addProvider(makeProvider("anthropic", 1));
    registry.addProvider(makeProvider("openrouter", 3));
    return registry;
  }

  it("default (unset) selection order is priority ascending", () => {
    const registry = buildRegistry();
    // Even after skewing health, priority mode must ignore it entirely.
    for (let i = 0; i < 10; i++)
      registry.recordProviderFailure("anthropic", notTransient);
    for (let i = 0; i < 10; i++) registry.recordProviderSuccess("openrouter");

    expect(registry.getModelWithFallback("chat").provider).toBe("anthropic");
    expect(
      registry.getModelFallbackCandidates("chat").map((c) => c.provider),
    ).toEqual(["anthropic", "openai", "openrouter"]);
  });

  it("explicit 'priority' mode matches the default byte-for-byte", () => {
    const def = buildRegistry();
    const explicit = buildRegistry("priority");
    for (const r of [def, explicit]) {
      for (let i = 0; i < 10; i++)
        r.recordProviderFailure("anthropic", notTransient);
    }
    expect(
      explicit.getModelFallbackCandidates("chat").map((c) => c.provider),
    ).toEqual(def.getModelFallbackCandidates("chat").map((c) => c.provider));
    expect(explicit.getModelWithFallback("chat").provider).toBe(
      def.getModelWithFallback("chat").provider,
    );
  });

  it("getProviderHealth is additive: keeps state/provider, adds weight/successRate/samples", () => {
    const registry = buildRegistry();
    const health = registry.getProviderHealth();
    // All providers present, warm-up neutral defaults.
    for (const name of ["anthropic", "openai", "openrouter"]) {
      expect(health[name]).toMatchObject({
        provider: name,
        state: "closed",
        weight: 1,
        successRate: 1,
        samples: 0,
      });
    }
  });
});

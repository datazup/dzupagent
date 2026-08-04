/**
 * DZUPAGENT-AGENT-C-06 — capability guard on the *same-run failover chain*.
 *
 * `getModelWithFallback` has had a capability guard since M-11, but
 * `getModelFallbackCandidates` — the function that builds the chain the agent
 * actually retries through — took no requirements at all. A tool-calling run
 * could therefore fail over onto a tier peer without tool calling and silently
 * degrade to prose.
 *
 * Covers:
 *   - candidates lacking a required capability are dropped from the chain
 *   - a chain with NO capable candidate throws NO_CAPABLE_FALLBACK (never a
 *     silently-degraded chain, never ALL_PROVIDERS_EXHAUSTED)
 *   - contextWindow filtering, and unknown contextWindow being allowed
 *   - `tool_use` / `function_calling` alias equivalence
 *   - `undeclaredCapabilityPolicy: 'allow'` keeps un-annotated registries working
 *   - omitting `requirements` preserves the pre-C-06 behaviour exactly
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type {
  LLMProviderConfig,
  ModelSpec,
  ModelOverrides,
  ModelFactory,
} from "../llm/model-config.js";

vi.mock("@langchain/anthropic", () => ({
  ChatAnthropic: vi.fn().mockImplementation(() => ({ _type: "anthropic" })),
}));
vi.mock("@langchain/openai", () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({ _type: "openai" })),
}));

import { ModelRegistry } from "../llm/model-registry.js";
import { ForgeError } from "../errors/forge-error.js";

const stubFactory: ModelFactory = (
  provider: LLMProviderConfig,
  spec: ModelSpec,
  _overrides?: ModelOverrides,
) =>
  ({
    _provider: provider.provider,
    _model: spec.name,
  }) as unknown as BaseChatModel;

function provider(
  name: string,
  priority: number,
  chat: ModelSpec,
): LLMProviderConfig {
  return {
    provider: name,
    apiKey: `key-${name}`,
    priority,
    models: { chat },
  };
}

describe("getModelFallbackCandidates — capability guard (C-06)", () => {
  let registry: ModelRegistry;

  beforeEach(() => {
    registry = new ModelRegistry();
    registry.setFactory(stubFactory);
  });

  it("drops chain candidates that do not declare the required capability", () => {
    registry.addProvider(
      provider("anthropic", 1, {
        name: "claude-sonnet",
        maxTokens: 4096,
        capabilities: ["tool_use", "streaming"],
      }),
    );
    registry.addProvider(
      provider("openai", 2, {
        name: "text-only",
        maxTokens: 4096,
        capabilities: ["streaming"],
      }),
    );
    registry.addProvider(
      provider("openrouter", 3, {
        name: "gpt-4o-mini",
        maxTokens: 4096,
        capabilities: ["tool_use"],
      }),
    );

    const candidates = registry.getModelFallbackCandidates("chat", undefined, {
      requiredCapabilities: ["tool_use"],
    });

    expect(candidates.map((c) => c.provider)).toEqual([
      "anthropic",
      "openrouter",
    ]);
  });

  it("throws NO_CAPABLE_FALLBACK when no candidate supports tool calling", () => {
    registry.addProvider(
      provider("openai", 1, {
        name: "text-only-a",
        maxTokens: 4096,
        capabilities: ["streaming"],
      }),
    );
    registry.addProvider(
      provider("openrouter", 2, {
        name: "text-only-b",
        maxTokens: 4096,
        capabilities: ["vision"],
      }),
    );

    let caught: unknown;
    try {
      registry.getModelFallbackCandidates("chat", undefined, {
        requiredCapabilities: ["tool_use"],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ForgeError);
    expect((caught as ForgeError).code).toBe("NO_CAPABLE_FALLBACK");
    expect((caught as ForgeError).message).toContain("tool_use");
  });

  it("keeps ALL_PROVIDERS_EXHAUSTED when the failure is not a capability gap", () => {
    // No providers at all: nothing was capability-skipped, so the generic
    // exhausted error must still be the one raised.
    let caught: unknown;
    try {
      registry.getModelFallbackCandidates("chat", undefined, {
        requiredCapabilities: ["tool_use"],
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as ForgeError).code).toBe("ALL_PROVIDERS_EXHAUSTED");
  });

  it("skips a candidate whose contextWindow is smaller than the run needs", () => {
    registry.addProvider(
      provider("openai", 1, {
        name: "small-window",
        maxTokens: 4096,
        contextWindow: 32_000,
        capabilities: ["tool_use"],
      }),
    );
    registry.addProvider(
      provider("anthropic", 2, {
        name: "big-window",
        maxTokens: 4096,
        contextWindow: 200_000,
        capabilities: ["tool_use"],
      }),
    );

    const candidates = registry.getModelFallbackCandidates("chat", undefined, {
      minContextWindow: 100_000,
    });
    expect(candidates.map((c) => c.provider)).toEqual(["anthropic"]);
  });

  it("does not skip a candidate whose contextWindow is unknown", () => {
    registry.addProvider(
      provider("anthropic", 1, {
        name: "unknown-window",
        maxTokens: 4096,
        capabilities: ["tool_use"],
      }),
    );

    const candidates = registry.getModelFallbackCandidates("chat", undefined, {
      minContextWindow: 500_000,
    });
    expect(candidates).toHaveLength(1);
  });

  it("treats function_calling as satisfying a tool_use requirement", () => {
    registry.addProvider(
      provider("openai", 1, {
        name: "gpt-4o",
        maxTokens: 4096,
        capabilities: ["function_calling"],
      }),
    );

    const candidates = registry.getModelFallbackCandidates("chat", undefined, {
      requiredCapabilities: ["tool_use"],
    });
    expect(candidates.map((c) => c.provider)).toEqual(["openai"]);
  });

  it("undeclaredCapabilityPolicy 'allow' keeps specs that declare no capabilities", () => {
    registry.addProvider(
      provider("anthropic", 1, { name: "unannotated", maxTokens: 4096 }),
    );

    expect(
      registry.getModelFallbackCandidates("chat", undefined, {
        requiredCapabilities: ["tool_use"],
        undeclaredCapabilityPolicy: "allow",
      }),
    ).toHaveLength(1);

    // ...while the default 'skip' policy still rejects them.
    expect(() =>
      registry.getModelFallbackCandidates("chat", undefined, {
        requiredCapabilities: ["tool_use"],
      }),
    ).toThrow(expect.objectContaining({ code: "NO_CAPABLE_FALLBACK" }));
  });

  it("'allow' still rejects a spec that declares capabilities but not the required one", () => {
    registry.addProvider(
      provider("openai", 1, {
        name: "declared-text-only",
        maxTokens: 4096,
        capabilities: ["streaming"],
      }),
    );

    expect(() =>
      registry.getModelFallbackCandidates("chat", undefined, {
        requiredCapabilities: ["tool_use"],
        undeclaredCapabilityPolicy: "allow",
      }),
    ).toThrow(expect.objectContaining({ code: "NO_CAPABLE_FALLBACK" }));
  });

  it("omitting requirements preserves the pre-C-06 unfiltered chain", () => {
    registry.addProvider(
      provider("openai", 1, {
        name: "text-only",
        maxTokens: 4096,
        capabilities: ["streaming"],
      }),
    );
    registry.addProvider(
      provider("anthropic", 2, { name: "unannotated", maxTokens: 4096 }),
    );

    const candidates = registry.getModelFallbackCandidates("chat");
    expect(candidates.map((c) => c.provider)).toEqual(["openai", "anthropic"]);
  });
});

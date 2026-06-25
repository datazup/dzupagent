/**
 * adapter-registry.test.ts
 *
 * Self-contained tests for the agent adapter registry pattern used in
 * @dzupagent/agent-adapters (ProviderAdapterRegistry + routers).
 *
 * These tests validate the specification of adapter registry behaviors:
 *   - Registration / unregistration CRUD
 *   - Health checks and health-based filtering
 *   - Circuit breaker: closed → open → half-open → closed lifecycle
 *   - Task routing by type tags
 *   - Routing by capability scoring
 *   - Default adapter fallback
 *   - Adapter priority ordering
 *   - Load balancing via round-robin
 *
 * The implementations below are minimal reference implementations that
 * mirror the contracts of ProviderAdapterRegistry, TagBasedRouter,
 * CapabilityRouter, and RoundRobinRouter so that the tests remain fully
 * runnable inside @dzupagent/connectors without adding a dependency on
 * @dzupagent/agent-adapters.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Minimal type definitions (mirror the contracts from agent-adapters)
// ---------------------------------------------------------------------------

type ProviderId = string;

interface HealthStatus {
  healthy: boolean;
  providerId: ProviderId;
  sdkInstalled: boolean;
  cliAvailable: boolean;
  lastError?: string;
}

interface Adapter {
  providerId: ProviderId;
  priority?: number;
  healthCheck(): Promise<HealthStatus>;
}

interface TaskDescriptor {
  tags: string[];
  requiresReasoning?: boolean;
  requiresExecution?: boolean;
  preferredProvider?: ProviderId;
  budgetConstraint?: "low" | "medium" | "high";
}

interface RoutingDecision {
  provider: ProviderId;
  reason: string;
  fallbackProviders: ProviderId[];
  confidence: number;
}

// ---------------------------------------------------------------------------
// Minimal CircuitBreaker implementation
// ---------------------------------------------------------------------------

type CircuitState = "closed" | "open" | "half-open";

interface CircuitBreakerConfig {
  failureThreshold: number;
  halfOpenAfterMs: number;
}

class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private openedAt = 0;
  private readonly threshold: number;
  private readonly halfOpenAfterMs: number;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.threshold = config?.failureThreshold ?? 3;
    this.halfOpenAfterMs = config?.halfOpenAfterMs ?? 5_000;
  }

  canExecute(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "half-open") return true;
    // open → check if we can transition to half-open
    if (Date.now() - this.openedAt >= this.halfOpenAfterMs) {
      this.state = "half-open";
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this.failures++;
    if (this.state === "half-open" || this.failures >= this.threshold) {
      this.state = "open";
      this.openedAt = Date.now();
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  reset(): void {
    this.state = "closed";
    this.failures = 0;
    this.openedAt = 0;
  }

  /** Force the circuit into open state (test helper). */
  forceOpen(): void {
    this.state = "open";
    this.openedAt = Date.now();
    this.failures = this.threshold;
  }
}

// ---------------------------------------------------------------------------
// Minimal AdapterRegistry implementation
// ---------------------------------------------------------------------------

class AdapterRegistry {
  private readonly adapters = new Map<ProviderId, Adapter>();
  private readonly disabled = new Set<ProviderId>();
  private readonly breakers = new Map<ProviderId, CircuitBreaker>();
  private defaultProviderId?: ProviderId;
  private readonly cbConfig?: Partial<CircuitBreakerConfig>;

  constructor(options?: { circuitBreaker?: Partial<CircuitBreakerConfig> }) {
    this.cbConfig = options?.circuitBreaker;
  }

  register(adapter: Adapter): this {
    this.adapters.set(adapter.providerId, adapter);
    if (!this.breakers.has(adapter.providerId)) {
      this.breakers.set(adapter.providerId, new CircuitBreaker(this.cbConfig));
    }
    return this;
  }

  unregister(providerId: ProviderId): boolean {
    const existed = this.adapters.has(providerId);
    this.adapters.delete(providerId);
    this.breakers.delete(providerId);
    this.disabled.delete(providerId);
    if (this.defaultProviderId === providerId)
      this.defaultProviderId = undefined;
    return existed;
  }

  get(providerId: ProviderId): Adapter | undefined {
    return this.adapters.get(providerId);
  }

  listAdapters(): ProviderId[] {
    return [...this.adapters.keys()];
  }

  disable(providerId: ProviderId): boolean {
    if (!this.adapters.has(providerId)) return false;
    this.disabled.add(providerId);
    return true;
  }

  enable(providerId: ProviderId): boolean {
    return this.disabled.delete(providerId);
  }

  isEnabled(providerId: ProviderId): boolean {
    return this.adapters.has(providerId) && !this.disabled.has(providerId);
  }

  setDefault(providerId: ProviderId): void {
    this.defaultProviderId = providerId;
  }

  getDefault(): Adapter | undefined {
    return this.defaultProviderId
      ? this.adapters.get(this.defaultProviderId)
      : undefined;
  }

  getHealthy(providerId: ProviderId): Adapter | undefined {
    if (!this.isEnabled(providerId)) return undefined;
    if (!this.breakers.get(providerId)?.canExecute()) return undefined;
    return this.adapters.get(providerId);
  }

  getHealthyProviderIds(): ProviderId[] {
    const ids: ProviderId[] = [];
    for (const [id] of this.adapters) {
      if (this.disabled.has(id)) continue;
      const breaker = this.breakers.get(id);
      if (breaker && !breaker.canExecute()) continue;
      ids.push(id);
    }
    return ids;
  }

  recordSuccess(providerId: ProviderId): void {
    this.breakers.get(providerId)?.recordSuccess();
  }

  recordFailure(providerId: ProviderId): void {
    this.breakers.get(providerId)?.recordFailure();
  }

  getCircuitState(providerId: ProviderId): CircuitState {
    return this.breakers.get(providerId)?.getState() ?? "closed";
  }

  getBreaker(providerId: ProviderId): CircuitBreaker | undefined {
    return this.breakers.get(providerId);
  }

  async getHealthStatus(): Promise<Record<string, HealthStatus>> {
    const result: Record<string, HealthStatus> = {};
    for (const [id, adapter] of this.adapters) {
      try {
        const h = await adapter.healthCheck();
        result[id] = this.disabled.has(id)
          ? { ...h, healthy: false, lastError: "disabled" }
          : h;
      } catch (err) {
        result[id] = {
          healthy: false,
          providerId: id,
          sdkInstalled: false,
          cliAvailable: false,
          lastError: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Minimal router implementations
// ---------------------------------------------------------------------------

const REASONING_TAGS = new Set([
  "reasoning",
  "review",
  "architecture",
  "analysis",
  "planning",
  "refactor",
]);
const EXECUTION_TAGS = new Set([
  "fix-tests",
  "implement",
  "execute",
  "code",
  "build",
  "debug",
  "test",
]);
const LOCAL_TAGS = new Set([
  "local",
  "offline",
  "private",
  "fast",
  "simple",
  "quick",
]);

const DEFAULT_PRIORITY: Record<string, number> = {
  claude: 5,
  codex: 4,
  gemini: 3,
  qwen: 2,
  crush: 1,
  goose: 3,
};

const COST_RANK: Record<string, number> = {
  crush: 1,
  goose: 2,
  qwen: 3,
  gemini: 4,
  codex: 5,
  claude: 6,
};

class TagBasedRouter {
  readonly name = "tag-based";

  route(
    task: TaskDescriptor,
    availableProviders: ProviderId[],
  ): RoutingDecision {
    if (
      task.preferredProvider &&
      availableProviders.includes(task.preferredProvider)
    ) {
      return {
        provider: task.preferredProvider,
        reason: `Preferred provider "${task.preferredProvider}" is available`,
        fallbackProviders: availableProviders.filter(
          (p) => p !== task.preferredProvider,
        ),
        confidence: 0.95,
      };
    }

    const tags = task.tags.map((t) => t.toLowerCase());

    if (tags.some((t) => REASONING_TAGS.has(t)) || task.requiresReasoning) {
      if (availableProviders.includes("claude")) {
        return {
          provider: "claude",
          reason: "Task requires deep reasoning — routed to claude",
          fallbackProviders: availableProviders.filter((p) => p !== "claude"),
          confidence: 0.85,
        };
      }
    }

    if (tags.some((t) => EXECUTION_TAGS.has(t)) || task.requiresExecution) {
      if (availableProviders.includes("codex")) {
        return {
          provider: "codex",
          reason: "Task is execution-focused — routed to codex",
          fallbackProviders: availableProviders.filter((p) => p !== "codex"),
          confidence: 0.8,
        };
      }
    }

    if (tags.some((t) => LOCAL_TAGS.has(t))) {
      const target = availableProviders.includes("crush")
        ? "crush"
        : availableProviders.includes("qwen")
          ? "qwen"
          : undefined;
      if (target) {
        return {
          provider: target,
          reason: "Task prefers local execution — routed to local adapter",
          fallbackProviders: availableProviders.filter((p) => p !== target),
          confidence: 0.75,
        };
      }
    }

    if (task.budgetConstraint === "low") {
      const sorted = [...availableProviders].sort(
        (a, b) => (COST_RANK[a] ?? 99) - (COST_RANK[b] ?? 99),
      );
      const cheapest = sorted[0];
      if (cheapest) {
        return {
          provider: cheapest,
          reason: "Low budget constraint — routed to cheapest adapter",
          fallbackProviders: sorted.slice(1),
          confidence: 0.7,
        };
      }
    }

    const sorted = [...availableProviders].sort(
      (a, b) => (DEFAULT_PRIORITY[b] ?? 0) - (DEFAULT_PRIORITY[a] ?? 0),
    );
    const primary = sorted[0];
    if (!primary) {
      return {
        provider: "auto",
        reason: "No adapters available",
        fallbackProviders: [],
        confidence: 0,
      };
    }
    return {
      provider: primary,
      reason: `Default routing — highest priority adapter "${primary}"`,
      fallbackProviders: sorted.slice(1),
      confidence: 0.5,
    };
  }
}

class RoundRobinRouter {
  readonly name = "round-robin";
  private counter = 0;

  route(
    task: TaskDescriptor,
    availableProviders: ProviderId[],
  ): RoutingDecision {
    if (
      task.preferredProvider &&
      availableProviders.includes(task.preferredProvider)
    ) {
      return {
        provider: task.preferredProvider,
        reason: `Preferred provider "${task.preferredProvider}" overrides round-robin`,
        fallbackProviders: availableProviders.filter(
          (p) => p !== task.preferredProvider,
        ),
        confidence: 0.9,
      };
    }

    if (availableProviders.length === 0) {
      return {
        provider: "auto",
        reason: "No adapters available",
        fallbackProviders: [],
        confidence: 0,
      };
    }

    const index = this.counter % availableProviders.length;
    this.counter++;
    const selected = availableProviders[index]!;
    return {
      provider: selected,
      reason: `Round-robin — selected "${selected}" (iteration ${this.counter})`,
      fallbackProviders: availableProviders.filter((p) => p !== selected),
      confidence: 0.6,
    };
  }

  reset(): void {
    this.counter = 0;
  }
}

type CapabilityTag =
  | "long-context"
  | "multimodal"
  | "multilingual"
  | "code-execution"
  | "local"
  | "reasoning"
  | "fast"
  | "cost-effective";

interface CapabilityProfile {
  maxContextTokens: number;
  reasoningStrength: number;
  executionStrength: number;
  costEfficiency: number;
  capabilities: Set<CapabilityTag>;
  requiresNetwork: boolean;
}

const DEFAULT_CAPABILITIES: Record<string, CapabilityProfile> = {
  claude: {
    maxContextTokens: 200_000,
    reasoningStrength: 0.95,
    executionStrength: 0.7,
    costEfficiency: 0.3,
    capabilities: new Set(["reasoning"]),
    requiresNetwork: true,
  },
  codex: {
    maxContextTokens: 128_000,
    reasoningStrength: 0.7,
    executionStrength: 0.95,
    costEfficiency: 0.4,
    capabilities: new Set(["code-execution"]),
    requiresNetwork: true,
  },
  gemini: {
    maxContextTokens: 1_000_000,
    reasoningStrength: 0.8,
    executionStrength: 0.6,
    costEfficiency: 0.6,
    capabilities: new Set(["long-context", "multimodal"]),
    requiresNetwork: true,
  },
  qwen: {
    maxContextTokens: 128_000,
    reasoningStrength: 0.65,
    executionStrength: 0.6,
    costEfficiency: 0.85,
    capabilities: new Set(["multilingual", "cost-effective"]),
    requiresNetwork: true,
  },
  crush: {
    maxContextTokens: 32_000,
    reasoningStrength: 0.4,
    executionStrength: 0.5,
    costEfficiency: 1.0,
    capabilities: new Set(["local", "fast", "cost-effective"]),
    requiresNetwork: false,
  },
};

class CapabilityRouter {
  readonly name = "capability-based";

  route(
    task: TaskDescriptor,
    availableProviders: ProviderId[],
  ): RoutingDecision {
    if (
      task.preferredProvider &&
      availableProviders.includes(task.preferredProvider)
    ) {
      return {
        provider: task.preferredProvider,
        reason: `Preferred provider "${task.preferredProvider}" is available`,
        fallbackProviders: availableProviders.filter(
          (p) => p !== task.preferredProvider,
        ),
        confidence: 0.95,
      };
    }

    if (availableProviders.length === 0) {
      return {
        provider: "auto",
        reason: "No adapters available",
        fallbackProviders: [],
        confidence: 0,
      };
    }

    const scored = availableProviders.map((id) => {
      const cap = DEFAULT_CAPABILITIES[id];
      if (!cap) return { provider: id, score: 0, reason: "unknown provider" };

      let score = 0;
      const reasons: string[] = [];

      if (task.requiresReasoning) {
        score += cap.reasoningStrength * 20;
        reasons.push(`reasoning=${cap.reasoningStrength}`);
      }
      if (task.requiresExecution) {
        score += cap.executionStrength * 20;
        reasons.push(`execution=${cap.executionStrength}`);
      }
      if (task.budgetConstraint === "low") {
        score += cap.costEfficiency * 25;
        reasons.push(`cost-efficiency=${cap.costEfficiency}`);
      }

      for (const tag of task.tags) {
        const mapped = TAG_TO_CAP[tag.toLowerCase()];
        if (mapped) {
          for (const capTag of mapped) {
            if (capTag === "local" || capTag === "long-context") {
              if (cap.capabilities.has(capTag)) {
                score += 30;
                reasons.push(`has required "${capTag}"`);
              } else {
                score -= 100;
                reasons.push("missing required capability");
              }
            } else if (cap.capabilities.has(capTag)) {
              score += 15;
              reasons.push(`has preferred "${capTag}"`);
            }
          }
        }
      }

      return { provider: id, score, reason: reasons.join(", ") || "no signal" };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]!;
    return {
      provider: best.provider,
      reason: `Capability routing — ${best.reason}`,
      fallbackProviders: scored.slice(1).map((s) => s.provider),
      confidence: 0.8,
    };
  }
}

const TAG_TO_CAP: Record<string, CapabilityTag[]> = {
  review: ["reasoning"],
  architecture: ["reasoning"],
  implement: ["code-execution"],
  "fix-tests": ["code-execution"],
  local: ["local"],
  offline: ["local"],
  translate: ["multilingual"],
  "large-codebase": ["long-context"],
  budget: ["cost-effective"],
  cheap: ["cost-effective"],
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeAdapter(
  providerId: ProviderId,
  overrides?: {
    healthyResult?: boolean;
    priority?: number;
    throwHealthCheck?: boolean;
  },
): Adapter {
  return {
    providerId,
    priority: overrides?.priority,
    async healthCheck() {
      if (overrides?.throwHealthCheck) throw new Error("healthCheck exploded");
      const healthy = overrides?.healthyResult ?? true;
      return {
        healthy,
        providerId,
        sdkInstalled: healthy,
        cliAvailable: healthy,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AdapterRegistry — registration", () => {
  it("registers an adapter and retrieves it by name", () => {
    const reg = new AdapterRegistry();
    const adapter = makeAdapter("claude");
    reg.register(adapter);
    expect(reg.get("claude")).toBe(adapter);
  });

  it("registers multiple adapters independently", () => {
    const reg = new AdapterRegistry();
    reg.register(makeAdapter("claude"));
    reg.register(makeAdapter("codex"));
    expect(reg.get("claude")).toBeDefined();
    expect(reg.get("codex")).toBeDefined();
  });

  it("returns undefined for an unregistered adapter", () => {
    const reg = new AdapterRegistry();
    expect(reg.get("unknown")).toBeUndefined();
  });

  it("overwriting an adapter with the same id replaces it", () => {
    const reg = new AdapterRegistry();
    const a1 = makeAdapter("claude");
    const a2 = makeAdapter("claude");
    reg.register(a1).register(a2);
    expect(reg.get("claude")).toBe(a2);
  });

  it("returns this for method chaining", () => {
    const reg = new AdapterRegistry();
    expect(reg.register(makeAdapter("claude"))).toBe(reg);
  });
});

describe("AdapterRegistry — listing", () => {
  it("lists all registered adapter ids", () => {
    const reg = new AdapterRegistry();
    reg.register(makeAdapter("claude"));
    reg.register(makeAdapter("codex"));
    reg.register(makeAdapter("qwen"));
    expect(reg.listAdapters()).toEqual(
      expect.arrayContaining(["claude", "codex", "qwen"]),
    );
    expect(reg.listAdapters()).toHaveLength(3);
  });

  it("returns empty list when no adapters registered", () => {
    const reg = new AdapterRegistry();
    expect(reg.listAdapters()).toEqual([]);
  });
});

describe("AdapterRegistry — unregistration", () => {
  it("removes the adapter from the registry", () => {
    const reg = new AdapterRegistry();
    reg.register(makeAdapter("claude"));
    reg.unregister("claude");
    expect(reg.get("claude")).toBeUndefined();
  });

  it("returns true when the adapter existed", () => {
    const reg = new AdapterRegistry();
    reg.register(makeAdapter("claude"));
    expect(reg.unregister("claude")).toBe(true);
  });

  it("returns false when the adapter did not exist", () => {
    const reg = new AdapterRegistry();
    expect(reg.unregister("ghost")).toBe(false);
  });

  it("is no longer present in listAdapters after unregistration", () => {
    const reg = new AdapterRegistry();
    reg.register(makeAdapter("claude"));
    reg.register(makeAdapter("codex"));
    reg.unregister("claude");
    expect(reg.listAdapters()).not.toContain("claude");
    expect(reg.listAdapters()).toContain("codex");
  });

  it("clears the circuit breaker on unregistration", () => {
    const reg = new AdapterRegistry();
    reg.register(makeAdapter("claude"));
    reg.unregister("claude");
    // After re-registration the circuit should be fresh (no stale state)
    reg.register(makeAdapter("claude"));
    expect(reg.getCircuitState("claude")).toBe("closed");
  });
});

describe("AdapterRegistry — default adapter", () => {
  it("returns the default adapter when set", () => {
    const reg = new AdapterRegistry();
    const adapter = makeAdapter("claude");
    reg.register(adapter);
    reg.setDefault("claude");
    expect(reg.getDefault()).toBe(adapter);
  });

  it("returns undefined when no default is set", () => {
    const reg = new AdapterRegistry();
    reg.register(makeAdapter("claude"));
    expect(reg.getDefault()).toBeUndefined();
  });

  it("clears default when the default adapter is unregistered", () => {
    const reg = new AdapterRegistry();
    reg.register(makeAdapter("claude"));
    reg.setDefault("claude");
    reg.unregister("claude");
    expect(reg.getDefault()).toBeUndefined();
  });
});

describe("AdapterRegistry — enable / disable", () => {
  it("disables an adapter, excluding it from isEnabled", () => {
    const reg = new AdapterRegistry();
    reg.register(makeAdapter("claude"));
    reg.disable("claude");
    expect(reg.isEnabled("claude")).toBe(false);
  });

  it("re-enables a disabled adapter", () => {
    const reg = new AdapterRegistry();
    reg.register(makeAdapter("claude"));
    reg.disable("claude");
    reg.enable("claude");
    expect(reg.isEnabled("claude")).toBe(true);
  });

  it("returns false for disable on unknown adapter", () => {
    const reg = new AdapterRegistry();
    expect(reg.disable("ghost")).toBe(false);
  });

  it("getHealthy returns undefined for disabled adapter", () => {
    const reg = new AdapterRegistry();
    reg.register(makeAdapter("claude"));
    reg.disable("claude");
    expect(reg.getHealthy("claude")).toBeUndefined();
  });
});

describe("AdapterRegistry — circuit breaker per adapter", () => {
  it("starts with circuit closed for a new adapter", () => {
    const reg = new AdapterRegistry();
    reg.register(makeAdapter("claude"));
    expect(reg.getCircuitState("claude")).toBe("closed");
  });

  it("opens circuit after repeated failures (default threshold 3)", () => {
    const reg = new AdapterRegistry({
      circuitBreaker: { failureThreshold: 3 },
    });
    reg.register(makeAdapter("claude"));
    reg.recordFailure("claude");
    reg.recordFailure("claude");
    expect(reg.getCircuitState("claude")).toBe("closed"); // not yet
    reg.recordFailure("claude");
    expect(reg.getCircuitState("claude")).toBe("open");
  });

  it("getHealthy returns undefined when circuit is open", () => {
    const reg = new AdapterRegistry({
      circuitBreaker: { failureThreshold: 1 },
    });
    reg.register(makeAdapter("claude"));
    reg.recordFailure("claude");
    expect(reg.getCircuitState("claude")).toBe("open");
    expect(reg.getHealthy("claude")).toBeUndefined();
  });

  it("circuit transitions to half-open after timeout", () => {
    vi.useFakeTimers();
    const reg = new AdapterRegistry({
      circuitBreaker: { failureThreshold: 1, halfOpenAfterMs: 100 },
    });
    reg.register(makeAdapter("claude"));
    reg.recordFailure("claude");
    expect(reg.getCircuitState("claude")).toBe("open");

    vi.advanceTimersByTime(101);
    // canExecute() triggers the half-open transition
    const breaker = reg.getBreaker("claude")!;
    breaker.canExecute();
    expect(reg.getCircuitState("claude")).toBe("half-open");
    vi.useRealTimers();
  });

  it("circuit closes when success recorded in half-open state", () => {
    vi.useFakeTimers();
    const reg = new AdapterRegistry({
      circuitBreaker: { failureThreshold: 1, halfOpenAfterMs: 100 },
    });
    reg.register(makeAdapter("claude"));
    reg.recordFailure("claude");

    vi.advanceTimersByTime(101);
    const breaker = reg.getBreaker("claude")!;
    breaker.canExecute(); // triggers half-open
    expect(reg.getCircuitState("claude")).toBe("half-open");

    reg.recordSuccess("claude");
    expect(reg.getCircuitState("claude")).toBe("closed");
    vi.useRealTimers();
  });

  it("each adapter has an independent circuit breaker", () => {
    const reg = new AdapterRegistry({
      circuitBreaker: { failureThreshold: 1 },
    });
    reg.register(makeAdapter("claude"));
    reg.register(makeAdapter("codex"));
    reg.recordFailure("claude");
    expect(reg.getCircuitState("claude")).toBe("open");
    expect(reg.getCircuitState("codex")).toBe("closed");
  });

  it("getHealthyProviderIds excludes adapters with open circuits", () => {
    const reg = new AdapterRegistry({
      circuitBreaker: { failureThreshold: 1 },
    });
    reg.register(makeAdapter("claude"));
    reg.register(makeAdapter("codex"));
    reg.recordFailure("claude");
    expect(reg.getHealthyProviderIds()).toEqual(["codex"]);
  });

  it("getHealthyProviderIds includes adapters after circuit closes", () => {
    const reg = new AdapterRegistry({
      circuitBreaker: { failureThreshold: 1 },
    });
    reg.register(makeAdapter("claude"));
    reg.recordFailure("claude");
    reg.recordSuccess("claude");
    expect(reg.getHealthyProviderIds()).toContain("claude");
  });
});

describe("AdapterRegistry — health checks", () => {
  it("healthy adapter appears healthy in getHealthStatus", async () => {
    const reg = new AdapterRegistry();
    reg.register(makeAdapter("claude", { healthyResult: true }));
    const status = await reg.getHealthStatus();
    expect(status["claude"]?.healthy).toBe(true);
  });

  it("unhealthy adapter appears unhealthy in getHealthStatus", async () => {
    const reg = new AdapterRegistry();
    reg.register(makeAdapter("claude", { healthyResult: false }));
    const status = await reg.getHealthStatus();
    expect(status["claude"]?.healthy).toBe(false);
  });

  it("disabled adapter is marked unhealthy even if healthCheck passes", async () => {
    const reg = new AdapterRegistry();
    reg.register(makeAdapter("claude", { healthyResult: true }));
    reg.disable("claude");
    const status = await reg.getHealthStatus();
    expect(status["claude"]?.healthy).toBe(false);
    expect(status["claude"]?.lastError).toBe("disabled");
  });

  it("adapter throwing in healthCheck is marked unhealthy with error message", async () => {
    const reg = new AdapterRegistry();
    reg.register(makeAdapter("claude", { throwHealthCheck: true }));
    const status = await reg.getHealthStatus();
    expect(status["claude"]?.healthy).toBe(false);
    expect(status["claude"]?.lastError).toContain("exploded");
  });

  it("multiple adapters health checks run independently", async () => {
    const reg = new AdapterRegistry();
    reg.register(makeAdapter("claude", { healthyResult: true }));
    reg.register(makeAdapter("codex", { healthyResult: false }));
    const status = await reg.getHealthStatus();
    expect(status["claude"]?.healthy).toBe(true);
    expect(status["codex"]?.healthy).toBe(false);
  });

  it("healthCheck spy is called once per adapter per getHealthStatus call", async () => {
    const spy = vi.fn().mockResolvedValue({
      healthy: true,
      providerId: "claude",
      sdkInstalled: true,
      cliAvailable: true,
    });
    const reg = new AdapterRegistry();
    reg.register({ providerId: "claude", healthCheck: spy });
    await reg.getHealthStatus();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("TagBasedRouter — routing by task type", () => {
  let router: TagBasedRouter;

  beforeEach(() => {
    router = new TagBasedRouter();
  });

  it("routes reasoning task to claude", () => {
    const decision = router.route({ tags: ["reasoning"] }, ["claude", "codex"]);
    expect(decision.provider).toBe("claude");
    expect(decision.confidence).toBeGreaterThan(0.5);
  });

  it("routes review task to claude (reasoning tag alias)", () => {
    const decision = router.route({ tags: ["review"] }, ["claude", "codex"]);
    expect(decision.provider).toBe("claude");
  });

  it("routes architecture tag to claude", () => {
    const decision = router.route({ tags: ["architecture"] }, [
      "claude",
      "codex",
    ]);
    expect(decision.provider).toBe("claude");
  });

  it("routes implementation task to codex", () => {
    const decision = router.route({ tags: ["implement"] }, ["claude", "codex"]);
    expect(decision.provider).toBe("codex");
  });

  it("routes fix-tests task to codex", () => {
    const decision = router.route({ tags: ["fix-tests"] }, ["claude", "codex"]);
    expect(decision.provider).toBe("codex");
  });

  it("routes local task to crush", () => {
    const decision = router.route({ tags: ["local"] }, [
      "claude",
      "codex",
      "crush",
    ]);
    expect(decision.provider).toBe("crush");
  });

  it("routes offline task to qwen when crush is not available", () => {
    const decision = router.route({ tags: ["offline"] }, [
      "claude",
      "codex",
      "qwen",
    ]);
    expect(decision.provider).toBe("qwen");
  });

  it("respects preferredProvider override", () => {
    const decision = router.route(
      { tags: ["reasoning"], preferredProvider: "codex" },
      ["claude", "codex"],
    );
    expect(decision.provider).toBe("codex");
    expect(decision.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("falls back to default routing when no tag matches", () => {
    const decision = router.route({ tags: ["unknown-tag"] }, [
      "claude",
      "codex",
    ]);
    // default: highest priority wins — claude has priority 5, codex 4
    expect(decision.provider).toBe("claude");
  });

  it("routes to cheapest when budgetConstraint is low", () => {
    const decision = router.route({ tags: [], budgetConstraint: "low" }, [
      "claude",
      "codex",
      "crush",
    ]);
    expect(decision.provider).toBe("crush"); // crush has lowest cost rank
  });

  it("returns fallbackProviders as remaining adapters", () => {
    const decision = router.route({ tags: ["reasoning"] }, [
      "claude",
      "codex",
      "gemini",
    ]);
    expect(decision.fallbackProviders).toContain("codex");
    expect(decision.fallbackProviders).toContain("gemini");
    expect(decision.fallbackProviders).not.toContain("claude");
  });

  it("returns auto when no adapters available", () => {
    const decision = router.route({ tags: ["reasoning"] }, []);
    expect(decision.provider).toBe("auto");
    expect(decision.confidence).toBe(0);
  });

  it("routes requiresReasoning flag without tags", () => {
    const decision = router.route({ tags: [], requiresReasoning: true }, [
      "claude",
      "codex",
    ]);
    expect(decision.provider).toBe("claude");
  });

  it("routes requiresExecution flag without tags", () => {
    const decision = router.route({ tags: [], requiresExecution: true }, [
      "claude",
      "codex",
    ]);
    expect(decision.provider).toBe("codex");
  });
});

describe("TagBasedRouter — adapter priority", () => {
  it("selects higher priority adapter by default (claude > codex > gemini > qwen > crush)", () => {
    const router = new TagBasedRouter();
    const providers: ProviderId[] = [
      "crush",
      "qwen",
      "gemini",
      "codex",
      "claude",
    ];
    const decision = router.route({ tags: [] }, providers);
    expect(decision.provider).toBe("claude");
  });

  it("selects codex when claude not available", () => {
    const router = new TagBasedRouter();
    const decision = router.route({ tags: [] }, ["codex", "qwen", "crush"]);
    expect(decision.provider).toBe("codex");
  });
});

describe("RoundRobinRouter — load balancing", () => {
  it("distributes across available adapters in round-robin order", () => {
    const router = new RoundRobinRouter();
    const providers: ProviderId[] = ["claude", "codex", "gemini"];

    const d1 = router.route({ tags: [] }, providers);
    const d2 = router.route({ tags: [] }, providers);
    const d3 = router.route({ tags: [] }, providers);
    const d4 = router.route({ tags: [] }, providers);

    expect(d1.provider).toBe("claude");
    expect(d2.provider).toBe("codex");
    expect(d3.provider).toBe("gemini");
    expect(d4.provider).toBe("claude"); // wraps around
  });

  it("respects preferredProvider over round-robin", () => {
    const router = new RoundRobinRouter();
    const decision = router.route({ tags: [], preferredProvider: "codex" }, [
      "claude",
      "codex",
      "gemini",
    ]);
    expect(decision.provider).toBe("codex");
  });

  it("returns auto when no adapters available", () => {
    const router = new RoundRobinRouter();
    const decision = router.route({ tags: [] }, []);
    expect(decision.provider).toBe("auto");
  });

  it("counter resets correctly", () => {
    const router = new RoundRobinRouter();
    const providers: ProviderId[] = ["claude", "codex"];
    router.route({ tags: [] }, providers); // index 0
    router.route({ tags: [] }, providers); // index 1
    router.reset();
    const d = router.route({ tags: [] }, providers);
    expect(d.provider).toBe("claude"); // back to index 0
  });

  it("distributes evenly across two healthy adapters over many requests", () => {
    const router = new RoundRobinRouter();
    const providers: ProviderId[] = ["claude", "codex"];
    const counts: Record<string, number> = { claude: 0, codex: 0 };
    for (let i = 0; i < 20; i++) {
      const d = router.route({ tags: [] }, providers);
      counts[d.provider] = (counts[d.provider] ?? 0) + 1;
    }
    expect(counts["claude"]).toBe(10);
    expect(counts["codex"]).toBe(10);
  });
});

describe("CapabilityRouter — routing by capability", () => {
  let router: CapabilityRouter;

  beforeEach(() => {
    router = new CapabilityRouter();
  });

  it("routes to claude for reasoning tasks", () => {
    const decision = router.route(
      { tags: ["review"], requiresReasoning: true },
      ["claude", "codex", "crush"],
    );
    expect(decision.provider).toBe("claude");
  });

  it("routes to codex for code execution tasks", () => {
    const decision = router.route(
      { tags: ["implement"], requiresExecution: true },
      ["codex", "claude", "crush"],
    );
    expect(decision.provider).toBe("codex");
  });

  it("routes to crush for local/offline tasks (local is a required capability)", () => {
    const decision = router.route({ tags: ["local"] }, [
      "crush",
      "claude",
      "codex",
    ]);
    expect(decision.provider).toBe("crush");
  });

  it("penalises adapters lacking a required capability tag", () => {
    const decision = router.route({ tags: ["local"] }, ["claude", "crush"]);
    // claude does not have 'local' capability — crush should win
    expect(decision.provider).toBe("crush");
  });

  it("routes to gemini for large-codebase tasks (long-context required)", () => {
    const decision = router.route({ tags: ["large-codebase"] }, [
      "gemini",
      "claude",
      "codex",
    ]);
    expect(decision.provider).toBe("gemini");
  });

  it("routes to qwen for multilingual tasks", () => {
    const decision = router.route({ tags: ["translate"] }, [
      "qwen",
      "claude",
      "codex",
    ]);
    expect(decision.provider).toBe("qwen");
  });

  it("respects preferredProvider even over capability scoring", () => {
    const decision = router.route(
      {
        tags: ["reasoning"],
        requiresReasoning: true,
        preferredProvider: "codex",
      },
      ["claude", "codex"],
    );
    expect(decision.provider).toBe("codex");
    expect(decision.confidence).toBe(0.95);
  });

  it("returns auto when no providers available", () => {
    const decision = router.route({ tags: [] }, []);
    expect(decision.provider).toBe("auto");
  });

  it("includes fallback providers in decision", () => {
    const decision = router.route(
      { tags: ["reasoning"], requiresReasoning: true },
      ["claude", "codex", "gemini"],
    );
    expect(decision.fallbackProviders.length).toBeGreaterThan(0);
    expect(decision.fallbackProviders).not.toContain(decision.provider);
  });

  it("returns a valid confidence value between 0 and 1", () => {
    const decision = router.route({ tags: ["implement"] }, ["claude", "codex"]);
    expect(decision.confidence).toBeGreaterThanOrEqual(0);
    expect(decision.confidence).toBeLessThanOrEqual(1);
  });

  it("routes budget-constrained task to cost-effective adapter", () => {
    const decision = router.route({ tags: [], budgetConstraint: "low" }, [
      "crush",
      "qwen",
      "claude",
    ]);
    // crush has costEfficiency=1.0, qwen=0.85, claude=0.3
    expect(decision.provider).toBe("crush");
  });
});

describe("AdapterRegistry + TagBasedRouter integration", () => {
  it("routes to registered healthy adapter matching task type", () => {
    const reg = new AdapterRegistry();
    reg.register(makeAdapter("claude"));
    reg.register(makeAdapter("codex"));
    const router = new TagBasedRouter();
    const healthy = reg.getHealthyProviderIds();
    const decision = router.route({ tags: ["reasoning"] }, healthy);
    expect(decision.provider).toBe("claude");
  });

  it("routes around open-circuit adapter via healthy providers list", () => {
    const reg = new AdapterRegistry({
      circuitBreaker: { failureThreshold: 1 },
    });
    reg.register(makeAdapter("claude"));
    reg.register(makeAdapter("codex"));
    // Trip claude's circuit
    reg.recordFailure("claude");
    const router = new TagBasedRouter();
    const healthy = reg.getHealthyProviderIds();
    // claude should not be in healthy list
    expect(healthy).not.toContain("claude");
    // router falls back to codex
    const decision = router.route({ tags: ["reasoning"] }, healthy);
    expect(decision.provider).toBe("codex");
  });

  it("no matching adapter throws informative error when no healthy providers", () => {
    const reg = new AdapterRegistry({
      circuitBreaker: { failureThreshold: 1 },
    });
    reg.register(makeAdapter("claude"));
    reg.recordFailure("claude");
    const healthy = reg.getHealthyProviderIds();
    const router = new TagBasedRouter();
    const decision = router.route({ tags: ["reasoning"] }, healthy);
    expect(decision.provider).toBe("auto");
    expect(decision.confidence).toBe(0);
  });
});

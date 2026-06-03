import { describe, it, expect } from "vitest";
import { RuleBasedRouting } from "../routing/rule-based-routing.js";
import { HashRouting } from "../routing/hash-routing.js";
import { RoundRobinRouting } from "../routing/round-robin-routing.js";
import { LLMRouting } from "../routing/llm-routing.js";
import type { AgentSpec, AgentTask } from "../routing-policy-types.js";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const agents: AgentSpec[] = [
  { id: "db-agent", name: "DB Agent", tags: ["database", "sql"] },
  { id: "api-agent", name: "API Agent", tags: ["api", "rest"] },
  { id: "ui-agent", name: "UI Agent", tags: ["ui", "frontend"] },
];

function task(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    taskId: "task-1",
    content: "Do something",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RuleBasedRouting
// ---------------------------------------------------------------------------

describe("RuleBasedRouting", () => {
  it("selects correct agent by tag match", () => {
    const routing = new RuleBasedRouting({
      rules: [
        { tag: "database", agentId: "db-agent" },
        { tag: "api", agentId: "api-agent" },
      ],
    });
    const decision = routing.select(task({ tags: ["database"] }), agents);
    expect(decision.selected).toHaveLength(1);
    expect(decision.selected[0]!.id).toBe("db-agent");
    expect(decision.strategy).toBe("rule");
  });

  it("uses fallback when no tag matches", () => {
    const routing = new RuleBasedRouting({
      rules: [{ tag: "database", agentId: "db-agent" }],
      fallbackAgentId: "api-agent",
    });
    const decision = routing.select(task({ tags: ["unknown"] }), agents);
    expect(decision.selected).toHaveLength(1);
    expect(decision.selected[0]!.id).toBe("api-agent");
    expect(decision.reason).toContain("Fallback");
  });

  it("falls back to first candidate when no match and no fallback configured", () => {
    const routing = new RuleBasedRouting({
      rules: [{ tag: "nonexistent", agentId: "nonexistent-agent" }],
    });
    const decision = routing.select(task({ tags: ["other"] }), agents);
    expect(decision.selected).toHaveLength(1);
    expect(decision.selected[0]!.id).toBe("db-agent");
    expect(decision.reason).toContain("first candidate");
  });
});

// ---------------------------------------------------------------------------
// HashRouting
// ---------------------------------------------------------------------------

describe("HashRouting", () => {
  it("same taskId always returns the same agent (deterministic)", () => {
    const routing = new HashRouting();
    const t = task({ taskId: "stable-id-123" });
    const first = routing.select(t, agents);
    const second = routing.select(t, agents);
    const third = routing.select(t, agents);
    expect(first.selected[0]!.id).toBe(second.selected[0]!.id);
    expect(second.selected[0]!.id).toBe(third.selected[0]!.id);
    expect(first.strategy).toBe("hash");
  });

  it("different taskIds distribute across agents", () => {
    const routing = new HashRouting();
    const results = new Set<string>();
    // Generate many different task IDs to see distribution
    for (let i = 0; i < 100; i++) {
      const t = task({ taskId: `task-${i}` });
      const decision = routing.select(t, agents);
      results.add(decision.selected[0]!.id);
    }
    // With 3 agents and 100 different IDs, we expect at least 2 different agents
    expect(results.size).toBeGreaterThanOrEqual(2);
  });

  it("returns empty selection when no candidates", () => {
    const routing = new HashRouting();
    const decision = routing.select(task(), []);
    expect(decision.selected).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// RoundRobinRouting
// ---------------------------------------------------------------------------

describe("RoundRobinRouting", () => {
  it("cycles through agents in order", () => {
    const routing = new RoundRobinRouting();
    const ids = [];
    for (let i = 0; i < 6; i++) {
      const decision = routing.select(task({ taskId: `t-${i}` }), agents);
      ids.push(decision.selected[0]!.id);
    }
    expect(ids).toEqual([
      "db-agent",
      "api-agent",
      "ui-agent",
      "db-agent",
      "api-agent",
      "ui-agent",
    ]);
  });

  it("reset() starts over", () => {
    const routing = new RoundRobinRouting();
    routing.select(task(), agents); // counter = 1
    routing.select(task(), agents); // counter = 2
    routing.reset();
    const decision = routing.select(task(), agents); // counter = 0
    expect(decision.selected[0]!.id).toBe("db-agent");
  });

  it("returns empty selection when no candidates", () => {
    const routing = new RoundRobinRouting();
    const decision = routing.select(task(), []);
    expect(decision.selected).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LLMRouting
// ---------------------------------------------------------------------------

describe("LLMRouting", () => {
  it("requires explicit fallback semantics", () => {
    expect(() => new LLMRouting(undefined as never)).toThrow(
      "LLMRouting requires explicit fallback semantics"
    );
  });

  it("select() returns all candidates only when pass-through fallback is explicit", () => {
    const routing = new LLMRouting({ fallback: "pass-through" });
    const decision = routing.select(task(), agents);
    expect(decision.selected).toHaveLength(3);
    expect(decision.selected.map((a) => a.id)).toEqual([
      "db-agent",
      "api-agent",
      "ui-agent",
    ]);
    expect(decision.strategy).toBe("llm");
    expect(decision.fallbackReason).toContain(
      "explicit 'pass-through' fallback"
    );
    expect(decision.diagnostics).toEqual({
      candidateIds: ["db-agent", "api-agent", "ui-agent"],
      selectedIds: ["db-agent", "api-agent", "ui-agent"],
      fallbackReason: expect.stringContaining(
        "explicit 'pass-through' fallback"
      ),
    });
  });

  it("select() returns LLM-selected candidates from a configured selector", () => {
    const routing = new LLMRouting({
      fallback: "first-candidate",
      selector: () => "api-agent",
    });
    const decision = routing.select(task(), agents);
    expect(decision.selected).toHaveLength(1);
    expect(decision.selected[0]!.id).toBe("api-agent");
    expect(decision.reason).toBe("LLM selected candidate(s): api-agent");
    expect(decision.fallbackReason).toBeUndefined();
    expect(decision.diagnostics).toEqual({
      candidateIds: ["db-agent", "api-agent", "ui-agent"],
      selectedIds: ["api-agent"],
      rejectionReasons: {
        "db-agent": "llm selected api-agent",
        "ui-agent": "llm selected api-agent",
      },
    });
  });

  it("select() uses deterministic fallback when selector returns no valid candidate", () => {
    const routing = new LLMRouting({
      fallback: "first-candidate",
      selector: () => "nonexistent",
    });
    const decision = routing.select(task(), agents);
    expect(decision.selected).toHaveLength(1);
    expect(decision.selected[0]!.id).toBe("db-agent");
    expect(decision.fallbackReason).toBe(
      "LLM routing fallback: selector returned no valid candidates"
    );
    expect(decision.diagnostics).toEqual({
      candidateIds: ["db-agent", "api-agent", "ui-agent"],
      selectedIds: ["db-agent"],
      fallbackReason:
        "LLM routing fallback: selector returned no valid candidates",
      rejectionReasons: {
        "api-agent":
          "llm fallback selected other candidate(s): LLM routing fallback: selector returned no valid candidates",
        "ui-agent":
          "llm fallback selected other candidate(s): LLM routing fallback: selector returned no valid candidates",
      },
    });
  });

  it("createDecision() with valid agentId returns that agent", () => {
    const routing = new LLMRouting({ fallback: "first-candidate" });
    const decision = routing.createDecision(
      "api-agent",
      agents,
      "LLM chose api-agent"
    );
    expect(decision.selected).toHaveLength(1);
    expect(decision.selected[0]!.id).toBe("api-agent");
    expect(decision.reason).toBe("LLM chose api-agent");
    expect(decision.fallbackReason).toBeUndefined();
  });

  it("createDecision() with invalid agentId falls back to first candidate", () => {
    const routing = new LLMRouting({ fallback: "first-candidate" });
    const decision = routing.createDecision("nonexistent", agents);
    expect(decision.selected).toHaveLength(1);
    expect(decision.selected[0]!.id).toBe("db-agent");
    expect(decision.fallbackReason).toBe(
      "LLM routing fallback: selected agent 'nonexistent' is not in the candidate set"
    );
  });
});

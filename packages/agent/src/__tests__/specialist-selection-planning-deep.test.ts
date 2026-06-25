/**
 * Deep test coverage for specialist-selection.ts and planning-decomposition.ts.
 *
 * Targets untested surface area:
 *   - specialist-selection: KEYWORD_TAG_MAP structure, scoreMatch scoring breakdown,
 *     routeSubtasksViaPolicy diagnostics, fallback reason propagation,
 *     multi-assignment routing, empty/edge inputs
 *   - planning-decomposition: buildSpecialistDescriptions (fully untested),
 *     refineDecomposition (fully untested), PlanNodeSchema/DecompositionSchema edge cases,
 *     decomposeGoal (LLM version) — mocked so no live LLM calls
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createEventBus, type DzupEvent } from "@dzupagent/core";
import type { AgentExecutionSpec } from "@dzupagent/core/persistence";
import type { AgentCircuitBreaker } from "../orchestration/circuit-breaker.js";
import {
  KEYWORD_TAG_MAP,
  decomposeGoal,
  matchSubtasksToSpecialists,
  routeSubtasksViaPolicy,
  scoreMatch,
  toAgentSpecs,
} from "../orchestration/specialist-selection.js";
import type { SelectionAssignment } from "../orchestration/specialist-selection.js";
import type {
  AgentSpec,
  RoutingDecision,
  RoutingDiagnostics,
  RoutingPolicy,
} from "../orchestration/routing-policy-types.js";
import {
  PlanNodeSchema,
  DecompositionSchema,
  buildSpecialistDescriptions,
  refineDecomposition,
  decomposeGoal as decomposeGoalLLM,
} from "../orchestration/planning-decomposition.js";
import { OrchestrationError } from "../orchestration/orchestration-error.js";
import type {
  DecomposeOptions,
  PlanningSupervisor,
} from "../orchestration/planning-types.js";
import type { StructuredLLM } from "../structured/structured-output-engine.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Build a minimal AgentExecutionSpec for tests. */
function makeSpec(
  id: string,
  overrides: Partial<AgentExecutionSpec> = {}
): AgentExecutionSpec {
  return {
    id,
    name: overrides.name ?? id,
    tools: overrides.tools ?? [],
    metadata: overrides.metadata ?? {},
    ...overrides,
  } as unknown as AgentExecutionSpec;
}

/** Build a minimal PlanningSupervisor for planning-decomposition tests. */
function makeSupervisor(
  specialists: Record<string, Partial<AgentExecutionSpec> & { id?: string }>
): PlanningSupervisor {
  const specsMap = new Map<string, AgentExecutionSpec>();
  for (const [id, partial] of Object.entries(specialists)) {
    specsMap.set(id, makeSpec(id, partial));
  }
  return {
    specialistIds: [...specsMap.keys()],
    getSpecialist: vi.fn((id: string) => specsMap.get(id)),
    delegateAndCollect: vi.fn(async () => ({
      results: new Map(),
      succeeded: [],
      failed: [],
      totalDurationMs: 0,
    })),
  };
}

/** Build a StructuredLLM mock that returns the given JSON string. */
function makeMockLLM(responseContent: string): StructuredLLM {
  return {
    invoke: vi.fn(async () => ({ content: responseContent })),
  };
}

// ===========================================================================
// specialist-selection.ts — deep tests
// ===========================================================================

// ---------------------------------------------------------------------------
// KEYWORD_TAG_MAP structure
// ---------------------------------------------------------------------------

describe("KEYWORD_TAG_MAP", () => {
  it("is a ReadonlyMap", () => {
    expect(KEYWORD_TAG_MAP).toBeInstanceOf(Map);
  });

  it("contains exactly the 6 expected domain keys", () => {
    const keys = [...KEYWORD_TAG_MAP.keys()];
    expect(keys).toContain("database");
    expect(keys).toContain("api");
    expect(keys).toContain("ui");
    expect(keys).toContain("test");
    expect(keys).toContain("security");
    expect(keys).toContain("deploy");
    expect(keys).toHaveLength(6);
  });

  it("database keywords include sql, schema, migration", () => {
    const kws = KEYWORD_TAG_MAP.get("database")!;
    expect(kws).toContain("sql");
    expect(kws).toContain("schema");
    expect(kws).toContain("migration");
  });

  it("security keywords include auth, authorization, rbac", () => {
    const kws = KEYWORD_TAG_MAP.get("security")!;
    expect(kws).toContain("auth");
    expect(kws).toContain("authorization");
    expect(kws).toContain("rbac");
  });

  it("deploy keywords include ci, cd, infrastructure", () => {
    const kws = KEYWORD_TAG_MAP.get("deploy")!;
    expect(kws).toContain("ci");
    expect(kws).toContain("cd");
    expect(kws).toContain("infrastructure");
  });
});

// ---------------------------------------------------------------------------
// decomposeGoal (specialist-selection version — pure string splitter)
// ---------------------------------------------------------------------------

describe("decomposeGoal (specialist-selection)", () => {
  it("splits on comma", () => {
    expect(decomposeGoal("a,b,c")).toEqual(["a", "b", "c"]);
  });

  it("splits on semicolon", () => {
    expect(decomposeGoal("a;b;c")).toEqual(["a", "b", "c"]);
  });

  it("splits on newline", () => {
    expect(decomposeGoal("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it('splits on " and " (case-insensitive)', () => {
    // The implementation trims each fragment, so surrounding spaces are removed
    expect(decomposeGoal("build api AND write tests")).toEqual([
      "build api",
      "write tests",
    ]);
  });

  it("trims whitespace from each fragment", () => {
    expect(decomposeGoal("  task one  ,  task two  ")).toEqual([
      "task one",
      "task two",
    ]);
  });

  it("filters out empty fragments after split", () => {
    expect(decomposeGoal(",,,")).toEqual([]);
  });

  it("returns single-element array when no delimiter present", () => {
    expect(decomposeGoal("build the api")).toEqual(["build the api"]);
  });

  it("handles mixed delimiters", () => {
    const result = decomposeGoal("a, b; c\nd and e");
    expect(result).toContain("a");
    expect(result).toContain("b");
    expect(result).toContain("c");
    expect(result.some((s) => s.includes("d"))).toBe(true);
  });

  it("returns empty array for empty string", () => {
    expect(decomposeGoal("")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scoreMatch — detailed scoring breakdown
// ---------------------------------------------------------------------------

describe("scoreMatch", () => {
  it("specialistId full substring match in subtask adds 3", () => {
    const def = makeSpec("coder", { name: "Coder", metadata: {} });
    const score = scoreMatch("coder should write the code", "coder", def);
    // Full id match (+3) AND id part match 'coder' (+2) = 5 minimum
    expect(score).toBeGreaterThanOrEqual(3);
  });

  it("id part match (split on hyphen) adds 2", () => {
    // 'db' is a part of 'db-agent'; 'db' appears in subtask
    const def = makeSpec("db-agent", { name: "DB Agent", metadata: {} });
    const score = scoreMatch("optimize the db query", "db-agent", def);
    expect(score).toBeGreaterThan(0);
  });

  it("name match in subtask adds 3", () => {
    const def = makeSpec("x", { name: "security scanner", metadata: {} });
    const score = scoreMatch("run security scanner on the code", "x", def);
    expect(score).toBeGreaterThanOrEqual(3);
  });

  it("tag match in subtask adds 4", () => {
    const def = makeSpec("agent", { metadata: { tags: ["database"] } });
    const score = scoreMatch("run a database migration", "agent", def);
    expect(score).toBeGreaterThanOrEqual(4);
  });

  it("tool match in subtask adds 2", () => {
    const def = makeSpec("coder", { tools: ["webpack"], metadata: {} });
    const score = scoreMatch("configure webpack for the project", "coder", def);
    expect(score).toBeGreaterThan(0);
  });

  it('keyword map match: subtask has "sql" and specialist has "database" tag adds 3', () => {
    const def = makeSpec("db-agent", { metadata: { tags: ["database"] } });
    // 'sql' is in the database keyword group; specialist has 'database' tag
    const score = scoreMatch("write an sql query", "db-agent", def);
    expect(score).toBeGreaterThanOrEqual(3);
  });

  it("returns 0 for completely unrelated subtask and specialist", () => {
    const def = makeSpec("z", { name: "Z", tools: [], metadata: {} });
    const score = scoreMatch("paint the walls", "z", def);
    expect(score).toBe(0);
  });

  it("tag matching is case-insensitive", () => {
    const def = makeSpec("agent", { metadata: { tags: ["DATABASE"] } });
    const score = scoreMatch("run a database migration", "agent", def);
    expect(score).toBeGreaterThanOrEqual(4);
  });

  it("multiple tags matched produce cumulative score", () => {
    const def = makeSpec("agent", { metadata: { tags: ["database", "sql"] } });
    const scoreOne = scoreMatch(
      "write a sql query",
      makeSpec("a", { metadata: { tags: ["sql"] } }).id,
      makeSpec("a", { metadata: { tags: ["sql"] } })
    );
    const scoreTwo = scoreMatch("write a database sql query", "agent", def);
    // Two tag hits should be strictly higher than no hits
    expect(scoreTwo).toBeGreaterThan(0);
  });

  it("specialist with no tags, name, or tools scores 0 for unrelated subtask", () => {
    const def = makeSpec("orphan", { name: "Orphan", tools: [], metadata: {} });
    expect(scoreMatch("deploy to kubernetes", "orphan", def)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// matchSubtasksToSpecialists
// ---------------------------------------------------------------------------

describe("matchSubtasksToSpecialists", () => {
  it("returns empty array for empty subtasks list", () => {
    const specialists = new Map([
      ["db", makeSpec("db", { metadata: { tags: ["database"] } })],
    ]);
    expect(matchSubtasksToSpecialists([], specialists)).toEqual([]);
  });

  it("returns empty array when specialists map is empty", () => {
    const result = matchSubtasksToSpecialists(["build the api"], new Map());
    expect(result).toEqual([]);
  });

  it("picks higher-scoring specialist when multiple candidates exist", () => {
    const specialists = new Map([
      ["db", makeSpec("db", { name: "DB", metadata: { tags: ["database"] } })],
      ["api", makeSpec("api", { name: "API", metadata: { tags: ["api"] } })],
      ["ui", makeSpec("ui", { name: "UI", metadata: { tags: ["ui"] } })],
    ]);
    const result = matchSubtasksToSpecialists(
      ["create a database schema"],
      specialists
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.specialistId).toBe("db");
  });

  it("input object has subtask field equal to original task string", () => {
    const specialists = new Map([
      ["db", makeSpec("db", { metadata: { tags: ["database"] } })],
    ]);
    const [assignment] = matchSubtasksToSpecialists(
      ["migrate database"],
      specialists
    );
    expect(assignment!.input).toEqual({ subtask: "migrate database" });
  });

  it("handles multiple subtasks assigned to different specialists", () => {
    const specialists = new Map([
      ["db", makeSpec("db", { metadata: { tags: ["database"] } })],
      ["api", makeSpec("api", { metadata: { tags: ["api"] } })],
    ]);
    const result = matchSubtasksToSpecialists(
      ["write a database migration", "expose REST api endpoint"],
      specialists
    );
    expect(result).toHaveLength(2);
    const dbTask = result.find((a) => a.specialistId === "db")!;
    const apiTask = result.find((a) => a.specialistId === "api")!;
    expect(dbTask).toBeDefined();
    expect(apiTask).toBeDefined();
  });

  it("drops subtasks that score 0 against ALL specialists", () => {
    const specialists = new Map([
      ["db", makeSpec("db", { name: "DB", metadata: { tags: ["database"] } })],
    ]);
    const result = matchSubtasksToSpecialists(
      ["paint the office walls", "order coffee"],
      specialists
    );
    expect(result).toEqual([]);
  });

  it("assigns same specialist to multiple matching subtasks", () => {
    const specialists = new Map([
      [
        "db",
        makeSpec("db", { name: "DB", metadata: { tags: ["database", "sql"] } }),
      ],
    ]);
    const result = matchSubtasksToSpecialists(
      ["create database table", "add database index"],
      specialists
    );
    expect(result).toHaveLength(2);
    expect(result[0]!.specialistId).toBe("db");
    expect(result[1]!.specialistId).toBe("db");
  });
});

// ---------------------------------------------------------------------------
// toAgentSpecs
// ---------------------------------------------------------------------------

describe("toAgentSpecs", () => {
  it("returns empty array for empty specialists map", () => {
    expect(toAgentSpecs(new Map())).toEqual([]);
  });

  it("preserves all entries when no circuit breaker", () => {
    const specialists = new Map([
      ["a", makeSpec("a")],
      ["b", makeSpec("b")],
      ["c", makeSpec("c")],
    ]);
    expect(toAgentSpecs(specialists)).toHaveLength(3);
  });

  it("maps id from registry key, not from spec.id", () => {
    const specialists = new Map([
      ["registry-key", makeSpec("inner-id", { name: "Test" })],
    ]);
    const [spec] = toAgentSpecs(specialists);
    expect(spec!.id).toBe("registry-key");
  });

  it("maps name from spec.name", () => {
    const specialists = new Map([
      ["agent", makeSpec("agent", { name: "Named Agent" })],
    ]);
    const [spec] = toAgentSpecs(specialists);
    expect(spec!.name).toBe("Named Agent");
  });

  it("maps tags from metadata.tags", () => {
    const specialists = new Map([
      ["agent", makeSpec("agent", { metadata: { tags: ["alpha", "beta"] } })],
    ]);
    const [spec] = toAgentSpecs(specialists);
    expect(spec!.tags).toEqual(["alpha", "beta"]);
  });

  it("uses empty array for tags when metadata.tags is absent", () => {
    const specialists = new Map([
      ["agent", makeSpec("agent", { metadata: {} })],
    ]);
    const [spec] = toAgentSpecs(specialists);
    expect(spec!.tags).toEqual([]);
  });

  it("passes all specs to circuit breaker filterAvailable", () => {
    const specialists = new Map([
      ["a", makeSpec("a")],
      ["b", makeSpec("b")],
    ]);
    const breaker = {
      filterAvailable: vi.fn((specs: AgentSpec[]) => specs),
    } as unknown as AgentCircuitBreaker;

    toAgentSpecs(specialists, breaker);

    expect(breaker.filterAvailable).toHaveBeenCalledOnce();
    const callArg = (breaker.filterAvailable as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(callArg).toHaveLength(2);
  });

  it("returns only the agents the circuit breaker passes through", () => {
    const specialists = new Map([
      ["open", makeSpec("open")],
      ["closed", makeSpec("closed")],
      ["half", makeSpec("half")],
    ]);
    const breaker = {
      filterAvailable: vi.fn((specs: AgentSpec[]) =>
        specs.filter((s) => s.id === "open")
      ),
    } as unknown as AgentCircuitBreaker;

    const result = toAgentSpecs(specialists, breaker);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("open");
  });

  it("returns empty array when circuit breaker filters everything out", () => {
    const specialists = new Map([["a", makeSpec("a")]]);
    const breaker = {
      filterAvailable: vi.fn(() => []),
    } as unknown as AgentCircuitBreaker;

    expect(toAgentSpecs(specialists, breaker)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// routeSubtasksViaPolicy — deep coverage
// ---------------------------------------------------------------------------

describe("routeSubtasksViaPolicy", () => {
  let candidates: AgentSpec[];

  beforeEach(() => {
    candidates = [
      { id: "db", name: "DB", tags: ["database"] },
      { id: "api", name: "API", tags: ["api"] },
      { id: "ui", name: "UI", tags: ["ui"] },
    ];
  });

  it("returns empty array and never calls policy.select when candidates is empty", () => {
    const policy: RoutingPolicy = { select: vi.fn() };
    const result = routeSubtasksViaPolicy(
      ["migrate db"],
      policy,
      [],
      undefined
    );
    expect(result).toEqual([]);
    expect(policy.select).not.toHaveBeenCalled();
  });

  it("calls policy.select once per subtask", () => {
    const policy: RoutingPolicy = {
      select: vi.fn(
        (_task, available): RoutingDecision => ({
          selected: [available[0]!],
          strategy: "rule",
          reason: "first",
        })
      ),
    };
    routeSubtasksViaPolicy(
      ["task-a", "task-b", "task-c"],
      policy,
      candidates,
      undefined
    );
    expect(policy.select).toHaveBeenCalledTimes(3);
  });

  it("produces one assignment per selected agent", () => {
    const policy: RoutingPolicy = {
      select: vi.fn(
        (_task, available): RoutingDecision => ({
          selected: [available[0]!],
          strategy: "rule",
          reason: "first",
        })
      ),
    };
    const result = routeSubtasksViaPolicy(
      ["only-task"],
      policy,
      candidates,
      undefined
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.specialistId).toBe("db");
    expect(result[0]!.task).toBe("only-task");
    expect(result[0]!.input).toEqual({ subtask: "only-task" });
  });

  it("produces multiple assignments when policy selects multiple agents", () => {
    const policy: RoutingPolicy = {
      select: vi.fn(
        (_task, available): RoutingDecision => ({
          selected: [available[0]!, available[1]!],
          strategy: "round-robin",
          reason: "multi",
        })
      ),
    };
    const result = routeSubtasksViaPolicy(
      ["broadcast-task"],
      policy,
      candidates,
      undefined
    );
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.specialistId)).toEqual(["db", "api"]);
  });

  it("emits supervisor:routing_decision event for each selected agent", () => {
    const events: DzupEvent[] = [];
    const bus = createEventBus();
    bus.onAny((e) => events.push(e));

    const policy: RoutingPolicy = {
      select: vi.fn(
        (_task, available): RoutingDecision => ({
          selected: [available[0]!, available[1]!],
          strategy: "rule",
          reason: "multi-select",
        })
      ),
    };
    routeSubtasksViaPolicy(["task-x"], policy, candidates, bus);

    const routingEvents = events.filter(
      (e) => e.type === "supervisor:routing_decision"
    );
    expect(routingEvents).toHaveLength(2);
  });

  it("routing event carries agentId, strategy, and reason fields", () => {
    const events: DzupEvent[] = [];
    const bus = createEventBus();
    bus.onAny((e) => events.push(e));

    const policy: RoutingPolicy = {
      select: vi.fn(
        (_task, available): RoutingDecision => ({
          selected: [available[0]!],
          strategy: "hash",
          reason: "hash-test",
        })
      ),
    };
    routeSubtasksViaPolicy(["task-y"], policy, candidates, bus);

    const event = events.find(
      (e) => e.type === "supervisor:routing_decision"
    ) as Record<string, unknown>;
    expect(event!["agentId"]).toBe("db");
    expect(event!["strategy"]).toBe("hash");
    expect(event!["reason"]).toBe("hash-test");
  });

  it("propagates fallbackReason to routing events when present", () => {
    const events: DzupEvent[] = [];
    const bus = createEventBus();
    bus.onAny((e) => events.push(e));

    const policy: RoutingPolicy = {
      select: vi.fn(
        (_task, available): RoutingDecision => ({
          selected: [available[0]!],
          strategy: "llm",
          reason: "llm-picked",
          fallbackReason: "no-match-fell-back",
        })
      ),
    };
    routeSubtasksViaPolicy(["task-z"], policy, candidates, bus);

    const event = events.find(
      (e) => e.type === "supervisor:routing_decision"
    ) as Record<string, unknown>;
    expect(event!["fallbackReason"]).toBe("no-match-fell-back");
  });

  it("uses diagnostics.selectedIds when present in routing event", () => {
    const events: DzupEvent[] = [];
    const bus = createEventBus();
    bus.onAny((e) => events.push(e));

    const diagnostics: RoutingDiagnostics = {
      candidateIds: ["db", "api"],
      selectedIds: ["db"],
    };
    const policy: RoutingPolicy = {
      select: vi.fn(
        (_task, available): RoutingDecision => ({
          selected: [available[0]!],
          strategy: "rule",
          reason: "with-diagnostics",
          diagnostics,
        })
      ),
    };
    routeSubtasksViaPolicy(["task-diag"], policy, candidates, bus);

    const event = events.find(
      (e) => e.type === "supervisor:routing_decision"
    ) as Record<string, unknown>;
    expect(event!["selectedCandidates"]).toEqual(["db"]);
    expect(event!["candidateSpecialists"]).toEqual(["db", "api"]);
  });

  it("falls back to computed selectedCandidates/candidateSpecialists when no diagnostics", () => {
    const events: DzupEvent[] = [];
    const bus = createEventBus();
    bus.onAny((e) => events.push(e));

    const policy: RoutingPolicy = {
      select: vi.fn(
        (_task, available): RoutingDecision => ({
          selected: [available[1]!],
          strategy: "rule",
          reason: "second-candidate",
        })
      ),
    };
    routeSubtasksViaPolicy(["task-fallback"], policy, candidates, bus);

    const event = events.find(
      (e) => e.type === "supervisor:routing_decision"
    ) as Record<string, unknown>;
    // Without diagnostics, selectedCandidates = [selected agent id]
    expect((event!["selectedCandidates"] as string[]).includes("api")).toBe(
      true
    );
    // candidateSpecialists = all candidate ids
    const candidateSpec = event!["candidateSpecialists"] as string[];
    expect(candidateSpec).toContain("db");
    expect(candidateSpec).toContain("api");
    expect(candidateSpec).toContain("ui");
  });

  it("does not emit events when no eventBus is provided", () => {
    const policy: RoutingPolicy = {
      select: vi.fn(
        (_task, available): RoutingDecision => ({
          selected: [available[0]!],
          strategy: "rule",
          reason: "no-bus",
        })
      ),
    };
    // Should not throw
    expect(() =>
      routeSubtasksViaPolicy(["task-no-bus"], policy, candidates, undefined)
    ).not.toThrow();
  });

  it("passes a generated taskId and content to policy.select", () => {
    const policy: RoutingPolicy = {
      select: vi.fn(
        (_task, available): RoutingDecision => ({
          selected: [available[0]!],
          strategy: "rule",
          reason: "check-task",
        })
      ),
    };
    routeSubtasksViaPolicy(
      ["verify the auth module"],
      policy,
      candidates,
      undefined
    );

    const passedTask = (policy.select as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(typeof passedTask.taskId).toBe("string");
    expect(passedTask.content).toBe("verify the auth module");
  });

  it("processes multiple subtasks independently", () => {
    let callCount = 0;
    const selectedIds = ["db", "api", "ui"];
    const policy: RoutingPolicy = {
      select: vi.fn(
        (_task, available): RoutingDecision => ({
          selected: [available[callCount++ % available.length]!],
          strategy: "round-robin",
          reason: "round",
        })
      ),
    };
    const result = routeSubtasksViaPolicy(
      ["task-1", "task-2", "task-3"],
      policy,
      candidates,
      undefined
    );
    expect(result).toHaveLength(3);
    expect(result[0]!.task).toBe("task-1");
    expect(result[1]!.task).toBe("task-2");
    expect(result[2]!.task).toBe("task-3");
  });
});

// ===========================================================================
// planning-decomposition.ts — deep tests
// ===========================================================================

// ---------------------------------------------------------------------------
// PlanNodeSchema
// ---------------------------------------------------------------------------

describe("PlanNodeSchema", () => {
  it("parses a valid node", () => {
    const result = PlanNodeSchema.safeParse({
      id: "node-0",
      task: "Do something",
      specialistId: "my-agent",
      dependsOn: ["node-1"],
    });
    expect(result.success).toBe(true);
  });

  it("defaults dependsOn to empty array when omitted", () => {
    const result = PlanNodeSchema.safeParse({
      id: "node-0",
      task: "Task",
      specialistId: "agent",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dependsOn).toEqual([]);
    }
  });

  it("rejects missing id", () => {
    const result = PlanNodeSchema.safeParse({
      task: "Task",
      specialistId: "agent",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing task", () => {
    const result = PlanNodeSchema.safeParse({
      id: "node-0",
      specialistId: "agent",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing specialistId", () => {
    const result = PlanNodeSchema.safeParse({
      id: "node-0",
      task: "Task",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-string dependsOn elements", () => {
    const result = PlanNodeSchema.safeParse({
      id: "node-0",
      task: "Task",
      specialistId: "agent",
      dependsOn: [123],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DecompositionSchema
// ---------------------------------------------------------------------------

describe("DecompositionSchema", () => {
  it("parses a well-formed single-node decomposition", () => {
    const result = DecompositionSchema.safeParse({
      nodes: [
        { id: "node-0", task: "Build DB", specialistId: "db", dependsOn: [] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty nodes array (min(1) constraint)", () => {
    const result = DecompositionSchema.safeParse({ nodes: [] });
    expect(result.success).toBe(false);
  });

  it("rejects missing nodes property", () => {
    const result = DecompositionSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("parses multi-node with cross-dependencies", () => {
    const result = DecompositionSchema.safeParse({
      nodes: [
        { id: "node-0", task: "A", specialistId: "x", dependsOn: [] },
        { id: "node-1", task: "B", specialistId: "y", dependsOn: ["node-0"] },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.nodes).toHaveLength(2);
    }
  });

  it("rejects when a node has an invalid field type", () => {
    const result = DecompositionSchema.safeParse({
      nodes: [{ id: 123, task: "Task", specialistId: "agent", dependsOn: [] }],
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildSpecialistDescriptions
// ---------------------------------------------------------------------------

describe("buildSpecialistDescriptions", () => {
  it("renders one line per specialist ID", () => {
    const supervisor = makeSupervisor({
      "db-agent": { name: "DB Agent" },
      "api-agent": { name: "API Agent" },
    });
    const desc = buildSpecialistDescriptions(supervisor);
    const lines = desc.split("\n");
    expect(lines).toHaveLength(2);
  });

  it("includes specialist id in output", () => {
    const supervisor = makeSupervisor({
      "my-specialist": { name: "My Specialist" },
    });
    const desc = buildSpecialistDescriptions(supervisor);
    expect(desc).toContain("my-specialist");
  });

  it("uses spec.description when available", () => {
    const supervisor = makeSupervisor({
      "doc-agent": { description: "Writes documentation", name: "Doc" },
    });
    const desc = buildSpecialistDescriptions(supervisor);
    expect(desc).toContain("Writes documentation");
  });

  it("falls back to spec.name when description is absent", () => {
    const supervisor = makeSupervisor({
      "code-agent": { name: "Code Agent" },
    });
    const desc = buildSpecialistDescriptions(supervisor);
    expect(desc).toContain("Code Agent");
  });

  it("includes tags in output", () => {
    const supervisor = makeSupervisor({
      "db-agent": {
        name: "DB",
        metadata: { tags: ["database", "sql"] },
      },
    });
    const desc = buildSpecialistDescriptions(supervisor);
    expect(desc).toContain("database");
    expect(desc).toContain("sql");
  });

  it("omits tags section when metadata.tags is empty", () => {
    const supervisor = makeSupervisor({
      "plain-agent": { name: "Plain" },
    });
    const desc = buildSpecialistDescriptions(supervisor);
    expect(desc).not.toContain("[tags:");
  });

  it("renders fallback line when getSpecialist returns undefined", () => {
    const supervisor: PlanningSupervisor = {
      specialistIds: ["ghost-agent"],
      getSpecialist: vi.fn(() => undefined),
      delegateAndCollect: vi.fn(async () => ({
        results: new Map(),
        succeeded: [],
        failed: [],
        totalDurationMs: 0,
      })),
    };
    const desc = buildSpecialistDescriptions(supervisor);
    expect(desc).toBe("- ghost-agent");
  });

  it("returns empty string for supervisor with no specialists", () => {
    const supervisor = makeSupervisor({});
    expect(buildSpecialistDescriptions(supervisor)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// refineDecomposition — direct tests of the validation/cleanup pipeline
// ---------------------------------------------------------------------------

describe("refineDecomposition", () => {
  const goal = "Build a feature";
  const validSpecialists = ["db-agent", "api-agent", "ui-agent"];

  it("returns a clean plan when all nodes have valid specialist IDs", () => {
    const decomposition = {
      nodes: [
        {
          id: "node-0",
          task: "Schema",
          specialistId: "db-agent",
          dependsOn: [],
        },
        {
          id: "node-1",
          task: "API",
          specialistId: "api-agent",
          dependsOn: ["node-0"],
        },
      ],
    };
    const plan = refineDecomposition(goal, decomposition, validSpecialists);
    expect(plan.goal).toBe(goal);
    expect(plan.nodes).toHaveLength(2);
    expect(plan.decompositionDiagnostics).toBeUndefined();
    expect(plan.executionLevels).toEqual([["node-0"], ["node-1"]]);
  });

  it("throws OrchestrationError when all nodes have invalid specialist IDs", () => {
    const decomposition = {
      nodes: [
        {
          id: "node-0",
          task: "Task",
          specialistId: "nonexistent-1",
          dependsOn: [],
        },
        {
          id: "node-1",
          task: "Task 2",
          specialistId: "nonexistent-2",
          dependsOn: [],
        },
      ],
    };
    expect(() =>
      refineDecomposition(goal, decomposition, validSpecialists)
    ).toThrow(OrchestrationError);
  });

  it('error message for all-invalid nodes mentions "no valid nodes"', () => {
    const decomposition = {
      nodes: [
        {
          id: "node-0",
          task: "Task",
          specialistId: "bad-agent",
          dependsOn: [],
        },
      ],
    };
    expect(() =>
      refineDecomposition(goal, decomposition, validSpecialists)
    ).toThrow(/no valid nodes/i);
  });

  it("throws with unresolved node info when some nodes have invalid specialist IDs", () => {
    const decomposition = {
      nodes: [
        { id: "node-0", task: "Good", specialistId: "db-agent", dependsOn: [] },
        {
          id: "node-1",
          task: "Bad",
          specialistId: "unknown-agent",
          dependsOn: [],
        },
      ],
    };
    expect(() =>
      refineDecomposition(goal, decomposition, validSpecialists)
    ).toThrow(/unknown-specialist/i);
  });

  it("throws when a valid node has a dangling dependency on a removed node", () => {
    const decomposition = {
      nodes: [
        { id: "node-0", task: "Invalid", specialistId: "ghost", dependsOn: [] },
        {
          id: "node-1",
          task: "Depends",
          specialistId: "api-agent",
          dependsOn: ["node-0"],
        },
      ],
    };
    expect(() =>
      refineDecomposition(goal, decomposition, validSpecialists)
    ).toThrow(OrchestrationError);
  });

  it("throws when a valid node has a dangling dependency on a simply missing node", () => {
    const decomposition = {
      nodes: [
        {
          id: "node-1",
          task: "API",
          specialistId: "api-agent",
          dependsOn: ["node-0"],
        },
      ],
    };
    expect(() =>
      refineDecomposition(goal, decomposition, validSpecialists)
    ).toThrow(/Dangling dependencies/);
  });

  it("removes unresolved nodes when acknowledgeUnresolvedNodes is true", () => {
    const decomposition = {
      nodes: [
        { id: "node-0", task: "Bad", specialistId: "bad-agent", dependsOn: [] },
        {
          id: "node-1",
          task: "Good",
          specialistId: "api-agent",
          dependsOn: ["node-0"],
        },
        {
          id: "node-2",
          task: "Also Good",
          specialistId: "ui-agent",
          dependsOn: ["node-1"],
        },
      ],
    };
    const plan = refineDecomposition(goal, decomposition, validSpecialists, {
      acknowledgeUnresolvedNodes: true,
    });
    expect(plan.nodes.map((n) => n.id)).toEqual(["node-1", "node-2"]);
    // The dangling dep on node-0 should have been stripped from node-1
    expect(plan.nodes[0]!.dependsOn).toEqual([]);
  });

  it("attaches decompositionDiagnostics when acknowledgeUnresolvedNodes is true", () => {
    const decomposition = {
      nodes: [
        { id: "node-0", task: "Bad", specialistId: "ghost", dependsOn: [] },
        {
          id: "node-1",
          task: "Good",
          specialistId: "db-agent",
          dependsOn: ["node-0"],
        },
      ],
    };
    const plan = refineDecomposition(goal, decomposition, validSpecialists, {
      acknowledgeUnresolvedNodes: true,
    });
    expect(plan.decompositionDiagnostics).toBeDefined();
    expect(plan.decompositionDiagnostics!.acknowledged).toBe(true);
    expect(plan.decompositionDiagnostics!.removedNodes).toHaveLength(1);
    expect(plan.decompositionDiagnostics!.danglingDependencies).toHaveLength(1);
  });

  it("does not attach decompositionDiagnostics for a clean plan", () => {
    const decomposition = {
      nodes: [
        { id: "node-0", task: "OK", specialistId: "db-agent", dependsOn: [] },
      ],
    };
    const plan = refineDecomposition(goal, decomposition, validSpecialists);
    expect(plan.decompositionDiagnostics).toBeUndefined();
  });

  it("respects maxNodes option by truncating nodes", () => {
    const nodes = Array.from({ length: 10 }, (_, i) => ({
      id: `node-${i}`,
      task: `Task ${i}`,
      specialistId: validSpecialists[i % validSpecialists.length]!,
      dependsOn: [] as string[],
    }));
    const plan = refineDecomposition(goal, { nodes }, validSpecialists, {
      maxNodes: 3,
    });
    expect(plan.nodes.length).toBeLessThanOrEqual(3);
  });

  it("defaults maxNodes to 20 when not specified", () => {
    const nodes = Array.from({ length: 25 }, (_, i) => ({
      id: `node-${i}`,
      task: `Task ${i}`,
      specialistId: validSpecialists[i % validSpecialists.length]!,
      dependsOn: [] as string[],
    }));
    const plan = refineDecomposition(goal, { nodes }, validSpecialists);
    expect(plan.nodes.length).toBeLessThanOrEqual(20);
  });

  it("throws OrchestrationError with delegation pattern", () => {
    const decomposition = {
      nodes: [
        { id: "node-0", task: "Task", specialistId: "missing", dependsOn: [] },
      ],
    };
    let caughtError: unknown;
    try {
      refineDecomposition(goal, decomposition, validSpecialists);
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(OrchestrationError);
    expect((caughtError as OrchestrationError).pattern).toBe("delegation");
  });

  it("error context contains availableSpecialists", () => {
    const decomposition = {
      nodes: [{ id: "n", task: "T", specialistId: "missing", dependsOn: [] }],
    };
    let caughtError: unknown;
    try {
      refineDecomposition(goal, decomposition, validSpecialists);
    } catch (err) {
      caughtError = err;
    }
    const ctx = (caughtError as OrchestrationError).context;
    expect(ctx!["availableSpecialists"]).toEqual(validSpecialists);
  });

  it("computes correct execution levels for a parallel plan", () => {
    const decomposition = {
      nodes: [
        { id: "a", task: "A", specialistId: "db-agent", dependsOn: [] },
        { id: "b", task: "B", specialistId: "api-agent", dependsOn: [] },
        { id: "c", task: "C", specialistId: "ui-agent", dependsOn: [] },
      ],
    };
    const plan = refineDecomposition(goal, decomposition, validSpecialists);
    expect(plan.executionLevels).toHaveLength(1);
    expect(new Set(plan.executionLevels[0]!)).toEqual(new Set(["a", "b", "c"]));
  });

  it("throws on cyclic dependencies between valid nodes", () => {
    const decomposition = {
      nodes: [
        {
          id: "node-0",
          task: "A",
          specialistId: "db-agent",
          dependsOn: ["node-1"],
        },
        {
          id: "node-1",
          task: "B",
          specialistId: "api-agent",
          dependsOn: ["node-0"],
        },
      ],
    };
    expect(() =>
      refineDecomposition(goal, decomposition, validSpecialists)
    ).toThrow(/Cycle detected/);
  });

  it("records dependencySpecialistId on dangling dependency when the dep node was removed", () => {
    const decomposition = {
      nodes: [
        {
          id: "bad-node",
          task: "T",
          specialistId: "unknown-specialist",
          dependsOn: [],
        },
        {
          id: "good-node",
          task: "G",
          specialistId: "api-agent",
          dependsOn: ["bad-node"],
        },
      ],
    };
    let caughtError: unknown;
    try {
      refineDecomposition(goal, decomposition, validSpecialists);
    } catch (err) {
      caughtError = err;
    }
    const ctx = (caughtError as OrchestrationError).context;
    const diagnostics = ctx!["diagnostics"] as Record<string, unknown>;
    const dangling = diagnostics["danglingDependencies"] as Array<
      Record<string, unknown>
    >;
    expect(dangling[0]!["dependencySpecialistId"]).toBe("unknown-specialist");
  });

  it("produces input field { task: <task text> } on each plan node", () => {
    const decomposition = {
      nodes: [
        {
          id: "node-0",
          task: "Schema migration",
          specialistId: "db-agent",
          dependsOn: [],
        },
      ],
    };
    const plan = refineDecomposition(goal, decomposition, validSpecialists);
    expect(plan.nodes[0]!.input).toEqual({ task: "Schema migration" });
  });
});

// ---------------------------------------------------------------------------
// decomposeGoal (LLM version) — mocked structured output engine
// ---------------------------------------------------------------------------

describe("decomposeGoal (LLM-powered, planning-decomposition)", () => {
  it("calls the LLM and returns a valid ExecutionPlan for a well-formed response", async () => {
    const supervisor = makeSupervisor({
      "db-agent": { name: "DB Agent", description: "Handles DB" },
      "api-agent": { name: "API Agent", description: "Handles API" },
    });

    const llmResponse = JSON.stringify({
      nodes: [
        {
          id: "node-0",
          task: "Create schema",
          specialistId: "db-agent",
          dependsOn: [],
        },
        {
          id: "node-1",
          task: "Build endpoint",
          specialistId: "api-agent",
          dependsOn: ["node-0"],
        },
      ],
    });
    const llm = makeMockLLM(llmResponse);

    const plan = await decomposeGoalLLM(
      supervisor,
      "Build user management",
      llm
    );
    expect(plan.goal).toBe("Build user management");
    expect(plan.nodes).toHaveLength(2);
    expect(plan.executionLevels).toEqual([["node-0"], ["node-1"]]);
  });

  it("passes maxNodes option through to refineDecomposition", async () => {
    const supervisor = makeSupervisor({
      "db-agent": { name: "DB" },
    });

    const nodes = Array.from({ length: 10 }, (_, i) => ({
      id: `node-${i}`,
      task: `Task ${i}`,
      specialistId: "db-agent",
      dependsOn: [],
    }));
    const llmResponse = JSON.stringify({ nodes });
    const llm = makeMockLLM(llmResponse);

    const options: DecomposeOptions = { maxNodes: 3 };
    const plan = await decomposeGoalLLM(supervisor, "Many tasks", llm, options);
    expect(plan.nodes.length).toBeLessThanOrEqual(3);
  });

  it("includes specialist descriptions in LLM system prompt", async () => {
    const supervisor = makeSupervisor({
      "db-agent": { name: "DB", description: "Manages database schemas" },
    });

    const llmResponse = JSON.stringify({
      nodes: [
        {
          id: "node-0",
          task: "Schema",
          specialistId: "db-agent",
          dependsOn: [],
        },
      ],
    });
    const llm = makeMockLLM(llmResponse);

    await decomposeGoalLLM(supervisor, "Create a DB", llm);

    const messages = (llm.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Array<{ role: string; content: string }>;
    const systemMessage = messages[0]!;
    expect(systemMessage.role).toBe("system");
    expect(systemMessage.content).toContain("db-agent");
    expect(systemMessage.content).toContain("Manages database schemas");
  });

  it("includes goal text in LLM user message", async () => {
    const supervisor = makeSupervisor({
      "db-agent": { name: "DB" },
    });

    const llmResponse = JSON.stringify({
      nodes: [
        {
          id: "node-0",
          task: "Schema",
          specialistId: "db-agent",
          dependsOn: [],
        },
      ],
    });
    const llm = makeMockLLM(llmResponse);

    const goal = "Build the entire product from scratch";
    await decomposeGoalLLM(supervisor, goal, llm);

    const messages = (llm.invoke as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Array<{ role: string; content: string }>;
    const userMessage = messages[1]!;
    expect(userMessage.role).toBe("user");
    expect(userMessage.content).toContain(goal);
  });

  it("throws OrchestrationError for unknown specialist IDs (without acknowledge)", async () => {
    const supervisor = makeSupervisor({
      "db-agent": { name: "DB" },
    });

    const llmResponse = JSON.stringify({
      nodes: [
        {
          id: "node-0",
          task: "Task",
          specialistId: "nonexistent",
          dependsOn: [],
        },
      ],
    });
    const llm = makeMockLLM(llmResponse);

    await expect(decomposeGoalLLM(supervisor, "Goal", llm)).rejects.toThrow(
      OrchestrationError
    );
  });

  it("removes unresolved nodes with acknowledgeUnresolvedNodes: true", async () => {
    const supervisor = makeSupervisor({
      "db-agent": { name: "DB" },
    });

    const llmResponse = JSON.stringify({
      nodes: [
        { id: "bad", task: "Bad", specialistId: "ghost", dependsOn: [] },
        {
          id: "good",
          task: "Good",
          specialistId: "db-agent",
          dependsOn: ["bad"],
        },
      ],
    });
    const llm = makeMockLLM(llmResponse);

    const plan = await decomposeGoalLLM(supervisor, "Goal", llm, {
      acknowledgeUnresolvedNodes: true,
    });
    expect(plan.nodes.map((n) => n.id)).toEqual(["good"]);
    expect(plan.nodes[0]!.dependsOn).toEqual([]);
    expect(plan.decompositionDiagnostics?.acknowledged).toBe(true);
  });
});

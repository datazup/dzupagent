import { describe, it, expect } from "vitest";
import type {
  AgentNode,
  ToolNode,
  TransformNode,
  GateNode,
  ForkNode,
  JoinNode,
  LoopNode,
  SuspendNode,
  PipelineNode,
  PipelineEdge,
  PipelineDefinition,
  PipelineValidationResult,
} from "../pipeline-definition.js";
import type { PipelineCheckpoint } from "../pipeline-checkpoint-store.js";
import type { PipelineLoopBodyGraphCheckpointState as NestedPipelineLoopBodyGraphCheckpointState } from "../index.js";
import type { PipelineLoopBodyGraphCheckpointState as PublicPipelineLoopBodyGraphCheckpointState } from "../../pipeline.js";
import {
  PipelineDefinitionSchema,
  LoopNodeSchema,
  PipelineNodeSchema,
  PipelineEdgeSchema,
  PipelineCheckpointSchema,
  serializePipeline,
  deserializePipeline,
} from "../pipeline-serialization.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalPipeline(
  overrides: Partial<PipelineDefinition> = {}
): PipelineDefinition {
  return {
    id: "pipe-1",
    name: "Test Pipeline",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "n1",
    nodes: [{ type: "tool", id: "n1", toolName: "echo" }],
    edges: [],
    ...overrides,
  };
}

function makeSequentialForEachPipeline(): PipelineDefinition {
  return {
    id: "for-each-pipeline",
    name: "For Each Pipeline",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "items",
    nodes: [
      {
        id: "items",
        type: "loop",
        bodyNodeIds: ["work"],
        maxIterations: 100,
        continuePredicateName: "forEach__item__predicate",
        forEach: {
          source: "items",
          as: "item",
          order: "input",
          concurrency: 1,
          empty: { body: "skip", aggregate: "empty-array" },
        },
      },
      { id: "work", type: "agent", agentId: "worker" },
    ],
    edges: [],
  };
}

// 24-I: the invalid vehicle moved from 2 (now admitted) to 0. Renamed so the
// helper says what it actually builds rather than "concurrent".
function invalidConcurrencyForEachPipeline(): PipelineDefinition {
  const definition = structuredClone(
    makeSequentialForEachPipeline()
  ) as unknown as {
    nodes: Array<{ forEach?: { concurrency: number } }>;
  };
  definition.nodes[0]!.forEach!.concurrency = 0;
  return definition as unknown as PipelineDefinition;
}

/** A for_each artifact at an admitted concurrency greater than one. */
function concurrentForEachPipeline(concurrency: number): PipelineDefinition {
  const definition = structuredClone(
    makeSequentialForEachPipeline()
  ) as unknown as {
    nodes: Array<{ forEach?: { concurrency: number } }>;
  };
  definition.nodes[0]!.forEach!.concurrency = concurrency;
  return definition as unknown as PipelineDefinition;
}

function makeFullPipeline(): PipelineDefinition {
  const nodes: PipelineNode[] = [
    {
      type: "agent",
      id: "n-agent",
      agentId: "code-gen",
      config: { model: "sonnet" },
    },
    {
      type: "tool",
      id: "n-tool",
      toolName: "git_status",
      arguments: { cwd: "/app" },
    },
    { type: "transform", id: "n-transform", transformName: "extractPaths" },
    {
      type: "gate",
      id: "n-gate",
      gateType: "approval",
      condition: "cost < 100",
    },
    { type: "fork", id: "n-fork", forkId: "parallel-1" },
    { type: "join", id: "n-join", forkId: "parallel-1", mergeStrategy: "all" },
    {
      type: "loop",
      id: "n-loop",
      bodyNodeIds: ["n-tool"],
      maxIterations: 5,
      continuePredicateName: "hasMore",
      failOnMaxIterations: true,
    },
    { type: "suspend", id: "n-suspend", resumeCondition: "approved" },
  ];

  const edges: PipelineEdge[] = [
    { type: "sequential", sourceNodeId: "n-agent", targetNodeId: "n-tool" },
    {
      type: "conditional",
      sourceNodeId: "n-gate",
      predicateName: "checkBudget",
      branches: { pass: "n-fork", fail: "n-suspend" },
    },
    {
      type: "error",
      sourceNodeId: "n-tool",
      targetNodeId: "n-suspend",
      errorCodes: ["TIMEOUT", "PROVIDER_UNAVAILABLE"],
    },
  ];

  return {
    id: "full-pipe",
    name: "Full Pipeline",
    version: "2.1.0",
    description: "A pipeline using all 8 node types and 3 edge types",
    schemaVersion: "1.0.0",
    entryNodeId: "n-agent",
    nodes,
    edges,
    budgetLimitCents: 500,
    tokenLimit: 100_000,
    checkpointStrategy: "after_each_node",
    metadata: { team: "core" },
    tags: ["ci", "codegen"],
  };
}

// ---------------------------------------------------------------------------
// Node type tests
// ---------------------------------------------------------------------------

describe("PipelineNode discriminated union", () => {
  it("accepts AgentNode", () => {
    const node: AgentNode = { type: "agent", id: "a1", agentId: "my-agent" };
    const result = PipelineNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "loop") {
      expect(result.data.forEach?.failFast).toBe(true);
    }
  });

  it("accepts ToolNode", () => {
    const node: ToolNode = { type: "tool", id: "t1", toolName: "git_diff" };
    const result = PipelineNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  it("accepts TransformNode", () => {
    const node: TransformNode = {
      type: "transform",
      id: "tr1",
      transformName: "parsePaths",
    };
    const result = PipelineNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  it("accepts GateNode", () => {
    const node: GateNode = { type: "gate", id: "g1", gateType: "budget" };
    const result = PipelineNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  it("accepts ForkNode", () => {
    const node: ForkNode = { type: "fork", id: "f1", forkId: "par-1" };
    const result = PipelineNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  it("accepts JoinNode", () => {
    const node: JoinNode = {
      type: "join",
      id: "j1",
      forkId: "par-1",
      mergeStrategy: "first",
    };
    const result = PipelineNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  it("accepts LoopNode", () => {
    const node: LoopNode = {
      type: "loop",
      id: "l1",
      bodyNodeIds: ["a", "b"],
      maxIterations: 10,
      continuePredicateName: "shouldContinue",
    };
    const result = PipelineNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  it("accepts sequential LoopNode for_each runtime metadata with failFast", () => {
    const node: LoopNode = {
      type: "loop",
      id: "validate_each",
      bodyNodeIds: ["classify_validation"],
      maxIterations: 1000,
      continuePredicateName: "forEach__validationItem__predicate",
      forEach: {
        source: "validationItems",
        as: "validationItem",
        order: "input",
        collect: {
          from: "validationStatus",
          into: "validationResults",
          order: "input",
        },
        concurrency: 1,
        failFast: true,
        empty: {
          body: "skip",
          aggregate: "empty-array",
        },
      },
    };

    const result = PipelineNodeSchema.safeParse(node);

    expect(result.success).toBe(true);
  });

  it("rejects an invalid LoopNode for_each concurrency", () => {
    const result = LoopNodeSchema.safeParse({
      type: "loop",
      id: "unsafe_each",
      bodyNodeIds: ["classify_validation"],
      maxIterations: 1000,
      continuePredicateName: "forEach__validationItem__predicate",
      forEach: {
        source: "validationItems",
        as: "validationItem",
        order: "input",
        concurrency: 0,
        empty: { body: "skip", aggregate: "empty-array" },
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts SuspendNode", () => {
    const node: SuspendNode = { type: "suspend", id: "s1" };
    const result = PipelineNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  it("accepts optional base fields (name, description, timeoutMs, retries)", () => {
    const node: AgentNode = {
      type: "agent",
      id: "a2",
      agentId: "my-agent",
      name: "Code Generator",
      description: "Generates code",
      timeoutMs: 30000,
      retries: 3,
    };
    const result = PipelineNodeSchema.safeParse(node);
    expect(result.success).toBe(true);
  });

  it("accepts source flow-node provenance on pipeline nodes", () => {
    const node: ToolNode = {
      type: "tool",
      id: "t-source",
      toolName: "dzup.runtime.prompt",
      source: {
        kind: "flow-node",
        path: "root.nodes[0]",
        nodeType: "prompt",
        nodeId: "collect-requirements",
      },
    };

    const result = PipelineNodeSchema.safeParse(node);

    expect(result.success).toBe(true);
  });

  it("rejects unknown node type", () => {
    const node = { type: "unknown", id: "u1" };
    const result = PipelineNodeSchema.safeParse(node);
    expect(result.success).toBe(false);
  });

  it("rejects node with missing required fields", () => {
    const node = { type: "agent", id: "a1" }; // missing agentId
    const result = PipelineNodeSchema.safeParse(node);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge type tests
// ---------------------------------------------------------------------------

describe("PipelineEdge discriminated union", () => {
  it("accepts sequential edge", () => {
    const edge: PipelineEdge = {
      type: "sequential",
      sourceNodeId: "n1",
      targetNodeId: "n2",
    };
    const result = PipelineEdgeSchema.safeParse(edge);
    expect(result.success).toBe(true);
  });

  it("accepts conditional edge", () => {
    const edge: PipelineEdge = {
      type: "conditional",
      sourceNodeId: "n1",
      predicateName: "routeByIntent",
      branches: { code: "n2", chat: "n3" },
    };
    const result = PipelineEdgeSchema.safeParse(edge);
    expect(result.success).toBe(true);
  });

  it("accepts error edge", () => {
    const edge: PipelineEdge = {
      type: "error",
      sourceNodeId: "n1",
      targetNodeId: "n-fallback",
      errorCodes: ["TIMEOUT"],
    };
    const result = PipelineEdgeSchema.safeParse(edge);
    expect(result.success).toBe(true);
  });

  it("accepts error edge without errorCodes", () => {
    const edge: PipelineEdge = {
      type: "error",
      sourceNodeId: "n1",
      targetNodeId: "n-fallback",
    };
    const result = PipelineEdgeSchema.safeParse(edge);
    expect(result.success).toBe(true);
  });

  it("rejects edge with unknown type", () => {
    const edge = { type: "parallel", sourceNodeId: "n1", targetNodeId: "n2" };
    const result = PipelineEdgeSchema.safeParse(edge);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PipelineDefinition tests
// ---------------------------------------------------------------------------

describe("PipelineDefinition", () => {
  it("accepts a minimal pipeline definition", () => {
    const def = makeMinimalPipeline();
    const result = PipelineDefinitionSchema.safeParse(def);
    expect(result.success).toBe(true);
  });

  it("accepts a full pipeline with all 8 node types and 3 edge types", () => {
    const def = makeFullPipeline();
    const result = PipelineDefinitionSchema.safeParse(def);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.nodes).toHaveLength(8);
      expect(result.data.edges).toHaveLength(3);
    }
  });

  it("rejects pipeline with no nodes", () => {
    const def = makeMinimalPipeline({ nodes: [] });
    const result = PipelineDefinitionSchema.safeParse(def);
    expect(result.success).toBe(false);
  });

  it("rejects pipeline with missing id", () => {
    const { id: _, ...rest } = makeMinimalPipeline();
    const result = PipelineDefinitionSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects pipeline with wrong schemaVersion", () => {
    const def = { ...makeMinimalPipeline(), schemaVersion: "2.0.0" };
    const result = PipelineDefinitionSchema.safeParse(def);
    expect(result.success).toBe(false);
  });

  it("accepts all checkpoint strategies", () => {
    for (const strategy of [
      "after_each_node",
      "on_suspend",
      "manual",
      "none",
    ] as const) {
      const def = makeMinimalPipeline({ checkpointStrategy: strategy });
      const result = PipelineDefinitionSchema.safeParse(def);
      expect(result.success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// PipelineCheckpoint tests
// ---------------------------------------------------------------------------

describe("PipelineCheckpoint", () => {
  /**
   * `overrides` is deliberately wider than `Partial<PipelineCheckpoint>`.
   * Several tests below feed MALFORMED values — a non-sha256 digest, an unknown
   * `sourceDigest` key, an item frame missing `nextBodyNodeIndex` — because
   * what they assert is that `PipelineCheckpointSchema` REJECTS them. Typing
   * the parameter strictly made those probes type errors, i.e. the compiler
   * objecting to the invalidity that is the test's subject.
   *
   * The RETURN type stays `PipelineCheckpoint`, so the valid callers are
   * unchanged and a typo in the envelope below is still caught.
   */
  function makeCheckpoint(
    overrides: Partial<Record<keyof PipelineCheckpoint, unknown>> = {}
  ): PipelineCheckpoint {
    return {
      pipelineRunId: "run-1",
      pipelineId: "pipe-1",
      version: 1,
      schemaVersion: "1.0.0",
      completedNodeIds: ["n1", "n2"],
      state: { lastOutput: "hello" },
      createdAt: "2026-03-25T10:00:00.000Z",
      // Cast, not `satisfies`: the spread of intentionally-invalid overrides is
      // what several callers below need, so the widened values are re-asserted
      // to the declared return type here — at ONE place — rather than at each
      // malformed call site.
      ...overrides,
    } as PipelineCheckpoint;
  }

  /**
   * Overrides admit an explicit `undefined` per property. Callers below pass
   * `nextNodeId: undefined` to mean "a terminal state has no next node", which
   * `exactOptionalPropertyTypes` rejects against a plain `Partial<...>` —
   * there, an optional property may be OMITTED but not explicitly undefined.
   * Writing it out is clearer at those call sites than omitting it, since the
   * absence is the fact under test.
   */
  function makeBodyGraphCheckpointState(
    overrides: {
      [K in keyof NestedPipelineLoopBodyGraphCheckpointState]?:
        | NestedPipelineLoopBodyGraphCheckpointState[K]
        | undefined;
    } = {}
  ): NestedPipelineLoopBodyGraphCheckpointState {
    return {
      completed: false,
      nextNodeId: "publish",
      completedNodeIds: ["prepare"],
      nodeResults: {},
      nodeIdempotencyKeys: {},
      // Cast for the same reason as `makeCheckpoint`: spreading overrides that
      // may carry an explicit `undefined` widens the required fields, so the
      // declared return type is re-asserted once here rather than at each site.
      ...overrides,
    } as NestedPipelineLoopBodyGraphCheckpointState;
  }

  function expectCheckpointIssues(
    checkpoint: unknown,
    expectedIssues: Array<{
      code: "custom";
      path: Array<string | number>;
      message: string;
    }>
  ): void {
    const result = PipelineCheckpointSchema.safeParse(checkpoint);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(expectedIssues);
    }
  }

  it("validates a minimal checkpoint", () => {
    const cp = makeCheckpoint();
    const result = PipelineCheckpointSchema.safeParse(cp);
    expect(result.success).toBe(true);
  });

  // --- E0: source binding + for-each item frame contract ---

  const DIGEST_A = `sha256:${"a".repeat(64)}` as const;
  const DIGEST_B = `sha256:${"b".repeat(64)}` as const;

  it("accepts a checkpoint carrying a root source binding", () => {
    const cp = makeCheckpoint({
      sourceBinding: {
        definitionDigest: DIGEST_A,
        loopSourceDigests: { "loop-items": DIGEST_B },
      },
    });
    const result = PipelineCheckpointSchema.safeParse(cp);
    expect(result.success).toBe(true);
  });

  it("still accepts a checkpoint with no source binding", () => {
    // Absence must stay valid: checkpoints written before E0 have no binding,
    // and resume treats "unbound" as unprovable rather than as agreement.
    const cp = makeCheckpoint();
    expect("sourceBinding" in cp).toBe(false);
    expect(PipelineCheckpointSchema.safeParse(cp).success).toBe(true);
  });

  it("accepts exact predicate-loop reservation and settlement bytes", () => {
    const reserved = makeCheckpoint({
      loopState: {
        loop: {
          iteration: 0,
          nextBodyNodeIndex: 0,
          bodyResults: {},
          iterationOutcome: "reserved",
          iterationEconomics: {
            reservationId: "resv:v1:run-1:iteration:loop:1",
            reservedCostCents: 8,
          },
        },
      },
    });
    expect(PipelineCheckpointSchema.safeParse(reserved).success).toBe(true);

    const completed = makeCheckpoint({
      loopState: {
        loop: {
          iteration: 0,
          bodyGraphState: makeBodyGraphCheckpointState({
            completed: true,
            nextNodeId: undefined,
            outcome: { kind: "terminal", exitNodeId: "complete" },
          }),
          iterationOutcome: "completed",
          iterationEconomics: {
            reservationId: "resv:v1:run-1:iteration:loop:1",
            reservedCostCents: 8,
            settledCostCents: 3,
          },
        },
      },
    });
    expect(PipelineCheckpointSchema.safeParse(completed).success).toBe(true);
  });

  it("rejects incomplete or contradictory predicate-loop economics", () => {
    const missingEconomics = makeCheckpoint({
      loopState: { loop: { iteration: 0, iterationOutcome: "running" } },
    });
    expect(PipelineCheckpointSchema.safeParse(missingEconomics).success).toBe(
      false
    );

    const completedWithoutCost = makeCheckpoint({
      loopState: {
        loop: {
          iteration: 0,
          iterationOutcome: "completed",
          iterationEconomics: {
            reservationId: "resv:v1:run-1:iteration:loop:1",
            reservedCostCents: 8,
          },
        },
      },
    });
    expect(
      PipelineCheckpointSchema.safeParse(completedWithoutCost).success
    ).toBe(false);

    const runningWithSettledCost = makeCheckpoint({
      loopState: {
        loop: {
          iteration: 0,
          iterationOutcome: "running",
          iterationEconomics: {
            reservationId: "resv:v1:run-1:iteration:loop:1",
            reservedCostCents: 8,
            settledCostCents: 3,
          },
        },
      },
    });
    expect(
      PipelineCheckpointSchema.safeParse(runningWithSettledCost).success
    ).toBe(false);
  });

  it("rejects predicate economics mixed with for_each item state", () => {
    const mixed = makeCheckpoint({
      loopState: {
        loop: {
          iteration: 0,
          iterationOutcome: "reserved",
          iterationEconomics: {
            reservationId: "resv:v1:run-1:iteration:loop:1",
            reservedCostCents: 8,
          },
          itemFrames: {
            "0": { itemIndex: 0, nextBodyNodeIndex: 0 },
          },
        },
      },
    });
    expect(PipelineCheckpointSchema.safeParse(mixed).success).toBe(false);
  });

  it("rejects a source-binding digest that is not a canonical sha256", () => {
    const result = PipelineCheckpointSchema.safeParse(
      makeCheckpoint({
        sourceBinding: { definitionDigest: "deadbeef" },
      })
    );
    expect(result.success).toBe(false);
  });

  it("rejects a per-loop source digest that is not a canonical sha256", () => {
    const result = PipelineCheckpointSchema.safeParse(
      makeCheckpoint({
        sourceBinding: {
          definitionDigest: DIGEST_A,
          loopSourceDigests: { "loop-items": `sha256:${"z".repeat(64)}` },
        },
      })
    );
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key inside the source binding", () => {
    // The binding is `.strict()` like the checkpoint itself, so a typo cannot
    // silently ride along as unvalidated provenance.
    const result = PipelineCheckpointSchema.safeParse(
      makeCheckpoint({
        sourceBinding: {
          definitionDigest: DIGEST_A,
          sourceDigest: DIGEST_B,
        },
      })
    );
    expect(result.success).toBe(false);
  });

  it("accepts a for-each loop cursor carrying mid-item progress", () => {
    const cp = makeCheckpoint({
      loopState: {
        "loop-items": {
          iteration: 2,
          itemFrame: {
            itemIndex: 2,
            nextBodyNodeIndex: 1,
            bodyResults: { fetch: { nodeId: "fetch", output: 1 } },
            attempt: 0,
          },
        },
      },
    });
    const result = PipelineCheckpointSchema.safeParse(cp);
    expect(result.success).toBe(true);
  });

  it("requires nextBodyNodeIndex on a for-each item frame", () => {
    // itemIndex alone cannot say how far into the item we got, which is the
    // whole point of the frame — a frame without it would re-run body nodes.
    const result = PipelineCheckpointSchema.safeParse(
      makeCheckpoint({
        loopState: {
          "loop-items": { iteration: 2, itemFrame: { itemIndex: 2 } },
        },
      })
    );
    expect(result.success).toBe(false);
  });

  it("rejects a negative item index on a for-each item frame", () => {
    const result = PipelineCheckpointSchema.safeParse(
      makeCheckpoint({
        loopState: {
          "loop-items": {
            iteration: 0,
            itemFrame: { itemIndex: -1, nextBodyNodeIndex: 0 },
          },
        },
      })
    );
    expect(result.success).toBe(false);
  });

  it("validates a checkpoint with budgetState and suspendedAtNodeId", () => {
    const cp = makeCheckpoint({
      suspendedAtNodeId: "n3",
      budgetState: { tokensUsed: 5000, costCents: 12 },
    });
    const result = PipelineCheckpointSchema.safeParse(cp);
    expect(result.success).toBe(true);
  });

  it("round-trips the full public durability surface without inventing provider session refs", () => {
    const graphState = makeBodyGraphCheckpointState({
      nodeResults: {
        prepare: {
          nodeId: "prepare",
          output: { status: "ready" },
          durationMs: 3,
        },
      },
      nodeIdempotencyKeys: { prepare: "prepare-key" },
      forkState: {
        parallel: {
          branches: {
            left: {
              stateDelta: { left: true },
              nodeResults: { left: { output: "left-result" } },
            },
          },
        },
      },
    });
    const publicGraphState: PublicPipelineLoopBodyGraphCheckpointState =
      graphState;
    const checkpoint = makeCheckpoint({
      nodeIdempotencyKeys: { prepare: "top-level-prepare-key" },
      loopState: {
        poll: {
          iteration: 2,
          bodyGraphState: publicGraphState,
        },
      },
      forkState: {
        outerParallel: {
          branches: {
            right: {
              stateDelta: { right: true },
              nodeResults: { right: { output: "right-result" } },
            },
          },
        },
      },
      recoveryAttemptsUsed: 2,
    });

    const result = PipelineCheckpointSchema.safeParse(checkpoint);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(checkpoint);
      expect(result.data.providerSessionRefs).toBeUndefined();
    }
  });

  it("accepts an older iteration-only checkpoint without new durability fields", () => {
    const checkpoint = makeCheckpoint({
      loopState: { poll: { iteration: 2 } },
    });

    const result = PipelineCheckpointSchema.safeParse(checkpoint);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(checkpoint);
      expect(result.data.nodeIdempotencyKeys).toBeUndefined();
      expect(result.data.forkState).toBeUndefined();
      expect(result.data.recoveryAttemptsUsed).toBeUndefined();
    }
  });

  it.each([
    {
      name: "normal",
      state: makeBodyGraphCheckpointState({
        completed: true,
        nextNodeId: undefined,
        outcome: { kind: "normal", exitNodeId: "prepare" },
      }),
    },
    {
      name: "suspended",
      state: makeBodyGraphCheckpointState({
        completed: false,
        nextNodeId: undefined,
        outcome: { kind: "suspended", exitNodeId: "approval" },
      }),
    },
    {
      name: "terminal",
      state: makeBodyGraphCheckpointState({
        completed: true,
        nextNodeId: undefined,
        outcome: { kind: "terminal", exitNodeId: "complete" },
      }),
    },
  ])("round-trips a $name graph outcome", ({ state }) => {
    const checkpoint = makeCheckpoint({
      loopState: { poll: { iteration: 1, bodyGraphState: state } },
    });

    const result = PipelineCheckpointSchema.safeParse(checkpoint);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.loopState?.["poll"]?.bodyGraphState).toEqual(state);
    }
  });

  it.each([
    {
      name: "normal outcome on an incomplete cursor",
      state: makeBodyGraphCheckpointState({
        outcome: { kind: "normal", exitNodeId: "prepare" },
      }),
    },
    {
      name: "terminal outcome with a next node",
      state: makeBodyGraphCheckpointState({
        completed: true,
        outcome: { kind: "terminal", exitNodeId: "complete" },
      }),
    },
    {
      name: "suspended outcome marked completed",
      state: makeBodyGraphCheckpointState({
        completed: true,
        nextNodeId: undefined,
        outcome: { kind: "suspended", exitNodeId: "approval" },
      }),
    },
  ])("rejects a $name", ({ state }) => {
    const result = PipelineCheckpointSchema.safeParse(
      makeCheckpoint({
        loopState: { poll: { iteration: 1, bodyGraphState: state } },
      })
    );

    expect(result.success).toBe(false);
  });

  it("rejects an unknown graph outcome discriminant", () => {
    const state = {
      ...makeBodyGraphCheckpointState(),
      nextNodeId: undefined,
      outcome: { kind: "paused", exitNodeId: "approval" },
    };
    const result = PipelineCheckpointSchema.safeParse(
      makeCheckpoint({
        loopState: {
          poll: { iteration: 1, bodyGraphState: state as never },
        },
      })
    );

    expect(result.success).toBe(false);
  });

  it("round-trips a mid-iteration predicate-loop cursor", () => {
    const result = PipelineCheckpointSchema.safeParse(
      JSON.parse(
        JSON.stringify(
          makeCheckpoint({
            loopState: {
              poll: {
                iteration: 2,
                nextBodyNodeIndex: 1,
                bodyResults: {
                  fetch: {
                    nodeId: "fetch",
                    output: { status: "pending" },
                    durationMs: 3,
                  },
                },
                previousOutput: { status: "previous" },
                progressDigest: `sha256:${"a".repeat(64)}`,
              },
            },
          })
        )
      )
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.loopState?.["poll"]).toMatchObject({
        iteration: 2,
        nextBodyNodeIndex: 1,
        previousOutput: { status: "previous" },
        progressDigest: `sha256:${"a".repeat(64)}`,
      });
    }
  });

  it("rejects a body cursor without retained results", () => {
    expectCheckpointIssues(
      makeCheckpoint({
        loopState: {
          poll: { iteration: 2, nextBodyNodeIndex: 1 },
        },
      }),
      [
        {
          code: "custom",
          path: ["loopState", "poll", "bodyResults"],
          message:
            "nextBodyNodeIndex and bodyResults must be present or absent together",
        },
      ]
    );
  });

  it("rejects a completed graph cursor that also names a next node", () => {
    expectCheckpointIssues(
      makeCheckpoint({
        loopState: {
          poll: {
            iteration: 2,
            bodyGraphState: makeBodyGraphCheckpointState({ completed: true }),
          },
        },
      }),
      [
        {
          code: "custom",
          path: ["loopState", "poll", "bodyGraphState", "nextNodeId"],
          message:
            "completed graph cursors omit nextNodeId; incomplete cursors require it",
        },
      ]
    );
  });

  it("rejects an incomplete graph cursor without a next node", () => {
    expectCheckpointIssues(
      makeCheckpoint({
        loopState: {
          poll: {
            iteration: 2,
            bodyGraphState: {
              completed: false,
              completedNodeIds: ["prepare"],
              nodeResults: {},
              nodeIdempotencyKeys: {},
            },
          },
        },
      }),
      [
        {
          code: "custom",
          path: ["loopState", "poll", "bodyGraphState", "nextNodeId"],
          message:
            "completed graph cursors omit nextNodeId; incomplete cursors require it",
        },
      ]
    );
  });

  it("rejects duplicate completed node IDs in a graph cursor", () => {
    expectCheckpointIssues(
      makeCheckpoint({
        loopState: {
          poll: {
            iteration: 2,
            bodyGraphState: makeBodyGraphCheckpointState({
              completedNodeIds: ["prepare", "prepare"],
            }),
          },
        },
      }),
      [
        {
          code: "custom",
          path: ["loopState", "poll", "bodyGraphState", "completedNodeIds", 1],
          message: 'completedNodeIds contains duplicate node ID "prepare"',
        },
      ]
    );
  });

  it("rejects a graph cursor combined with the legacy flat cursor", () => {
    expectCheckpointIssues(
      makeCheckpoint({
        loopState: {
          poll: {
            iteration: 2,
            nextBodyNodeIndex: 1,
            bodyResults: {},
            bodyGraphState: makeBodyGraphCheckpointState(),
          },
        },
      }),
      [
        {
          code: "custom",
          path: ["loopState", "poll", "bodyGraphState"],
          message:
            "bodyGraphState is mutually exclusive with the flat body cursor",
        },
      ]
    );
  });

  it("round-trips checkpoint fields through JSON", () => {
    const cp = makeCheckpoint({
      suspendedAtNodeId: "n-suspend",
      budgetState: { tokensUsed: 10000, costCents: 25 },
    });
    const json = JSON.stringify(cp);
    const parsed: unknown = JSON.parse(json);
    const result = PipelineCheckpointSchema.safeParse(parsed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pipelineRunId).toBe("run-1");
      expect(result.data.completedNodeIds).toEqual(["n1", "n2"]);
      expect(result.data.budgetState?.tokensUsed).toBe(10000);
      expect(result.data.suspendedAtNodeId).toBe("n-suspend");
    }
  });

  it("rejects checkpoint with missing pipelineRunId", () => {
    const { pipelineRunId: _, ...rest } = makeCheckpoint();
    const result = PipelineCheckpointSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Serialization / deserialization tests
// ---------------------------------------------------------------------------

describe("serializePipeline / deserializePipeline", () => {
  it("round-trips a full pipeline definition", () => {
    const original = makeFullPipeline();
    const json = serializePipeline(original);
    const restored = deserializePipeline(json);
    expect(restored).toEqual(original);
  });

  it("round-trips a minimal pipeline", () => {
    const original = makeMinimalPipeline();
    const json = serializePipeline(original);
    const restored = deserializePipeline(json);
    expect(restored.id).toBe("pipe-1");
    expect(restored.nodes).toHaveLength(1);
  });

  it("round-trips the admitted sequential for_each artifact", () => {
    const original = makeSequentialForEachPipeline();

    expect(deserializePipeline(serializePipeline(original))).toEqual(original);
  });

  it("rejects an invalid for_each concurrency at definition, serialization, and deserialization boundaries", () => {
    const invalid = invalidConcurrencyForEachPipeline();
    const parsed = PipelineDefinitionSchema.safeParse(invalid);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["nodes", 0, "forEach", "concurrency"],
            message: "for_each.concurrency must be a positive integer",
          }),
        ])
      );
    }
    expect(() => serializePipeline(invalid)).toThrow(
      "for_each.concurrency must be a positive integer"
    );
    expect(() => deserializePipeline(JSON.stringify(invalid))).toThrow(
      "for_each.concurrency must be a positive integer"
    );
  });

  // 24-I: the admission at the core boundary. `concurrency` was `z.literal(1)`
  // and a type-level literal `1`, so N>1 could not be expressed here at all —
  // these three boundaries are where a relaxed compiler would otherwise have
  // its artifact rejected on load.
  it.each([2, 4, 32])(
    "admits and round-trips for_each concurrency %s",
    (concurrency) => {
      const definition = concurrentForEachPipeline(concurrency);

      expect(PipelineDefinitionSchema.safeParse(definition).success).toBe(true);
      // Round-trip preserves the value rather than normalizing it back to 1.
      expect(deserializePipeline(serializePipeline(definition))).toEqual(
        definition
      );
    }
  );

  it("round-trips W1 per-node durability fields", () => {
    const original = makeMinimalPipeline({
      nodes: [
        {
          type: "tool",
          id: "n1",
          toolName: "write.record",
          declaredIdempotencyKey: "record-123",
          idempotency: "exactly-once-required",
          effectClass: "db_write",
        },
      ],
    });

    const restored = deserializePipeline(serializePipeline(original));

    expect(restored.nodes[0]).toMatchObject({
      declaredIdempotencyKey: "record-123",
      idempotency: "exactly-once-required",
      effectClass: "db_write",
    });
  });

  it("round-trips per-node source provenance", () => {
    const original = makeMinimalPipeline({
      nodes: [
        {
          type: "tool",
          id: "n1",
          toolName: "dzup.runtime.prompt",
          source: {
            kind: "flow-node",
            path: "root.nodes[0]",
            nodeType: "prompt",
            nodeId: "collect-requirements",
          },
        },
      ],
    });

    const restored = deserializePipeline(serializePipeline(original));

    expect(restored.nodes[0]).toMatchObject({
      source: {
        kind: "flow-node",
        path: "root.nodes[0]",
        nodeType: "prompt",
        nodeId: "collect-requirements",
      },
    });
  });

  it("round-trips the W1 Slice 2 resume policy (zod mirror check)", () => {
    const original = makeMinimalPipeline({
      resume: {
        onProcessRestart: "resume_from_checkpoint",
        requireResumePoint: true,
        maxReplayNodes: 3,
      },
    });

    const restored = deserializePipeline(serializePipeline(original));

    // If the zod schema failed to mirror `resume`, the field would be dropped
    // on deserialize (the Slice 1 serialization-mirror lesson).
    expect(restored.resume).toEqual({
      onProcessRestart: "resume_from_checkpoint",
      requireResumePoint: true,
      maxReplayNodes: 3,
    });
  });

  it("deserializePipeline rejects invalid JSON", () => {
    expect(() => deserializePipeline("not-json")).toThrow("invalid JSON");
  });

  it("deserializePipeline rejects missing required fields", () => {
    const invalid = JSON.stringify({ id: "p1" });
    expect(() => deserializePipeline(invalid)).toThrow(
      "Pipeline deserialization failed"
    );
  });

  it("deserializePipeline rejects wrong schemaVersion", () => {
    const def = { ...makeMinimalPipeline(), schemaVersion: "99.0.0" };
    const json = JSON.stringify(def);
    expect(() => deserializePipeline(json)).toThrow(
      "Pipeline deserialization failed"
    );
  });

  it("serializePipeline rejects invalid definition", () => {
    const invalid = { ...makeMinimalPipeline(), nodes: [] };
    expect(() => serializePipeline(invalid)).toThrow(
      "Pipeline serialization failed"
    );
  });

  it("produces valid JSON (parseable by JSON.parse)", () => {
    const json = serializePipeline(makeMinimalPipeline());
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// JSON-serializable constraint
// ---------------------------------------------------------------------------

describe("JSON-serializable constraint", () => {
  it("PipelineDefinition contains no Date objects or functions", () => {
    const def = makeFullPipeline();
    const json = JSON.stringify(def);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    // Recursively check no value is a function or Date
    function assertSerializable(obj: unknown, path: string): void {
      expect(typeof obj).not.toBe("function");
      expect(obj).not.toBeInstanceOf(Date);
      if (obj !== null && typeof obj === "object") {
        for (const [key, value] of Object.entries(
          obj as Record<string, unknown>
        )) {
          assertSerializable(value, `${path}.${key}`);
        }
      }
    }

    assertSerializable(parsed, "root");
  });

  it("PipelineCheckpoint contains no Date objects (uses ISO strings)", () => {
    const cp: PipelineCheckpoint = {
      pipelineRunId: "run-1",
      pipelineId: "pipe-1",
      version: 0,
      schemaVersion: "1.0.0",
      completedNodeIds: [],
      state: {},
      createdAt: new Date().toISOString(),
    };
    const json = JSON.stringify(cp);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(typeof parsed["createdAt"]).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Validation result types (compile-time check)
// ---------------------------------------------------------------------------

describe("PipelineValidationResult", () => {
  it("has the expected shape", () => {
    const result: PipelineValidationResult = {
      valid: false,
      errors: [
        {
          code: "MISSING_ENTRY",
          message: "Entry node not found",
          nodeId: "n1",
        },
        {
          code: "DANGLING_EDGE",
          message: "Edge references non-existent node",
          edgeIndex: 0,
        },
      ],
      warnings: [
        {
          code: "UNREACHABLE_NODE",
          message: "Node n3 is unreachable",
          nodeId: "n3",
        },
      ],
    };
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
    expect(result.warnings).toHaveLength(1);
  });
});

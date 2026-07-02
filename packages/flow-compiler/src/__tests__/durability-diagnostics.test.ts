/**
 * P0 — DSL Durability Contract: compiler diagnostics (D4/D5) + evidence (D6).
 *
 * D4/D5 are advisory warnings (never block compilation); D6 surfaces the
 * document durability profile on the successful result. D1/D2/D3 are deferred
 * to the node-field follow-up — see durability-diagnostics.ts.
 */
import type { ResolvedTool, ToolResolver } from "@dzupagent/flow-ast";
import { InMemoryDomainToolRegistry } from "@dzupagent/app-tools";
import { describe, expect, it } from "vitest";

import { createFlowCompiler } from "../index.js";

function makeResolver(toolRefs: string[]): ToolResolver {
  const registry = new InMemoryDomainToolRegistry();
  for (const name of toolRefs) {
    const namespace = name.split(".")[0] ?? name;
    registry.register({
      name,
      description: `test skill ${name}`,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      permissionLevel: "read",
      sideEffects: [],
      namespace,
    });
  }
  return {
    resolve(ref: string): ResolvedTool | null {
      const def = registry.get(ref);
      return def
        ? { ref, kind: "skill", inputSchema: def.inputSchema, handle: def }
        : null;
    },
    listAvailable: () => registry.list().map((t) => t.name),
  };
}

function baseDoc(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dsl: "dzupflow/v1",
    id: "durability-compile-test",
    version: 1,
    root: {
      type: "sequence",
      id: "root",
      nodes: [
        { type: "action", id: "step1", toolRef: "tool.run", input: {} },
        { type: "complete", id: "done" },
      ],
    },
    ...extra,
  };
}

describe("durability diagnostics — D6 evidence", () => {
  it("surfaces documentDurability on a successful compile", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      baseDoc({
        durability: {
          mode: "durable",
          checkpoint: { strategy: "after_each_node", storeRef: "pg://ck" },
        },
      })
    );
    expect("errors" in result).toBe(false);
    if ("errors" in result) throw new Error("expected success");
    expect(result.documentDurability?.mode).toBe("durable");
    expect(result.documentDurability?.checkpoint?.storeRef).toBe("pg://ck");
  });

  it("omits documentDurability when not declared", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(baseDoc());
    expect("errors" in result).toBe(false);
    if ("errors" in result) throw new Error("expected success");
    expect(result.documentDurability).toBeUndefined();
  });
});

describe("durability diagnostics — D5 durable without store", () => {
  it("warns (does not error) when durable mode lacks a checkpoint storeRef", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      baseDoc({ durability: { mode: "durable" } })
    );
    expect("errors" in result).toBe(false);
    if ("errors" in result) throw new Error("expected success");
    expect(result.warnings.some((w) => w.code === "DURABILITY_NO_STORE")).toBe(
      true
    );
  });

  it("does not warn when durable mode has a storeRef", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      baseDoc({
        durability: { mode: "durable", checkpoint: { storeRef: "pg://ck" } },
      })
    );
    expect("errors" in result).toBe(false);
    if ("errors" in result) throw new Error("expected success");
    expect(result.warnings.some((w) => w.code === "DURABILITY_NO_STORE")).toBe(
      false
    );
  });

  it("does not warn for checkpointed (non-durable) mode", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      baseDoc({ durability: { mode: "checkpointed" } })
    );
    expect("errors" in result).toBe(false);
    if ("errors" in result) throw new Error("expected success");
    expect(result.warnings.some((w) => w.code === "DURABILITY_NO_STORE")).toBe(
      false
    );
  });
});

describe("durability diagnostics — backward compatibility", () => {
  it("a document with no durability block compiles with no durability warnings", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(baseDoc());
    expect("errors" in result).toBe(false);
    if ("errors" in result) throw new Error("expected success");
    expect(
      result.warnings.some(
        (w) =>
          w.code === "DURABILITY_NO_STORE" ||
          w.code === "IDEMPOTENCY_MODE_CONFLICT"
      )
    ).toBe(false);
  });
});

// A document whose single action node carries the given extra fields.
function docWithActionNode(
  nodeExtra: Record<string, unknown>
): Record<string, unknown> {
  return {
    dsl: "dzupflow/v1",
    id: "node-effect-test",
    version: 1,
    root: {
      type: "sequence",
      id: "root",
      nodes: [
        {
          type: "action",
          id: "s1",
          toolRef: "tool.run",
          input: {},
          ...nodeExtra,
        },
        { type: "complete", id: "done" },
      ],
    },
  };
}

describe("durability diagnostics — D1 mutating effect without idempotency", () => {
  it("warns when a node has a mutating effectClass and no idempotency", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      docWithActionNode({ effectClass: "db_write" })
    );
    if ("errors" in result) throw new Error("expected success");
    expect(
      result.warnings.some((w) => w.code === "MUTATING_EFFECT_NO_IDEMPOTENCY")
    ).toBe(true);
  });

  it("does not warn when the mutating node declares idempotency", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      docWithActionNode({
        effectClass: "db_write",
        idempotency: "exactly-once-required",
      })
    );
    if ("errors" in result) throw new Error("expected success");
    expect(
      result.warnings.some((w) => w.code === "MUTATING_EFFECT_NO_IDEMPOTENCY")
    ).toBe(false);
  });

  it("does not warn when allowDuplicateEffects is set", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      docWithActionNode({
        effectClass: "file_write",
        allowDuplicateEffects: true,
      })
    );
    if ("errors" in result) throw new Error("expected success");
    expect(
      result.warnings.some((w) => w.code === "MUTATING_EFFECT_NO_IDEMPOTENCY")
    ).toBe(false);
  });

  it("does not warn for a non-mutating effectClass (read/compute)", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      docWithActionNode({ effectClass: "read" })
    );
    if ("errors" in result) throw new Error("expected success");
    expect(
      result.warnings.some((w) => w.code === "MUTATING_EFFECT_NO_IDEMPOTENCY")
    ).toBe(false);
  });
});

describe("durability diagnostics — D2 idempotent without output schema", () => {
  it("warns when idempotency='idempotent' but no output schema", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      docWithActionNode({ idempotency: "idempotent" })
    );
    if ("errors" in result) throw new Error("expected success");
    expect(
      result.warnings.some((w) => w.code === "IDEMPOTENT_NO_OUTPUT_SCHEMA")
    ).toBe(true);
  });

  it("does not warn when an output schema is present", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      docWithActionNode({
        idempotency: "idempotent",
        outputSchema: "schema.v1",
      })
    );
    if ("errors" in result) throw new Error("expected success");
    expect(
      result.warnings.some((w) => w.code === "IDEMPOTENT_NO_OUTPUT_SCHEMA")
    ).toBe(false);
  });

  it("does not warn for at-least-once idempotency (no prior-result replay)", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      docWithActionNode({ idempotency: "at-least-once" })
    );
    if ("errors" in result) throw new Error("expected success");
    expect(
      result.warnings.some((w) => w.code === "IDEMPOTENT_NO_OUTPUT_SCHEMA")
    ).toBe(false);
  });
});

// A document with the given durability block and the given root nodes.
function docWithDurability(
  durability: Record<string, unknown> | undefined,
  nodes: Record<string, unknown>[]
): Record<string, unknown> {
  return {
    dsl: "dzupflow/v1",
    id: "resume-reachability-test",
    version: 1,
    ...(durability ? { durability } : {}),
    root: {
      type: "sequence",
      id: "root",
      nodes: [...nodes, { type: "complete", id: "done" }],
    },
  };
}

describe("durability diagnostics — D3 resume reachability", () => {
  it("warns when a durable flow has a mutating node but no resume_point", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      docWithDurability(
        { mode: "durable", checkpoint: { storeRef: "pg://ck" } },
        [
          {
            type: "action",
            id: "s1",
            toolRef: "tool.run",
            input: {},
            effectClass: "db_write",
            idempotency: "exactly-once-required",
          },
        ]
      )
    );
    if ("errors" in result) throw new Error("expected success");
    expect(
      result.warnings.some((w) => w.code === "DURABLE_MUTATION_NO_RESUME_POINT")
    ).toBe(true);
  });

  it("does not warn when a durable mutating flow has a resume_point node", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      docWithDurability(
        { mode: "durable", checkpoint: { storeRef: "pg://ck" } },
        [
          {
            type: "action",
            id: "s1",
            toolRef: "tool.run",
            input: {},
            effectClass: "db_write",
            idempotency: "exactly-once-required",
            resumePoint: true,
          },
        ]
      )
    );
    if ("errors" in result) throw new Error("expected success");
    expect(
      result.warnings.some((w) => w.code === "DURABLE_MUTATION_NO_RESUME_POINT")
    ).toBe(false);
  });

  it("does not warn for a non-durable flow with mutating nodes", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      docWithDurability(undefined, [
        {
          type: "action",
          id: "s1",
          toolRef: "tool.run",
          input: {},
          effectClass: "db_write",
          idempotency: "exactly-once-required",
        },
      ])
    );
    if ("errors" in result) throw new Error("expected success");
    expect(
      result.warnings.some((w) => w.code === "DURABLE_MUTATION_NO_RESUME_POINT")
    ).toBe(false);
  });
});

describe("durability diagnostics — Gap 4 requireResumePoint warn→ERROR", () => {
  it("FAILS the compile (error, not warning) when requireResumePoint is true and no resume point is reachable", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      docWithDurability({ resume: { requireResumePoint: true } }, [
        { type: "action", id: "s1", toolRef: "tool.run", input: {} },
      ])
    );
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected failure");
    const err = result.errors.find((e) => e.code === "RESUME_POINT_REQUIRED");
    expect(err).toBeDefined();
    expect(err?.stage).toBe(4);
  });

  it("does NOT fail when requireResumePoint is true and a resume point IS reachable", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      docWithDurability({ resume: { requireResumePoint: true } }, [
        {
          type: "action",
          id: "s1",
          toolRef: "tool.run",
          input: {},
          resumePoint: true,
        },
      ])
    );
    expect("errors" in result).toBe(false);
  });

  it("keeps DURABLE_MUTATION_NO_RESUME_POINT as a WARNING (not an error)", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      docWithDurability(
        { mode: "durable", checkpoint: { storeRef: "pg://ck" } },
        [
          {
            type: "action",
            id: "s1",
            toolRef: "tool.run",
            input: {},
            effectClass: "db_write",
            idempotency: "exactly-once-required",
          },
        ]
      )
    );
    if ("errors" in result)
      throw new Error("expected success (heuristic is advisory)");
    expect(
      result.warnings.some((w) => w.code === "DURABLE_MUTATION_NO_RESUME_POINT")
    ).toBe(true);
  });
});

describe("durability diagnostics — Slice 2 checkpoint-strategy reconciliation", () => {
  // A branch in the root escalates routing to `workflow-builder`, which emits a
  // PipelineDefinition artifact — the only artifact shape that honors
  // `checkpointStrategy` at runtime. A plain sequence routes to `skill-chain`,
  // whose artifact is intentionally NOT stamped (see the skill-chain test below).
  function pipelineDoc(
    checkpoint: Record<string, unknown> | undefined
  ): Record<string, unknown> {
    return {
      dsl: "dzupflow/v1",
      id: "slice2-strategy-test",
      version: 1,
      ...(checkpoint !== undefined ? { durability: { checkpoint } } : {}),
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "branch",
            id: "b1",
            condition: "check.ok",
            then: [
              { type: "action", id: "s1", toolRef: "tool.run", input: {} },
            ],
            else: [
              { type: "action", id: "s2", toolRef: "tool.run", input: {} },
            ],
          },
          { type: "complete", id: "done" },
        ],
      },
    };
  }

  it("stamps the runtime checkpointStrategy on a pipeline artifact for a 1:1 strategy (after_each_node)", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      pipelineDoc({ strategy: "after_each_node", storeRef: "pg://ck" })
    );
    if ("errors" in result) throw new Error("expected success");
    expect(result.target).not.toBe("skill-chain");
    expect(
      (result.artifact as Record<string, unknown>)["checkpointStrategy"]
    ).toBe("after_each_node");
    // 1:1 map is not a coarsening → no coarsening warning.
    expect(
      result.warnings.some((w) => w.code === "CHECKPOINT_STRATEGY_COARSENED")
    ).toBe(false);
  });

  it("translates explicit → manual with no coarsening warning", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      pipelineDoc({ strategy: "explicit" })
    );
    if ("errors" in result) throw new Error("expected success");
    expect(
      (result.artifact as Record<string, unknown>)["checkpointStrategy"]
    ).toBe("manual");
    expect(
      result.warnings.some((w) => w.code === "CHECKPOINT_STRATEGY_COARSENED")
    ).toBe(false);
  });

  it("coarsens after_each_effect → after_each_node AND emits the coarsening warning", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      pipelineDoc({ strategy: "after_each_effect" })
    );
    if ("errors" in result) throw new Error("expected success");
    expect(
      (result.artifact as Record<string, unknown>)["checkpointStrategy"]
    ).toBe("after_each_node");
    const warn = result.warnings.find(
      (w) => w.code === "CHECKPOINT_STRATEGY_COARSENED"
    );
    expect(warn).toBeDefined();
    expect(warn?.nodePath).toBe("root.durability.checkpoint");
    expect(warn?.message).toContain("after_each_effect");
  });

  it("coarsens after_each_branch → after_each_node AND emits the coarsening warning", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      pipelineDoc({ strategy: "after_each_branch" })
    );
    if ("errors" in result) throw new Error("expected success");
    expect(
      (result.artifact as Record<string, unknown>)["checkpointStrategy"]
    ).toBe("after_each_node");
    expect(
      result.warnings.some((w) => w.code === "CHECKPOINT_STRATEGY_COARSENED")
    ).toBe(true);
  });

  it("leaves the pipeline artifact untouched (no checkpointStrategy, no warning) when durability omits a strategy", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(pipelineDoc(undefined));
    if ("errors" in result) throw new Error("expected success");
    expect(
      "checkpointStrategy" in (result.artifact as Record<string, unknown>)
    ).toBe(false);
    expect(
      result.warnings.some((w) => w.code === "CHECKPOINT_STRATEGY_COARSENED")
    ).toBe(false);
  });

  it("emits the coarsening warning even for a skill-chain doc, but does NOT stamp the skill-chain artifact", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    // A plain sequence routes to skill-chain. The warning is target-independent
    // (author declared an unimplemented strategy), but the artifact must not be
    // stamped — skill-chain does not honor checkpointStrategy.
    const result = await compiler.compileDocument(
      baseDoc({ durability: { checkpoint: { strategy: "after_each_effect" } } })
    );
    if ("errors" in result) throw new Error("expected success");
    expect(result.target).toBe("skill-chain");
    expect(
      "checkpointStrategy" in (result.artifact as Record<string, unknown>)
    ).toBe(false);
    expect(
      result.warnings.some((w) => w.code === "CHECKPOINT_STRATEGY_COARSENED")
    ).toBe(true);
  });
});

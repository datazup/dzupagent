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
      }),
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
      baseDoc({ durability: { mode: "durable" } }),
    );
    expect("errors" in result).toBe(false);
    if ("errors" in result) throw new Error("expected success");
    expect(result.warnings.some((w) => w.code === "DURABILITY_NO_STORE")).toBe(
      true,
    );
  });

  it("does not warn when durable mode has a storeRef", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      baseDoc({
        durability: { mode: "durable", checkpoint: { storeRef: "pg://ck" } },
      }),
    );
    expect("errors" in result).toBe(false);
    if ("errors" in result) throw new Error("expected success");
    expect(result.warnings.some((w) => w.code === "DURABILITY_NO_STORE")).toBe(
      false,
    );
  });

  it("does not warn for checkpointed (non-durable) mode", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      baseDoc({ durability: { mode: "checkpointed" } }),
    );
    expect("errors" in result).toBe(false);
    if ("errors" in result) throw new Error("expected success");
    expect(result.warnings.some((w) => w.code === "DURABILITY_NO_STORE")).toBe(
      false,
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
          w.code === "IDEMPOTENCY_MODE_CONFLICT",
      ),
    ).toBe(false);
  });
});

// A document whose single action node carries the given extra fields.
function docWithActionNode(
  nodeExtra: Record<string, unknown>,
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
      docWithActionNode({ effectClass: "db_write" }),
    );
    if ("errors" in result) throw new Error("expected success");
    expect(
      result.warnings.some((w) => w.code === "MUTATING_EFFECT_NO_IDEMPOTENCY"),
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
      }),
    );
    if ("errors" in result) throw new Error("expected success");
    expect(
      result.warnings.some((w) => w.code === "MUTATING_EFFECT_NO_IDEMPOTENCY"),
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
      }),
    );
    if ("errors" in result) throw new Error("expected success");
    expect(
      result.warnings.some((w) => w.code === "MUTATING_EFFECT_NO_IDEMPOTENCY"),
    ).toBe(false);
  });

  it("does not warn for a non-mutating effectClass (read/compute)", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      docWithActionNode({ effectClass: "read" }),
    );
    if ("errors" in result) throw new Error("expected success");
    expect(
      result.warnings.some((w) => w.code === "MUTATING_EFFECT_NO_IDEMPOTENCY"),
    ).toBe(false);
  });
});

describe("durability diagnostics — D2 idempotent without output schema", () => {
  it("warns when idempotency='idempotent' but no output schema", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      docWithActionNode({ idempotency: "idempotent" }),
    );
    if ("errors" in result) throw new Error("expected success");
    expect(
      result.warnings.some((w) => w.code === "IDEMPOTENT_NO_OUTPUT_SCHEMA"),
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
      }),
    );
    if ("errors" in result) throw new Error("expected success");
    expect(
      result.warnings.some((w) => w.code === "IDEMPOTENT_NO_OUTPUT_SCHEMA"),
    ).toBe(false);
  });

  it("does not warn for at-least-once idempotency (no prior-result replay)", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tool.run"]),
    });
    const result = await compiler.compileDocument(
      docWithActionNode({ idempotency: "at-least-once" }),
    );
    if ("errors" in result) throw new Error("expected success");
    expect(
      result.warnings.some((w) => w.code === "IDEMPOTENT_NO_OUTPUT_SCHEMA"),
    ).toBe(false);
  });
});

import type { FlowNode, ResolvedTool, ToolResolver } from "@dzupagent/flow-ast";
import { InMemoryDomainToolRegistry } from "@dzupagent/app-tools";
import { describe, expect, it } from "vitest";

import { createFlowCompiler } from "../index.js";
import { semanticResolve } from "../stages/semantic.js";

/**
 * `emit` nodes parse, validate, normalize and compile cleanly, but no runtime
 * emitter for the `flow:emit` event exists — the event type is declared in the
 * OrchestrationDomainEvent union and never published by any call site. The
 * semantic stage therefore raises a compile-time policy warning so the silence
 * is loud. These tests pin that warning down.
 */

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
    listAvailable(): string[] {
      return toolRefs;
    },
  };
}

describe("emit node compile-time diagnostic (semantic stage)", () => {
  it("produces exactly one policy warning naming the event", async () => {
    const ast: FlowNode = {
      type: "emit",
      id: "notify-done",
      event: "task.completed",
    };

    const result = await semanticResolve(ast, {
      toolResolver: makeResolver([]),
    });

    const emitWarnings = result.warnings.filter((w) => w.nodeType === "emit");
    expect(emitWarnings).toHaveLength(1);

    const warning = emitWarnings[0];
    expect(warning?.code).toBe("UNIMPLEMENTED_AT_RUNTIME");
    expect(warning?.category).toBe("policy");
    // The event name must appear so the author can locate the dead node.
    expect(warning?.message).toContain("task.completed");
    expect(warning?.message).toContain("notify-done");
    expect(warning?.message).toContain("flow:emit");
    expect(warning?.message).toContain("NOT be published at runtime");
  });

  it("falls back to the event name for locatability when the node has no id", async () => {
    const ast: FlowNode = { type: "emit", event: "plan.approved" };

    const result = await semanticResolve(ast, {
      toolResolver: makeResolver([]),
    });

    const warning = result.warnings.find((w) => w.nodeType === "emit");
    expect(warning?.message).toContain("plan.approved");
  });

  it("warns once per emit node in a multi-emit flow", async () => {
    const ast: FlowNode = {
      type: "sequence",
      nodes: [
        { type: "emit", id: "first", event: "a.happened" },
        { type: "action", toolRef: "tasks.run", input: {} },
        { type: "emit", id: "second", event: "b.happened" },
      ],
    };

    const result = await semanticResolve(ast, {
      toolResolver: makeResolver(["tasks.run"]),
    });

    const emitWarnings = result.warnings.filter((w) => w.nodeType === "emit");
    expect(emitWarnings).toHaveLength(2);
    expect(emitWarnings.map((w) => w.nodePath)).toEqual([
      "root.nodes[0].event",
      "root.nodes[2].event",
    ]);
  });

  it("does NOT warn for a flow without an emit node", async () => {
    const ast: FlowNode = {
      type: "sequence",
      nodes: [
        { type: "action", toolRef: "tasks.run", input: {} },
        {
          type: "classify",
          prompt: "pick",
          choices: ["a", "b"],
          outputKey: "choice",
        },
        {
          type: "memory",
          operation: "read",
          tier: "session",
          key: "k",
          outputVar: "v",
        },
      ],
    };

    const result = await semanticResolve(ast, {
      toolResolver: makeResolver(["tasks.run"]),
    });

    expect(result.warnings.filter((w) => w.nodeType === "emit")).toHaveLength(
      0
    );
    // Sibling runtime-deferred node types must not be swept into this warning.
    expect(
      result.warnings.filter(
        (w) => w.nodeType === "classify" || w.nodeType === "memory"
      )
    ).toHaveLength(0);
  });
});

describe("emit node diagnostic is a warning, not an error", () => {
  it("does not fail compilation", async () => {
    const compiler = createFlowCompiler({
      toolResolver: makeResolver(["tasks.run"]),
    });

    const result = await compiler.compile({
      type: "sequence",
      nodes: [
        { type: "emit", id: "notify", event: "task.completed" },
        { type: "action", toolRef: "tasks.run", input: {} },
      ],
    });

    // Compile-result union: an `errors` key means the compile failed.
    expect("errors" in result).toBe(false);
    if ("errors" in result) throw new Error("expected compile success");

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "UNIMPLEMENTED_AT_RUNTIME",
          category: "policy",
          message: expect.stringContaining("task.completed"),
        }),
      ])
    );
  });

  it("still warns at the semantic stage when the emit node is the whole flow", async () => {
    // An emit-only flow lowers to zero executable nodes, so Stage 4 rejects it
    // with EMPTY_TARGET_ARTIFACT — independent of, and unrelated to, this
    // warning. Assert the semantic-stage warning directly so the two concerns
    // stay decoupled.
    const ast: FlowNode = {
      type: "emit",
      id: "lonely",
      event: "nothing.listens",
    };

    const result = await semanticResolve(ast, {
      toolResolver: makeResolver([]),
    });

    expect(result.errors).toHaveLength(0);
    expect(
      result.warnings.some((w) => w.message.includes("nothing.listens"))
    ).toBe(true);
  });

  it("an emit-only flow fails lowering for a reason unrelated to the warning", async () => {
    const compiler = createFlowCompiler({ toolResolver: makeResolver([]) });

    const result = await compiler.compile({
      type: "emit",
      id: "lonely",
      event: "nothing.listens",
    });

    // Documents the pre-existing consequence of `emit` contributing no nodes to
    // the lowered graph: there is nothing executable left to run.
    expect("errors" in result).toBe(true);
    if (!("errors" in result)) throw new Error("expected compile failure");
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "EMPTY_TARGET_ARTIFACT" }),
      ])
    );
  });
});

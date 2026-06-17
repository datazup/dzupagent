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
    const compiler = createFlowCompiler({ toolResolver: makeResolver(['tool.run']) });
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
    const compiler = createFlowCompiler({ toolResolver: makeResolver(['tool.run']) });
    const result = await compiler.compileDocument(baseDoc());
    expect("errors" in result).toBe(false);
    if ("errors" in result) throw new Error("expected success");
    expect(result.documentDurability).toBeUndefined();
  });
});

describe("durability diagnostics — D5 durable without store", () => {
  it("warns (does not error) when durable mode lacks a checkpoint storeRef", async () => {
    const compiler = createFlowCompiler({ toolResolver: makeResolver(['tool.run']) });
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
    const compiler = createFlowCompiler({ toolResolver: makeResolver(['tool.run']) });
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
    const compiler = createFlowCompiler({ toolResolver: makeResolver(['tool.run']) });
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
    const compiler = createFlowCompiler({ toolResolver: makeResolver(['tool.run']) });
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

import type {
  FlowDocumentV1,
  ResolvedTool,
  ToolResolver,
} from "@dzupagent/flow-ast";
import { describe, expect, it } from "vitest";

import { createFlowCompiler } from "../index.js";
import { inlineSubflows } from "../stages/subflow-inline.js";
import type { FlowDocumentResolver } from "../types.js";

function resolverFrom(
  documents: Record<string, FlowDocumentV1>,
): FlowDocumentResolver {
  return {
    resolve(flowRef: string) {
      return documents[flowRef] ?? null;
    },
  };
}

const toolResolver: ToolResolver = {
  resolve(ref: string): ResolvedTool {
    return {
      ref,
      kind: "skill",
      inputSchema: { type: "object" },
      handle: { skillId: ref },
    };
  },
  listAvailable: () => ["tasks.create"],
};

describe("inlineSubflows", () => {
  it("inlines a known subflow with prefixed child node ids", async () => {
    const child: FlowDocumentV1 = {
      dsl: "dzupflow/v1",
      id: "child",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "action",
            id: "create",
            toolRef: "tasks.create",
            input: {},
          },
        ],
      },
    };

    const result = await inlineSubflows(
      {
        type: "sequence",
        id: "root",
        nodes: [
          { type: "subflow", id: "child_call", flowRef: "child" },
          { type: "complete", id: "done", result: "ok" },
        ],
      },
      resolverFrom({ child }),
    );

    expect(result.root.type).toBe("sequence");
    if (result.root.type !== "sequence") {
      throw new Error("expected sequence root");
    }
    expect(result.root.nodes.map((node) => node.id)).toEqual([
      "child_call__create",
      "done",
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.subflows).toEqual([
      { flowRef: "child", instanceId: "child_call", nodePath: "root.nodes[0]" },
    ]);
  });

  it("inlines subflows inside branch bodies", async () => {
    const child: FlowDocumentV1 = {
      dsl: "dzupflow/v1",
      id: "child",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "action",
            id: "create",
            toolRef: "tasks.create",
            input: {},
          },
        ],
      },
    };

    const result = await inlineSubflows(
      {
        type: "branch",
        id: "branch",
        condition: "state.ready",
        then: [{ type: "subflow", id: "then_call", flowRef: "child" }],
        else: [{ type: "subflow", id: "else_call", flowRef: "child" }],
      },
      resolverFrom({ child }),
    );

    expect(result.root.type).toBe("branch");
    if (result.root.type !== "branch") {
      throw new Error("expected branch root");
    }
    expect(result.root.then.map((node) => node.id)).toEqual(["then_call__create"]);
    expect(result.root.else?.map((node) => node.id)).toEqual(["else_call__create"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("fails when a subflow reference cannot be resolved", async () => {
    const result = await inlineSubflows(
      {
        type: "sequence",
        id: "root",
        nodes: [{ type: "subflow", id: "missing_call", flowRef: "missing" }],
      },
      resolverFrom({}),
    );

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "UNKNOWN_SUBFLOW_REF",
        message: expect.stringContaining("missing"),
        nodePath: "root.nodes[0]",
      }),
    ]);
  });

  it("fails deterministically on subflow cycles", async () => {
    const a: FlowDocumentV1 = {
      dsl: "dzupflow/v1",
      id: "A",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [{ type: "subflow", id: "b_call", flowRef: "B" }],
      },
    };
    const b: FlowDocumentV1 = {
      dsl: "dzupflow/v1",
      id: "B",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [{ type: "subflow", id: "a_call", flowRef: "A" }],
      },
    };

    const result = await inlineSubflows(a.root, resolverFrom({ A: a, B: b }), {
      currentFlowRef: "A",
    });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "SUBFLOW_CYCLE",
        message: expect.stringContaining("A -> B -> A"),
      }),
    ]);
  });

  it("inlines subflows during compileDocument when a resolver is configured", async () => {
    const child: FlowDocumentV1 = {
      dsl: "dzupflow/v1",
      id: "child",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "action",
            id: "create",
            toolRef: "tasks.create",
            input: {},
          },
        ],
      },
    };
    const compiler = createFlowCompiler({
      toolResolver,
      flowDocumentResolver: resolverFrom({ child }),
    });

    const result = await compiler.compileDocument({
      dsl: "dzupflow/v1",
      id: "parent",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [{ type: "subflow", id: "child_call", flowRef: "child" }],
      },
    });

    expect("errors" in result).toBe(false);
    if ("errors" in result) {
      throw new Error("expected compile success");
    }
    expect(result.evidence.canonicalNodeIds).toContain("child_call__create");
    expect(result.evidence.canonicalNodeIds).not.toContain("child_call");
    expect(result.evidence.composition?.subflows).toEqual([
      { flowRef: "child", instanceId: "child_call", nodePath: "root.nodes[0]" },
    ]);
  });

  it("preserves fragment expansion metadata in compile evidence", async () => {
    const compiler = createFlowCompiler({ toolResolver });

    const result = await compiler.compileDocument({
      dsl: "dzupflow/v1",
      id: "fragment_evidence",
      version: 1,
      meta: {
        fragmentExpansions: [
          {
            id: "sdlc.validation_gate",
            version: 1,
            namespace: "sdlc",
            catalogRef: "dzup.sdlc@1",
            instanceId: "validation",
            invocationPath: "steps[0]",
            expandedPaths: ["steps[0].fragment[0]"],
            exports: {
              status: "{{ state.validation__status }}",
            },
          },
        ],
      },
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "action",
            id: "validation__run",
            toolRef: "tasks.create",
            input: {},
          },
        ],
      },
    });

    expect("errors" in result).toBe(false);
    if ("errors" in result) {
      throw new Error("expected compile success");
    }
    expect(result.evidence.composition?.fragments).toEqual([
      expect.objectContaining({
        id: "sdlc.validation_gate",
        catalogRef: "dzup.sdlc@1",
        instanceId: "validation",
      }),
    ]);
  });
});

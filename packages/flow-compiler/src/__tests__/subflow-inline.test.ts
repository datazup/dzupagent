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

  it("rewrites inlined subflow-local state template references", async () => {
    const child: FlowDocumentV1 = {
      dsl: "dzupflow/v1",
      id: "child",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          { type: "action", id: "produce", toolRef: "tasks.create", input: {}, outputKey: "taskResult" } as unknown as FlowDocumentV1["root"]["nodes"][number],
          {
            type: "action",
            id: "consume",
            toolRef: "tasks.create",
            input: { task: "{{ state.taskResult }}" },
          },
        ],
      },
    };

    const result = await inlineSubflows(
      {
        type: "sequence",
        id: "root",
        nodes: [{ type: "subflow", id: "child_call", flowRef: "child" }],
      },
      resolverFrom({ child }),
    );

    expect(result.root.type).toBe("sequence");
    if (result.root.type !== "sequence") throw new Error("expected sequence");
    expect(result.root.nodes[1]).toMatchObject({
      input: { task: "{{ state.child_call__taskResult }}" },
    });
  });

  it("rewrites templated state-key fields through template rewriting", async () => {
    const child: FlowDocumentV1 = {
      dsl: "dzupflow/v1",
      id: "child",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          { type: "action", id: "produce", toolRef: "tasks.create", input: {}, outputKey: "taskResult" } as unknown as FlowDocumentV1["root"]["nodes"][number],
          {
            type: "evidence.write",
            id: "write_evidence",
            output: "evidenceRef",
            source: "{{ state.taskResult.status }}",
          },
        ],
      },
    };

    const result = await inlineSubflows(
      {
        type: "sequence",
        id: "root",
        nodes: [{ type: "subflow", id: "child_call", flowRef: "child" }],
      },
      resolverFrom({ child }),
    );

    expect(result.root.type).toBe("sequence");
    if (result.root.type !== "sequence") throw new Error("expected sequence");
    expect(result.root.nodes[1]).toMatchObject({
      source: "{{ state.child_call__taskResult.status }}",
    });
  });

  it("rewrites inlined subflow agent output keys", async () => {
    const child: FlowDocumentV1 = {
      dsl: "dzupflow/v1alpha-agent",
      id: "child",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "agent",
            id: "plan",
            agentId: "planner",
            instructions: "Plan from {{ state.request }}",
            output: { key: "plan", schemaRef: "plan.v1" },
          },
        ],
      },
    };

    const result = await inlineSubflows(
      {
        type: "sequence",
        id: "root",
        nodes: [{ type: "subflow", id: "child_call", flowRef: "child" }],
      },
      resolverFrom({ child }),
    );

    expect(result.root.type).toBe("sequence");
    if (result.root.type !== "sequence") throw new Error("expected sequence");
    expect(result.root.nodes[0]).toMatchObject({
      id: "child_call__plan",
      instructions: "Plan from {{ state.child_call__request }}",
      output: { key: "child_call__plan", schemaRef: "plan.v1" },
    });
  });

  it("rewrites inlined subflow loop and SPDD state keys", async () => {
    const child: FlowDocumentV1 = {
      dsl: "dzupflow/v1",
      id: "child",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "loop",
            id: "poll",
            condition: "{{ state.keepPolling }}",
            progressKey: "pollProgress",
            body: [{ type: "complete", id: "poll_done" }],
          },
          {
            type: "spdd.build_source_pack",
            id: "build_pack",
            spddRunId: "run-1",
            sourceRefsKey: "sourceRefs",
            outputKey: "sourcePack",
          },
          {
            type: "spdd.create_sync_proposal",
            id: "sync",
            spddRunId: "run-1",
            driftFindingIdsKey: "driftFindingIds",
            outputKey: "syncProposal",
          },
        ],
      },
    };

    const result = await inlineSubflows(
      {
        type: "sequence",
        id: "root",
        nodes: [{ type: "subflow", id: "child_call", flowRef: "child" }],
      },
      resolverFrom({ child }),
    );

    expect(result.root.type).toBe("sequence");
    if (result.root.type !== "sequence") throw new Error("expected sequence");
    expect(result.root.nodes).toEqual([
      expect.objectContaining({
        id: "child_call__poll",
        progressKey: "child_call__pollProgress",
        condition: "{{ state.child_call__keepPolling }}",
      }),
      expect.objectContaining({
        id: "child_call__build_pack",
        sourceRefsKey: "child_call__sourceRefs",
        outputKey: "child_call__sourcePack",
      }),
      expect.objectContaining({
        id: "child_call__sync",
        driftFindingIdsKey: "child_call__driftFindingIds",
        outputKey: "child_call__syncProposal",
      }),
    ]);
  });

  it("rewrites inlined subflow set assign keys and try_catch errorVar", async () => {
    const child: FlowDocumentV1 = {
      dsl: "dzupflow/v1",
      id: "child",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "set",
            id: "record",
            assign: { status: "ready" },
          },
          {
            type: "try_catch",
            id: "recover",
            body: [{ type: "complete", id: "attempt" }],
            catch: [{ type: "complete", id: "caught" }],
            errorVar: "lastError",
          },
        ],
      },
    };

    const result = await inlineSubflows(
      {
        type: "sequence",
        id: "root",
        nodes: [{ type: "subflow", id: "child_call", flowRef: "child" }],
      },
      resolverFrom({ child }),
    );

    expect(result.root.type).toBe("sequence");
    if (result.root.type !== "sequence") throw new Error("expected sequence");
    expect(result.root.nodes[0]).toEqual({
      type: "set",
      id: "child_call__record",
      assign: { child_call__status: "ready" },
    });
    expect(result.root.nodes[1]).toMatchObject({
      id: "child_call__recover",
      errorVar: "child_call__lastError",
    });
  });

  it("does not rewrite non-state source fields during subflow inlining", async () => {
    const child: FlowDocumentV1 = {
      dsl: "dzupflow/v1",
      id: "child",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "fleet.gather",
            id: "gather",
            source: "fleet.dispatch",
            output: "fleetResults",
          },
          {
            type: "evidence.write",
            id: "write_evidence",
            source: "fleetResults",
            output: "evidenceRef",
          },
        ],
      },
    };

    const result = await inlineSubflows(
      {
        type: "sequence",
        id: "root",
        nodes: [{ type: "subflow", id: "child_call", flowRef: "child" }],
      },
      resolverFrom({ child }),
    );

    expect(result.root.type).toBe("sequence");
    if (result.root.type !== "sequence") throw new Error("expected sequence");
    expect(result.root.nodes[0]).toMatchObject({
      id: "child_call__gather",
      source: "fleet.dispatch",
      output: "child_call__fleetResults",
    });
    expect(result.root.nodes[1]).toMatchObject({
      id: "child_call__write_evidence",
      source: "child_call__fleetResults",
      output: "child_call__evidenceRef",
    });
  });

  it("does not treat nested typed data payloads as subflow nodes", async () => {
    const child: FlowDocumentV1 = {
      dsl: "dzupflow/v1",
      id: "child",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "adapter.run",
            id: "summarize",
            provider: "claude",
            instructions: "Summarize",
            input: {
              payload: {
                type: "evidence.write",
                id: "external-id",
                source: "externalEvidence",
                output: "rawArtifact",
              },
            },
            meta: {
              type: "evidence.write",
              id: "metadata-id",
              source: "dsl",
              output: "metadata",
            },
            output: "summary",
          },
        ],
      },
    };

    const result = await inlineSubflows(
      {
        type: "sequence",
        id: "root",
        nodes: [{ type: "subflow", id: "child_call", flowRef: "child" }],
      },
      resolverFrom({ child }),
    );

    expect(result.root.type).toBe("sequence");
    if (result.root.type !== "sequence") throw new Error("expected sequence");
    expect(result.root.nodes[0]).toMatchObject({
      id: "child_call__summarize",
      input: {
        payload: {
          type: "evidence.write",
          id: "external-id",
          source: "externalEvidence",
          output: "rawArtifact",
        },
      },
      meta: {
        type: "evidence.write",
        id: "metadata-id",
        source: "dsl",
        output: "metadata",
      },
      output: "child_call__summary",
    });
  });

  it("rewrites inlined subflow node id and checkpoint label references", async () => {
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
            id: "produce",
            toolRef: "tasks.create",
            input: {},
            outputKey: "taskResult",
          } as unknown as FlowDocumentV1["root"]["nodes"][number],
          {
            type: "checkpoint",
            id: "capture_task",
            captureOutputOf: "produce",
            label: "after_task",
          },
          {
            type: "restore",
            id: "restore_task",
            checkpointLabel: "after_task",
          },
          {
            type: "return_to",
            id: "retry_task",
            targetId: "produce",
            condition: "{{ state.shouldRetry }}",
          },
        ],
      },
    };

    const result = await inlineSubflows(
      {
        type: "sequence",
        id: "root",
        nodes: [{ type: "subflow", id: "child_call", flowRef: "child" }],
      },
      resolverFrom({ child }),
    );

    expect(result.root.type).toBe("sequence");
    if (result.root.type !== "sequence") throw new Error("expected sequence");
    expect(result.root.nodes[1]).toMatchObject({
      id: "child_call__capture_task",
      captureOutputOf: "child_call__produce",
      label: "child_call__after_task",
    });
    expect(result.root.nodes[2]).toMatchObject({
      id: "child_call__restore_task",
      checkpointLabel: "child_call__after_task",
    });
    expect(result.root.nodes[3]).toMatchObject({
      id: "child_call__retry_task",
      targetId: "child_call__produce",
      condition: "{{ state.child_call__shouldRetry }}",
    });
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
          {
            type: "checkpoint",
            id: "validation__capture",
            captureOutputOf: "validation__run",
            label: "validation__after_run",
          },
          {
            type: "restore",
            id: "validation__restore",
            checkpointLabel: "validation__after_run",
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
        version: 1,
        catalogRef: "dzup.sdlc@1",
        instanceId: "validation",
        invocationPath: "steps[0]",
        expandedPaths: ["steps[0].fragment[0]"],
        exports: {
          status: "{{ state.validation__status }}",
        },
      }),
    ]);
    expect(result.evidence.canonicalNodeIds).toEqual(
      expect.arrayContaining([
        "validation__run",
        "validation__capture",
        "validation__restore",
      ]),
    );
    expect(result.evidence.canonicalNodePaths).toMatchObject({
      "root.nodes[1]": {
        type: "checkpoint",
        id: "validation__capture",
      },
      "root.nodes[2]": {
        type: "restore",
        id: "validation__restore",
      },
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  InMemoryPipelineCheckpointStore,
  PipelineRuntime,
  type NodeExecutor,
} from "@dzupagent/agent";
import type {
  PipelineCheckpoint,
  PipelineDefinition,
} from "@dzupagent/core/pipeline";
import {
  FLOW_TYPED_CONDITION_CAPABILITY,
  createFlowCompiler,
  createTypedLoopPredicates,
} from "@dzupagent/flow-compiler";
import { createPipelineInteractionResumeV1 } from "@dzupagent/runtime-contracts";

const targetCapabilities = [FLOW_TYPED_CONDITION_CAPABILITY] as const;
const toolNames = ["tasks.prepare", "tasks.reject", "tasks.after"] as const;

const toolResolver = {
  resolve(ref: string) {
    if (!toolNames.includes(ref as (typeof toolNames)[number])) return null;
    return {
      ref,
      kind: "skill" as const,
      inputSchema: { type: "object" },
      handle: {
        name: ref,
        description: `test tool ${ref}`,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        permissionLevel: "read" as const,
        sideEffects: [],
        namespace: "tasks",
      },
    };
  },
  listAvailable: () => [...toolNames],
};

describe("public compiler/runtime interaction agreement", () => {
  it("recovers a committed approval receipt without replaying its prefix or outer continuation", async () => {
    const definition = await compileInteractionLoop();
    const loop = definition.nodes.find((node) => node.type === "loop");
    const gate = definition.nodes.find(
      (node) => node.type === "gate" && node.interaction?.kind === "approval",
    );
    expect(loop?.type).toBe("loop");
    expect(gate?.type).toBe("gate");
    if (loop?.type !== "loop" || gate?.type !== "gate") return;
    expect(loop.bodyGraph?.suspensionSiteNodeIds).toContain(gate.id);
    expect(loop.bodyGraph?.suspendedExitNodeIds).not.toContain(gate.id);

    const checkpointStore = new InteractionSaveThenThrowStore();
    const toolCalls: string[] = [];
    const firstRuntime = runtimeFor(definition, checkpointStore, toolCalls);
    const suspended = await firstRuntime.execute(undefined, {
      runId: "compiled-interaction-restart",
    });
    expect(suspended.state).toBe("suspended");
    expect(toolCalls).toEqual(["tasks.prepare"]);
    const checkpoint = (await checkpointStore.load(suspended.runId))!;
    const pending = checkpoint.pendingInteraction!;

    await expect(firstRuntime.resume(checkpoint, { approved: true })).resolves
      .toMatchObject({ state: "suspended" });
    expect(toolCalls).toEqual(["tasks.prepare"]);

    const receipt = createPipelineInteractionResumeV1({
      ...pending,
      receiptId: "compiled-approval-receipt",
      submittedAt: "2026-08-14T20:00:01.000Z",
      response: { kind: "approval", decision: "approved" },
    });
    await expect(
      firstRuntime.resumeInteraction(checkpoint, receipt),
    ).rejects.toThrow("simulated committed interaction transport failure");
    expect(toolCalls).toEqual(["tasks.prepare"]);

    const restartedRuntime = runtimeFor(
      definition,
      checkpointStore,
      toolCalls,
    );
    await expect(
      restartedRuntime.resumeInteraction(checkpoint, receipt),
    ).resolves.toMatchObject({ state: "completed" });
    expect(toolCalls).toEqual(["tasks.prepare"]);

    const finalCheckpoint = (await checkpointStore.load(suspended.runId))!;
    expect(finalCheckpoint.pendingInteraction).toBeUndefined();
    expect(finalCheckpoint.interactionResumeCursor).toBeUndefined();
    expect(finalCheckpoint.interactionReceipts?.[pending.interactionId]).toEqual(
      receipt,
    );
    expect(finalCheckpoint.completedNodeIds).toContain(loop.id);
    expect(
      definition.nodes.find(
        (node) => node.type === "tool" && node.toolName === "tasks.after",
      )?.id,
    ).not.toSatisfy((nodeId: string | undefined) =>
      nodeId === undefined
        ? false
        : finalCheckpoint.completedNodeIds.includes(nodeId),
    );

    await restartedRuntime.resumeInteraction(checkpoint, receipt);
    expect(toolCalls).toEqual(["tasks.prepare"]);
  });
});

async function compileInteractionLoop(): Promise<PipelineDefinition> {
  const compiled = await createFlowCompiler({
    toolResolver,
    targetCapabilities,
  }).compileDocument({
    dsl: "dzupflow/v1",
    id: "interaction-compile-to-run",
    version: 1,
    root: {
      type: "sequence",
      id: "root",
      nodes: [
        {
          type: "loop",
          id: "reviewLoop",
          condition: "false",
          typedCondition: {
            schema: "dzupagent.flowTypedCondition/v1",
            expression: { op: "literal", value: false },
          },
          maxIterations: 2,
          body: [
            {
              type: "action",
              id: "prepare",
              toolRef: "tasks.prepare",
              input: {},
            },
            {
              type: "approval",
              id: "review",
              question: "Ship?",
              onApprove: [
                {
                  type: "complete",
                  id: "approvedTerminal",
                  result: "approved",
                },
              ],
              onReject: [
                {
                  type: "action",
                  id: "reject",
                  toolRef: "tasks.reject",
                  input: {},
                },
              ],
            },
          ],
        },
        {
          type: "action",
          id: "after",
          toolRef: "tasks.after",
          input: {},
        },
      ],
    },
  });
  expect("errors" in compiled ? JSON.stringify(compiled.errors) : "ok").toBe(
    "ok",
  );
  if ("errors" in compiled) throw new Error(JSON.stringify(compiled.errors));
  return {
    ...(compiled.artifact as PipelineDefinition),
    checkpointStrategy: "after_each_node",
  };
}

function runtimeFor(
  definition: PipelineDefinition,
  checkpointStore: InMemoryPipelineCheckpointStore,
  toolCalls: string[],
): PipelineRuntime {
  const predicates = createTypedLoopPredicates(definition.nodes, {
    hostCapabilities: targetCapabilities,
  });
  for (const node of definition.nodes) {
    if (node.type === "gate" && node.interaction?.kind === "approval") {
      const edge = definition.edges.find(
        (candidate) =>
          candidate.type === "conditional" &&
          candidate.sourceNodeId === node.id,
      );
      if (edge?.type === "conditional") {
        predicates[edge.predicateName] = () => {
          throw new Error("approval predicate must not run");
        };
      }
    }
  }
  const nodeExecutor: NodeExecutor = async (nodeId, node) => {
    if (node.type === "tool") toolCalls.push(node.toolName);
    return { nodeId, output: node.id, durationMs: 1 };
  };
  return new PipelineRuntime({
    definition,
    checkpointStore,
    predicates,
    nodeExecutor,
    interaction: { now: () => new Date("2026-08-14T20:00:00.000Z") },
  });
}

class InteractionSaveThenThrowStore extends InMemoryPipelineCheckpointStore {
  private failed = false;

  override async save(checkpoint: PipelineCheckpoint): Promise<void> {
    if (!this.failed && checkpoint.interactionResumeCursor !== undefined) {
      this.failed = true;
      await super.save(checkpoint);
      throw new Error("simulated committed interaction transport failure");
    }
    await super.save(checkpoint);
  }
}

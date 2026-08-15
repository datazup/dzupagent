import { describe, expect, it, vi } from "vitest";

import type {
  LoopNode,
  PipelineCheckpoint,
  PipelineCheckpointStore,
  PipelineDefinition,
  PipelineEdge,
  PipelineNode,
} from "@dzupagent/core/pipeline";
import type { PipelineInteractionResumeV1 } from "@dzupagent/runtime-contracts";

import { executeLoop } from "../pipeline/loop-executor.js";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { validatePipeline } from "../pipeline/pipeline-validator.js";

function sequentialDefinition(): PipelineDefinition {
  return {
    id: "for-each-admission",
    name: "ForEachAdmission",
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
          source: "$.items",
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

function rawDefinition(input: {
  concurrency?: number;
  bodyNodes?: PipelineNode[];
  bodyNodeIds?: string[];
  bodyGraph?: LoopNode["bodyGraph"];
  edges?: PipelineEdge[];
} = {}): PipelineDefinition {
  const definition = structuredClone(sequentialDefinition()) as unknown as {
    nodes: Array<Record<string, unknown>>;
    edges: PipelineEdge[];
  };
  const bodyNodes = input.bodyNodes ?? [
    { id: "work", type: "agent", agentId: "worker" },
  ];
  const loop = definition.nodes[0]!;
  loop.bodyNodeIds = input.bodyNodeIds ?? bodyNodes.map((node) => node.id);
  if (input.bodyGraph !== undefined) loop.bodyGraph = input.bodyGraph;
  const forEach = loop.forEach as { concurrency: number };
  forEach.concurrency = input.concurrency ?? 1;
  definition.nodes = [loop, ...bodyNodes] as unknown as Array<Record<string, unknown>>;
  definition.edges = input.edges ?? [];
  return definition as unknown as PipelineDefinition;
}

function checkpoint(): PipelineCheckpoint {
  return {
    pipelineRunId: "run-items",
    pipelineId: "for-each-admission",
    version: 1,
    schemaVersion: "1.0.0",
    completedNodeIds: [],
    state: { items: ["a", "b"] },
    createdAt: new Date(0).toISOString(),
  };
}

describe("for_each runtime admission", () => {
  it("rejects raw concurrent definitions with the stable code", () => {
    const result = validatePipeline(rawDefinition({ concurrency: 2 }));

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "FOR_EACH_CONCURRENCY_UNSUPPORTED",
          nodeId: "items",
        }),
      ])
    );
  });

  it("protects every public lifecycle entry before executor or store access", async () => {
    const nodeExecutor = vi.fn();
    const store: PipelineCheckpointStore = {
      save: vi.fn(),
      load: vi.fn(),
      loadVersion: vi.fn(),
      listVersions: vi.fn(),
      delete: vi.fn(),
      prune: vi.fn(),
    };
    const runtime = new PipelineRuntime({
      definition: rawDefinition({ concurrency: 2 }),
      nodeExecutor,
      checkpointStore: store,
    });

    await expect(runtime.execute({ items: ["a"] })).rejects.toThrow(
      "for_each concurrency must be 1"
    );
    await expect(runtime.resume(checkpoint())).rejects.toThrow(
      "for_each concurrency must be 1"
    );
    await expect(
      runtime.resumeInteraction(
        checkpoint(),
        {} as PipelineInteractionResumeV1
      )
    ).rejects.toThrow("for_each concurrency must be 1");
    await expect(runtime.recoverAfterProcessRestart("run-items")).rejects.toThrow(
      "for_each concurrency must be 1"
    );

    expect(nodeExecutor).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    expect(store.load).not.toHaveBeenCalled();
    expect(store.loadVersion).not.toHaveBeenCalled();
    expect(store.listVersions).not.toHaveBeenCalled();
    expect(store.delete).not.toHaveBeenCalled();
    expect(store.prune).not.toHaveBeenCalled();
  });

  it("protects the public executeLoop bypass before item dispatch", async () => {
    const definition = rawDefinition({ concurrency: 2 });
    const loop = definition.nodes[0] as LoopNode;
    const body = definition.nodes[1]!;
    const executor = vi.fn();

    const { result, metrics } = await executeLoop(
      loop,
      [body],
      executor,
      { state: { items: ["a", "b"] }, previousResults: new Map() },
      {}
    );

    expect(result.error).toContain("for_each concurrency must be 1");
    expect(metrics.iterationCount).toBe(0);
    expect(executor).not.toHaveBeenCalled();
  });

  it.each([
    [
      "graph body",
      rawDefinition({
        bodyGraph: {
          entryNodeId: "work",
          normalExitNodeIds: ["work"],
          suspendedExitNodeIds: [],
          terminalExitNodeIds: [],
          errorExitNodeIds: [],
        },
      }),
      "FOR_EACH_RECURSIVE_CONTROL_UNSUPPORTED",
    ],
    [
      "gate body",
      rawDefinition({
        bodyNodes: [{ id: "decision", type: "gate", gateType: "quality" }],
      }),
      "FOR_EACH_RECURSIVE_CONTROL_UNSUPPORTED",
    ],
    [
      "approval body",
      rawDefinition({
        bodyNodes: [{ id: "review", type: "gate", gateType: "approval" }],
      }),
      "FOR_EACH_INTERACTION_UNSUPPORTED",
    ],
    [
      "terminal body",
      rawDefinition({ bodyNodes: [{ id: "done", type: "suspend" }] }),
      "FOR_EACH_TERMINAL_UNSUPPORTED",
    ],
    [
      "nested loop body",
      rawDefinition({
        bodyNodes: [
          {
            id: "nested",
            type: "loop",
            bodyNodeIds: ["nested-work"],
            maxIterations: 2,
            continuePredicateName: "again",
          },
          { id: "nested-work", type: "agent", agentId: "nested-worker" },
        ],
        bodyNodeIds: ["nested"],
      }),
      "FOR_EACH_RECURSIVE_CONTROL_UNSUPPORTED",
    ],
    [
      "conditional body edge",
      rawDefinition({
        bodyNodes: [
          { id: "first", type: "agent", agentId: "first" },
          { id: "second", type: "agent", agentId: "second" },
        ],
        edges: [
          {
            type: "conditional",
            sourceNodeId: "first",
            predicateName: "choose",
            branches: { true: "second" },
          },
        ],
      }),
      "FOR_EACH_RECURSIVE_CONTROL_UNSUPPORTED",
    ],
  ] as const)("rejects %s", (_name, definition, code) => {
    expect(validatePipeline(definition).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code })])
    );
  });

  it("keeps legacy sequential leaf inventories without redundant edges valid", () => {
    const definition = rawDefinition({
      bodyNodes: [
        { id: "first", type: "agent", agentId: "first" },
        { id: "second", type: "transform", transformName: "second" },
      ],
    });

    expect(validatePipeline(definition).valid).toBe(true);
  });
});

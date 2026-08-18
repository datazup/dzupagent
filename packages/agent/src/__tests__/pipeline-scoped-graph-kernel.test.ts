import { createHash } from "node:crypto";

import type {
  LoopNode,
  PipelineDefinition,
  PipelineEdge,
  PipelineNode,
} from "@dzupagent/core/pipeline";
import { describe, expect, it } from "vitest";

import { loopBoundary } from "../pipeline/loop-body-graph-checkpoint-validator.js";
import {
  scheduleLoopBodyGraph,
} from "../pipeline/loop-executor/graph-scheduler/schedule-loop-body-graph.js";
import type { LoopBodyGraphCheckpointState } from "../pipeline/loop-executor/types.js";
import type {
  ScopedGraphExecutorCoordinator,
  ScopedGraphFrameCodec,
} from "../pipeline/scoped-graph/contract.js";
import { executeScopedGraph } from "../pipeline/scoped-graph/execute-scoped-graph.js";
import type { RunFrame } from "../pipeline/pipeline-runtime/stage-dispatch.js";
import type {
  PipelineRuntimeConfig,
  PipelineRunResult,
} from "../pipeline/pipeline-runtime-types.js";

const bodyNode: PipelineNode = {
  id: "body",
  type: "agent",
  agentId: "body-agent",
};

const loopNode: LoopNode = {
  id: "loop",
  type: "loop",
  bodyNodeIds: [bodyNode.id],
  bodyGraph: {
    entryNodeId: bodyNode.id,
    normalExitNodeIds: [bodyNode.id],
    suspendedExitNodeIds: [],
    terminalExitNodeIds: [],
    errorExitNodeIds: [],
  },
  maxIterations: 1,
  continuePredicateName: "once",
};

const definition: PipelineDefinition = {
  id: "scoped-kernel-fixture",
  name: "Scoped kernel fixture",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  entryNodeId: loopNode.id,
  nodes: [loopNode, bodyNode],
  edges: [],
};

const codec: ScopedGraphFrameCodec<LoopBodyGraphCheckpointState> = {
  decode: (frame) => frame,
  encode: (frame) => frame,
};

function frame(): RunFrame {
  return {
    runId: "run",
    runState: {},
    nodeResults: new Map(),
    completedNodeIds: [],
    nodeIdempotencyKeys: {},
    loopState: {},
    forkState: {},
    eventLog: [],
    versionTracker: { version: 0 },
    interactionReceipts: {},
    startTime: 0,
  };
}

function deps(counter: { dispatches: number }) {
  const budget = {
    cumulativeCostCents: 0,
    warnings: { warn70: false, warn90: false },
  };
  const coordinator: ScopedGraphExecutorCoordinator = {
    getState: () => "running",
    setState: () => undefined,
    getRecoveryAttemptsUsed: () => 0,
    incrementRecoveryAttempts: () => 1,
    getBudgetTracker: () => budget,
  };

  class OneNodeExecutor {
    private readonly checkpointOverride:
      | ((runFrame: RunFrame, selectedNextNodeId?: string) => Promise<void>)
      | undefined;

    constructor(
      _config: PipelineRuntimeConfig,
      _nodeMap: Map<string, PipelineNode>,
      _outgoingEdges: Map<string, PipelineEdge[]>,
      _errorEdges: Map<string, PipelineEdge[]>,
      _coordinator: ScopedGraphExecutorCoordinator,
      checkpointOverride?: (
        runFrame: RunFrame,
        selectedNextNodeId?: string
      ) => Promise<void>
    ) {
      this.checkpointOverride = checkpointOverride;
    }

    async executeFromNode(
      runFrame: RunFrame & { startNodeId: string }
    ): Promise<PipelineRunResult> {
      counter.dispatches += 1;
      runFrame.completedNodeIds.push(runFrame.startNodeId);
      runFrame.nodeResults.set(runFrame.startNodeId, {
        nodeId: runFrame.startNodeId,
        output: "ok",
        durationMs: 1,
      });
      await this.checkpointOverride?.(runFrame);
      return {
        pipelineId: definition.id,
        runId: runFrame.runId,
        state: "completed",
        nodeResults: runFrame.nodeResults,
        totalDurationMs: 1,
      };
    }
  }

  const config: PipelineRuntimeConfig = {
    definition,
    nodeExecutor: async (nodeId) => ({
      nodeId,
      output: "unused",
      durationMs: 0,
    }),
  };
  return { config, coordinator, Executor: OneNodeExecutor };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("W3-A scoped graph kernel", () => {
  it("matches the legacy loop adapter and preserves checkpoint bytes", async () => {
    const adapterCounter = { dispatches: 0 };
    const kernelCounter = { dispatches: 0 };
    const adapterFrames: string[] = [];
    const kernelFrames: string[] = [];
    const context = { state: {}, previousResults: new Map() };

    const adapterResult = await scheduleLoopBodyGraph(
      deps(adapterCounter),
      loopNode,
      frame(),
      {
        iteration: 0,
        context,
        onCheckpoint: async (checkpoint) => {
          adapterFrames.push(JSON.stringify(checkpoint));
        },
      }
    );
    const kernelResult = await executeScopedGraph(
      deps(kernelCounter),
      loopBoundary(loopNode, definition.id),
      frame(),
      {
        scopedRunId: "run::loop:loop:iteration:0",
        context: { state: {}, previousResults: new Map() },
        onCheckpoint: async (checkpoint) => {
          kernelFrames.push(JSON.stringify(checkpoint));
        },
      },
      codec
    );

    expect(adapterCounter.dispatches).toBe(1);
    expect(kernelCounter.dispatches).toBe(1);
    expect(kernelResult.outcome).toEqual(adapterResult.outcome);
    expect([...kernelResult.nodeResults]).toEqual([...adapterResult.bodyResults]);
    expect(kernelFrames).toEqual(adapterFrames);
    expect(kernelFrames).toHaveLength(1);
    expect(digest(kernelFrames[0]!)).toBe(digest(adapterFrames[0]!));
    expect(kernelFrames[0]).toBe(
      '{"completed":true,"outcome":{"kind":"normal","exitNodeId":"body"},"completedNodeIds":["body"],"nodeResults":{"body":{"nodeId":"body","output":"ok","durationMs":1}},"nodeIdempotencyKeys":{}}'
    );
  });

  it("rejects definition drift before constructing or dispatching work", async () => {
    const counter = { dispatches: 0 };
    await expect(
      executeScopedGraph(
        deps(counter),
        {
          ...loopBoundary(loopNode, definition.id),
          sourceDefinitionId: "different-definition",
        },
        frame(),
        {
          scopedRunId: "run::scope",
          context: { state: {}, previousResults: new Map() },
        },
        codec
      )
    ).rejects.toThrow(/definition binding mismatch/);
    expect(counter.dispatches).toBe(0);
  });

  it("rejects a corrupt generic cursor before dispatch", async () => {
    const counter = { dispatches: 0 };
    await expect(
      executeScopedGraph(
        deps(counter),
        loopBoundary(loopNode, definition.id),
        frame(),
        {
          scopedRunId: "run::scope",
          context: { state: {}, previousResults: new Map() },
          resumeFrame: {
            completed: false,
            nextNodeId: "outside",
            completedNodeIds: [],
            nodeResults: {},
            nodeIdempotencyKeys: {},
          },
        },
        codec
      )
    ).rejects.toThrow(/outside bodyNodeIds/);
    expect(counter.dispatches).toBe(0);
  });
});

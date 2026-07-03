import { describe, expect, it } from "vitest";
import type { PipelineCheckpoint, PipelineDefinition } from "@dzupagent/core";
import { InMemoryPipelineCheckpointStore } from "../pipeline/in-memory-checkpoint-store.js";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import type {
  NodeExecutor,
  PipelineExecutionLogEntry,
  PipelineExecutionLogStore,
  PipelineRuntimeEvent,
} from "../pipeline/pipeline-runtime-types.js";

function linearPipeline(
  overrides: Partial<PipelineDefinition> = {},
): PipelineDefinition {
  return {
    id: "w1-runtime-pipe",
    name: "W1 Runtime Pipe",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "a",
    checkpointStrategy: "after_each_node",
    nodes: [
      { id: "a", type: "agent", agentId: "agent-a" },
      { id: "b", type: "agent", agentId: "agent-b" },
      { id: "c", type: "agent", agentId: "agent-c" },
    ],
    edges: [
      { type: "sequential", sourceNodeId: "a", targetNodeId: "b" },
      { type: "sequential", sourceNodeId: "b", targetNodeId: "c" },
    ],
    ...overrides,
  };
}

function executorWithRuns(runs: string[] = []): NodeExecutor {
  return async (nodeId, _node, ctx) => {
    runs.push(nodeId);
    ctx.state[`seen_${nodeId}`] = true;
    return { nodeId, output: `out-${nodeId}`, durationMs: 1 };
  };
}

describe("PipelineRuntime W1 durability policy", () => {
  it("resolves checkpoint.storeRef from the runtime checkpointStores registry", async () => {
    const selected = new InMemoryPipelineCheckpointStore();
    const fallback = new InMemoryPipelineCheckpointStore();
    const runtime = new PipelineRuntime({
      definition: linearPipeline({
        checkpoint: { storeRef: "primary" },
      }),
      nodeExecutor: executorWithRuns(),
      checkpointStore: fallback,
      checkpointStores: { primary: selected },
    });

    const result = await runtime.execute();

    expect(await selected.load(result.runId)).toBeDefined();
    expect(await fallback.load(result.runId)).toBeUndefined();
  });

  it("enforces checkpoint.retention.maxVersions after each save", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const runtime = new PipelineRuntime({
      definition: linearPipeline({
        checkpoint: { retention: { maxVersions: 2 } },
      }),
      nodeExecutor: executorWithRuns(),
      checkpointStore: store,
    });

    const result = await runtime.execute();
    const versions = await store.listVersions(result.runId);

    expect(versions.map((v) => v.version)).toEqual([2, 3]);
  });

  it("enforces checkpoint.retention.ttlMs by pruning old checkpoints", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    await store.save({
      pipelineRunId: "old-run",
      pipelineId: "old-pipe",
      version: 1,
      schemaVersion: "1.0.0",
      completedNodeIds: ["old"],
      state: {},
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const runtime = new PipelineRuntime({
      definition: linearPipeline({
        checkpoint: { retention: { ttlMs: 1_000 } },
      }),
      nodeExecutor: executorWithRuns(),
      checkpointStore: store,
    });

    const result = await runtime.execute();

    expect(await store.load("old-run")).toBeUndefined();
    expect(await store.load(result.runId)).toBeDefined();
  });

  it("embeds runtime events in checkpoints when checkpoint.includeEvents is true", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const externalEvents: PipelineRuntimeEvent[] = [];
    const runtime = new PipelineRuntime({
      definition: linearPipeline({
        checkpoint: { includeEvents: true },
      }),
      nodeExecutor: executorWithRuns(),
      checkpointStore: store,
      onEvent: (event) => externalEvents.push(event),
    });

    const result = await runtime.execute();
    const checkpoint = await store.load(result.runId);

    expect(externalEvents.length).toBeGreaterThan(0);
    expect(checkpoint?.events?.map((event) => event.type)).toContain(
      "pipeline:started",
    );
    expect(checkpoint?.events?.map((event) => event.type)).toContain(
      "pipeline:node_completed",
    );
  });

  it("embeds provider session refs when checkpoint.includeProviderSessionRefs is true", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const runtime = new PipelineRuntime({
      definition: linearPipeline({
        checkpoint: { includeProviderSessionRefs: true },
      }),
      nodeExecutor: async (nodeId, _node, ctx) => {
        ctx.state[`seen_${nodeId}`] = true;
        return {
          nodeId,
          output: `out-${nodeId}`,
          durationMs: 1,
          providerSessionRefs:
            nodeId === "a"
              ? [
                  {
                    provider: "openai",
                    sessionId: "sess-a",
                    metadata: { threadId: "thread-a" },
                  },
                ]
              : [],
        } as Awaited<ReturnType<NodeExecutor>>;
      },
      checkpointStore: store,
    });

    const result = await runtime.execute();
    const checkpoint: PipelineCheckpoint | undefined = await store.load(
      result.runId,
    );

    expect(checkpoint?.providerSessionRefs).toEqual([
      {
        nodeId: "a",
        provider: "openai",
        sessionId: "sess-a",
        metadata: { threadId: "thread-a" },
      },
    ]);
  });

  it("embeds compact executionLog events in checkpoints when executionLog.eventHistory=compact", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const runtime = new PipelineRuntime({
      definition: linearPipeline({
        executionLog: {
          storeRef: "audit-log",
          eventHistory: "compact",
        },
      }),
      nodeExecutor: executorWithRuns(),
      checkpointStore: store,
    });

    const result = await runtime.execute();
    const checkpoint = await store.load(result.runId);
    const logTypes = checkpoint?.executionLog?.events.map((event) => event.type);

    expect(checkpoint?.executionLog?.storeRef).toBe("audit-log");
    expect(checkpoint?.executionLog?.eventHistory).toBe("compact");
    expect(logTypes).toContain("pipeline:started");
    expect(logTypes).toContain("pipeline:checkpoint_saved");
    expect(logTypes).not.toContain("pipeline:node_started");
  });

  it("writes executionLog snapshots to the named executionLog.storeRef sink", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const appended: PipelineExecutionLogEntry[] = [];
    const executionLogStore: PipelineExecutionLogStore = {
      append: async (entry) => {
        appended.push(entry);
      },
    };
    const runtime = new PipelineRuntime({
      definition: linearPipeline({
        executionLog: {
          storeRef: "audit-log",
          eventHistory: "compact",
        },
      }),
      nodeExecutor: executorWithRuns(),
      checkpointStore: store,
      executionLogStores: { "audit-log": executionLogStore },
    });

    const result = await runtime.execute();

    expect(appended).toHaveLength(3);
    expect(appended.at(-1)).toMatchObject({
      pipelineId: "w1-runtime-pipe",
      pipelineRunId: result.runId,
      checkpointVersion: 3,
      storeRef: "audit-log",
      eventHistory: "compact",
    });
    expect(appended.at(-1)?.events.map((event) => event.type)).toContain(
      "pipeline:checkpoint_saved",
    );
  });

  it("recovers after process restart from the next node after the latest checkpoint", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const firstRuns: string[] = [];
    const first = new PipelineRuntime({
      definition: linearPipeline({
        resume: { onProcessRestart: "resume_from_checkpoint" },
      }),
      nodeExecutor: async (nodeId, node, ctx) => {
        if (nodeId === "b") {
          throw new Error("crash after checkpoint a");
        }
        return executorWithRuns(firstRuns)(nodeId, node, ctx);
      },
      checkpointStore: store,
    });

    const failed = await first.execute();
    expect(failed.state).toBe("failed");
    expect(firstRuns).toEqual(["a"]);

    const secondRuns: string[] = [];
    const second = new PipelineRuntime({
      definition: linearPipeline({
        resume: { onProcessRestart: "resume_from_checkpoint" },
      }),
      nodeExecutor: executorWithRuns(secondRuns),
      checkpointStore: store,
    });

    const recovered = await second.recoverAfterProcessRestart(failed.runId);

    expect(recovered.state).toBe("completed");
    expect(secondRuns).toEqual(["b", "c"]);
  });

  it("redelivers a running pipeline from the entry node after process restart", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const firstRuns: string[] = [];
    const first = new PipelineRuntime({
      definition: linearPipeline({
        resume: { onProcessRestart: "redeliver_running" },
      }),
      nodeExecutor: async (nodeId, node, ctx) => {
        if (nodeId === "b") {
          throw new Error("crash after checkpoint a");
        }
        return executorWithRuns(firstRuns)(nodeId, node, ctx);
      },
      checkpointStore: store,
    });

    const failed = await first.execute();
    expect(failed.state).toBe("failed");
    expect(firstRuns).toEqual(["a"]);

    const secondRuns: string[] = [];
    const second = new PipelineRuntime({
      definition: linearPipeline({
        resume: { onProcessRestart: "redeliver_running" },
      }),
      nodeExecutor: executorWithRuns(secondRuns),
      checkpointStore: store,
    });

    const redelivered = await second.recoverAfterProcessRestart(failed.runId);

    expect(redelivered.state).toBe("completed");
    expect(secondRuns).toEqual(["a", "b", "c"]);
  });

  it("counts the full redelivered pipeline against maxReplayNodes", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const first = new PipelineRuntime({
      definition: linearPipeline({
        resume: {
          onProcessRestart: "redeliver_running",
          maxReplayNodes: 2,
        },
      }),
      nodeExecutor: async (nodeId, node, ctx) => {
        if (nodeId === "b") {
          throw new Error("crash after checkpoint a");
        }
        return executorWithRuns()(nodeId, node, ctx);
      },
      checkpointStore: store,
    });

    const failed = await first.execute();
    expect(failed.state).toBe("failed");

    const secondRuns: string[] = [];
    const second = new PipelineRuntime({
      definition: linearPipeline({
        resume: {
          onProcessRestart: "redeliver_running",
          maxReplayNodes: 2,
        },
      }),
      nodeExecutor: executorWithRuns(secondRuns),
      checkpointStore: store,
    });

    const redelivered = await second.recoverAfterProcessRestart(failed.runId);

    expect(redelivered.state).toBe("failed");
    expect(secondRuns).toEqual([]);
  });

  it("fails process-restart recovery when remaining replay exceeds maxReplayNodes", async () => {
    const store = new InMemoryPipelineCheckpointStore();
    const first = new PipelineRuntime({
      definition: linearPipeline({
        resume: {
          onProcessRestart: "resume_from_checkpoint",
          maxReplayNodes: 1,
        },
      }),
      nodeExecutor: async (nodeId, node, ctx) => {
        if (nodeId === "b") {
          throw new Error("crash after checkpoint a");
        }
        return executorWithRuns()(nodeId, node, ctx);
      },
      checkpointStore: store,
    });

    const failed = await first.execute();
    expect(failed.state).toBe("failed");

    const secondRuns: string[] = [];
    const second = new PipelineRuntime({
      definition: linearPipeline({
        resume: {
          onProcessRestart: "resume_from_checkpoint",
          maxReplayNodes: 1,
        },
      }),
      nodeExecutor: executorWithRuns(secondRuns),
      checkpointStore: store,
    });

    const recovered = await second.recoverAfterProcessRestart(failed.runId);

    expect(recovered.state).toBe("failed");
    expect(secondRuns).toEqual([]);
  });
});

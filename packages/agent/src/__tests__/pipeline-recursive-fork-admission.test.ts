import { describe, expect, it, vi } from "vitest";

import type {
  PipelineCheckpoint,
  PipelineCheckpointCommitReceipt,
  PipelineDefinition,
} from "@dzupagent/core/pipeline";

import {
  InMemoryPipelineCheckpointStore,
  PipelineRuntime,
  type NodeExecutor,
  type PipelineRecursiveForkCommitSaveInput,
  type PipelineRecursiveForkDurablePort,
  type PipelineRecursiveForkFrameSaveInput,
} from "../pipeline.js";

class MemoryRecursivePort implements PipelineRecursiveForkDurablePort {
  readonly frames = new Map<
    string,
    { identity: `sha256:${string}`; serialized: string }
  >();
  readonly commits = new Map<
    string,
    { identity: `sha256:${string}`; serialized: string }
  >();

  async loadFrame(childScopeId: string): Promise<string | undefined> {
    return this.frames.get(childScopeId)?.serialized;
  }

  async compareAndSaveFrame(input: PipelineRecursiveForkFrameSaveInput) {
    const current = this.frames.get(input.childScopeId);
    if (current?.identity !== input.expectedFrameIdentity) {
      return { status: "conflict" as const };
    }
    this.frames.set(input.childScopeId, {
      identity: input.frameIdentity,
      serialized: input.serializedFrame,
    });
    return {
      status: "committed" as const,
      storedIdentity: input.frameIdentity,
    };
  }

  async loadCommittedChild(childScopeId: string): Promise<string | undefined> {
    return this.commits.get(childScopeId)?.serialized;
  }

  async compareAndSaveCommittedChild(
    input: PipelineRecursiveForkCommitSaveInput
  ) {
    const current = this.commits.get(input.childScopeId);
    if (current?.identity !== input.expectedCommitIdentity) {
      return { status: "conflict" as const };
    }
    this.commits.set(input.childScopeId, {
      identity: input.commitIdentity,
      serialized: input.serializedCommit,
    });
    return {
      status: "committed" as const,
      storedIdentity: input.commitIdentity,
    };
  }
}

class CrashCheckpointStore extends InMemoryPipelineCheckpointStore {
  constructor(private crash: "before" | "after" | undefined) {
    super();
  }

  override async saveIfVersion(
    checkpoint: PipelineCheckpoint,
    expectedVersion: number
  ): Promise<PipelineCheckpointCommitReceipt> {
    const crash = this.crash;
    this.crash = undefined;
    if (crash === "before") throw new Error("process-death-before-parent");
    const receipt = await super.saveIfVersion(checkpoint, expectedVersion);
    if (crash === "after") throw new Error("process-death-after-parent");
    return receipt;
  }
}

function definition(): PipelineDefinition {
  return {
    id: "recursive-public-fork",
    name: "RecursivePublicFork",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: "fork",
    checkpointStrategy: "after_each_node",
    resume: { onProcessRestart: "resume_from_checkpoint" },
    nodes: [
      { id: "fork", type: "fork", forkId: "parallel" },
      { id: "decision", type: "gate", gateType: "quality" },
      { id: "then", type: "agent", agentId: "then" },
      { id: "else", type: "agent", agentId: "else" },
      { id: "sibling", type: "agent", agentId: "sibling" },
      { id: "join", type: "join", forkId: "parallel" },
      { id: "after", type: "agent", agentId: "after" },
    ],
    edges: [
      { type: "sequential", sourceNodeId: "fork", targetNodeId: "decision" },
      { type: "sequential", sourceNodeId: "fork", targetNodeId: "sibling" },
      {
        type: "conditional",
        sourceNodeId: "decision",
        predicateName: "choose",
        branches: { true: "then", false: "else" },
      },
      { type: "sequential", sourceNodeId: "then", targetNodeId: "join" },
      { type: "sequential", sourceNodeId: "else", targetNodeId: "join" },
      { type: "sequential", sourceNodeId: "sibling", targetNodeId: "join" },
      { type: "sequential", sourceNodeId: "join", targetNodeId: "after" },
    ],
  };
}

function executor(calls: string[]): NodeExecutor {
  return async (nodeId, _node, context) => {
    calls.push(nodeId);
    context.state[nodeId] = true;
    return { nodeId, output: { nodeId }, durationMs: 1 };
  };
}

function runtime(input: {
  port: MemoryRecursivePort;
  store: InMemoryPipelineCheckpointStore;
  calls: string[];
  choose?: boolean;
}): PipelineRuntime {
  return new PipelineRuntime({
    definition: definition(),
    nodeExecutor: executor(input.calls),
    predicates: { choose: () => input.choose ?? true },
    checkpointStore: input.store,
    recursiveFork: { durable: input.port },
  });
}

describe("W3-C5A public recursive conditional fork admission", () => {
  it.each([
    [true, "then", "else"],
    [false, "else", "then"],
  ] as const)(
    "executes only the selected %s arm and merges the sibling deterministically",
    async (choose, selected, skipped) => {
      const calls: string[] = [];
      const store = new InMemoryPipelineCheckpointStore();
      const result = await runtime({
        port: new MemoryRecursivePort(),
        store,
        calls,
        choose,
      }).execute({}, { runId: `selection-${String(choose)}` });

      expect(result.state).toBe("completed");
      expect(calls).toEqual(expect.arrayContaining(["decision", selected, "sibling", "after"]));
      expect(calls).not.toContain(skipped);
      expect(result.nodeResults.has(selected)).toBe(true);
      expect(result.nodeResults.has(skipped)).toBe(false);
      const checkpoint = await store.load(`selection-${String(choose)}`);
      expect(checkpoint?.schemaVersion).toBe("1.2.0");
      expect(checkpoint?.recursiveForkCompletions?.fork?.children).toHaveLength(2);
    }
  );

  it("fails missing recursive or parent CAS custody before node dispatch", () => {
    const nodeExecutor = vi.fn();
    const checkpointStore = new InMemoryPipelineCheckpointStore();
    expect(
      () =>
        new PipelineRuntime({
          definition: definition(),
          nodeExecutor,
          checkpointStore,
          predicates: { choose: () => true },
        })
    ).toThrow("recursiveFork.durable");
    expect(
      () =>
        new PipelineRuntime({
          definition: definition(),
          nodeExecutor,
          recursiveFork: { durable: new MemoryRecursivePort() },
          predicates: { choose: () => true },
        })
    ).toThrow("explicit checkpoint store");
    const { checkpointStrategy: _checkpointStrategy, ...withoutStrategy } =
      definition();
    expect(
      () =>
        new PipelineRuntime({
          definition: withoutStrategy,
          nodeExecutor,
          checkpointStore,
          recursiveFork: { durable: new MemoryRecursivePort() },
          predicates: { choose: () => true },
        })
    ).toThrow("checkpointStrategy=after_each_node");
    expect(nodeExecutor).not.toHaveBeenCalled();
  });

  it("restores exact child commits after death before parent completion", async () => {
    const port = new MemoryRecursivePort();
    const store = new CrashCheckpointStore("before");
    const firstCalls: string[] = [];
    const first = await runtime({ port, store, calls: firstCalls }).execute(
      {},
      { runId: "before-parent" }
    );
    expect(first.state).toBe("failed");
    expect(firstCalls).toEqual(expect.arrayContaining(["decision", "then", "sibling"]));
    expect(firstCalls).not.toContain("after");
    expect(port.commits.size).toBe(2);

    const restartCalls: string[] = [];
    const restarted = await runtime({ port, store, calls: restartCalls }).execute(
      {},
      { runId: "before-parent" }
    );
    expect(restarted.error).toBeUndefined();
    expect(restarted.state).toBe("completed");
    expect(restartCalls).toEqual(["after"]);
    expect((await store.load("before-parent"))?.recursiveForkCompletions?.fork)
      .toBeDefined();
  });

  it("uses the acknowledged parent checkpoint without repeating child or continuation work", async () => {
    const port = new MemoryRecursivePort();
    const store = new CrashCheckpointStore("after");
    const firstCalls: string[] = [];
    const first = await runtime({ port, store, calls: firstCalls }).execute(
      {},
      { runId: "after-parent" }
    );
    expect(first.state).toBe("failed");
    const parentCheckpoint = await store.load("after-parent");
    expect(parentCheckpoint?.completedNodeIds).toEqual(
      expect.arrayContaining(["fork", "join"])
    );
    expect(firstCalls).not.toContain("after");

    const resumeCalls: string[] = [];
    const resumed = await runtime({ port, store, calls: resumeCalls }).resume(
      parentCheckpoint!
    );
    expect(resumed.state).toBe("completed");
    expect(resumeCalls).toEqual(["after"]);

    const finalCheckpoint = await store.load("after-parent");
    const replayCalls: string[] = [];
    const replayed = await runtime({ port, store, calls: replayCalls }).resume(
      finalCheckpoint!
    );
    expect(replayed.state).toBe("completed");
    expect(replayCalls).toEqual([]);
  });

  it("rejects parent, child aggregate, merge, and continuation drift before dispatch", async () => {
    const port = new MemoryRecursivePort();
    const store = new InMemoryPipelineCheckpointStore();
    await runtime({ port, store, calls: [] }).execute({}, { runId: "drift" });
    const checkpoint = (await store.load("drift"))!;

    const mutations: Array<(value: PipelineCheckpoint) => void> = [
      (value) => {
        value.recursiveForkCompletions!.fork!.parentCommitIdentity =
          `sha256:${"1".repeat(64)}`;
      },
      (value) => {
        value.recursiveForkCompletions!.fork!.mergeIdentity =
          `sha256:${"2".repeat(64)}`;
      },
      (value) => {
        value.recursiveForkCompletions!.fork!.children[0]!.normalExitNodeId = "else";
      },
      (value) => {
        value.recursiveForkCompletions!.fork!.selectedContinuationNodeId = "then";
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(checkpoint);
      mutate(changed);
      const calls: string[] = [];
      await expect(
        runtime({ port, store, calls }).resume(changed)
      ).rejects.toThrow(/recursive fork completion|Invalid pipeline checkpoint/);
      expect(calls).toEqual([]);
    }
  });

  it("keeps merge and receipt bytes independent of sibling completion order", async () => {
    const run = async (firstToFinish: "then" | "sibling") => {
      const port = new MemoryRecursivePort();
      const store = new InMemoryPipelineCheckpointStore();
      const calls: string[] = [];
      const started = new Set<string>();
      let releaseStarted!: () => void;
      const bothStarted = new Promise<void>((resolve) => {
        releaseStarted = resolve;
      });
      const releases = new Map<string, () => void>();
      const gates = new Map(
        ["then", "sibling"].map((nodeId) => [
          nodeId,
          new Promise<void>((resolve) => releases.set(nodeId, resolve)),
        ])
      );
      const nodeExecutor: NodeExecutor = async (nodeId, _node, context) => {
        calls.push(nodeId);
        if (gates.has(nodeId)) {
          started.add(nodeId);
          if (started.size === 2) releaseStarted();
          await gates.get(nodeId);
        }
        context.state[nodeId] = true;
        return { nodeId, output: { nodeId }, durationMs: 1 };
      };
      const execution = new PipelineRuntime({
        definition: definition(),
        nodeExecutor,
        predicates: { choose: () => true },
        checkpointStore: store,
        recursiveFork: { durable: port },
      }).execute({}, { runId: "completion-order" });
      await bothStarted;
      releases.get(firstToFinish)!();
      for (let turn = 0; turn < 100 && port.commits.size === 0; turn += 1) {
        await Promise.resolve();
      }
      expect(port.commits.size).toBe(1);
      releases.get(firstToFinish === "then" ? "sibling" : "then")!();
      const result = await execution;
      expect(result.state).toBe("completed");
      return {
        receipt: (await store.load("completion-order"))!
          .recursiveForkCompletions!.fork!,
        commits: [...port.commits.values()].map(({ serialized }) =>
          JSON.parse(serialized)
        ).sort(
          (left, right) =>
            left.ownership.branchOrdinal - right.ownership.branchOrdinal
        ),
      };
    };

    const conditionalFirst = await run("then");
    const siblingFirst = await run("sibling");
    expect(conditionalFirst.commits).toEqual(siblingFirst.commits);
    expect({
      mergeIdentity: conditionalFirst.receipt.mergeIdentity,
      childCommitIdentities: conditionalFirst.receipt.childCommitIdentities,
      children: conditionalFirst.receipt.children.map(({ normalExitNodeId }) => ({ normalExitNodeId })),
    }).toEqual({
      mergeIdentity: siblingFirst.receipt.mergeIdentity,
      childCommitIdentities: siblingFirst.receipt.childCommitIdentities,
      children: siblingFirst.receipt.children.map(({ normalExitNodeId }) => ({ normalExitNodeId })),
    });
  });
});

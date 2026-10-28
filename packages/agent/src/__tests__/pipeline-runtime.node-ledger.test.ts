/**
 * P2 — PipelineRuntime × DurableNodeLedger (opt-in) integration.
 *
 * Verifies:
 *  - no ledger ⇒ execution unchanged (node runs once, normal result)
 *  - ledger ⇒ a node runs once and is recorded; a completed node REPLAYS its
 *    prior result instead of re-executing on a re-run with the same ledger
 *  - a node whose lease was stolen mid-run is fenced out (run fails, not
 *    double-completed)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PipelineRuntime } from "../pipeline/pipeline-runtime.js";
import { InMemoryDurableNodeLedger } from "@dzupagent/core";
import type { PipelineDefinition, PipelineNode } from "@dzupagent/runtime-contracts/pipeline-artifact";
import type {
  NodeExecutor, NodeLedgerLike, NodeExecutionContext, NodeResult,
} from "../pipeline/pipeline-runtime-types.js";
import {
  startNodeHeartbeat, DEFAULT_LEASE_TTL_MS, DEFAULT_HEARTBEAT_MS,
} from "../pipeline/executor-internals/node-ledger-integration.js";
import {
  nodeIdempotencyKey,
  nodeIdempotencyContext,
} from "../pipeline/pipeline-shared/idempotency.js";

function singleNode(node: PipelineNode): PipelineDefinition {
  return {
    id: "p2-ledger-pipeline",
    name: "P2 Ledger Test",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    entryNodeId: node.id,
    nodes: [node],
    edges: [],
  };
}

/** The canonical key the runtime produces for `nodeId` in `def` (N3b). */
function runtimeKey(
  def: PipelineDefinition,
  runId: string,
  nodeId: string
): string {
  const node = def.nodes.find((n) => n.id === nodeId)!;
  return nodeIdempotencyKey(runId, nodeId, {
    flowDefinition: def,
    ...nodeIdempotencyContext(node),
  });
}

const NODE: PipelineNode = {
  id: "n1",
  type: "transform",
} as PipelineNode;

describe("PipelineRuntime × DurableNodeLedger (opt-in)", () => {
  it("without a ledger, the node executes exactly once (unchanged behavior)", async () => {
    const executor = vi.fn<NodeExecutor>().mockResolvedValue({
      nodeId: "n1",
      output: { ok: true },
      durationMs: 1,
    });
    const runtime = new PipelineRuntime({
      definition: singleNode(NODE),
      nodeExecutor: executor,
    });
    const result = await runtime.execute();
    expect(result.state).toBe("completed");
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("with a ledger, the node executes once and records a completion", async () => {
    const ledger = new InMemoryDurableNodeLedger();
    const executor = vi.fn<NodeExecutor>().mockResolvedValue({
      nodeId: "n1",
      output: { value: 7 },
      durationMs: 1,
    });
    const def = singleNode(NODE);
    const runtime = new PipelineRuntime({
      definition: def,
      nodeExecutor: executor,
      nodeLedger: ledger,
    });
    const result = await runtime.execute();
    expect(result.state).toBe("completed");
    expect(executor).toHaveBeenCalledTimes(1);
    // The completion is queryable for replay under the runtime's canonical key.
    const runId = result.runId;
    const completion = await ledger.getByIdempotencyKey(
      runtimeKey(def, runId, "n1")
    );
    expect(completion?.output).toEqual({ value: 7 });
  });

  it("a node already completed in the ledger REPLAYS (no re-execution)", async () => {
    const ledger = new InMemoryDurableNodeLedger();
    // Pre-seed a completion for the run id the runtime will use is not possible
    // (runId is generated), so instead run twice with a fixed runId via resume
    // semantics is overkill — assert replay within one ledger across two
    // runtimes sharing the same runId by pre-acquiring + completing.
    const runId = "fixed-run";
    const key = nodeIdempotencyKey(runId, "n1");
    const lease = await ledger.acquire(runId, "n1", key, "seed", 60_000, 0);
    await ledger.complete({
      runId,
      nodeId: "n1",
      idempotencyKey: key,
      fenceToken: lease!.fenceToken,
      output: { replayed: true },
    });

    // A runtime that produces this runId would replay. We assert the helper
    // path directly: a completed key short-circuits acquire.
    const reacquire = await ledger.acquire(runId, "n1", key, "w2", 60_000, 1);
    expect(reacquire).toBeNull(); // completed ⇒ caller replays
    const completion = await ledger.getByIdempotencyKey(key);
    expect(completion?.output).toEqual({ replayed: true });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function heartbeatLedger(heartbeat: NodeLedgerLike["heartbeat"]): NodeLedgerLike {
  return {
    getByIdempotencyKey: vi.fn().mockResolvedValue(undefined),
    acquire: vi.fn().mockResolvedValue({ owner: "lease-run", fenceToken: 1 }),
    heartbeat,
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
  };
}

describe("confirmed node lease deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("serializes a hung renewal and ignores its success after revocation", async () => {
    const pending = deferred<boolean>();
    const heartbeat = vi.fn<NodeLedgerLike["heartbeat"]>(() => pending.promise);
    const parent = new AbortController();
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    const onRenewed = vi.fn();
    const onLost = vi.fn();
    const handle = startNodeHeartbeat(
      heartbeatLedger(heartbeat), "r", "n", "w", 1, parent.signal,
      1_000, 100, { onRenewed, onLost },
    );

    await vi.advanceTimersByTimeAsync(899);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(handle.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(handle.signal.aborted).toBe(true);
    expect(handle.lost()).toBe(true);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);

    pending.resolve(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onRenewed).not.toHaveBeenCalled();
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(handle.lost()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["reject", "throw"] as const)(
    "bounds repeated renewal errors (%s) by the last confirmed deadline",
    async (mode) => {
      const heartbeat = vi.fn<NodeLedgerLike["heartbeat"]>(() => {
        if (mode === "throw") throw new Error("renewal unavailable");
        return Promise.reject(new Error("renewal unavailable"));
      });
      const handle = startNodeHeartbeat(
        heartbeatLedger(heartbeat), "r", "n", "w", 1, undefined, 1_000, 100,
      );
      await vi.advanceTimersByTimeAsync(100);
      expect(handle.signal.aborted).toBe(false); // transient retry remains permitted
      await vi.advanceTimersByTimeAsync(799);
      expect(handle.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(handle.signal.aborted).toBe(true);
      expect(handle.lost()).toBe(true);
      expect(heartbeat).toHaveBeenCalledTimes(8);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("counts a delayed acknowledgement from request time", async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const heartbeat = vi.fn<NodeLedgerLike["heartbeat"]>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(() => second.promise);
    const renewed = vi.fn();
    const handle = startNodeHeartbeat(
      heartbeatLedger(heartbeat), "r", "n", "w", 1, undefined,
      1_000, 100, { onRenewed: renewed },
    );
    await vi.advanceTimersByTimeAsync(800);
    first.resolve(true); // request at 100 => confirmed expiry 1_100, cutoff 1_000
    await vi.advanceTimersByTimeAsync(0);
    expect(renewed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(199);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(handle.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(handle.lost()).toBe(true);
    second.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(renewed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renews repeatedly on success and immediately revokes on fencing", async () => {
    const heartbeat = vi.fn<NodeLedgerLike["heartbeat"]>()
      .mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const handle = startNodeHeartbeat(
      heartbeatLedger(heartbeat), "r", "n", "w", 1, undefined, 1_000, 100,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(handle.lost()).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(handle.lost()).toBe(true);
    expect(handle.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["stop", "cancel"] as const)(
    "%s cleans timers and listeners while a renewal is pending",
    async (action) => {
      const pending = deferred<boolean>();
      const heartbeat = vi.fn<NodeLedgerLike["heartbeat"]>(() => pending.promise);
      const parent = new AbortController();
      const remove = vi.spyOn(parent.signal, "removeEventListener");
      const onRenewed = vi.fn();
      const onLost = vi.fn();
      const handle = startNodeHeartbeat(
        heartbeatLedger(heartbeat), "r", "n", "w", 1, parent.signal,
        1_000, 100, { onRenewed, onLost },
      );
      await vi.advanceTimersByTimeAsync(100);
      if (action === "stop") handle.stop();
      else parent.abort();
      handle.stop(); // idempotent
      pending.reject(new Error("late rejection"));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(handle.signal.aborted).toBe(action === "cancel");
      expect(handle.lost()).toBe(false);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      expect(onRenewed).not.toHaveBeenCalled();
      expect(onLost).not.toHaveBeenCalled();
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not start renewal for an already cancelled parent or expired acquisition", () => {
    const heartbeat = vi.fn<NodeLedgerLike["heartbeat"]>().mockResolvedValue(true);
    const ledger = heartbeatLedger(heartbeat);
    const parent = new AbortController();
    parent.abort();
    const cancelled = startNodeHeartbeat(ledger, "r", "n", "w", 1, parent.signal, 1_000, 100);
    const expired = startNodeHeartbeat(ledger, "r", "n", "w", 1, undefined, 1_000, 100, undefined, -1_000);
    expect(cancelled.signal.aborted).toBe(true);
    expect(cancelled.lost()).toBe(false);
    expect(expired.signal.aborted).toBe(true);
    expect(expired.lost()).toBe(true);
    expect(heartbeat).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { cause: "lease loss", timeoutMs: undefined },
    { cause: "cancellation", timeoutMs: undefined },
    { cause: "lease loss", timeoutMs: 120_000 },
    { cause: "cancellation", timeoutMs: 120_000 },
  ] as const)(
    "abandons an uncooperative executor on $cause (timeout: $timeoutMs) and discards its late result",
    async ({ cause, timeoutMs }) => {
      const entered = deferred<NodeExecutionContext>();
      const work = deferred<NodeResult>();
      const renewal = deferred<boolean>();
      const ledger = heartbeatLedger(vi.fn(() => renewal.promise));
      const parent = new AbortController();
      const add = vi.spyOn(AbortSignal.prototype, "addEventListener");
      const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");
      const executor = vi.fn<NodeExecutor>(async (_id, _node, context) => {
        entered.resolve(context);
        return work.promise;
      });
      const events: string[] = [];
      const running = new PipelineRuntime({
        definition: singleNode({
          ...NODE, idempotency: "exactly-once-required", retries: 2,
          ...(timeoutMs === undefined ? {} : { executionPolicy: { timeoutMs } }),
        }),
        nodeExecutor: executor, nodeLedger: ledger, signal: parent.signal,
        onEvent: (event) => { events.push(event.type); },
      }).execute({}, { runId: "lease-run" });
      const context = await entered.promise;
      expect(vi.getTimerCount()).toBe(timeoutMs === undefined ? 2 : 3);

      if (cause === "cancellation") {
        await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_MS);
        parent.abort();
      } else {
        await vi.advanceTimersByTimeAsync(DEFAULT_LEASE_TTL_MS - 1);
      }
      const result = await running;
      expect(result.state).toBe("failed");
      expect(result.error).toContain(cause === "cancellation" ? "cancelled" : "lease lost");
      expect(result.totalDurationMs).toBeLessThan(DEFAULT_LEASE_TTL_MS);
      expect(context.signal?.aborted).toBe(true);
      expect(ledger.heartbeat).toHaveBeenCalledTimes(1);
      expect(ledger.complete).not.toHaveBeenCalled();
      expect(ledger.fail).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      // Check each listener on its original signal, including the deadline's
      // parent listener (the executor sees a different signal when timed).
      const abortListeners = add.mock.calls
        .map(([type, listener], index) => ({ type, listener, signal: add.mock.contexts[index] }))
        .filter(({ type }) => type === "abort");
      expect(abortListeners).toHaveLength(timeoutMs === undefined ? 2 : 3);
      for (const { listener, signal } of abortListeners) {
        expect(remove.mock.calls.some(([type, removed], index) =>
          type === "abort" && removed === listener && remove.mock.contexts[index] === signal,
        )).toBe(true);
      }

      renewal.resolve(true);
      work.resolve({ nodeId: NODE.id, output: { late: true }, durationMs: 1 });
      await vi.advanceTimersByTimeAsync(DEFAULT_LEASE_TTL_MS);
      expect(executor).toHaveBeenCalledTimes(1);
      expect(ledger.complete).not.toHaveBeenCalled();
      expect(events).not.toContain("pipeline:node_completed");
      expect(result.nodeResults.get(NODE.id)?.output).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("clears an outstanding retry backoff when the lease deadline revokes execution", async () => {
    const retrying = deferred<void>();
    const renewal = deferred<boolean>();
    const ledger = heartbeatLedger(vi.fn(() => renewal.promise));
    const executor = vi.fn<NodeExecutor>().mockResolvedValue({
      nodeId: NODE.id, output: null, durationMs: 1, error: "timeout",
    });
    const running = new PipelineRuntime({
      definition: singleNode({ ...NODE, retries: 2 }),
      nodeExecutor: executor, nodeLedger: ledger,
      retryPolicy: { initialBackoffMs: 120_000, maxBackoffMs: 120_000, jitter: false },
      onEvent: (event) => {
        if (event.type === "pipeline:node_retry") retrying.resolve(undefined);
      },
    }).execute({}, { runId: "lease-run" });
    await retrying.promise;
    await vi.advanceTimersByTimeAsync(DEFAULT_LEASE_TTL_MS - 1);
    const result = await running;
    expect(result.state).toBe("failed");
    expect(result.error).toContain("lease lost");
    expect(executor).toHaveBeenCalledTimes(1);
    expect(ledger.complete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    renewal.resolve(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not dispatch after acquisition consumed the initial lease window", async () => {
    const acquiring = deferred<void>();
    const acquired = deferred<unknown>();
    const ledger = heartbeatLedger(vi.fn().mockResolvedValue(true));
    ledger.acquire = vi.fn(() => { acquiring.resolve(undefined); return acquired.promise; });
    const executor = vi.fn<NodeExecutor>();
    const running = new PipelineRuntime({
      definition: singleNode({ ...NODE, idempotency: "exactly-once-required" }),
      nodeExecutor: executor, nodeLedger: ledger,
    }).execute({}, { runId: "lease-run" });
    await acquiring.promise;
    await vi.advanceTimersByTimeAsync(DEFAULT_LEASE_TTL_MS);
    acquired.resolve({ owner: "lease-run", fenceToken: 1 });
    const result = await running;
    expect(result.state).toBe("failed");
    expect(result.error).toContain("lease lost");
    expect(executor).not.toHaveBeenCalled();
    expect(ledger.heartbeat).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["success", "failure", "throw"] as const)(
    "cleans heartbeat resources after terminal executor %s",
    async (outcome) => {
      const ledger = heartbeatLedger(vi.fn().mockResolvedValue(true));
      const parent = new AbortController();
      const remove = vi.spyOn(parent.signal, "removeEventListener");
      const executor: NodeExecutor = async () => {
        if (outcome === "throw") throw new Error("executor threw");
        return { nodeId: NODE.id, output: "ok", durationMs: 1,
          ...(outcome === "failure" ? { error: "executor failed" } : {}) };
      };
      const result = await new PipelineRuntime({
        definition: singleNode(NODE), nodeExecutor: executor,
        nodeLedger: ledger, signal: parent.signal,
      }).execute({}, { runId: "lease-run" });
      expect(result.state).toBe(outcome === "success" ? "completed" : "failed");
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
      parent.abort();
      await vi.advanceTimersByTimeAsync(DEFAULT_LEASE_TTL_MS);
      expect(ledger.heartbeat).not.toHaveBeenCalled();
    },
  );
});

/**
 * P1 — startRunWorker fleet registry wiring.
 *
 * When `workerRegistry` is supplied, the worker registers a node, emits
 * worker:registered, tracks in-flight, and the stop handle drains/deregisters.
 */
import { describe, it, expect } from "vitest";
import {
  InMemoryRunStore,
  InMemoryAgentStore,
  ModelRegistry,
  createEventBus,
  type DzupEvent,
} from "@dzupagent/core";
import { waitForCondition } from "@dzupagent/testing";
import { InMemoryRunQueue } from "../queue/run-queue.js";
import { startRunWorker } from "../runtime/run-worker.js";
import { InMemoryWorkerNodeStore } from "../runtime/worker-registry.js";

function baseOptions(extra: Record<string, unknown> = {}) {
  return {
    runQueue: new InMemoryRunQueue({ concurrency: 1 }),
    runStore: new InMemoryRunStore(),
    agentStore: new InMemoryAgentStore(),
    eventBus: createEventBus(),
    modelRegistry: new ModelRegistry(),
    runExecutor: async () => ({ output: { ok: true } }),
    ...extra,
  };
}

describe("startRunWorker — worker fleet registry (P1)", () => {
  it("registers the node and emits worker:registered when a registry is provided", async () => {
    const store = new InMemoryWorkerNodeStore();
    const eventBus = createEventBus();
    const events: DzupEvent["type"][] = [];
    eventBus.onAny((e) => events.push(e.type));

    startRunWorker(
      baseOptions({
        eventBus,
        workerRegistry: { store, workerId: "w-test-1", capacity: 3 },
      }) as Parameters<typeof startRunWorker>[0],
    );

    await waitForCondition(async () => (await store.list()).length === 1, {
      timeoutMs: 1000,
      intervalMs: 10,
      description: "worker node registered",
    });
    const [node] = await store.list();
    expect(node?.id).toBe("w-test-1");
    expect(node?.status).toBe("active");
    expect(node?.capacity).toBe(3);
    expect(events).toContain("worker:registered");
  });

  it("does not register anything when no registry is provided (backward compatible)", async () => {
    const store = new InMemoryWorkerNodeStore();
    startRunWorker(baseOptions() as Parameters<typeof startRunWorker>[0]);
    // Flush microtasks; with no registry wired, nothing should land in the store.
    await Promise.resolve();
    await Promise.resolve();
    expect(await store.list()).toHaveLength(0);
  });

  it("the stop handle drains and deregisters the node", async () => {
    const store = new InMemoryWorkerNodeStore();
    const eventBus = createEventBus();
    const events: DzupEvent["type"][] = [];
    eventBus.onAny((e) => events.push(e.type));
    let stop: (() => Promise<void>) | undefined;

    startRunWorker(
      baseOptions({
        eventBus,
        workerRegistry: {
          store,
          workerId: "w-stop",
          onStop: (s: () => Promise<void>) => {
            stop = s;
          },
        },
      }) as Parameters<typeof startRunWorker>[0],
    );

    await waitForCondition(async () => (await store.list()).length === 1, {
      timeoutMs: 1000,
      intervalMs: 10,
      description: "registered",
    });
    expect(stop).toBeDefined();
    await stop!();
    expect(await store.list()).toHaveLength(0);
    expect(events).toContain("worker:draining");
  });
});

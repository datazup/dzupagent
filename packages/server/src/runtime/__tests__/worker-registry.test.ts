/**
 * P1 — Worker Fleet Registry (InMemoryWorkerNodeStore).
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryWorkerNodeStore,
  type WorkerNode,
} from "../worker-registry.js";

const T0 = 1_000_000;

function baseNode(id: string): Omit<WorkerNode, "lastHeartbeatAt" | "status"> {
  return { id, tenantScope: "shared", capacity: 5, inFlight: 0, startedAt: T0 };
}

describe("InMemoryWorkerNodeStore", () => {
  it("registers a node as active with the registration time as first heartbeat", async () => {
    const store = new InMemoryWorkerNodeStore();
    const node = await store.register(baseNode("w1"), T0);
    expect(node.status).toBe("active");
    expect(node.lastHeartbeatAt).toBe(T0);
    expect(await store.list()).toHaveLength(1);
  });

  it("heartbeat updates lastHeartbeatAt and inFlight", async () => {
    const store = new InMemoryWorkerNodeStore();
    await store.register(baseNode("w1"), T0);
    await store.heartbeat("w1", 3, T0 + 5_000);
    const [node] = await store.list();
    expect(node?.lastHeartbeatAt).toBe(T0 + 5_000);
    expect(node?.inFlight).toBe(3);
  });

  it("reapExpired marks only nodes past the ttl as dead and returns their ids", async () => {
    const store = new InMemoryWorkerNodeStore();
    await store.register(baseNode("stale"), T0);
    await store.register(baseNode("fresh"), T0);
    await store.heartbeat("fresh", 0, T0 + 9_000);
    // ttl 10s; at T0+11s, 'stale' (last hb T0) is 11s old → reaped; 'fresh' (hb T0+9s) is 2s old → kept.
    const reaped = await store.reapExpired(T0 + 11_000, 10_000);
    expect(reaped).toEqual(["stale"]);
    expect((await store.list({ status: "dead" })).map((n) => n.id)).toEqual([
      "stale",
    ]);
    expect((await store.list({ status: "active" })).map((n) => n.id)).toEqual([
      "fresh",
    ]);
  });

  it("reapExpired is idempotent (a dead node is not re-reaped)", async () => {
    const store = new InMemoryWorkerNodeStore();
    await store.register(baseNode("w1"), T0);
    expect(await store.reapExpired(T0 + 20_000, 10_000)).toEqual(["w1"]);
    expect(await store.reapExpired(T0 + 30_000, 10_000)).toEqual([]);
  });

  it("a heartbeat resurrects a node previously reaped as dead", async () => {
    const store = new InMemoryWorkerNodeStore();
    await store.register(baseNode("w1"), T0);
    await store.reapExpired(T0 + 20_000, 10_000);
    await store.heartbeat("w1", 1, T0 + 21_000);
    expect((await store.list({ status: "active" })).map((n) => n.id)).toEqual([
      "w1",
    ]);
  });

  it("setStatus + deregister", async () => {
    const store = new InMemoryWorkerNodeStore();
    await store.register(baseNode("w1"), T0);
    await store.setStatus("w1", "draining");
    expect((await store.list())[0]?.status).toBe("draining");
    await store.deregister("w1");
    expect(await store.list()).toHaveLength(0);
  });
});

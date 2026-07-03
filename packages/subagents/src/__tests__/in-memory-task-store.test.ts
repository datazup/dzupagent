import { describe, it, expect } from "vitest";
import { InMemoryTaskStore } from "../store/in-memory-task-store.js";
import { runTaskStoreContract } from "./task-store-contract.js";

runTaskStoreContract("InMemoryTaskStore", () => new InMemoryTaskStore());

describe("InMemoryTaskStore.remove", () => {
  it("removes a task", async () => {
    const store = new InMemoryTaskStore();
    await store.put({
      id: "a",
      parentRunId: "r",
      spec: { agentId: "x", input: "hi" },
      status: "succeeded",
      createdAt: 0,
      ttlMs: 1,
      depth: 0,
      endedAt: 1,
    });
    await store.remove("a");
    expect(await store.get("a")).toBeNull();
  });
});

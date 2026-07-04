import { describe, it, expect } from "vitest";
import type { BackgroundTask } from "../contracts/background-task.js";
import type { TaskStore } from "../contracts/task-store.js";

function task(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "a",
    parentRunId: "run-1",
    spec: { agentId: "x", input: "hi" },
    status: "queued",
    createdAt: 0,
    ttlMs: 1000,
    depth: 0,
    ...over,
  };
}

/**
 * Conformance suite every {@link TaskStore} implementation must pass — the
 * barbell guarantee that runner/store seams are interchangeable.
 */
export function runTaskStoreContract(
  name: string,
  factory: () => TaskStore
): void {
  describe(`TaskStore contract: ${name}`, () => {
    it("put then get returns an equal (independent) copy", async () => {
      const store = factory();
      const t = task();
      await store.put(t);
      const got = await store.get("a");
      expect(got).toEqual(t);
      expect(got).not.toBe(t);
    });

    it("get returns null for unknown id", async () => {
      expect(await factory().get("nope")).toBeNull();
    });

    it("patch shallow-merges", async () => {
      const store = factory();
      await store.put(task());
      await store.patch("a", { status: "running", startedAt: 5 });
      const got = await store.get("a");
      expect(got?.status).toBe("running");
      expect(got?.startedAt).toBe(5);
      expect(got?.parentRunId).toBe("run-1");
    });

    it("patch on unknown id is a no-op", async () => {
      const store = factory();
      await store.patch("ghost", { status: "failed" });
      expect(await store.get("ghost")).toBeNull();
    });

    it("list filters by parentRunId and status", async () => {
      const store = factory();
      await store.put(task({ id: "a", parentRunId: "r1", status: "queued" }));
      await store.put(task({ id: "b", parentRunId: "r1", status: "running" }));
      await store.put(task({ id: "c", parentRunId: "r2", status: "queued" }));

      expect(
        (await store.list({ parentRunId: "r1" })).map((t) => t.id).sort()
      ).toEqual(["a", "b"]);
      expect(
        (await store.list({ status: "queued" })).map((t) => t.id).sort()
      ).toEqual(["a", "c"]);
      expect(
        (await store.list({ status: ["queued", "running"], parentRunId: "r1" }))
          .length
      ).toBe(2);
    });

    it("list filters by endedBefore", async () => {
      const store = factory();
      await store.put(task({ id: "a", status: "succeeded", endedAt: 10 }));
      await store.put(task({ id: "b", status: "succeeded", endedAt: 30 }));
      await store.put(task({ id: "c", status: "running" })); // no endedAt
      const r = await store.list({ endedBefore: 20 });
      expect(r.map((t) => t.id)).toEqual(["a"]);
    });

    it("mutating a returned task does not corrupt the store", async () => {
      const store = factory();
      await store.put(task());
      const got = await store.get("a");
      if (got) {
        got.status = "failed";
      }
      expect((await store.get("a"))?.status).toBe("queued");
    });
  });
}

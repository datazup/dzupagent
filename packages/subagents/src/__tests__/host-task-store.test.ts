import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { HostTaskStore } from "../store/host-task-store.js";
import { runTaskStoreContract } from "./task-store-contract.js";

describe("HostTaskStore", () => {
  runTaskStoreContract("HostTaskStore", () => {
    const directory = join(
      tmpdir(),
      `dzupagent-task-store-contract-${process.pid}-${Math.random()}`,
    );
    return new HostTaskStore({ directory });
  });

  it("persists tasks across store reattachment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dzupagent-tasks-"));
    try {
      const first = new HostTaskStore({ directory: dir });
      await first.put({
        id: "durable-task",
        parentRunId: "run-1",
        spec: {
          agentId: "reviewer",
          instructions: "Review carefully.",
          input: "check this",
          outboundScope: ["read"],
        },
        status: "queued",
        createdAt: 0,
        ttlMs: 1000,
        depth: 0,
      });

      const second = new HostTaskStore({ directory: dir });
      expect(await second.get("durable-task")).toMatchObject({
        id: "durable-task",
        status: "queued",
        spec: {
          agentId: "reviewer",
          instructions: "Review carefully.",
          outboundScope: ["read"],
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

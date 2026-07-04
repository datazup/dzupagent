import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { HostTaskQueue } from "../store/host-task-queue.js";

async function withQueueDir<T>(test: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "dzupagent-task-queue-"));
  try {
    return await test(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("HostTaskQueue", () => {
  it("persists queued task ids across queue reattachment", async () => {
    await withQueueDir(async (dir) => {
      const first = new HostTaskQueue({
        directory: dir,
        workerId: "first",
        autoDrain: false,
      });
      await first.enqueue("durable-task");

      const handled: string[] = [];
      const second = new HostTaskQueue({
        directory: dir,
        workerId: "second",
        autoDrain: false,
      });
      second.consume(async (taskId) => {
        handled.push(taskId);
      });

      await second.drainAvailable();

      expect(handled).toEqual(["durable-task"]);
      expect(await second.pendingCount()).toBe(0);
    });
  });

  it("does not dispatch the same leased item to a second worker", async () => {
    await withQueueDir(async (dir) => {
      const first = new HostTaskQueue({
        directory: dir,
        workerId: "first",
        leaseMs: 60_000,
        autoDrain: false,
      });
      await first.enqueue("leased-task");

      const firstHandled: string[] = [];
      first.consume(async (taskId) => {
        firstHandled.push(taskId);
      });
      await first.claimNextForTest();

      const secondHandled: string[] = [];
      const second = new HostTaskQueue({
        directory: dir,
        workerId: "second",
        leaseMs: 60_000,
        autoDrain: false,
      });
      second.consume(async (taskId) => {
        secondHandled.push(taskId);
      });
      await second.drainAvailable();

      expect(firstHandled).toEqual(["leased-task"]);
      expect(secondHandled).toEqual([]);
      expect(await second.pendingCount()).toBe(1);
    });
  });

  it("redelivers a leased item after its lease expires", async () => {
    await withQueueDir(async (dir) => {
      let now = 1_000;
      const first = new HostTaskQueue({
        directory: dir,
        workerId: "first",
        leaseMs: 50,
        clock: () => now,
        autoDrain: false,
      });
      await first.enqueue("retry-task");
      first.consume(async () => undefined);
      await first.claimNextForTest();

      now = 1_051;
      const handled: string[] = [];
      const second = new HostTaskQueue({
        directory: dir,
        workerId: "second",
        leaseMs: 50,
        clock: () => now,
        autoDrain: false,
      });
      second.consume(async (taskId) => {
        handled.push(taskId);
      });

      await second.drainAvailable();

      expect(handled).toEqual(["retry-task"]);
      expect(await second.pendingCount()).toBe(0);
    });
  });

  it("coalesces duplicate enqueues for the same task id", async () => {
    await withQueueDir(async (dir) => {
      const queue = new HostTaskQueue({
        directory: dir,
        workerId: "worker",
        autoDrain: false,
      });

      await queue.enqueue("same-task");
      await queue.enqueue("same-task");

      expect(await queue.pendingCount()).toBe(1);
    });
  });
});

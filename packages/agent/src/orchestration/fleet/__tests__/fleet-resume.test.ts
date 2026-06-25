import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { computeResumePlan } from "../fleet-resume.js";
import { FilesystemKnowledgeStore } from "@dzupagent/memory/knowledge";
import type {
  KnowledgeEnvelope,
  TaskState,
} from "@dzupagent/agent-types/fleet";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "resume-"));
});

describe("computeResumePlan", () => {
  it("returns tasks whose latest state is claimed or in-progress", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    await store.append("run:r1", taskState("t1", "completed", 1));
    await store.append("run:r1", taskState("t2", "in-progress", 1));
    await store.append("run:r1", taskState("t3", "claimed", 1));
    await store.append("run:r1", taskState("t4", "failed", 1));
    const plan = await computeResumePlan({ knowledge: store, runId: "r1" });
    expect(plan.resumableTaskIds.sort()).toEqual(["t2", "t3"]);
    expect(plan.completedTaskIds.sort()).toEqual(["t1"]);
    expect(plan.failedTaskIds.sort()).toEqual(["t4"]);
  });

  it("uses the highest-version envelope per task (latest-wins)", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    // Real histories carry multiple transitions per task. The latest version
    // (not append order) must decide the task's state. Append a higher-version
    // "completed" first, then a lower-version "claimed", to prove the resolver
    // honours version rather than write order.
    await store.append("run:r2", taskState("t1", "completed", 20));
    await store.append("run:r2", taskState("t1", "claimed", 10));
    await store.append("run:r2", taskState("t2", "claimed", 5));
    await store.append("run:r2", taskState("t2", "in-progress", 15));
    const plan = await computeResumePlan({ knowledge: store, runId: "r2" });
    expect(plan.resumableTaskIds).toEqual(["t2"]);
    expect(plan.completedTaskIds).toEqual(["t1"]);
  });

  it("treats surrendered tasks as failed", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    await store.append("run:r3", taskState("t1", "surrendered", 1));
    const plan = await computeResumePlan({ knowledge: store, runId: "r3" });
    expect(plan.failedTaskIds).toEqual(["t1"]);
    expect(plan.resumableTaskIds).toEqual([]);
  });

  it("returns empty plans for an unknown run", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    const plan = await computeResumePlan({
      knowledge: store,
      runId: "missing",
    });
    expect(plan).toEqual({
      runId: "missing",
      resumableTaskIds: [],
      completedTaskIds: [],
      failedTaskIds: [],
    });
  });

  it("treats queued and blocked tasks as resumable", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    await store.append("run:r4", taskState("t1", "queued", 1));
    await store.append("run:r4", taskState("t2", "blocked", 1));
    const plan = await computeResumePlan({ knowledge: store, runId: "r4" });
    expect(plan.resumableTaskIds.sort()).toEqual(["t1", "t2"]);
    expect(plan.completedTaskIds).toEqual([]);
    expect(plan.failedTaskIds).toEqual([]);
  });

  it("handles a task that transitions completed → in-progress (lower version wins as in-progress)", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    // version 5 = in-progress (latest), version 3 = completed (older)
    await store.append("run:r5", taskState("t1", "in-progress", 5));
    await store.append("run:r5", taskState("t1", "completed", 3));
    const plan = await computeResumePlan({ knowledge: store, runId: "r5" });
    expect(plan.resumableTaskIds).toEqual(["t1"]);
    expect(plan.completedTaskIds).toEqual([]);
  });

  it("isolates runIds — tasks from a different runId are not included", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    await store.append("run:r6", taskState("t1", "in-progress", 1));
    await store.append("run:r6", taskState("t2", "claimed", 1));
    // tasks for a different run
    await store.append("run:r7", taskState("t3", "in-progress", 1));
    await store.append("run:r7", taskState("t4", "completed", 1));
    const plan = await computeResumePlan({ knowledge: store, runId: "r6" });
    expect(plan.resumableTaskIds.sort()).toEqual(["t1", "t2"]);
    expect(plan.completedTaskIds).toEqual([]);
    expect(plan.failedTaskIds).toEqual([]);
    // t3 and t4 must not appear
    expect(plan.resumableTaskIds).not.toContain("t3");
    expect(plan.resumableTaskIds).not.toContain("t4");
  });

  it("handles multiple tasks across all three buckets simultaneously", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    // 2 completed
    await store.append("run:r8", taskState("t1", "completed", 1));
    await store.append("run:r8", taskState("t2", "completed", 1));
    // 1 failed
    await store.append("run:r8", taskState("t3", "failed", 1));
    // 1 surrendered (also failed bucket)
    await store.append("run:r8", taskState("t4", "surrendered", 1));
    // 2 resumable (queued + claimed)
    await store.append("run:r8", taskState("t5", "queued", 1));
    await store.append("run:r8", taskState("t6", "claimed", 1));
    const plan = await computeResumePlan({ knowledge: store, runId: "r8" });
    expect(plan.completedTaskIds.sort()).toEqual(["t1", "t2"]);
    expect(plan.failedTaskIds.sort()).toEqual(["t3", "t4"]);
    expect(plan.resumableTaskIds.sort()).toEqual(["t5", "t6"]);
  });
});

function taskState(
  taskId: string,
  state: TaskState,
  version: number
): KnowledgeEnvelope {
  return {
    id: `${taskId}-${state}-${version}`,
    runId: "r1",
    repo: null,
    kind: "task-state",
    key: taskId,
    version,
    authorWorkerId: "w",
    parentId: null,
    createdAt: "2026-05-29T00:00:00.000Z",
    supersededAt: null,
    payload: { taskId, state, claimedBy: "w" },
    tags: [],
  };
}

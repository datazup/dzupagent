import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DependencyTrackerPolicy } from "../policies/dependency-tracker-policy.js";
import { FilesystemKnowledgeStore } from "@dzupagent/memory/knowledge";
import type { KnowledgeEnvelope } from "@dzupagent/agent-types/fleet";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "deppolicy-"));
});

describe("DependencyTrackerPolicy", () => {
  it("blocks assignment until dependencies are completed", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    await store.append("run:r1", taskState("t-a", "in-progress"));
    const p = new DependencyTrackerPolicy({ runId: "r1" });
    await expect(
      p.assignTask(
        { id: "t-b", description: "", payload: {}, dependsOn: ["t-a"] },
        [{ workerId: "w1", repo: "r1", busy: false }],
        store
      )
    ).rejects.toThrow(/blocked|dependency|not completed/i);
  });

  it("assigns when all dependencies are completed", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    await store.append("run:r1", taskState("t-a", "completed"));
    const p = new DependencyTrackerPolicy({ runId: "r1" });
    const a = await p.assignTask(
      { id: "t-b", description: "", payload: {}, dependsOn: ["t-a"] },
      [{ workerId: "w1", repo: "r1", busy: false }],
      store
    );
    expect(a.workerId).toBe("w1");
  });
});

function taskState(
  taskId: string,
  state: "in-progress" | "completed"
): KnowledgeEnvelope {
  return {
    id: `${taskId}-${state}`,
    runId: "r1",
    repo: null,
    kind: "task-state",
    key: taskId,
    version: Date.now(),
    authorWorkerId: "w",
    parentId: null,
    createdAt: new Date().toISOString(),
    supersededAt: null,
    payload: { taskId, state, claimedBy: "w" },
    tags: [],
  };
}

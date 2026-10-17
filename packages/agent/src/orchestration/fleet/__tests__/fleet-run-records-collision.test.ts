import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ulid } from "ulidx";
import { FilesystemKnowledgeStore } from "@dzupagent/memory/knowledge";
import type {
  KnowledgeEnvelope,
  KnowledgeStore,
} from "@dzupagent/agent-types/fleet";
import { writeTaskControlState } from "../fleet-run-records.js";

/**
 * FLEET-CONTROL-VERSION-COLLISION-20261015-R1: a control write (pause, cancel,
 * reassign) and a worker's task-state write in the same millisecond can derive
 * the same version. The control writer must move past the collision the way
 * RepoAgent does, not fail the control operation.
 */

const NOW = 1_792_000_000_000;

async function queryAll(
  store: FilesystemKnowledgeStore,
  scope: string
): Promise<KnowledgeEnvelope[]> {
  const results: KnowledgeEnvelope[] = [];
  for await (const e of store.query({ scope })) results.push(e);
  return results;
}

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "fleet-records-"));
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("writeTaskControlState version collisions", () => {
  it("records the control state when a worker already holds the same task-state version", async () => {
    const store = new FilesystemKnowledgeStore({ rootDir: tmp });
    // The version the control writer derives for task "t1" at NOW. Probe it on
    // an uncontested run so a change to the formula cannot silently stop this
    // test from forcing a collision.
    const contested = NOW * 1000 + ("1".charCodeAt(0) % 1000);
    await writeTaskControlState(store, "probe", "t1", "blocked", "probe");
    const [probe] = await queryAll(store, "run:probe");
    expect(probe?.version).toBe(contested);
    await store.append("run:r1", {
      id: ulid(),
      runId: "r1",
      repo: "repo-a",
      kind: "task-state",
      key: "t1",
      version: contested,
      authorWorkerId: "worker-1",
      parentId: null,
      createdAt: new Date(NOW).toISOString(),
      supersededAt: null,
      payload: { taskId: "t1", state: "in-progress" },
      tags: [],
    } satisfies KnowledgeEnvelope);

    await writeTaskControlState(store, "r1", "t1", "blocked", "draining queue");

    const states = (await queryAll(store, "run:r1")).filter(
      (e) => e.kind === "task-state" && e.key === "t1"
    );
    expect(states).toHaveLength(2);
    const control = states.find((e) => e.tags.includes("control"));
    expect(control?.payload).toMatchObject({ state: "blocked" });
    expect(control?.version).toBe(contested + 1);
  });

  it("does not retry an error that is not a version collision", async () => {
    const failure = new Error("store unavailable");
    const append = vi.fn().mockRejectedValue(failure);
    const store = { append } as unknown as KnowledgeStore;

    await expect(
      writeTaskControlState(store, "r1", "t1", "surrendered", "cancelled")
    ).rejects.toBe(failure);
    expect(append).toHaveBeenCalledTimes(1);
  });
});

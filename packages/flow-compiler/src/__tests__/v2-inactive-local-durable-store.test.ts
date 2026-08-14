import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFileV2InactiveLocalHostStore,
  type V2InactiveLocalHostCheckpoint,
} from "../v2-inactive-local-target.js";
import {
  digest,
  stableStringify,
} from "../v2-inactive-local-target/evidence.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function temporaryDirectory(name: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const directory = await mkdtemp(`/tmp/dzupagent-${name}-`);
  temporaryDirectories.push(directory);
  return directory;
}

function checkpoint(
  runId: string,
  revision: number,
  previousCheckpointSha256: `sha256:${string}` | null,
  status: V2InactiveLocalHostCheckpoint["status"] = "running"
): V2InactiveLocalHostCheckpoint {
  const core = {
    schema: "dzupagent.v2InactiveLocalHostCheckpoint/v1" as const,
    target: "dzupagent.local-v2-multi-step-host@1" as const,
    runId,
    sourceSha256: `sha256:${"1".repeat(64)}` as const,
    qualificationSha256: `sha256:${"2".repeat(64)}` as const,
    planSha256: `sha256:${"3".repeat(64)}` as const,
    revision,
    status,
    nextStepIndex: revision,
    state: { revision },
    stepOutputs: {},
    branchDecisions: {},
    steps: [],
    previousCheckpointSha256,
  };
  return {
    ...core,
    checkpointSha256: digest(stableStringify(core)),
  };
}

function runKey(runId: string): string {
  return createHash("sha256").update(runId).digest("hex");
}

describe("inactive V2 durable checkpoint store", () => {
  it("persists a terminal checkpoint across fresh store instances with private modes", async () => {
    const rootDirectory = await temporaryDirectory("durable-restart");
    const firstStore = createFileV2InactiveLocalHostStore({
      rootDirectory,
      randomId: () => "first-process",
    });
    const firstClaim = await firstStore.claim({
      runId: "restart-run",
      ownerId: "worker-a",
    });
    expect(firstClaim).toMatchObject({ ok: true, fencingToken: 1 });
    if (!firstClaim.ok) throw new Error("expected first claim");

    const terminal = checkpoint("restart-run", 1, null, "completed");
    expect(
      await firstStore.commit({
        runId: "restart-run",
        leaseToken: firstClaim.leaseToken,
        fencingToken: firstClaim.fencingToken,
        expectedPreviousSha256: null,
        checkpoint: terminal,
      })
    ).toBe(true);
    expect(
      await firstStore.release({
        runId: "restart-run",
        leaseToken: firstClaim.leaseToken,
        fencingToken: firstClaim.fencingToken,
      })
    ).toBe(true);
    expect(
      await firstStore.release({
        runId: "restart-run",
        leaseToken: firstClaim.leaseToken,
        fencingToken: firstClaim.fencingToken,
      })
    ).toBe(true);

    const secondStore = createFileV2InactiveLocalHostStore({
      rootDirectory,
      randomId: () => "fresh-process",
    });
    const restored = await secondStore.claim({
      runId: "restart-run",
      ownerId: "worker-b",
    });
    expect(restored).toMatchObject({
      ok: true,
      fencingToken: 2,
      checkpoint: terminal,
    });
    expect((await stat(rootDirectory)).mode & 0o777).toBe(0o700);
    expect(
      (await stat(resolve(rootDirectory, `${runKey("restart-run")}.json`)))
        .mode & 0o777
    ).toBe(0o600);
    expect(secondStore.evidence).toMatchObject({
      capability: "flow.runtime.durable-checkpoint-store@1",
      processScope: "multi-process",
      fencing: "monotonic-token-before-every-cas",
      providerDispatch: false,
      workflowExternalMutation: false,
      deployment: false,
      activation: false,
    });
  });

  it("expires a lease and rejects every stale-owner CAS and release", async () => {
    const rootDirectory = await temporaryDirectory("durable-fencing");
    let nowMs = 10_000;
    const options = {
      rootDirectory,
      leaseDurationMs: 100,
      clock: () => nowMs,
    };
    const staleStore = createFileV2InactiveLocalHostStore({
      ...options,
      randomId: () => "stale-owner",
    });
    const firstClaim = await staleStore.claim({
      runId: "fenced-run",
      ownerId: "worker-a",
    });
    if (!firstClaim.ok) throw new Error("expected first claim");

    nowMs = 10_101;
    const currentStore = createFileV2InactiveLocalHostStore({
      ...options,
      randomId: () => "current-owner",
    });
    const secondClaim = await currentStore.claim({
      runId: "fenced-run",
      ownerId: "worker-b",
    });
    expect(secondClaim).toMatchObject({ ok: true, fencingToken: 2 });
    if (!secondClaim.ok) throw new Error("expected second claim");

    const firstCheckpoint = checkpoint("fenced-run", 1, null);
    expect(
      await staleStore.commit({
        runId: "fenced-run",
        leaseToken: firstClaim.leaseToken,
        fencingToken: firstClaim.fencingToken,
        expectedPreviousSha256: null,
        checkpoint: firstCheckpoint,
      })
    ).toBe(false);
    expect(
      await staleStore.release({
        runId: "fenced-run",
        leaseToken: firstClaim.leaseToken,
        fencingToken: firstClaim.fencingToken,
      })
    ).toBe(false);
    expect(
      await currentStore.commit({
        runId: "fenced-run",
        leaseToken: secondClaim.leaseToken,
        fencingToken: secondClaim.fencingToken,
        expectedPreviousSha256: null,
        checkpoint: firstCheckpoint,
      })
    ).toBe(true);
  });

  it("admits exactly one owner under eight-way process contention", async () => {
    const rootDirectory = await temporaryDirectory("durable-contention");
    const workerPath = fileURLToPath(
      new URL("./fixtures/durable-host-store-worker.mjs", import.meta.url)
    );
    const startAt = Date.now() + 500;
    const workerResults = await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const { stdout } = await execFileAsync(process.execPath, [
          workerPath,
          rootDirectory,
          "contended-run",
          `worker-${index}`,
          String(startAt),
        ]);
        return JSON.parse(stdout) as {
          claim:
            | { ok: false }
            | { ok: true; leaseToken: string; fencingToken: number };
        };
      })
    );
    expect(workerResults.filter((result) => result.claim.ok)).toHaveLength(1);
    expect(workerResults.filter((result) => !result.claim.ok)).toHaveLength(7);
    expect(workerResults.find((result) => result.claim.ok)).toMatchObject({
      claim: { fencingToken: 1 },
    });

    const winner = workerResults.find((result) => result.claim.ok);
    if (!winner?.claim.ok) throw new Error("expected one winning claim");
    const cleanupStore = createFileV2InactiveLocalHostStore({ rootDirectory });
    await expect(
      cleanupStore.release({
        runId: "contended-run",
        leaseToken: winner.claim.leaseToken,
        fencingToken: winner.claim.fencingToken,
      })
    ).resolves.toBe(true);

    const nextStore = createFileV2InactiveLocalHostStore({
      rootDirectory,
      randomId: () => "next-owner",
    });
    await expect(
      nextStore.claim({ runId: "contended-run", ownerId: "next-owner" })
    ).resolves.toMatchObject({
      ok: true,
      fencingToken: 2,
      checkpoint: null,
    });
  });

  it("recovers a stale crash lock while ignoring an uncommitted temp record", async () => {
    const rootDirectory = await temporaryDirectory("durable-crash");
    const key = runKey("crash-run");
    const lockDirectory = resolve(rootDirectory, `${key}.lock`);
    await mkdir(lockDirectory, { mode: 0o700 });
    await writeFile(resolve(rootDirectory, `${key}.json.tmp-dead-owner`), "partial", {
      mode: 0o600,
    });
    await utimes(lockDirectory, new Date(0), new Date(0));

    const store = createFileV2InactiveLocalHostStore({
      rootDirectory,
      lockStaleMs: 10,
      randomId: () => "recovery",
    });
    await expect(
      store.claim({ runId: "crash-run", ownerId: "recovery-worker" })
    ).resolves.toMatchObject({ ok: true, fencingToken: 1, checkpoint: null });
  });

  it("rejects a substituted durable record before returning checkpoint evidence", async () => {
    const rootDirectory = await temporaryDirectory("durable-tamper");
    const store = createFileV2InactiveLocalHostStore({
      rootDirectory,
      randomId: () => "tamper-owner",
    });
    const claim = await store.claim({ runId: "tamper-run", ownerId: "worker" });
    if (!claim.ok) throw new Error("expected claim");
    await store.release({
      runId: "tamper-run",
      leaseToken: claim.leaseToken,
      fencingToken: claim.fencingToken,
    });

    const recordPath = resolve(rootDirectory, `${runKey("tamper-run")}.json`);
    const envelope = JSON.parse(await readFile(recordPath, "utf8")) as {
      record: { runId: string };
    };
    envelope.record.runId = "substituted-run";
    await writeFile(recordPath, JSON.stringify(envelope), { mode: 0o600 });

    await expect(
      store.claim({ runId: "tamper-run", ownerId: "next-worker" })
    ).rejects.toThrow("failed identity or digest validation");
  });
});

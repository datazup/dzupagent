import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

import { canonicalInputDigest } from "@dzupagent/runtime-contracts";

import type { RecursiveCrashEventV1 } from "./fixtures/recursive-crash-test-port.js";

type Scenario =
  | "branch"
  | "branch-single"
  | "branch-left-last"
  | "branch-right-last"
  | "public-branch"
  | "item"
  | "control-single"
  | "control-terminal"
  | "control-ambiguous";

interface WorkerSummary {
  readonly status: string;
  readonly reason?: string;
  readonly childScopeId?: string;
  readonly control?: string;
  readonly decisionIdentity?: string;
  readonly mergeIdentity?: string;
  readonly orderedResults?: readonly unknown[];
  readonly checkpointVersion?: number;
  readonly receiptCheckpointVersion?: number;
  readonly completedNodeIds?: readonly string[];
  readonly progress?: {
    readonly skippedBodyCompleteChildScopeIds?: readonly string[];
    readonly skippedCommittedChildScopeIds?: readonly string[];
  };
}

type WorkerRun =
  | {
      readonly kind: "crashed";
      readonly point: string;
      readonly signal: string;
    }
  | {
      readonly kind: "result";
      readonly summary: WorkerSummary;
    };

const workerPath = fileURLToPath(
  new URL("./fixtures/recursive-crash-worker.ts", import.meta.url),
);
const packageDirectory = fileURLToPath(new URL("../../../", import.meta.url));

async function runWorker(
  rootDirectory: string,
  scenario: Scenario,
  mode: "initial" | "restart",
  crashPoint = "none",
): Promise<WorkerRun> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      workerPath,
      rootDirectory,
      scenario,
      mode,
      crashPoint,
    ],
    {
      cwd: packageDirectory,
      env: { NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exit = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  let ready: string | undefined;
  let summary: WorkerSummary | undefined;
  for await (const line of lines) {
    if (line.startsWith("READY:")) {
      ready = line.slice("READY:".length);
      child.kill("SIGKILL");
      break;
    }
    if (line.startsWith("RESULT:")) {
      summary = JSON.parse(line.slice("RESULT:".length)) as WorkerSummary;
    }
  }
  const [code, signal] = (await exit) as [number | null, string | null];
  if (ready !== undefined) {
    if (ready !== crashPoint || signal !== "SIGKILL") {
      throw new Error(
        `Unexpected crash receipt ${ready}/${String(signal)}: ${stderr}`,
      );
    }
    return { kind: "crashed", point: ready, signal };
  }
  if (code !== 0 || summary === undefined) {
    throw new Error(
      `Recursive crash worker failed (${String(code)}/${String(signal)}): ${stderr}`,
    );
  }
  return { kind: "result", summary };
}

async function withState(
  run: (rootDirectory: string) => Promise<void>,
): Promise<void> {
  const rootDirectory = await mkdtemp(
    join(tmpdir(), "dzupagent-recursive-crash-"),
  );
  try {
    await run(rootDirectory);
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
}

async function events(rootDirectory: string): Promise<RecursiveCrashEventV1[]> {
  try {
    return (await readFile(join(rootDirectory, "events.jsonl"), "utf8"))
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as RecursiveCrashEventV1);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function collectionFiles(
  rootDirectory: string,
  collection: string,
): Promise<string[]> {
  try {
    return await readdir(join(rootDirectory, collection));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function result(
  rootDirectory: string,
  scenario: Scenario,
  mode: "initial" | "restart",
): Promise<WorkerSummary> {
  const run = await runWorker(rootDirectory, scenario, mode);
  if (run.kind !== "result") {
    throw new Error(`Expected result, received crash at ${run.point}.`);
  }
  return run.summary;
}

function count(
  retained: readonly RecursiveCrashEventV1[],
  event: string,
  childScopeId?: string,
): number {
  return retained.filter(
    (entry) =>
      entry.event === event &&
      (childScopeId === undefined || entry.childScopeId === childScopeId),
  ).length;
}

describe.sequential("recursive independent-process crash windows", () => {
  it.each(["initial-frame-before-write", "initial-frame-after-write"])(
    "retries %s in a fresh process before child dispatch",
    async (point) =>
      withState(async (rootDirectory) => {
        const interrupted = await runWorker(
          rootDirectory,
          "branch",
          "initial",
          point,
        );
        expect(interrupted).toEqual({
          kind: "crashed",
          point,
          signal: "SIGKILL",
        });
        expect(count(await events(rootDirectory), "executor-executed")).toBe(0);
        expect(await collectionFiles(rootDirectory, "frames")).toHaveLength(
          point.endsWith("after-write") ? 1 : 0,
        );

        const resumed = await result(
          rootDirectory,
          "branch",
          "initial",
        );
        expect(resumed.status).toBe("completed");
        expect(count(await events(rootDirectory), "executor-executed")).toBe(2);
      }),
  );

  it("restores an acknowledged in-flight checkpoint after worker death", async () =>
    withState(async (rootDirectory) => {
      await runWorker(
        rootDirectory,
        "branch-single",
        "initial",
        "checkpoint-after-write",
      );
      const resumed = await result(rootDirectory, "branch-single", "restart");
      const retained = await events(rootDirectory);
      expect(resumed).toMatchObject({ status: "completed" });
      expect(count(retained, "checkpoint-restored", "parallel/left")).toBe(1);
      expect(count(retained, "executor-executed", "parallel/left")).toBe(2);
      expect(count(retained, "executor-executed", "parallel/right")).toBe(0);
    }));

  it.each([
    "effect-before-write",
    "effect-after-write",
    "charge-before-write",
    "charge-after-write",
  ])("reconciles item economics exactly once after %s", async (point) =>
    withState(async (rootDirectory) => {
      await runWorker(rootDirectory, "item", "initial", point);
      const resumed = await result(rootDirectory, "item", "restart");
      const retained = await events(rootDirectory);
      expect(resumed.status).toBe("completed");
      expect(resumed.orderedResults).toEqual([
        { itemOrdinal: 0, itemValue: "zero" },
        { itemOrdinal: 1, itemValue: "one" },
      ]);
      expect(count(retained, "effect-performed", "recursive-items/0")).toBe(1);
      expect(count(retained, "charge-performed", "recursive-items/0")).toBe(1);
      expect(count(retained, "effect-performed", "recursive-items/1")).toBe(1);
      expect(count(retained, "charge-performed", "recursive-items/1")).toBe(1);
    }),
  );

  it.each(["body-complete-after-write", "child-commit-after-write"])(
    "does not redispatch a settled item after %s",
    async (point) =>
      withState(async (rootDirectory) => {
        await runWorker(rootDirectory, "item", "initial", point);
        const resumed = await result(rootDirectory, "item", "restart");
        const retained = await events(rootDirectory);
        expect(resumed.status).toBe("completed");
        expect(count(retained, "executor-executed", "recursive-items/0")).toBe(1);
        expect(count(retained, "effect-performed", "recursive-items/0")).toBe(1);
        expect(count(retained, "charge-performed", "recursive-items/0")).toBe(1);
        if (point === "body-complete-after-write") {
          expect(resumed.progress?.skippedBodyCompleteChildScopeIds).toContain(
            "recursive-items/0",
          );
        } else {
          expect(resumed.progress?.skippedCommittedChildScopeIds).toContain(
            "recursive-items/0",
          );
        }
      }),
  );

  it.each([
    "candidate-set-after-write",
    "owner-claim-after-write",
    "control-decision-after-write",
  ])("restores the same control owner after %s", async (point) =>
    withState(async (rootDirectory) => {
      await runWorker(rootDirectory, "control-single", "initial", point);
      const beforeRestart = await events(rootDirectory);
      const resumed = await result(
        rootDirectory,
        "control-single",
        "restart",
      );
      const afterRestart = await events(rootDirectory);
      expect(resumed).toMatchObject({
        status: "suspended-for-later",
        childScopeId: "parallel/left",
        control: "interaction",
      });
      expect(resumed.decisionIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(count(afterRestart, "executor-executed")).toBe(
        count(beforeRestart, "executor-executed"),
      );
    }),
  );

  it("restores exact terminal cancellation after process death", async () =>
    withState(async (rootDirectory) => {
      await runWorker(
        rootDirectory,
        "control-terminal",
        "initial",
        "cancellation-after-write",
      );
      const beforeRestart = await events(rootDirectory);
      const resumed = await result(
        rootDirectory,
        "control-terminal",
        "restart",
      );
      expect(resumed).toMatchObject({
        status: "suspended-for-later",
        childScopeId: "parallel/left",
        control: "terminal",
      });
      expect(await collectionFiles(rootDirectory, "cancellations")).toHaveLength(1);
      expect(count(await events(rootDirectory), "executor-executed")).toBe(
        count(beforeRestart, "executor-executed"),
      );
    }));

  it("preserves ambiguity when death interrupts candidate claim persistence", async () =>
    withState(async (rootDirectory) => {
      await runWorker(
        rootDirectory,
        "control-ambiguous",
        "initial",
        "owner-claim-after-write",
      );
      const beforeRestart = await events(rootDirectory);
      expect(await collectionFiles(rootDirectory, "commits")).toHaveLength(1);
      const resumed = await result(
        rootDirectory,
        "control-ambiguous",
        "restart",
      );
      expect(resumed).toMatchObject({
        status: "blocked",
        reason: "ambiguous-control-owner",
      });
      expect(await collectionFiles(rootDirectory, "commits")).toHaveLength(2);
      expect(await collectionFiles(rootDirectory, "decisions")).toHaveLength(0);
      expect(count(await events(rootDirectory), "executor-executed")).toBe(
        count(beforeRestart, "executor-executed"),
      );
    }));

  it("reconstructs the same merge after death at the private parent boundary", async () =>
    withState(async (rootDirectory) => {
      await runWorker(
        rootDirectory,
        "branch",
        "initial",
        "parent-merge-after-materialize",
      );
      const beforeRestart = await events(rootDirectory);
      const interruptedSummary = JSON.parse(
        await readFile(join(rootDirectory, "last-summary.json"), "utf8"),
      ) as WorkerSummary;
      const resumed = await result(rootDirectory, "branch", "restart");
      expect(resumed.status).toBe("completed");
      expect(resumed.mergeIdentity).toBe(interruptedSummary.mergeIdentity);
      expect(count(await events(rootDirectory), "executor-executed")).toBe(
        count(beforeRestart, "executor-executed"),
      );
    }));

  it.each([
    "public-parent-completion-before-write",
    "public-parent-completion-after-write",
  ])(
    "restores the public PipelineRuntime exactly once after SIGKILL at %s",
    async (point) =>
      withState(async (rootDirectory) => {
        const interrupted = await runWorker(
          rootDirectory,
          "public-branch",
          "initial",
          point,
        );
        expect(interrupted).toEqual({
          kind: "crashed",
          point,
          signal: "SIGKILL",
        });
        const beforeRestart = await events(rootDirectory);
        expect(count(beforeRestart, "public-node-executed", "decision")).toBe(1);
        expect(count(beforeRestart, "public-node-executed", "then")).toBe(1);
        expect(count(beforeRestart, "public-node-executed", "else")).toBe(0);
        expect(count(beforeRestart, "public-node-executed", "sibling")).toBe(1);
        expect(count(beforeRestart, "public-node-executed", "after")).toBe(0);

        const resumed = await result(
          rootDirectory,
          "public-branch",
          "restart",
        );
        expect(resumed).toMatchObject({
          status: "completed",
          checkpointVersion: 2,
          receiptCheckpointVersion: 1,
          completedNodeIds: expect.arrayContaining([
            "fork",
            "join",
            "after",
          ]),
        });
        const afterResume = await events(rootDirectory);
        expect(count(afterResume, "public-node-executed", "decision")).toBe(1);
        expect(count(afterResume, "public-node-executed", "then")).toBe(1);
        expect(count(afterResume, "public-node-executed", "else")).toBe(0);
        expect(count(afterResume, "public-node-executed", "sibling")).toBe(1);
        expect(count(afterResume, "public-node-executed", "after")).toBe(1);

        const replayed = await result(
          rootDirectory,
          "public-branch",
          "restart",
        );
        expect(replayed).toMatchObject({
          status: "completed",
          checkpointVersion: 2,
          receiptCheckpointVersion: 1,
        });
        const afterReplay = await events(rootDirectory);
        for (const nodeId of ["decision", "then", "else", "sibling", "after"]) {
          expect(count(afterReplay, "public-node-executed", nodeId)).toBe(
            count(afterResume, "public-node-executed", nodeId),
          );
        }
      }),
  );

  it("keeps merge identity independent of fresh-process completion order", async () => {
    const leftRoot = await mkdtemp(join(tmpdir(), "dzupagent-recursive-order-"));
    const rightRoot = await mkdtemp(join(tmpdir(), "dzupagent-recursive-order-"));
    try {
      const leftLast = await result(leftRoot, "branch-left-last", "initial");
      const rightLast = await result(rightRoot, "branch-right-last", "initial");
      expect(leftLast.status).toBe("completed");
      expect(rightLast.status).toBe("completed");
      expect(leftLast.mergeIdentity).toBe(rightLast.mergeIdentity);
    } finally {
      await rm(leftRoot, { recursive: true, force: true });
      await rm(rightRoot, { recursive: true, force: true });
    }
  });

  it("rejects partial frame bytes in a fresh process with zero redispatch", async () =>
    withState(async (rootDirectory) => {
      expect((await result(rootDirectory, "branch", "initial")).status).toBe(
        "completed",
      );
      const beforeRestart = await events(rootDirectory);
      const [frameFile] = await collectionFiles(rootDirectory, "frames");
      expect(frameFile).toBeDefined();
      await writeFile(join(rootDirectory, "frames", frameFile!), "{", "utf8");
      const resumed = await result(rootDirectory, "branch", "restart");
      expect(resumed).toMatchObject({
        status: "corrupt",
        reason: "frame-corrupt",
      });
      expect(count(await events(rootDirectory), "executor-executed")).toBe(
        count(beforeRestart, "executor-executed"),
      );
    }));

  it("rejects a canonically valid foreign candidate set with zero redispatch", async () =>
    withState(async (rootDirectory) => {
      expect(
        (await result(rootDirectory, "control-single", "initial")).status,
      ).toBe("suspended-for-later");
      const beforeRestart = await events(rootDirectory);
      const [candidateFile] = await collectionFiles(
        rootDirectory,
        "candidate-sets",
      );
      expect(candidateFile).toBeDefined();
      const path = join(rootDirectory, "candidate-sets", candidateFile!);
      const parsed = JSON.parse(await readFile(path, "utf8")) as Record<
        string,
        unknown
      >;
      const { candidateSetIdentity: _ignored, ...core } = parsed;
      const foreignCore = {
        ...core,
        parentCommitIdentity: `sha256:${"f".repeat(64)}`,
      };
      await writeFile(
        path,
        JSON.stringify({
          ...foreignCore,
          candidateSetIdentity: `sha256:${canonicalInputDigest(foreignCore)}`,
        }),
        "utf8",
      );
      const resumed = await result(
        rootDirectory,
        "control-single",
        "restart",
      );
      expect(resumed).toMatchObject({
        status: "corrupt",
        reason: "control-candidate-set-drift",
      });
      expect(count(await events(rootDirectory), "executor-executed")).toBe(
        count(beforeRestart, "executor-executed"),
      );
    }));
});

import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RecursiveScopedSha256Digest } from "@dzupagent/runtime-contracts/recursive-scope";

import type {
  RecursiveCommitCompareAndSaveInputV1,
  RecursiveControlCandidateSetCompareAndSaveInputV1,
  RecursiveControlCancellationCompareAndSaveInputV1,
  RecursiveControlDecisionCompareAndSaveInputV1,
  RecursiveControlDurablePortV1,
  RecursiveControlDurableWriteResultV1,
  RecursiveDurableWriteResultV1,
  RecursiveFrameCompareAndSaveInputV1,
  RecursiveScopedDurablePortV1,
} from "../../recursive-scope/index.js";

export interface RecursiveCrashEventV1 {
  readonly event: string;
  readonly childScopeId?: string;
  readonly detail?: string;
}

export class RecursiveCrashController {
  private triggered = false;

  constructor(
    private readonly rootDirectory: string,
    private readonly target: string,
  ) {}

  async hit(point: string): Promise<void> {
    if (this.triggered || this.target !== point) return;
    this.triggered = true;
    await appendRecursiveCrashEvent(this.rootDirectory, {
      event: "crash-ready",
      detail: point,
    });
    process.stdout.write(`READY:${point}\n`);
    await new Promise<void>(() => {});
  }
}

export async function appendRecursiveCrashEvent(
  rootDirectory: string,
  event: RecursiveCrashEventV1,
): Promise<void> {
  await mkdir(rootDirectory, { recursive: true });
  await appendFile(
    join(rootDirectory, "events.jsonl"),
    `${JSON.stringify(event)}\n`,
    "utf8",
  );
}

function encoded(key: string): string {
  return `${Buffer.from(key).toString("base64url")}.json`;
}

function identity(
  serialized: string | undefined,
  field: string,
): RecursiveScopedSha256Digest | undefined {
  if (serialized === undefined) return undefined;
  try {
    const value = (JSON.parse(serialized) as Record<string, unknown>)[field];
    return typeof value === "string"
      ? (value as RecursiveScopedSha256Digest)
      : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function frameBoundary(
  input: RecursiveFrameCompareAndSaveInputV1,
): "initial-frame" | "checkpoint" | "body-complete" {
  if (input.expectedFrameIdentity === undefined) return "initial-frame";
  try {
    const frame = JSON.parse(input.serializedFrame) as {
      readonly checkpoint?: { readonly phase?: unknown };
    };
    return frame.checkpoint?.phase === "body-complete"
      ? "body-complete"
      : "checkpoint";
  } catch {
    return "checkpoint";
  }
}

function commitBoundary(
  input: RecursiveCommitCompareAndSaveInputV1,
): "owner-claim" | "child-commit" {
  try {
    const commit = JSON.parse(input.serializedCommit) as {
      readonly intentClaims?: readonly unknown[];
    };
    return (commit.intentClaims?.length ?? 0) > 0
      ? "owner-claim"
      : "child-commit";
  } catch {
    return "child-commit";
  }
}

type DurableWriteResult =
  | RecursiveDurableWriteResultV1
  | RecursiveControlDurableWriteResultV1;

export class FileRecursiveCrashPort
  implements RecursiveScopedDurablePortV1, RecursiveControlDurablePortV1
{
  constructor(
    private readonly rootDirectory: string,
    private readonly crash: RecursiveCrashController,
  ) {}

  async loadFrame(childScopeId: string): Promise<string | undefined> {
    return this.load("frames", childScopeId);
  }

  async compareAndSaveFrame(
    input: RecursiveFrameCompareAndSaveInputV1,
  ): Promise<RecursiveDurableWriteResultV1> {
    const boundary = frameBoundary(input);
    return this.compareAndSave(
      "frames",
      input.childScopeId,
      input.expectedFrameIdentity,
      input.frameIdentity,
      input.serializedFrame,
      "frameIdentity",
      boundary,
    );
  }

  async loadCommittedChild(childScopeId: string): Promise<string | undefined> {
    return this.load("commits", childScopeId);
  }

  async compareAndSaveCommittedChild(
    input: RecursiveCommitCompareAndSaveInputV1,
  ): Promise<RecursiveDurableWriteResultV1> {
    return this.compareAndSave(
      "commits",
      input.childScopeId,
      input.expectedCommitIdentity,
      input.commitIdentity,
      input.serializedCommit,
      "commitIdentity",
      commitBoundary(input),
    );
  }

  async loadControlCandidateSet(
    controlScopeIdentity: RecursiveScopedSha256Digest,
  ): Promise<string | undefined> {
    return this.load("candidate-sets", controlScopeIdentity);
  }

  async compareAndSaveControlCandidateSet(
    input: RecursiveControlCandidateSetCompareAndSaveInputV1,
  ): Promise<RecursiveControlDurableWriteResultV1> {
    return this.compareAndSave(
      "candidate-sets",
      input.controlScopeIdentity,
      input.expectedCandidateSetIdentity,
      input.candidateSetIdentity,
      input.serializedCandidateSet,
      "candidateSetIdentity",
      "candidate-set",
    );
  }

  async loadControlDecision(
    controlScopeIdentity: RecursiveScopedSha256Digest,
  ): Promise<string | undefined> {
    return this.load("decisions", controlScopeIdentity);
  }

  async compareAndSaveControlDecision(
    input: RecursiveControlDecisionCompareAndSaveInputV1,
  ): Promise<RecursiveControlDurableWriteResultV1> {
    return this.compareAndSave(
      "decisions",
      input.controlScopeIdentity,
      input.expectedDecisionIdentity,
      input.decisionIdentity,
      input.serializedDecision,
      "decisionIdentity",
      "control-decision",
    );
  }

  async loadControlCancellation(
    childScopeId: string,
  ): Promise<string | undefined> {
    return this.load("cancellations", childScopeId);
  }

  async compareAndSaveControlCancellation(
    input: RecursiveControlCancellationCompareAndSaveInputV1,
  ): Promise<RecursiveControlDurableWriteResultV1> {
    return this.compareAndSave(
      "cancellations",
      input.childScopeId,
      input.expectedCancellationIdentity,
      input.cancellationIdentity,
      input.serializedCancellation,
      "cancellationIdentity",
      "cancellation",
    );
  }

  private async load(
    collection: string,
    key: string,
  ): Promise<string | undefined> {
    try {
      return await readFile(
        join(this.rootDirectory, collection, encoded(key)),
        "utf8",
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    }
  }

  private async compareAndSave(
    collection: string,
    key: string,
    expectedIdentity: RecursiveScopedSha256Digest | undefined,
    nextIdentity: RecursiveScopedSha256Digest,
    serialized: string,
    identityField: string,
    boundary: string,
  ): Promise<DurableWriteResult> {
    await this.crash.hit(`${boundary}-before-write`);
    const target = join(this.rootDirectory, collection, encoded(key));
    await mkdir(dirname(target), { recursive: true });
    const lockPath = `${target}.lock`;
    const lock = await this.acquireLock(lockPath);
    if (lock === undefined) return { status: "conflict" };
    try {
      const current = await this.load(collection, key);
      if (identity(current, identityField) !== expectedIdentity) {
        return { status: "conflict" };
      }
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx" });
      await rename(temporary, target);
    } finally {
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
    }
    await appendRecursiveCrashEvent(this.rootDirectory, {
      event: `${boundary}-saved`,
      childScopeId: key,
    });
    await this.crash.hit(`${boundary}-after-write`);
    return { status: "committed", storedIdentity: nextIdentity };
  }

  private async acquireLock(lockPath: string): Promise<FileHandle | undefined> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const lock = await open(lockPath, "wx");
        await lock.writeFile(String(process.pid), "utf8");
        return lock;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
        ) {
          throw error;
        }
        let owner = Number.NaN;
        try {
          owner = Number.parseInt(await readFile(lockPath, "utf8"), 10);
        } catch {
          // A killed process can leave the lock before its PID is flushed.
        }
        if (Number.isInteger(owner) && processIsAlive(owner)) return undefined;
        await unlink(lockPath).catch(() => undefined);
      }
    }
    return undefined;
  }
}

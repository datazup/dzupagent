import { describe, expect, it } from "vitest";

import {
  deserializeRecursiveScopedFrameV1,
  materializeRecursiveScopedCommitV1,
  mergeRecursiveScopedCommitsV1,
  recursiveScopedFrameBindingV1,
  serializeRecursiveScopedCommitV1,
  serializeRecursiveScopedFrameV1,
  serializeRecursiveScopedMergeV1,
  type RecursiveAcknowledgementEvidenceInputV1,
  type RecursiveScopedFrameV1,
  type RecursiveScopedSha256Digest,
} from "@dzupagent/runtime-contracts/recursive-scope";

import {
  dispatchRecursiveBranchesV1,
  materializeRecursiveBranchPlanV1,
  type RecursiveBranchChildCommitPayloadV1,
  type RecursiveBranchChildExecutorFactoryV1,
  type RecursiveBranchDurablePortV1,
  type RecursiveBranchPlanInputV1,
  type RecursiveCommitCompareAndSaveInputV1,
  type RecursiveDurableWriteResultV1,
  type RecursiveFrameCompareAndSaveInputV1,
} from "../recursive-scope/index.js";

const sha = (character: string) =>
  `sha256:${character.repeat(64)}` as RecursiveScopedSha256Digest;
const observedAt = "2026-08-18T14:00:00.000Z";

type WriteMode =
  | "normal"
  | "acknowledgement-lost-saved"
  | "acknowledgement-lost-absent"
  | "conflict";

class MemoryRecursiveBranchPort implements RecursiveBranchDurablePortV1 {
  readonly frames = new Map<string, string>();
  readonly commits = new Map<string, string>();
  readonly frameWriteModes = new Map<string, WriteMode>();
  readonly commitWriteModes = new Map<string, WriteMode>();

  async loadFrame(childScopeId: string): Promise<string | undefined> {
    return this.frames.get(childScopeId);
  }

  async compareAndSaveFrame(
    input: RecursiveFrameCompareAndSaveInputV1,
  ): Promise<RecursiveDurableWriteResultV1> {
    return this.write(
      this.frames,
      this.frameWriteModes.get(input.childScopeId) ?? "normal",
      input.childScopeId,
      input.expectedFrameIdentity,
      input.frameIdentity,
      input.serializedFrame,
      "frameIdentity",
    );
  }

  async loadCommittedChild(childScopeId: string): Promise<string | undefined> {
    return this.commits.get(childScopeId);
  }

  async compareAndSaveCommittedChild(
    input: RecursiveCommitCompareAndSaveInputV1,
  ): Promise<RecursiveDurableWriteResultV1> {
    return this.write(
      this.commits,
      this.commitWriteModes.get(input.childScopeId) ?? "normal",
      input.childScopeId,
      input.expectedCommitIdentity,
      input.commitIdentity,
      input.serializedCommit,
      "commitIdentity",
    );
  }

  private write(
    target: Map<string, string>,
    mode: WriteMode,
    childScopeId: string,
    expectedIdentity: RecursiveScopedSha256Digest | undefined,
    nextIdentity: RecursiveScopedSha256Digest,
    serialized: string,
    identityField: "frameIdentity" | "commitIdentity",
  ): RecursiveDurableWriteResultV1 {
    if (mode === "conflict") return { status: "conflict" };
    const current = target.get(childScopeId);
    if (this.identity(current, identityField) !== expectedIdentity) {
      return { status: "conflict" };
    }
    if (mode === "acknowledgement-lost-absent") {
      return { status: "acknowledgement-lost" };
    }
    target.set(childScopeId, serialized);
    if (mode === "acknowledgement-lost-saved") {
      return { status: "acknowledgement-lost" };
    }
    return { status: "committed", storedIdentity: nextIdentity };
  }

  private identity(
    serialized: string | undefined,
    field: "frameIdentity" | "commitIdentity",
  ): RecursiveScopedSha256Digest | undefined {
    if (serialized === undefined) return undefined;
    try {
      const parsed = JSON.parse(serialized) as Record<string, unknown>;
      const value = parsed[field];
      return typeof value === "string"
        ? (value as RecursiveScopedSha256Digest)
        : undefined;
    } catch {
      return undefined;
    }
  }
}

function planInput(): RecursiveBranchPlanInputV1 {
  return {
    frameKind: "fork-branch",
    rootDefinitionId: "root-flow",
    rootDefinitionDigest: sha("a"),
    ownerPath: ["root", "parallel"],
    ownerNodeId: "parallel",
    parentCommitIdentity: sha("c"),
    branches: [
      {
        branchOrdinal: 1,
        branchIdentity: "right",
        childScopeId: "parallel/branch/right",
        scopedDefinitionId: "parallel/right",
        scopedDefinitionDigest: sha("e"),
        nodeInventory: ["right-exit", "right-entry"],
        continuation: { kind: "fork-join", nodeId: "join" },
        checkpoint: { cursor: "right-entry" },
      },
      {
        branchOrdinal: 0,
        branchIdentity: "left",
        childScopeId: "parallel/branch/left",
        scopedDefinitionId: "parallel/left",
        scopedDefinitionDigest: sha("d"),
        nodeInventory: ["left-exit", "left-entry"],
        continuation: { kind: "fork-join", nodeId: "join" },
        checkpoint: { cursor: "left-entry" },
      },
    ],
  };
}

function oneBranchPlan(): RecursiveBranchPlanInputV1 {
  const input = planInput();
  return { ...input, branches: [input.branches[1]!] };
}

function conditionalBranchPlan(): RecursiveBranchPlanInputV1 {
  const input = oneBranchPlan();
  return {
    ...input,
    frameKind: "branch",
    ownerPath: ["root", "decision"],
    ownerNodeId: "decision",
    branches: input.branches.map((branch) => ({
      ...branch,
      continuation: { kind: "node", nodeId: "after-decision" },
    })),
  };
}

function replaceBranch(
  input: RecursiveBranchPlanInputV1,
  childScopeId: string,
  replacement: Partial<RecursiveBranchPlanInputV1["branches"][number]>,
): RecursiveBranchPlanInputV1 {
  return {
    ...input,
    branches: input.branches.map((branch) =>
      branch.childScopeId === childScopeId
        ? { ...branch, ...replacement }
        : branch,
    ),
  };
}

function uniqueCommitPayload(
  frame: RecursiveScopedFrameV1,
): RecursiveBranchChildCommitPayloadV1 {
  const ordinal = branchOrdinal(frame);
  return {
    state: { [`state-${ordinal}`]: `state-${ordinal}` },
    results: { [`result-${ordinal}`]: [ordinal] },
    idempotencyKeys: { [`node-${ordinal}`]: `key-${ordinal}` },
  };
}

function branchOrdinal(frame: RecursiveScopedFrameV1): number {
  if (frame.ownership.kind === "for-each-item") {
    throw new Error("W3-C1 does not admit for-each item frames.");
  }
  return frame.ownership.branchOrdinal;
}

function successfulFactory(
  constructed: string[],
  payload: (
    frame: RecursiveScopedFrameV1,
  ) => RecursiveBranchChildCommitPayloadV1 = uniqueCommitPayload,
): RecursiveBranchChildExecutorFactoryV1 {
  return ({ frame }) => {
    constructed.push(frame.childScopeId);
    return {
      execute: async () => ({ status: "completed", commit: payload(frame) }),
    };
  };
}

function seedFrames(
  store: MemoryRecursiveBranchPort,
  input: RecursiveBranchPlanInputV1,
): readonly RecursiveScopedFrameV1[] {
  const frames = materializeRecursiveBranchPlanV1(input).frames;
  for (const frame of frames) {
    store.frames.set(
      frame.childScopeId,
      serializeRecursiveScopedFrameV1(frame),
    );
  }
  return frames;
}

function committedAcknowledgement(
  character: string,
): RecursiveAcknowledgementEvidenceInputV1 {
  return {
    status: "committed",
    observation: {
      kind: "durable-commit",
      committedIdentity: sha(character),
      evidenceDigest: sha("f"),
    },
    observedAt,
  };
}

describe("recursive branch plan v1", () => {
  it("sorts definition-owned ordinals and pins stable child-frame identities", () => {
    const forward = materializeRecursiveBranchPlanV1(planInput());
    const reversed = materializeRecursiveBranchPlanV1({
      ...planInput(),
      branches: [...planInput().branches].reverse(),
    });

    expect(forward.frames.map((frame) => branchOrdinal(frame))).toEqual([
      0, 1,
    ]);
    expect(forward.frames.map((frame) => frame.frameIdentity)).toEqual([
      "sha256:d324816c01db36d894f22d8e1ac09498c983760235b50f2b9fe1c29b8b7c4a46",
      "sha256:6aa6e81e3af97a19c1d4f688500b5e846d263656d4f9a705f3f186d4577cf7e0",
    ]);
    expect(reversed.frames).toEqual(forward.frames);
  });

  it.each([
    ["duplicate ordinal", { branchOrdinal: 0 }],
    ["duplicate identity", { branchIdentity: "left" }],
    ["duplicate child scope", { childScopeId: "parallel/branch/left" }],
  ] as const)("rejects %s before dispatch", (_label, replacement) => {
    const input = replaceBranch(
      planInput(),
      "parallel/branch/right",
      replacement,
    );
    expect(() => materializeRecursiveBranchPlanV1(input)).toThrow();
  });

  it("materializes and dispatches a conditional branch owner without public admission", async () => {
    const store = new MemoryRecursiveBranchPort();
    const constructed: string[] = [];
    const plan = materializeRecursiveBranchPlanV1(conditionalBranchPlan());
    expect(plan.frames[0]?.ownership).toMatchObject({
      kind: "branch",
      branchNodeId: "decision",
      branchOrdinal: 0,
    });

    const outcome = await dispatchRecursiveBranchesV1(
      { durable: store, createChildExecutor: successfulFactory(constructed) },
      { mode: "initial", plan: conditionalBranchPlan() },
    );
    expect(outcome.status).toBe("completed");
    expect(constructed).toEqual(["parallel/branch/left"]);
  });
});

describe("recursive branch dispatcher v1", () => {
  it("dispatches every normal child once and merges independently of completion order", async () => {
    const store = new MemoryRecursiveBranchPort();
    const constructed: string[] = [];
    const completed: string[] = [];
    const releases = new Map<string, () => void>();
    const factory: RecursiveBranchChildExecutorFactoryV1 = ({ frame }) => {
      constructed.push(frame.childScopeId);
      return {
        execute: async () => {
          await new Promise<void>((resolve) => {
            releases.set(frame.childScopeId, resolve);
          });
          completed.push(frame.childScopeId);
          return { status: "completed", commit: uniqueCommitPayload(frame) };
        },
      };
    };

    const pending = dispatchRecursiveBranchesV1(
      { durable: store, createChildExecutor: factory },
      { mode: "initial", plan: planInput() },
    );
    while (releases.size < 2) await Promise.resolve();
    releases.get("parallel/branch/right")!();
    while (completed.length < 1) await Promise.resolve();
    releases.get("parallel/branch/left")!();
    const outcome = await pending;

    expect(constructed).toEqual([
      "parallel/branch/left",
      "parallel/branch/right",
    ]);
    expect(completed).toEqual([
      "parallel/branch/right",
      "parallel/branch/left",
    ]);
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(outcome.progress.dispatchedChildScopeIds).toEqual(constructed);
    expect(serializeRecursiveScopedMergeV1(outcome.merge)).toBe(
      serializeRecursiveScopedMergeV1(
        mergeRecursiveScopedCommitsV1([...outcome.commits].reverse()),
      ),
    );
  });

  it.each([
    [
      "root definition",
      (input: RecursiveBranchPlanInputV1) => ({
        ...input,
        rootDefinitionDigest: sha("9"),
      }),
    ],
    [
      "owner path",
      (input: RecursiveBranchPlanInputV1) => ({
        ...input,
        ownerPath: ["different-root", "parallel"],
      }),
    ],
    [
      "child scope",
      (input: RecursiveBranchPlanInputV1) =>
        replaceBranch(input, "parallel/branch/left", {
          childScopeId: "parallel/branch/other",
        }),
    ],
    [
      "branch ordinal",
      (input: RecursiveBranchPlanInputV1) => ({
        ...input,
        branches: input.branches.map((branch) => ({
          ...branch,
          branchOrdinal: branch.branchOrdinal === 0 ? 1 : 0,
        })),
      }),
    ],
    [
      "node inventory",
      (input: RecursiveBranchPlanInputV1) =>
        replaceBranch(input, "parallel/branch/left", {
          nodeInventory: ["left-entry", "different-exit"],
        }),
    ],
    [
      "continuation",
      (input: RecursiveBranchPlanInputV1) =>
        replaceBranch(input, "parallel/branch/left", {
          continuation: { kind: "fork-join", nodeId: "different-join" },
        }),
    ],
    [
      "parent commit",
      (input: RecursiveBranchPlanInputV1) => ({
        ...input,
        parentCommitIdentity: sha("8"),
      }),
    ],
    [
      "scoped definition",
      (input: RecursiveBranchPlanInputV1) =>
        replaceBranch(input, "parallel/branch/left", {
          scopedDefinitionDigest: sha("7"),
        }),
    ],
  ] as const)(
    "constructs zero executors when retained %s binding drifts",
    async (_label, mutate) => {
      const store = new MemoryRecursiveBranchPort();
      seedFrames(store, planInput());
      const constructed: string[] = [];
      const outcome = await dispatchRecursiveBranchesV1(
        { durable: store, createChildExecutor: successfulFactory(constructed) },
        { mode: "restart", plan: mutate(planInput()) },
      );

      expect(["blocked", "corrupt"]).toContain(outcome.status);
      expect(constructed).toEqual([]);
      expect(outcome.progress.dispatchedChildScopeIds).toEqual([]);
    },
  );

  it("preflights every retained frame before constructing any executor", async () => {
    const store = new MemoryRecursiveBranchPort();
    seedFrames(store, planInput());
    store.frames.set("parallel/branch/right", "{not-json");
    const constructed: string[] = [];
    const outcome = await dispatchRecursiveBranchesV1(
      { durable: store, createChildExecutor: successfulFactory(constructed) },
      { mode: "restart", plan: planInput() },
    );

    expect(outcome).toMatchObject({
      status: "corrupt",
      childScopeId: "parallel/branch/right",
      reason: "frame-corrupt",
    });
    expect(constructed).toEqual([]);
  });

  it("skips an exact committed child on restart and dispatches only the remainder", async () => {
    const store = new MemoryRecursiveBranchPort();
    const [left] = seedFrames(store, planInput());
    const leftCommit = materializeRecursiveScopedCommitV1({
      frame: left!,
      ...uniqueCommitPayload(left!),
    });
    store.commits.set(
      left!.childScopeId,
      serializeRecursiveScopedCommitV1(leftCommit),
    );
    const constructed: string[] = [];
    const outcome = await dispatchRecursiveBranchesV1(
      { durable: store, createChildExecutor: successfulFactory(constructed) },
      { mode: "restart", plan: planInput() },
    );

    expect(outcome.status).toBe("completed");
    expect(constructed).toEqual(["parallel/branch/right"]);
    expect(outcome.progress.skippedCommittedChildScopeIds).toEqual([
      "parallel/branch/left",
    ]);
    if (outcome.status === "completed") expect(outcome.commits).toHaveLength(2);
  });

  it("resolves an acknowledgement-lost frame save from exact retained evidence", async () => {
    const store = new MemoryRecursiveBranchPort();
    const scope = "parallel/branch/left";
    store.frameWriteModes.set(scope, "acknowledgement-lost-saved");
    const constructed: string[] = [];
    const outcome = await dispatchRecursiveBranchesV1(
      { durable: store, createChildExecutor: successfulFactory(constructed) },
      { mode: "initial", plan: oneBranchPlan() },
    );

    expect(outcome.status).toBe("completed");
    expect(constructed).toEqual([scope]);
  });

  it("returns retryable before dispatch when a frame save has no retained evidence", async () => {
    const store = new MemoryRecursiveBranchPort();
    const scope = "parallel/branch/left";
    store.frameWriteModes.set(scope, "acknowledgement-lost-absent");
    const constructed: string[] = [];
    const outcome = await dispatchRecursiveBranchesV1(
      { durable: store, createChildExecutor: successfulFactory(constructed) },
      { mode: "initial", plan: oneBranchPlan() },
    );

    expect(outcome).toMatchObject({
      status: "retryable-before-dispatch",
      childScopeId: scope,
      reason: "frame-acknowledgement-lost-without-evidence",
    });
    expect(constructed).toEqual([]);
  });

  it("resolves an acknowledgement-lost commit save from the exact retained commit", async () => {
    const store = new MemoryRecursiveBranchPort();
    const scope = "parallel/branch/left";
    store.commitWriteModes.set(scope, "acknowledgement-lost-saved");
    const constructed: string[] = [];
    const outcome = await dispatchRecursiveBranchesV1(
      { durable: store, createChildExecutor: successfulFactory(constructed) },
      { mode: "initial", plan: oneBranchPlan() },
    );

    expect(outcome.status).toBe("completed");
    expect(constructed).toEqual([scope]);
    expect(store.commits.has(scope)).toBe(true);
  });

  it("blocks an acknowledgement-lost commit save without redispatch permission", async () => {
    const store = new MemoryRecursiveBranchPort();
    const scope = "parallel/branch/left";
    store.commitWriteModes.set(scope, "acknowledgement-lost-absent");
    const constructed: string[] = [];
    const outcome = await dispatchRecursiveBranchesV1(
      { durable: store, createChildExecutor: successfulFactory(constructed) },
      { mode: "initial", plan: oneBranchPlan() },
    );

    expect(outcome).toMatchObject({
      status: "blocked",
      childScopeId: scope,
      reason: "commit-acknowledgement-unknown",
    });
    expect(constructed).toEqual([scope]);
    expect(store.commits.has(scope)).toBe(false);
  });

  it.each([
    ["acknowledgement-lost-saved", "completed"],
    [
      "acknowledgement-lost-absent",
      "frame-acknowledgement-unknown-after-dispatch",
    ],
  ] as const)(
    "reconciles an in-flight checkpoint write in mode %s",
    async (writeMode, expected) => {
      const store = new MemoryRecursiveBranchPort();
      const scope = "parallel/branch/left";
      seedFrames(store, oneBranchPlan());
      store.frameWriteModes.set(scope, writeMode);
      const constructed: string[] = [];
      const outcome = await dispatchRecursiveBranchesV1(
        {
          durable: store,
          createChildExecutor: ({ frame }) => {
            constructed.push(frame.childScopeId);
            return {
              execute: async ({ persistCheckpoint }) => {
                await persistCheckpoint({ cursor: "after-work" });
                return {
                  status: "completed",
                  commit: uniqueCommitPayload(frame),
                };
              },
            };
          },
        },
        { mode: "restart", plan: oneBranchPlan() },
      );

      if (expected === "completed") {
        expect(outcome.status).toBe("completed");
      } else {
        expect(outcome).toMatchObject({ status: "blocked", reason: expected });
      }
      expect(constructed).toEqual([scope]);
    },
  );

  it("persists a deferred-control checkpoint and returns a typed later-packet outcome", async () => {
    const store = new MemoryRecursiveBranchPort();
    const scope = "parallel/branch/left";
    const constructed: string[] = [];
    const outcome = await dispatchRecursiveBranchesV1(
      {
        durable: store,
        createChildExecutor: ({ frame }) => {
          constructed.push(frame.childScopeId);
          return {
            execute: async () => ({
              status: "suspended-for-later",
              control: "interaction",
              checkpoint: { cursor: "approval" },
            }),
          };
        },
      },
      { mode: "initial", plan: oneBranchPlan() },
    );

    expect(outcome).toMatchObject({
      status: "suspended-for-later",
      childScopeId: scope,
      control: "interaction",
    });
    expect(constructed).toEqual([scope]);
    const planned = materializeRecursiveBranchPlanV1(oneBranchPlan()).frames[0]!;
    const restored = deserializeRecursiveScopedFrameV1(
      store.frames.get(scope)!,
      recursiveScopedFrameBindingV1(planned),
    );
    expect(restored.checkpoint).toEqual({ cursor: "approval" });

    const resumedCheckpoints: unknown[] = [];
    const resumed = await dispatchRecursiveBranchesV1(
      {
        durable: store,
        createChildExecutor: ({ frame }) => {
          resumedCheckpoints.push(frame.checkpoint);
          return {
            execute: async () => ({
              status: "completed",
              commit: uniqueCommitPayload(frame),
            }),
          };
        },
      },
      { mode: "restart", plan: oneBranchPlan() },
    );
    expect(resumed.status).toBe("completed");
    expect(resumedCheckpoints).toEqual([{ cursor: "approval" }]);
  });

  it("blocks missing and corrupt restart custody before executor construction", async () => {
    const missingStore = new MemoryRecursiveBranchPort();
    const missingConstructed: string[] = [];
    const missing = await dispatchRecursiveBranchesV1(
      {
        durable: missingStore,
        createChildExecutor: successfulFactory(missingConstructed),
      },
      { mode: "restart", plan: oneBranchPlan() },
    );
    expect(missing).toMatchObject({ status: "blocked", reason: "missing-frame" });
    expect(missingConstructed).toEqual([]);

    const corruptStore = new MemoryRecursiveBranchPort();
    seedFrames(corruptStore, oneBranchPlan());
    corruptStore.commits.set("parallel/branch/left", "{not-json");
    const corruptConstructed: string[] = [];
    const corrupt = await dispatchRecursiveBranchesV1(
      {
        durable: corruptStore,
        createChildExecutor: successfulFactory(corruptConstructed),
      },
      { mode: "restart", plan: oneBranchPlan() },
    );
    expect(corrupt).toMatchObject({ status: "corrupt", reason: "commit-corrupt" });
    expect(corruptConstructed).toEqual([]);
  });

  it("rejects a structurally valid committed child with parent/frame drift", async () => {
    const store = new MemoryRecursiveBranchPort();
    const [expectedFrame] = seedFrames(store, oneBranchPlan());
    const foreignPlan = {
      ...oneBranchPlan(),
      parentCommitIdentity: sha("8"),
    };
    const foreignFrame = materializeRecursiveBranchPlanV1(foreignPlan).frames[0]!;
    const foreignCommit = materializeRecursiveScopedCommitV1({
      frame: foreignFrame,
      ...uniqueCommitPayload(foreignFrame),
    });
    store.commits.set(
      expectedFrame!.childScopeId,
      serializeRecursiveScopedCommitV1(foreignCommit),
    );
    const constructed: string[] = [];
    const outcome = await dispatchRecursiveBranchesV1(
      { durable: store, createChildExecutor: successfulFactory(constructed) },
      { mode: "restart", plan: oneBranchPlan() },
    );

    expect(outcome).toMatchObject({ status: "corrupt", reason: "commit-drift" });
    expect(constructed).toEqual([]);
  });

  it("blocks a valid commit whose effect acknowledgement remains uncertain", async () => {
    const store = new MemoryRecursiveBranchPort();
    const constructed: string[] = [];
    const outcome = await dispatchRecursiveBranchesV1(
      {
        durable: store,
        createChildExecutor: successfulFactory(constructed, () => ({
          effects: {
            "effect-left": {
              idempotencyKey: "effect-key-left",
              intentDigest: sha("4"),
              acknowledgement: {
                status: "blocked",
                observation: { kind: "uncertain", evidenceDigest: sha("5") },
                observedAt,
              },
            },
          },
        })),
      },
      { mode: "initial", plan: oneBranchPlan() },
    );

    expect(outcome).toMatchObject({
      status: "blocked",
      reason: "operation-acknowledgement-unknown",
    });
    expect(constructed).toEqual(["parallel/branch/left"]);
  });

  it.each([
    ["state", (ordinal: number) => ({ state: { shared: ordinal } })],
    ["result", (ordinal: number) => ({ results: { shared: ordinal } })],
    [
      "idempotency",
      (ordinal: number) => ({ idempotencyKeys: { shared: `key-${ordinal}` } }),
    ],
    [
      "effect",
      (ordinal: number) => ({
        effects: {
          shared: {
            idempotencyKey: `effect-key-${ordinal}`,
            intentDigest: sha(String(ordinal + 1)),
            acknowledgement: committedAcknowledgement(String(ordinal + 1)),
          },
        },
      }),
    ],
    [
      "charge",
      (ordinal: number) => ({
        charges: {
          shared: {
            reservationIdentity: sha(String(ordinal + 1)),
            measurementDigest: sha(String(ordinal + 3)),
            settledCostMicros: ordinal + 1,
            currency: "USD",
            acknowledgement: committedAcknowledgement(String(ordinal + 1)),
          },
        },
      }),
    ],
  ] as const)("blocks a same-key %s conflict at the W3-B merge", async (_label, payload) => {
    const store = new MemoryRecursiveBranchPort();
    const constructed: string[] = [];
    const outcome = await dispatchRecursiveBranchesV1(
      {
        durable: store,
        createChildExecutor: successfulFactory(constructed, (frame) =>
          payload(branchOrdinal(frame)),
        ),
      },
      { mode: "initial", plan: planInput() },
    );

    expect(outcome).toMatchObject({ status: "blocked", reason: "merge-conflict" });
    expect(constructed).toHaveLength(2);
  });
});

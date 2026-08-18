import { describe, expect, it } from "vitest";

import { canonicalInputDigest } from "@dzupagent/runtime-contracts";
import {
  materializeRecursiveScopedCommitV1,
  serializeRecursiveScopedCommitV1,
  type RecursiveScopedFrameV1,
  type RecursiveScopedJsonValue,
  type RecursiveScopedSha256Digest,
} from "@dzupagent/runtime-contracts/recursive-scope";

import {
  deriveRecursiveForEachItemIdentityV1,
  dispatchRecursiveBranchesV1,
  dispatchRecursiveForEachItemsV1,
  materializeRecursiveForEachItemPlanV1,
  recursiveControlScopeIdentityV1,
  type RecursiveBranchChildExecutionV1,
  type RecursiveBranchPlanInputV1,
  type RecursiveCommitCompareAndSaveInputV1,
  type RecursiveControlCandidateSetCompareAndSaveInputV1,
  type RecursiveControlCancellationCompareAndSaveInputV1,
  type RecursiveControlDecisionCompareAndSaveInputV1,
  type RecursiveControlDurablePortV1,
  type RecursiveControlDurableWriteResultV1,
  type RecursiveControlPolicyV1,
  type RecursiveDurableWriteResultV1,
  type RecursiveForEachItemExecutionV1,
  type RecursiveForEachItemPlanInputV1,
  type RecursiveFrameCompareAndSaveInputV1,
  type RecursiveScopedDurablePortV1,
} from "../recursive-scope/index.js";

const sha = (character: string) =>
  `sha256:${character.repeat(64)}` as RecursiveScopedSha256Digest;
const digest = (value: unknown) =>
  `sha256:${canonicalInputDigest(value)}` as RecursiveScopedSha256Digest;

type WriteMode =
  | "normal"
  | "acknowledgement-lost-saved"
  | "acknowledgement-lost-absent"
  | "conflict";

class MemoryRecursiveControlPort
  implements RecursiveScopedDurablePortV1, RecursiveControlDurablePortV1
{
  readonly frames = new Map<string, string>();
  readonly commits = new Map<string, string>();
  readonly candidateSets = new Map<string, string>();
  readonly decisions = new Map<string, string>();
  readonly cancellations = new Map<string, string>();
  readonly commitCrashesAfterSave = new Set<string>();
  readonly cancellationWriteModes = new Map<string, WriteMode>();
  decisionWriteMode: WriteMode = "normal";
  decisionWrites = 0;
  cancellationWrites = 0;

  async loadFrame(childScopeId: string): Promise<string | undefined> {
    return this.frames.get(childScopeId);
  }

  async compareAndSaveFrame(
    input: RecursiveFrameCompareAndSaveInputV1,
  ): Promise<RecursiveDurableWriteResultV1> {
    return this.write(
      this.frames,
      "normal",
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
    const result = this.write(
      this.commits,
      "normal",
      input.childScopeId,
      input.expectedCommitIdentity,
      input.commitIdentity,
      input.serializedCommit,
      "commitIdentity",
    );
    if (
      result.status === "committed" &&
      this.commitCrashesAfterSave.delete(input.childScopeId)
    ) {
      throw new Error("simulated process death after owner-claim save");
    }
    return result;
  }

  async loadControlDecision(
    controlScopeIdentity: RecursiveScopedSha256Digest,
  ): Promise<string | undefined> {
    return this.decisions.get(controlScopeIdentity);
  }

  async loadControlCandidateSet(
    controlScopeIdentity: RecursiveScopedSha256Digest,
  ): Promise<string | undefined> {
    return this.candidateSets.get(controlScopeIdentity);
  }

  async compareAndSaveControlCandidateSet(
    input: RecursiveControlCandidateSetCompareAndSaveInputV1,
  ): Promise<RecursiveControlDurableWriteResultV1> {
    return this.write(
      this.candidateSets,
      "normal",
      input.controlScopeIdentity,
      input.expectedCandidateSetIdentity,
      input.candidateSetIdentity,
      input.serializedCandidateSet,
      "candidateSetIdentity",
    );
  }

  async compareAndSaveControlDecision(
    input: RecursiveControlDecisionCompareAndSaveInputV1,
  ): Promise<RecursiveControlDurableWriteResultV1> {
    this.decisionWrites += 1;
    return this.write(
      this.decisions,
      this.decisionWriteMode,
      input.controlScopeIdentity,
      input.expectedDecisionIdentity,
      input.decisionIdentity,
      input.serializedDecision,
      "decisionIdentity",
    );
  }

  async loadControlCancellation(
    childScopeId: string,
  ): Promise<string | undefined> {
    return this.cancellations.get(childScopeId);
  }

  async compareAndSaveControlCancellation(
    input: RecursiveControlCancellationCompareAndSaveInputV1,
  ): Promise<RecursiveControlDurableWriteResultV1> {
    this.cancellationWrites += 1;
    return this.write(
      this.cancellations,
      this.cancellationWriteModes.get(input.childScopeId) ?? "normal",
      input.childScopeId,
      input.expectedCancellationIdentity,
      input.cancellationIdentity,
      input.serializedCancellation,
      "cancellationIdentity",
    );
  }

  private write(
    target: Map<string, string>,
    mode: WriteMode,
    key: string,
    expectedIdentity: RecursiveScopedSha256Digest | undefined,
    nextIdentity: RecursiveScopedSha256Digest,
    serialized: string,
    identityField:
      | "frameIdentity"
      | "commitIdentity"
      | "candidateSetIdentity"
      | "decisionIdentity"
      | "cancellationIdentity",
  ): RecursiveDurableWriteResultV1 {
    if (mode === "conflict") return { status: "conflict" };
    const current = target.get(key);
    if (this.identity(current, identityField) !== expectedIdentity) {
      return { status: "conflict" };
    }
    if (mode === "acknowledgement-lost-absent") {
      return { status: "acknowledgement-lost" };
    }
    target.set(key, serialized);
    if (mode === "acknowledgement-lost-saved") {
      return { status: "acknowledgement-lost" };
    }
    return { status: "committed", storedIdentity: nextIdentity };
  }

  private identity(
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
}

function branchPlan(): RecursiveBranchPlanInputV1 {
  return {
    frameKind: "fork-branch",
    rootDefinitionId: "root-flow",
    rootDefinitionDigest: sha("a"),
    ownerPath: ["root", "try-owner", "parallel"],
    ownerNodeId: "parallel",
    parentCommitIdentity: sha("c"),
    branches: [
      {
        branchOrdinal: 1,
        branchIdentity: "right",
        childScopeId: "parallel/right",
        scopedDefinitionId: "parallel/right",
        scopedDefinitionDigest: sha("e"),
        nodeInventory: ["right-entry", "right-exit"],
        continuation: { kind: "fork-join", nodeId: "join" },
        checkpoint: { cursor: "right-entry" },
      },
      {
        branchOrdinal: 0,
        branchIdentity: "left",
        childScopeId: "parallel/left",
        scopedDefinitionId: "parallel/left",
        scopedDefinitionDigest: sha("d"),
        nodeInventory: ["left-entry", "left-exit"],
        continuation: { kind: "fork-join", nodeId: "join" },
        checkpoint: { cursor: "left-entry" },
      },
    ],
  };
}

function itemPlan(): RecursiveForEachItemPlanInputV1 {
  const values: readonly RecursiveScopedJsonValue[] = ["zero", "one"];
  const collectionSourceDigest = digest(values);
  const forEachNodeId = "recursive-items";
  return {
    rootDefinitionId: "root-flow",
    rootDefinitionDigest: sha("a"),
    ownerPath: ["root", "try-owner", forEachNodeId],
    forEachNodeId,
    parentCommitIdentity: sha("c"),
    collectionSourceDigest,
    maxConcurrency: 2,
    items: values.map((itemValue, itemOrdinal) => {
      const itemValueDigest = digest(itemValue);
      return {
        itemOrdinal,
        itemIdentity: deriveRecursiveForEachItemIdentityV1({
          collectionSourceDigest,
          forEachNodeId,
          itemOrdinal,
          itemValueDigest,
        }),
        itemValue,
        childScopeId: `recursive-items/${itemOrdinal}`,
        scopedDefinitionId: `recursive-items/body/${itemOrdinal}`,
        scopedDefinitionDigest: sha(itemOrdinal === 0 ? "d" : "e"),
        nodeInventory: [`item-${itemOrdinal}-entry`, `item-${itemOrdinal}-exit`],
        continuation: { kind: "for-each-join" as const, nodeId: "items-join" },
        checkpoint: { cursor: `item-${itemOrdinal}-entry` },
      };
    }),
  };
}

const policy = (routes: RecursiveControlPolicyV1["catchRoutes"] = []) => ({
  catchRoutes: routes,
});

const normalBranch = (frame: RecursiveScopedFrameV1): RecursiveBranchChildExecutionV1 => ({
  status: "completed",
  commit: { results: { [frame.childScopeId]: "completed" } },
});

const structuredBranch = (
  frame: RecursiveScopedFrameV1,
  kind: "interaction" | "suspension" | "terminal" | "error",
): RecursiveBranchChildExecutionV1 => ({
  status: "suspended-for-later",
  control: kind,
  checkpoint: { cursor: `${kind}-checkpoint` },
  intent: {
    kind,
    intentKey: `${kind}:intent`,
    nodeId: frame.nodeInventory[0]!,
  },
});

function branchFactory(
  outcomes: Readonly<
    Record<
      string,
      (
        frame: RecursiveScopedFrameV1,
      ) => RecursiveBranchChildExecutionV1 | Promise<RecursiveBranchChildExecutionV1>
    >
  >,
  constructed: string[],
) {
  return ({ frame }: { readonly frame: RecursiveScopedFrameV1 }) => {
    constructed.push(frame.childScopeId);
    return {
      execute: async () =>
        (outcomes[frame.childScopeId] ?? normalBranch)(frame),
    };
  };
}

async function dispatchBranch(
  store: MemoryRecursiveControlPort,
  outcomes: Readonly<
    Record<
      string,
      (
        frame: RecursiveScopedFrameV1,
      ) => RecursiveBranchChildExecutionV1 | Promise<RecursiveBranchChildExecutionV1>
    >
  >,
  constructed: string[],
  options: {
    readonly mode?: "initial" | "restart";
    readonly policy?: RecursiveControlPolicyV1;
    readonly withControl?: boolean;
  } = {},
) {
  return dispatchRecursiveBranchesV1(
    {
      durable: store,
      createChildExecutor: branchFactory(outcomes, constructed),
      ...(options.withControl === false
        ? {}
        : { control: { durable: store } }),
    },
    {
      mode: options.mode ?? "initial",
      plan: branchPlan(),
      ...(options.withControl === false
        ? {}
        : { controlPolicy: options.policy ?? policy() }),
    },
  );
}

describe("recursive control ownership — branch integration", () => {
  it("persists one definition-bound interaction owner", async () => {
    const store = new MemoryRecursiveControlPort();
    const constructed: string[] = [];
    const outcome = await dispatchBranch(
      store,
      { "parallel/left": (frame) => structuredBranch(frame, "interaction") },
      constructed,
    );

    expect(outcome.status).toBe("suspended-for-later");
    if (outcome.status !== "suspended-for-later") return;
    expect(outcome.childScopeId).toBe("parallel/left");
    expect(outcome.decision).toMatchObject({
      kind: "interaction",
      nodeId: "left-entry",
      ownerChildScopeId: "parallel/left",
      catchRoute: null,
    });
    expect(constructed).toEqual(["parallel/left", "parallel/right"]);
    expect(store.decisions.size).toBe(1);
    expect(store.commits.size).toBe(2);
  });

  it("restores the same owner without constructing executors", async () => {
    const store = new MemoryRecursiveControlPort();
    const first = await dispatchBranch(
      store,
      { "parallel/left": (frame) => structuredBranch(frame, "suspension") },
      [],
    );
    const constructed: string[] = [];
    const restart = await dispatchBranch(store, {}, constructed, {
      mode: "restart",
    });

    expect(restart.status).toBe("suspended-for-later");
    if (
      first.status !== "suspended-for-later" ||
      restart.status !== "suspended-for-later"
    ) return;
    expect(restart.decision).toEqual(first.decision);
    expect(constructed).toEqual([]);
  });

  it("selects identical owner bytes independent of sibling completion order", async () => {
    const run = async (releaseRightFirst: boolean) => {
      let releaseLeft!: () => void;
      let releaseRight!: () => void;
      const leftGate = new Promise<void>((resolve) => {
        releaseLeft = resolve;
      });
      const rightGate = new Promise<void>((resolve) => {
        releaseRight = resolve;
      });
      const pending = dispatchBranch(
        new MemoryRecursiveControlPort(),
        {
          "parallel/left": async (frame) => {
            await leftGate;
            return structuredBranch(frame, "interaction");
          },
          "parallel/right": async (frame) => {
            await rightGate;
            return normalBranch(frame);
          },
        },
        [],
      );
      await Promise.resolve();
      if (releaseRightFirst) {
        releaseRight();
        await Promise.resolve();
        releaseLeft();
      } else {
        releaseLeft();
        await Promise.resolve();
        releaseRight();
      }
      const outcome = await pending;
      if (outcome.status !== "suspended-for-later") {
        throw new Error(`Unexpected outcome: ${outcome.status}`);
      }
      return outcome.decision;
    };

    expect(await run(true)).toEqual(await run(false));
  });

  it("recovers a committed owner when decision acknowledgement was interrupted", async () => {
    const store = new MemoryRecursiveControlPort();
    const first = await dispatchBranch(
      store,
      { "parallel/left": (frame) => structuredBranch(frame, "interaction") },
      [],
    );
    expect(first.status).toBe("suspended-for-later");
    store.decisions.clear();
    const constructed: string[] = [];
    const restart = await dispatchBranch(store, {}, constructed, {
      mode: "restart",
    });

    expect(restart.status).toBe("suspended-for-later");
    expect(constructed).toEqual([]);
    expect(store.decisions.size).toBe(1);
  });

  it("routes an error through its exact definition-owned catch", async () => {
    const store = new MemoryRecursiveControlPort();
    const outcome = await dispatchBranch(
      store,
      { "parallel/left": (frame) => structuredBranch(frame, "error") },
      [],
      {
        policy: policy([
          {
            errorNodeId: "left-entry",
            catchNodeId: "catch-entry",
            catchOwnerPath: ["root", "try-owner"],
          },
        ]),
      },
    );

    expect(outcome.status).toBe("suspended-for-later");
    if (outcome.status !== "suspended-for-later") return;
    expect(outcome.decision?.catchRoute).toEqual({
      catchNodeId: "catch-entry",
      catchOwnerPath: ["root", "try-owner"],
    });
  });

  it.each([
    ["missing", policy(), "blocked", "catch-owner-missing"],
    [
      "duplicate",
      policy([
        {
          errorNodeId: "left-entry",
          catchNodeId: "catch-a",
          catchOwnerPath: ["root", "try-owner"],
        },
        {
          errorNodeId: "left-entry",
          catchNodeId: "catch-b",
          catchOwnerPath: ["root", "try-owner"],
        },
      ]),
      "corrupt",
      "catch-owner-ambiguous",
    ],
    [
      "foreign",
      policy([
        {
          errorNodeId: "left-entry",
          catchNodeId: "catch-entry",
          catchOwnerPath: ["foreign", "try-owner"],
        },
      ]),
      "corrupt",
      "control-intent-corrupt",
    ],
  ] as const)("rejects %s catch ownership", async (_name, controlPolicy, status, reason) => {
    const outcome = await dispatchBranch(
      new MemoryRecursiveControlPort(),
      { "parallel/left": (frame) => structuredBranch(frame, "error") },
      [],
      { policy: controlPolicy },
    );
    expect(outcome).toMatchObject({ status, reason });
  });

  it("blocks simultaneous structured owners independent of result ordering", async () => {
    const outcome = await dispatchBranch(
      new MemoryRecursiveControlPort(),
      {
        "parallel/left": (frame) => structuredBranch(frame, "interaction"),
        "parallel/right": (frame) => structuredBranch(frame, "terminal"),
      },
      [],
    );
    expect(outcome).toMatchObject({
      status: "blocked",
      reason: "ambiguous-control-owner",
    });
  });

  it("keeps simultaneous owners ambiguous after a crash between claim commits", async () => {
    const store = new MemoryRecursiveControlPort();
    store.commitCrashesAfterSave.add("parallel/left");
    const interrupted = await dispatchBranch(
      store,
      {
        "parallel/left": (frame) => structuredBranch(frame, "interaction"),
        "parallel/right": (frame) => structuredBranch(frame, "suspension"),
      },
      [],
    );
    expect(interrupted).toMatchObject({
      status: "blocked",
      reason: "storage-error",
    });
    expect(store.commits.has("parallel/left")).toBe(true);
    expect(store.commits.has("parallel/right")).toBe(false);

    const constructed: string[] = [];
    const restart = await dispatchBranch(store, {}, constructed, {
      mode: "restart",
    });
    expect(restart).toMatchObject({
      status: "blocked",
      reason: "ambiguous-control-owner",
    });
    expect(store.commits.has("parallel/right")).toBe(true);
    expect(store.decisions.size).toBe(0);
    expect(constructed).toEqual([]);
  });

  it("rejects a foreign control node and a kind mismatch", async () => {
    const foreign = await dispatchBranch(
      new MemoryRecursiveControlPort(),
      {
        "parallel/left": () => ({
          status: "suspended-for-later",
          control: "interaction",
          intent: {
            kind: "interaction",
            intentKey: "interaction:intent",
            nodeId: "foreign-node",
          },
        }),
      },
      [],
    );
    const mismatch = await dispatchBranch(
      new MemoryRecursiveControlPort(),
      {
        "parallel/left": (frame) => ({
          ...structuredBranch(frame, "terminal"),
          control: "interaction",
        }),
      },
      [],
    );
    expect(foreign).toMatchObject({
      status: "corrupt",
      reason: "control-intent-corrupt",
    });
    expect(mismatch).toMatchObject({
      status: "corrupt",
      reason: "control-intent-corrupt",
    });
  });

  it("requires the durable coordinator for structured evidence", async () => {
    const outcome = await dispatchBranch(
      new MemoryRecursiveControlPort(),
      { "parallel/left": (frame) => structuredBranch(frame, "interaction") },
      [],
      { withControl: false },
    );
    expect(outcome).toMatchObject({
      status: "blocked",
      reason: "control-policy-unavailable",
    });
  });

  it("terminal ownership durably cancels only the unsettled sibling", async () => {
    const store = new MemoryRecursiveControlPort();
    const outcome = await dispatchBranch(
      store,
      {
        "parallel/left": (frame) => structuredBranch(frame, "terminal"),
        "parallel/right": () => ({
          status: "suspended-for-later",
          control: "suspension",
        }),
      },
      [],
    );

    expect(outcome).toMatchObject({
      status: "suspended-for-later",
      childScopeId: "parallel/left",
      control: "terminal",
    });
    expect(store.cancellations.has("parallel/right")).toBe(true);
    expect(store.cancellations.has("parallel/left")).toBe(false);
    expect(store.commits.has("parallel/right")).toBe(false);
  });

  it("terminal ownership never cancels an already committed sibling", async () => {
    const store = new MemoryRecursiveControlPort();
    const outcome = await dispatchBranch(
      store,
      { "parallel/left": (frame) => structuredBranch(frame, "terminal") },
      [],
    );

    expect(outcome).toMatchObject({
      status: "suspended-for-later",
      childScopeId: "parallel/left",
      control: "terminal",
    });
    expect(store.commits.has("parallel/right")).toBe(true);
    expect(store.cancellations.has("parallel/right")).toBe(false);
  });

  it("restores terminal cancellation without redispatch", async () => {
    const store = new MemoryRecursiveControlPort();
    await dispatchBranch(
      store,
      {
        "parallel/left": (frame) => structuredBranch(frame, "terminal"),
        "parallel/right": () => ({
          status: "suspended-for-later",
          control: "suspension",
        }),
      },
      [],
    );
    const constructed: string[] = [];
    const restart = await dispatchBranch(store, {}, constructed, {
      mode: "restart",
    });
    expect(restart).toMatchObject({
      status: "suspended-for-later",
      childScopeId: "parallel/left",
      control: "terminal",
    });
    expect(constructed).toEqual([]);
  });

  it.each([
    ["decision", "acknowledgement-lost-saved", "suspended-for-later"],
    ["decision", "acknowledgement-lost-absent", "blocked"],
    ["cancellation", "acknowledgement-lost-saved", "suspended-for-later"],
    ["cancellation", "acknowledgement-lost-absent", "blocked"],
  ] as const)("reconciles %s %s", async (boundary, mode, status) => {
    const store = new MemoryRecursiveControlPort();
    if (boundary === "decision") store.decisionWriteMode = mode;
    else store.cancellationWriteModes.set("parallel/right", mode);
    const outcome = await dispatchBranch(
      store,
      {
        "parallel/left": (frame) =>
          structuredBranch(
            frame,
            boundary === "decision" ? "interaction" : "terminal",
          ),
        ...(boundary === "cancellation"
          ? {
              "parallel/right": () => ({
                status: "suspended-for-later" as const,
                control: "suspension" as const,
              }),
            }
          : {}),
      },
      [],
    );
    expect(outcome.status).toBe(status);
    if (status === "blocked") {
      expect(outcome).toMatchObject({
        reason:
          boundary === "decision"
            ? "control-decision-acknowledgement-unknown"
            : "cancellation-acknowledgement-unknown",
      });
    }
  });

  it("rejects corrupt retained decisions before executor construction", async () => {
    const store = new MemoryRecursiveControlPort();
    const first = await dispatchBranch(
      store,
      { "parallel/left": (frame) => structuredBranch(frame, "interaction") },
      [],
    );
    expect(first.status).toBe("suspended-for-later");
    const scope = recursiveControlScopeIdentityV1({
      rootDefinitionDigest: branchPlan().rootDefinitionDigest,
      ownerPath: branchPlan().ownerPath,
      parentCommitIdentity: branchPlan().parentCommitIdentity,
    });
    store.decisions.set(scope, '{"schema":"wrong"}');
    const constructed: string[] = [];
    const restart = await dispatchBranch(store, {}, constructed, {
      mode: "restart",
    });
    expect(restart).toMatchObject({
      status: "corrupt",
      reason: "control-decision-corrupt",
    });
    expect(constructed).toEqual([]);
  });

  it("rejects a canonically valid foreign decision binding before construction", async () => {
    const store = new MemoryRecursiveControlPort();
    await dispatchBranch(
      store,
      { "parallel/left": (frame) => structuredBranch(frame, "interaction") },
      [],
    );
    const [scope, serialized] = [...store.decisions.entries()][0]!;
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    const { decisionIdentity: _ignored, ...core } = parsed;
    const foreignCore = { ...core, parentCommitIdentity: sha("9") };
    store.decisions.set(
      scope,
      JSON.stringify({
        ...foreignCore,
        decisionIdentity: digest(foreignCore),
      }),
    );
    const constructed: string[] = [];
    const restart = await dispatchBranch(store, {}, constructed, {
      mode: "restart",
    });
    expect(restart).toMatchObject({
      status: "corrupt",
      reason: "control-decision-drift",
    });
    expect(constructed).toEqual([]);
  });

  it("rejects a canonically valid foreign cancellation binding", async () => {
    const store = new MemoryRecursiveControlPort();
    await dispatchBranch(
      store,
      {
        "parallel/left": (frame) => structuredBranch(frame, "terminal"),
        "parallel/right": () => ({
          status: "suspended-for-later",
          control: "suspension",
        }),
      },
      [],
    );
    const serialized = store.cancellations.get("parallel/right")!;
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    const { cancellationIdentity: _ignored, ...core } = parsed;
    const foreignCore = { ...core, childFrameIdentity: sha("9") };
    store.cancellations.set(
      "parallel/right",
      JSON.stringify({
        ...foreignCore,
        cancellationIdentity: digest(foreignCore),
      }),
    );
    const constructed: string[] = [];
    const restart = await dispatchBranch(store, {}, constructed, {
      mode: "restart",
    });
    expect(restart).toMatchObject({
      status: "corrupt",
      reason: "control-cancellation-drift",
    });
    expect(constructed).toEqual([]);
  });

  it("blocks a second retained owner that appears after decision custody", async () => {
    const store = new MemoryRecursiveControlPort();
    await dispatchBranch(
      store,
      { "parallel/left": (frame) => structuredBranch(frame, "interaction") },
      [],
    );
    const rightFrame = JSON.parse(store.frames.get("parallel/right")!) as RecursiveScopedFrameV1;
    const secondOwner = materializeRecursiveScopedCommitV1({
      frame: rightFrame,
      intentClaims: [
        {
          kind: "suspension",
          intentKey: "second-owner",
          nodeId: "right-entry",
        },
      ],
    });
    store.commits.set(
      "parallel/right",
      serializeRecursiveScopedCommitV1(secondOwner),
    );
    const constructed: string[] = [];
    const restart = await dispatchBranch(store, {}, constructed, {
      mode: "restart",
    });
    expect(restart).toMatchObject({
      status: "blocked",
      reason: "ambiguous-control-owner",
    });
    expect(constructed).toEqual([]);
  });

  it("rejects cancellation/commit conflict before redispatch", async () => {
    const store = new MemoryRecursiveControlPort();
    await dispatchBranch(
      store,
      {
        "parallel/left": (frame) => structuredBranch(frame, "terminal"),
        "parallel/right": () => ({
          status: "suspended-for-later",
          control: "suspension",
        }),
      },
      [],
    );
    const rightFrame = JSON.parse(store.frames.get("parallel/right")!) as RecursiveScopedFrameV1;
    const foreignCommit = materializeRecursiveScopedCommitV1({
      frame: rightFrame,
      results: { foreign: true },
    });
    store.commits.set(
      "parallel/right",
      serializeRecursiveScopedCommitV1(foreignCommit),
    );
    const constructed: string[] = [];
    const restart = await dispatchBranch(store, {}, constructed, {
      mode: "restart",
    });
    expect(restart).toMatchObject({
      status: "corrupt",
      reason: "control-cancellation-commit-conflict",
    });
    expect(constructed).toEqual([]);
  });

  it("rejects orphan cancellation custody before redispatch", async () => {
    const store = new MemoryRecursiveControlPort();
    const initial = await dispatchBranch(store, {}, [], { withControl: false });
    expect(initial.status).toBe("completed");
    store.cancellations.set("parallel/right", "{}");
    const constructed: string[] = [];
    const restart = await dispatchBranch(store, {}, constructed, {
      mode: "restart",
    });

    expect(restart).toMatchObject({
      status: "corrupt",
      reason: "orphan-control-cancellation",
    });
    expect(constructed).toEqual([]);
  });
});

function itemFactory(
  outcomes: Readonly<
    Record<string, (frame: RecursiveScopedFrameV1) => RecursiveForEachItemExecutionV1>
  >,
  constructed: string[],
) {
  return ({ frame }: { readonly frame: RecursiveScopedFrameV1 }) => {
    constructed.push(frame.childScopeId);
    return {
      execute: async () =>
        outcomes[frame.childScopeId]?.(frame) ?? {
          status: "completed" as const,
          orderedResult: frame.childScopeId,
          commit: { results: { [frame.childScopeId]: "completed" } },
        },
    };
  };
}

async function dispatchItems(
  store: MemoryRecursiveControlPort,
  outcomes: Readonly<
    Record<string, (frame: RecursiveScopedFrameV1) => RecursiveForEachItemExecutionV1>
  >,
  constructed: string[],
  mode: "initial" | "restart" = "initial",
) {
  return dispatchRecursiveForEachItemsV1(
    {
      durable: store,
      control: { durable: store },
      createItemExecutor: itemFactory(outcomes, constructed),
    },
    { mode, plan: itemPlan(), controlPolicy: policy() },
  );
}

describe("recursive control ownership — item integration", () => {
  it("persists and restores an item interaction owner", async () => {
    const store = new MemoryRecursiveControlPort();
    const first = await dispatchItems(
      store,
      {
        "recursive-items/0": (frame) => ({
          status: "suspended-for-later",
          control: "interaction",
          checkpoint: { cursor: "interaction" },
          intent: {
            kind: "interaction",
            intentKey: "item:interaction",
            nodeId: frame.nodeInventory[0]!,
          },
        }),
      },
      [],
    );
    const constructed: string[] = [];
    const restart = await dispatchItems(store, {}, constructed, "restart");

    expect(first.status).toBe("suspended-for-later");
    expect(restart.status).toBe("suspended-for-later");
    if (
      first.status !== "suspended-for-later" ||
      restart.status !== "suspended-for-later"
    ) return;
    expect(restart.decision).toEqual(first.decision);
    expect(constructed).toEqual([]);
  });

  it("terminal item ownership cancels an unsettled item and survives restart", async () => {
    const store = new MemoryRecursiveControlPort();
    const first = await dispatchItems(
      store,
      {
        "recursive-items/0": (frame) => ({
          status: "suspended-for-later",
          control: "terminal",
          intent: {
            kind: "terminal",
            intentKey: "item:terminal",
            nodeId: frame.nodeInventory[0]!,
          },
        }),
        "recursive-items/1": () => ({
          status: "suspended-for-later",
          control: "suspension",
        }),
      },
      [],
    );
    const constructed: string[] = [];
    const restart = await dispatchItems(store, {}, constructed, "restart");

    expect(first).toMatchObject({
      status: "suspended-for-later",
      childScopeId: "recursive-items/0",
      control: "terminal",
    });
    expect(store.cancellations.has("recursive-items/1")).toBe(true);
    expect(restart.status).toBe("suspended-for-later");
    expect(constructed).toEqual([]);
  });

  it("blocks simultaneous item owners without persisting a decision", async () => {
    const store = new MemoryRecursiveControlPort();
    const outcome = await dispatchItems(
      store,
      {
        "recursive-items/0": (frame) => ({
          status: "suspended-for-later",
          control: "interaction",
          intent: {
            kind: "interaction",
            intentKey: "item:interaction",
            nodeId: frame.nodeInventory[0]!,
          },
        }),
        "recursive-items/1": (frame) => ({
          status: "suspended-for-later",
          control: "suspension",
          intent: {
            kind: "suspension",
            intentKey: "item:suspension",
            nodeId: frame.nodeInventory[0]!,
          },
        }),
      },
      [],
    );

    expect(outcome).toMatchObject({
      status: "blocked",
      reason: "ambiguous-control-owner",
    });
    expect(store.decisions.size).toBe(0);
    expect(store.commits.size).toBe(2);
    const constructed: string[] = [];
    const restart = await dispatchItems(store, {}, constructed, "restart");
    expect(restart).toMatchObject({
      status: "blocked",
      reason: "ambiguous-control-owner",
    });
    expect(constructed).toEqual([]);
  });

  it("rejects an in-flight committed item without an exact control decision", async () => {
    const store = new MemoryRecursiveControlPort();
    const materialized = materializeRecursiveForEachItemPlanV1(itemPlan());
    const frame = materialized.frames[0]!;
    store.frames.set(frame.childScopeId, JSON.stringify(frame));
    store.commits.set(
      frame.childScopeId,
      serializeRecursiveScopedCommitV1(
        materializeRecursiveScopedCommitV1({
          frame,
          intentClaims: [
            {
              kind: "interaction",
              intentKey: "foreign",
              nodeId: "foreign-node",
            },
          ],
        }),
      ),
    );
    for (const other of materialized.frames.slice(1)) {
      store.frames.set(other.childScopeId, JSON.stringify(other));
    }
    const constructed: string[] = [];
    const outcome = await dispatchItems(store, {}, constructed, "restart");
    expect(outcome).toMatchObject({
      status: "corrupt",
      reason: "control-intent-corrupt",
    });
    expect(constructed).toEqual([]);
  });
});

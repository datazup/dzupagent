import { describe, expect, it } from "vitest";

import { canonicalInputDigest } from "@dzupagent/runtime-contracts";
import {
  materializeRecursiveScopedCommitV1,
  mergeRecursiveScopedCommitsV1,
  serializeRecursiveScopedCommitV1,
  serializeRecursiveScopedFrameV1,
  serializeRecursiveScopedMergeV1,
  type RecursiveAcknowledgementEvidenceInputV1,
  type RecursiveScopedFrameV1,
  type RecursiveScopedJsonValue,
  type RecursiveScopedSha256Digest,
} from "@dzupagent/runtime-contracts/recursive-scope";

import {
  deriveRecursiveForEachItemIdentityV1,
  dispatchRecursiveForEachItemsV1,
  materializeRecursiveForEachItemPlanV1,
  type RecursiveCommitCompareAndSaveInputV1,
  type RecursiveDurableWriteResultV1,
  type RecursiveForEachItemCommitPayloadV1,
  type RecursiveForEachItemExecutorFactoryV1,
  type RecursiveForEachItemPlanInputV1,
  type RecursiveFrameCompareAndSaveInputV1,
  type RecursiveScopedDurablePortV1,
} from "../recursive-scope/index.js";
import {
  bodyCompleteRecursiveForEachItemCheckpointV1,
  inFlightRecursiveForEachItemCheckpointV1,
  parseRecursiveForEachItemCheckpointV1,
} from "../recursive-scope/for-each-item-checkpoint.js";
import { recursiveFrameWithCheckpointV1 } from "../recursive-scope/durable-child.js";

const sha = (character: string) =>
  `sha256:${character.repeat(64)}` as RecursiveScopedSha256Digest;
const digest = (value: unknown) =>
  `sha256:${canonicalInputDigest(value)}` as RecursiveScopedSha256Digest;
const observedAt = "2026-08-18T16:00:00.000Z";

type WriteMode =
  | "normal"
  | "acknowledgement-lost-saved"
  | "acknowledgement-lost-absent"
  | "conflict";

class MemoryRecursiveItemPort implements RecursiveScopedDurablePortV1 {
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

interface PlanOptions {
  readonly values?: readonly RecursiveScopedJsonValue[];
  readonly rootDefinitionDigest?: RecursiveScopedSha256Digest;
  readonly ownerPath?: readonly string[];
  readonly parentCommitIdentity?: RecursiveScopedSha256Digest;
  readonly continuationNodeId?: string;
  readonly inventorySuffix?: string;
  readonly economics?: boolean;
  readonly maxConcurrency?: number;
}

function planInput(options: PlanOptions = {}): RecursiveForEachItemPlanInputV1 {
  const values = options.values ?? ["zero", "one", "two"];
  const collectionSourceDigest = digest(values);
  const forEachNodeId = "recursive-items";
  const chars = ["d", "e", "f"];
  const items = values.map((itemValue, itemOrdinal) => {
    const itemValueDigest = digest(itemValue);
    const itemIdentity = deriveRecursiveForEachItemIdentityV1({
      collectionSourceDigest,
      forEachNodeId,
      itemOrdinal,
      itemValueDigest,
    });
    return {
      itemOrdinal,
      itemIdentity,
      itemValue,
      childScopeId: `recursive-items/item/${itemOrdinal}`,
      scopedDefinitionId: `recursive-items/body/${itemOrdinal}`,
      scopedDefinitionDigest: sha(chars[itemOrdinal] ?? "9"),
      nodeInventory: [
        `body-${itemOrdinal}-exit${options.inventorySuffix ?? ""}`,
        `body-${itemOrdinal}-entry`,
      ],
      continuation: {
        kind: "for-each-join" as const,
        nodeId: options.continuationNodeId ?? "recursive-items-join",
      },
      checkpoint: { cursor: `body-${itemOrdinal}-entry`, effectsApplied: 0 },
      ...(options.economics
        ? {
            economics: {
              chargeKey: `item-charge-${itemOrdinal}`,
              reservationIdentity: sha(["6", "7", "8"][itemOrdinal] ?? "5"),
              hardCeilingMicros: 1_000 + itemOrdinal,
              currency: "USD",
            },
          }
        : {}),
    };
  });
  return {
    rootDefinitionId: "root-flow",
    rootDefinitionDigest: options.rootDefinitionDigest ?? sha("a"),
    ownerPath: options.ownerPath ?? ["root", forEachNodeId],
    forEachNodeId,
    parentCommitIdentity: options.parentCommitIdentity ?? sha("c"),
    collectionSourceDigest,
    maxConcurrency: options.maxConcurrency ?? 2,
    items: [...items].reverse(),
  };
}

function itemOrdinal(frame: RecursiveScopedFrameV1): number {
  if (frame.ownership.kind !== "for-each-item") {
    throw new Error("Expected a recursive for_each item frame.");
  }
  return frame.ownership.itemOrdinal;
}

function uniqueCommitPayload(
  frame: RecursiveScopedFrameV1,
): RecursiveForEachItemCommitPayloadV1 {
  const ordinal = itemOrdinal(frame);
  return {
    state: { [`state-${ordinal}`]: `state-${ordinal}` },
    results: { [`result-${ordinal}`]: [ordinal] },
    idempotencyKeys: { [`node-${ordinal}`]: `key-${ordinal}` },
  };
}

function committedAcknowledgement(
  character: string,
): RecursiveAcknowledgementEvidenceInputV1 {
  return {
    status: "committed",
    observation: {
      kind: "durable-commit",
      committedIdentity: sha(character),
      evidenceDigest: sha("b"),
    },
    observedAt,
  };
}

function retryableAcknowledgement(): RecursiveAcknowledgementEvidenceInputV1 {
  return {
    status: "retryable",
    observation: { kind: "confirmed-absent", evidenceDigest: sha("b") },
    observedAt,
  };
}

function blockedAcknowledgement(): RecursiveAcknowledgementEvidenceInputV1 {
  return {
    status: "blocked",
    observation: { kind: "uncertain", evidenceDigest: sha("b") },
    observedAt,
  };
}

function strictCommitPayload(
  frame: RecursiveScopedFrameV1,
  input: RecursiveForEachItemPlanInputV1,
  overrides: Partial<{
    reservationIdentity: RecursiveScopedSha256Digest;
    currency: string;
    settledCostMicros: number;
    acknowledgement: RecursiveAcknowledgementEvidenceInputV1;
  }> = {},
): RecursiveForEachItemCommitPayloadV1 {
  const ordinal = itemOrdinal(frame);
  const definition = [...input.items].sort(
    (left, right) => left.itemOrdinal - right.itemOrdinal,
  )[ordinal]!;
  const economics = definition.economics!;
  return {
    ...uniqueCommitPayload(frame),
    charges: {
      [economics.chargeKey]: {
        reservationIdentity:
          overrides.reservationIdentity ?? economics.reservationIdentity,
        measurementDigest: sha(["1", "2", "3"][ordinal] ?? "4"),
        settledCostMicros: overrides.settledCostMicros ?? 500 + ordinal,
        currency: overrides.currency ?? economics.currency,
        acknowledgement:
          overrides.acknowledgement ?? committedAcknowledgement("5"),
      },
    },
  };
}

function successfulFactory(
  constructed: string[],
  executed: string[],
  payload: (
    frame: RecursiveScopedFrameV1,
  ) => RecursiveForEachItemCommitPayloadV1 = uniqueCommitPayload,
): RecursiveForEachItemExecutorFactoryV1 {
  return ({ frame, itemValue, checkpoint }) => {
    constructed.push(frame.childScopeId);
    return {
      execute: async ({ persistCheckpoint }) => {
        executed.push(frame.childScopeId);
        await persistCheckpoint({ ...checkpoint, resumed: true });
        return {
          status: "completed",
          orderedResult: { ordinal: itemOrdinal(frame), itemValue },
          commit: payload(frame),
        };
      },
    };
  };
}

function seedInitialFrames(
  store: MemoryRecursiveItemPort,
  input: RecursiveForEachItemPlanInputV1,
): ReturnType<typeof materializeRecursiveForEachItemPlanV1> {
  const plan = materializeRecursiveForEachItemPlanV1(input);
  for (const frame of plan.frames) {
    store.frames.set(frame.childScopeId, serializeRecursiveScopedFrameV1(frame));
  }
  return plan;
}

function bodyCompleteFrame(
  plan: ReturnType<typeof materializeRecursiveForEachItemPlanV1>,
  ordinal: number,
  payload: RecursiveForEachItemCommitPayloadV1 = uniqueCommitPayload(
    plan.items[ordinal]!.frame,
  ),
): RecursiveScopedFrameV1 {
  const item = plan.items[ordinal]!;
  const parsed = parseRecursiveForEachItemCheckpointV1(
    item.frame,
    plan.collectionSourceDigest,
    item,
  );
  if (parsed.status !== "valid") throw new Error("Invalid test fixture.");
  return recursiveFrameWithCheckpointV1(
    item.frame,
    bodyCompleteRecursiveForEachItemCheckpointV1(
      parsed.checkpoint,
      { ordinal, itemValue: item.itemValue },
      payload,
    ),
  );
}

describe("recursive for_each item plan", () => {
  it("sorts definitions and pins source-bound item/frame identities", () => {
    const forward = materializeRecursiveForEachItemPlanV1(planInput());
    const reversed = materializeRecursiveForEachItemPlanV1({
      ...planInput(),
      items: [...planInput().items].reverse(),
    });

    expect(forward.items.map(({ itemOrdinal }) => itemOrdinal)).toEqual([0, 1, 2]);
    expect(forward.items.map(({ itemIdentity }) => itemIdentity)).toEqual(
      reversed.items.map(({ itemIdentity }) => itemIdentity),
    );
    expect(forward.frames.map(({ frameIdentity }) => frameIdentity)).toEqual(
      reversed.frames.map(({ frameIdentity }) => frameIdentity),
    );
    expect(forward.items.map(({ itemIdentity }) => itemIdentity)).toEqual([
      "sha256:554bbc2cfc673e152aca025747a81dc933ec3fc05643a73d079c2cbfd5348a3e",
      "sha256:ba187d4d9f39e7a4cbff760d7d03af8247dbe53271d8e05d91add66f987f4cef",
      "sha256:c43525d997f289d67a6fdc95c9fa41310ea7fec67f83cdea0968723a942e725d",
    ]);
  });

  it.each([
    [
      "source digest",
      (input: RecursiveForEachItemPlanInputV1) => ({
        ...input,
        collectionSourceDigest: sha("9"),
      }),
    ],
    [
      "item identity",
      (input: RecursiveForEachItemPlanInputV1) => ({
        ...input,
        items: input.items.map((item) =>
          item.itemOrdinal === 0
            ? { ...item, itemIdentity: sha("9") }
            : item,
        ),
      }),
    ],
    [
      "ordinal",
      (input: RecursiveForEachItemPlanInputV1) => ({
        ...input,
        items: input.items.map((item) =>
          item.itemOrdinal === 0 ? { ...item, itemOrdinal: 4 } : item,
        ),
      }),
    ],
    [
      "owner path",
      (input: RecursiveForEachItemPlanInputV1) => ({
        ...input,
        ownerPath: ["root", "other"],
      }),
    ],
    [
      "continuation",
      (input: RecursiveForEachItemPlanInputV1) => ({
        ...input,
        items: input.items.map((item) => ({
          ...item,
          continuation: { kind: "node" as const, nodeId: "join" },
        })),
      }),
    ],
    [
      "concurrency",
      (input: RecursiveForEachItemPlanInputV1) => ({
        ...input,
        maxConcurrency: 0,
      }),
    ],
    [
      "scope",
      (input: RecursiveForEachItemPlanInputV1) => ({
        ...input,
        items: input.items.map((item) => ({
          ...item,
          childScopeId: "same",
        })),
      }),
    ],
    [
      "reservation",
      (input: RecursiveForEachItemPlanInputV1) => ({
        ...input,
        items: input.items.map((item) => ({
          ...item,
          economics: {
            chargeKey: `charge-${item.itemOrdinal}`,
            reservationIdentity: sha("6"),
            hardCeilingMicros: 10,
            currency: "USD",
          },
        })),
      }),
    ],
  ])("rejects invalid %s ownership before dispatch", (_name, mutate) => {
    expect(() => materializeRecursiveForEachItemPlanV1(mutate(planInput()))).toThrow();
  });
});

describe("recursive for_each item dispatch", () => {
  it("dispatches with a hard concurrency bound and collects by ordinal", async () => {
    const store = new MemoryRecursiveItemPort();
    const input = planInput({ maxConcurrency: 2 });
    const constructed: string[] = [];
    const executed: string[] = [];
    let active = 0;
    let peak = 0;
    const releases = new Map<number, () => void>();
    const factory: RecursiveForEachItemExecutorFactoryV1 = ({ frame, itemValue }) => {
      constructed.push(frame.childScopeId);
      return {
        execute: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => releases.set(itemOrdinal(frame), resolve));
          active -= 1;
          executed.push(frame.childScopeId);
          return {
            status: "completed",
            orderedResult: itemValue,
            commit: uniqueCommitPayload(frame),
          };
        },
      };
    };
    const pending = dispatchRecursiveForEachItemsV1(
      { durable: store, createItemExecutor: factory },
      { mode: "initial", plan: input },
    );
    await viWaitFor(() => releases.size === 2);
    releases.get(1)!();
    await viWaitFor(() => releases.has(2));
    releases.get(2)!();
    releases.get(0)!();
    const outcome = await pending;

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(peak).toBe(2);
    expect(constructed).toEqual([
      "recursive-items/item/0",
      "recursive-items/item/1",
      "recursive-items/item/2",
    ]);
    expect(executed).toEqual([
      "recursive-items/item/1",
      "recursive-items/item/2",
      "recursive-items/item/0",
    ]);
    expect(outcome.orderedResults).toEqual(["zero", "one", "two"]);
    expect(serializeRecursiveScopedMergeV1(outcome.merge)).toBe(
      serializeRecursiveScopedMergeV1(
        mergeRecursiveScopedCommitsV1([...outcome.commits].reverse()),
      ),
    );
  });

  it.each([
    ["definition", () => planInput({ rootDefinitionDigest: sha("9") })],
    ["owner", () => planInput({ ownerPath: ["alternate", "recursive-items"] })],
    ["parent", () => planInput({ parentCommitIdentity: sha("9") })],
    ["inventory", () => planInput({ inventorySuffix: "-changed" })],
    ["continuation", () => planInput({ continuationNodeId: "other-join" })],
    ["source and item", () => planInput({ values: ["changed", "one", "two"] })],
  ])("creates zero executors for valid %s drift", async (_name, changed) => {
    const store = new MemoryRecursiveItemPort();
    seedInitialFrames(store, planInput());
    const constructed: string[] = [];
    const outcome = await dispatchRecursiveForEachItemsV1(
      { durable: store, createItemExecutor: successfulFactory(constructed, []) },
      { mode: "restart", plan: changed() },
    );
    expect(outcome.status).toMatch(/blocked|corrupt/);
    expect(constructed).toEqual([]);
  });

  it("binds the strict economics ceiling across restart", async () => {
    const store = new MemoryRecursiveItemPort();
    const original = planInput({ economics: true });
    seedInitialFrames(store, original);
    const changed: RecursiveForEachItemPlanInputV1 = {
      ...original,
      items: original.items.map((item) => ({
        ...item,
        ...(item.economics === undefined
          ? {}
          : {
              economics: {
                ...item.economics,
                hardCeilingMicros: item.economics.hardCeilingMicros + 1,
              },
            }),
      })),
    };
    const constructed: string[] = [];
    const outcome = await dispatchRecursiveForEachItemsV1(
      { durable: store, createItemExecutor: successfulFactory(constructed, []) },
      { mode: "restart", plan: changed },
    );
    expect(outcome).toMatchObject({
      status: "corrupt",
      reason: "item-checkpoint-drift",
    });
    expect(constructed).toEqual([]);
  });

  it("restores committed, body-complete, and in-flight items without duplicate work", async () => {
    const input = planInput();
    const store = new MemoryRecursiveItemPort();
    const plan = seedInitialFrames(store, input);

    const committedFrame = bodyCompleteFrame(plan, 0);
    const committed = materializeRecursiveScopedCommitV1({
      frame: committedFrame,
      ...uniqueCommitPayload(committedFrame),
    });
    store.frames.set(
      committedFrame.childScopeId,
      serializeRecursiveScopedFrameV1(committedFrame),
    );
    store.commits.set(
      committedFrame.childScopeId,
      serializeRecursiveScopedCommitV1(committed),
    );

    const completeFrame = bodyCompleteFrame(plan, 1);
    store.frames.set(
      completeFrame.childScopeId,
      serializeRecursiveScopedFrameV1(completeFrame),
    );

    const item = plan.items[2]!;
    const parsed = parseRecursiveForEachItemCheckpointV1(
      item.frame,
      plan.collectionSourceDigest,
      item,
    );
    if (parsed.status !== "valid") throw new Error("Invalid fixture.");
    const inFlight = recursiveFrameWithCheckpointV1(
      item.frame,
      inFlightRecursiveForEachItemCheckpointV1(parsed.checkpoint, {
        cursor: "body-2-second",
        effectsApplied: 1,
      }),
    );
    store.frames.set(inFlight.childScopeId, serializeRecursiveScopedFrameV1(inFlight));

    const constructed: string[] = [];
    const executed: string[] = [];
    let restoredCheckpoint: unknown;
    const factory: RecursiveForEachItemExecutorFactoryV1 = ({ frame, checkpoint }) => {
      constructed.push(frame.childScopeId);
      restoredCheckpoint = checkpoint;
      return {
        execute: async () => {
          executed.push(frame.childScopeId);
          return {
            status: "completed",
            orderedResult: { ordinal: 2, itemValue: "two" },
            commit: uniqueCommitPayload(frame),
          };
        },
      };
    };
    const outcome = await dispatchRecursiveForEachItemsV1(
      { durable: store, createItemExecutor: factory },
      { mode: "restart", plan: input },
    );

    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed") return;
    expect(constructed).toEqual(["recursive-items/item/2"]);
    expect(executed).toEqual(["recursive-items/item/2"]);
    expect(restoredCheckpoint).toEqual({
      cursor: "body-2-second",
      effectsApplied: 1,
    });
    expect(outcome.progress.skippedCommittedChildScopeIds).toEqual([
      "recursive-items/item/0",
    ]);
    expect(outcome.progress.skippedBodyCompleteChildScopeIds).toEqual([
      "recursive-items/item/1",
    ]);
    expect(outcome.orderedResults).toEqual([
      { ordinal: 0, itemValue: "zero" },
      { ordinal: 1, itemValue: "one" },
      { ordinal: 2, itemValue: "two" },
    ]);
  });

  it("does not repeat item economics after body completion or commit loss", async () => {
    const input = planInput({ economics: true });
    const store = new MemoryRecursiveItemPort();
    const executions = new Map<number, number>();
    const factory: RecursiveForEachItemExecutorFactoryV1 = ({ frame }) => ({
      execute: async () => {
        const ordinal = itemOrdinal(frame);
        executions.set(ordinal, (executions.get(ordinal) ?? 0) + 1);
        return {
          status: "completed",
          orderedResult: ordinal,
          commit: strictCommitPayload(frame, input),
        };
      },
    });
    const first = await dispatchRecursiveForEachItemsV1(
      { durable: store, createItemExecutor: factory },
      { mode: "initial", plan: input },
    );
    expect(first.status).toBe("completed");
    store.commits.delete("recursive-items/item/1");

    const second = await dispatchRecursiveForEachItemsV1(
      { durable: store, createItemExecutor: factory },
      { mode: "restart", plan: input },
    );
    expect(second.status).toBe("completed");
    expect(executions).toEqual(new Map([[0, 1], [1, 1], [2, 1]]));
    if (second.status === "completed") {
      expect(second.progress.skippedBodyCompleteChildScopeIds).toEqual([
        "recursive-items/item/1",
      ]);
    }
  });

  it.each([
    ["over ceiling", { settledCostMicros: 10_000 }],
    ["foreign reservation", { reservationIdentity: sha("9") }],
    ["foreign currency", { currency: "EUR" }],
    ["retryable charge", { acknowledgement: retryableAcknowledgement() }],
  ])("blocks strict economics with %s and never redispatches its body", async (_name, overrides) => {
    const input = planInput({ economics: true });
    const store = new MemoryRecursiveItemPort();
    const constructed: string[] = [];
    const factory: RecursiveForEachItemExecutorFactoryV1 = ({ frame }) => {
      constructed.push(frame.childScopeId);
      return {
        execute: async () => ({
          status: "completed",
          orderedResult: itemOrdinal(frame),
          commit:
            itemOrdinal(frame) === 0
              ? strictCommitPayload(frame, input, overrides)
              : strictCommitPayload(frame, input),
        }),
      };
    };
    const first = await dispatchRecursiveForEachItemsV1(
      { durable: store, createItemExecutor: factory },
      { mode: "initial", plan: input },
    );
    expect(first).toMatchObject({
      status: "blocked",
      childScopeId: "recursive-items/item/0",
      reason: "item-economics-policy-blocked",
    });
    constructed.length = 0;
    const second = await dispatchRecursiveForEachItemsV1(
      { durable: store, createItemExecutor: factory },
      { mode: "restart", plan: input },
    );
    expect(second.status).toBe("blocked");
    expect(constructed).toEqual([]);
  });

  it("accepts exact frame and commit acknowledgement-loss evidence", async () => {
    const input = planInput();
    const store = new MemoryRecursiveItemPort();
    store.frameWriteModes.set(
      "recursive-items/item/0",
      "acknowledgement-lost-saved",
    );
    store.commitWriteModes.set(
      "recursive-items/item/1",
      "acknowledgement-lost-saved",
    );
    const outcome = await dispatchRecursiveForEachItemsV1(
      { durable: store, createItemExecutor: successfulFactory([], []) },
      { mode: "initial", plan: input },
    );
    expect(outcome.status).toBe("completed");
  });

  it("retries only an unobserved initial frame before dispatch", async () => {
    const store = new MemoryRecursiveItemPort();
    store.frameWriteModes.set(
      "recursive-items/item/0",
      "acknowledgement-lost-absent",
    );
    const constructed: string[] = [];
    const outcome = await dispatchRecursiveForEachItemsV1(
      { durable: store, createItemExecutor: successfulFactory(constructed, []) },
      { mode: "initial", plan: planInput() },
    );
    expect(outcome).toMatchObject({
      status: "retryable-before-dispatch",
      childScopeId: "recursive-items/item/0",
    });
    expect(constructed).toEqual([]);
  });

  it.each([
    ["checkpoint", "frame" as const],
    ["commit", "commit" as const],
  ])("blocks unobserved post-dispatch %s acknowledgement", async (_name, boundary) => {
    const input = planInput();
    const store = new MemoryRecursiveItemPort();
    seedInitialFrames(store, input);
    if (boundary === "frame") {
      store.frameWriteModes.set(
        "recursive-items/item/0",
        "acknowledgement-lost-absent",
      );
    } else {
      store.commitWriteModes.set(
        "recursive-items/item/0",
        "acknowledgement-lost-absent",
      );
    }
    const factory: RecursiveForEachItemExecutorFactoryV1 = ({ frame }) => ({
      execute: async ({ persistCheckpoint }) => {
        if (boundary === "frame") await persistCheckpoint({ cursor: "after-effect" });
        return {
          status: "completed",
          orderedResult: itemOrdinal(frame),
          commit: uniqueCommitPayload(frame),
        };
      },
    });
    const outcome = await dispatchRecursiveForEachItemsV1(
      { durable: store, createItemExecutor: factory },
      { mode: "restart", plan: input },
    );
    expect(outcome.status).toBe("blocked");
    if (outcome.status === "blocked") {
      expect(outcome.reason).toMatch(/acknowledgement-unknown/);
    }
  });

  it("blocks unknown effect evidence and retains body completion", async () => {
    const input = planInput();
    const store = new MemoryRecursiveItemPort();
    const constructed: string[] = [];
    const factory: RecursiveForEachItemExecutorFactoryV1 = ({ frame }) => {
      constructed.push(frame.childScopeId);
      return {
        execute: async () => ({
          status: "completed",
          orderedResult: itemOrdinal(frame),
          commit: {
            ...uniqueCommitPayload(frame),
            effects:
              itemOrdinal(frame) === 0
                ? {
                    external: {
                      idempotencyKey: "effect-0",
                      intentDigest: sha("4"),
                      acknowledgement: blockedAcknowledgement(),
                    },
                  }
                : {},
          },
        }),
      };
    };
    const first = await dispatchRecursiveForEachItemsV1(
      { durable: store, createItemExecutor: factory },
      { mode: "initial", plan: input },
    );
    expect(first).toMatchObject({
      status: "blocked",
      reason: "operation-acknowledgement-unknown",
    });
    constructed.length = 0;
    const restart = await dispatchRecursiveForEachItemsV1(
      { durable: store, createItemExecutor: factory },
      { mode: "restart", plan: input },
    );
    expect(restart.status).toBe("blocked");
    expect(constructed).toEqual([]);
  });

  it.each([
    ["state", (ordinal: number) => ({ state: { shared: ordinal } })],
    ["result", (ordinal: number) => ({ results: { shared: ordinal } })],
    ["idempotency", (ordinal: number) => ({ idempotencyKeys: { shared: `key-${ordinal}` } })],
    ["effect", (ordinal: number) => ({ effects: { shared: { idempotencyKey: `effect-${ordinal}`, intentDigest: sha(ordinal === 0 ? "1" : "2"), acknowledgement: committedAcknowledgement("3") } } })],
    ["charge", (ordinal: number) => ({ charges: { shared: { reservationIdentity: sha(ordinal === 0 ? "6" : "7"), measurementDigest: sha(ordinal === 0 ? "1" : "2"), settledCostMicros: ordinal + 1, currency: "USD", acknowledgement: committedAcknowledgement("3") } } })],
  ])("routes same-key %s conflict through the W3-B reducer", async (_name, conflict) => {
    const input = planInput({ values: ["zero", "one"] });
    const store = new MemoryRecursiveItemPort();
    const outcome = await dispatchRecursiveForEachItemsV1(
      {
        durable: store,
        createItemExecutor: ({ frame }) => ({
          execute: async () => ({
            status: "completed",
            orderedResult: itemOrdinal(frame),
            commit: conflict(itemOrdinal(frame)),
          }),
        }),
      },
      { mode: "initial", plan: input },
    );
    expect(outcome).toMatchObject({ status: "blocked", reason: "merge-conflict" });
  });

  it("rejects duplicate charge reservations across distinct keys", async () => {
    const input = planInput({ values: ["zero", "one"] });
    const store = new MemoryRecursiveItemPort();
    const outcome = await dispatchRecursiveForEachItemsV1(
      {
        durable: store,
        createItemExecutor: ({ frame }) => ({
          execute: async () => ({
            status: "completed",
            orderedResult: itemOrdinal(frame),
            commit: {
              charges: {
                [`charge-${itemOrdinal(frame)}`]: {
                  reservationIdentity: sha("6"),
                  measurementDigest: sha(itemOrdinal(frame) === 0 ? "1" : "2"),
                  settledCostMicros: 10,
                  currency: "USD",
                  acknowledgement: committedAcknowledgement("3"),
                },
              },
            },
          }),
        }),
      },
      { mode: "initial", plan: input },
    );
    expect(outcome).toMatchObject({ status: "blocked", reason: "merge-conflict" });
  });

  it("rejects duplicate effect identity across distinct keys", async () => {
    const input = planInput({ values: ["zero", "one"] });
    const store = new MemoryRecursiveItemPort();
    const outcome = await dispatchRecursiveForEachItemsV1(
      {
        durable: store,
        createItemExecutor: ({ frame }) => ({
          execute: async () => ({
            status: "completed",
            orderedResult: itemOrdinal(frame),
            commit: {
              effects: {
                [`effect-${itemOrdinal(frame)}`]: {
                  idempotencyKey: "shared-effect",
                  intentDigest: sha("4"),
                  acknowledgement: committedAcknowledgement("3"),
                },
              },
            },
          }),
        }),
      },
      { mode: "initial", plan: input },
    );
    expect(outcome).toMatchObject({ status: "blocked", reason: "merge-conflict" });
  });

  it("rejects corrupt item checkpoint bytes before executor construction", async () => {
    const input = planInput();
    const store = new MemoryRecursiveItemPort();
    const plan = seedInitialFrames(store, input);
    const corrupt = recursiveFrameWithCheckpointV1(plan.items[0]!.frame, {
      schema: "wrong",
    });
    store.frames.set(corrupt.childScopeId, serializeRecursiveScopedFrameV1(corrupt));
    const constructed: string[] = [];
    const outcome = await dispatchRecursiveForEachItemsV1(
      { durable: store, createItemExecutor: successfulFactory(constructed, []) },
      { mode: "restart", plan: input },
    );
    expect(outcome).toMatchObject({
      status: "corrupt",
      reason: "item-checkpoint-corrupt",
    });
    expect(constructed).toEqual([]);
  });

  it("preflights a corrupt later item before constructing any executor", async () => {
    const input = planInput();
    const store = new MemoryRecursiveItemPort();
    const plan = seedInitialFrames(store, input);
    const corrupt = recursiveFrameWithCheckpointV1(plan.items[2]!.frame, {
      schema: "wrong",
    });
    store.frames.set(corrupt.childScopeId, serializeRecursiveScopedFrameV1(corrupt));
    const constructed: string[] = [];
    const outcome = await dispatchRecursiveForEachItemsV1(
      { durable: store, createItemExecutor: successfulFactory(constructed, []) },
      { mode: "restart", plan: input },
    );
    expect(outcome).toMatchObject({
      status: "corrupt",
      childScopeId: "recursive-items/item/2",
      reason: "item-checkpoint-corrupt",
    });
    expect(constructed).toEqual([]);
  });

  it("rejects a committed child that diverges from its body-complete receipt", async () => {
    const input = planInput();
    const store = new MemoryRecursiveItemPort();
    const plan = seedInitialFrames(store, input);
    const complete = bodyCompleteFrame(plan, 0);
    store.frames.set(complete.childScopeId, serializeRecursiveScopedFrameV1(complete));
    const foreign = materializeRecursiveScopedCommitV1({
      frame: complete,
      state: { foreign: true },
    });
    store.commits.set(
      complete.childScopeId,
      serializeRecursiveScopedCommitV1(foreign),
    );
    const constructed: string[] = [];
    const outcome = await dispatchRecursiveForEachItemsV1(
      { durable: store, createItemExecutor: successfulFactory(constructed, []) },
      { mode: "restart", plan: input },
    );
    expect(outcome).toMatchObject({
      status: "corrupt",
      reason: "body-complete-commit-drift",
    });
    expect(constructed).toEqual([]);
  });

  it("returns the typed deferred-control boundary", async () => {
    const outcome = await dispatchRecursiveForEachItemsV1(
      {
        durable: new MemoryRecursiveItemPort(),
        createItemExecutor: ({ frame }) => ({
          execute: async () =>
            itemOrdinal(frame) === 1
              ? {
                  status: "suspended-for-later",
                  control: "interaction",
                  checkpoint: { cursor: "interaction" },
                }
              : {
                  status: "completed",
                  orderedResult: itemOrdinal(frame),
                  commit: uniqueCommitPayload(frame),
                },
        }),
      },
      { mode: "initial", plan: planInput() },
    );
    expect(outcome).toMatchObject({
      status: "suspended-for-later",
      childScopeId: "recursive-items/item/1",
      control: "interaction",
    });
  });
});

async function viWaitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Condition was not reached.");
}

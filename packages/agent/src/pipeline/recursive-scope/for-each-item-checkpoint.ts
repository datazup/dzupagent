import type {
  RecursiveScopedFrameV1,
  RecursiveScopedJsonObject,
  RecursiveScopedJsonValue,
  RecursiveScopedSha256Digest,
} from "@dzupagent/runtime-contracts/recursive-scope";

import type {
  RecursiveForEachItemCommitPayloadV1,
  RecursiveForEachPlannedItemV1,
} from "./for-each-item-types.js";

const RECURSIVE_FOR_EACH_ITEM_CHECKPOINT_SCHEMA_V1 =
  "dzupagent.recursiveForEachItemCheckpoint/v1" as const;

interface RecursiveForEachItemCheckpointBaseV1 {
  readonly schema: typeof RECURSIVE_FOR_EACH_ITEM_CHECKPOINT_SCHEMA_V1;
  readonly collectionSourceDigest: RecursiveScopedSha256Digest;
  readonly itemIdentity: RecursiveScopedSha256Digest;
  readonly itemOrdinal: number;
  readonly itemValueDigest: RecursiveScopedSha256Digest;
  readonly executorCheckpoint: RecursiveScopedJsonObject;
}

export interface RecursiveForEachItemInFlightCheckpointV1
  extends RecursiveForEachItemCheckpointBaseV1 {
  readonly phase: "in-flight";
}

export interface RecursiveForEachItemBodyCompleteCheckpointV1
  extends RecursiveForEachItemCheckpointBaseV1 {
  readonly phase: "body-complete";
  readonly orderedResult: RecursiveScopedJsonValue;
  readonly commit: RecursiveForEachItemCommitPayloadV1;
}

export type RecursiveForEachItemCheckpointV1 =
  | RecursiveForEachItemInFlightCheckpointV1
  | RecursiveForEachItemBodyCompleteCheckpointV1;

export type RecursiveForEachItemCheckpointParseV1 =
  | {
      readonly status: "valid";
      readonly checkpoint: RecursiveForEachItemCheckpointV1;
    }
  | { readonly status: "corrupt" }
  | { readonly status: "drift" };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((entry, index) => entry === [...expected].sort()[index])
  );
}

function commitPayload(value: unknown): value is RecursiveForEachItemCommitPayloadV1 {
  if (!record(value)) return false;
  const allowed = [
    "state",
    "results",
    "idempotencyKeys",
    "effects",
    "charges",
    "intentClaims",
  ];
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function initialRecursiveForEachItemCheckpointV1(
  collectionSourceDigest: RecursiveScopedSha256Digest,
  item: Pick<
    RecursiveForEachPlannedItemV1,
    "itemIdentity" | "itemOrdinal" | "itemValueDigest"
  >,
  executorCheckpoint: RecursiveScopedJsonObject,
): RecursiveScopedJsonObject {
  return {
    schema: RECURSIVE_FOR_EACH_ITEM_CHECKPOINT_SCHEMA_V1,
    phase: "in-flight",
    collectionSourceDigest,
    itemIdentity: item.itemIdentity,
    itemOrdinal: item.itemOrdinal,
    itemValueDigest: item.itemValueDigest,
    executorCheckpoint,
  };
}

export function inFlightRecursiveForEachItemCheckpointV1(
  previous: RecursiveForEachItemCheckpointV1,
  executorCheckpoint: RecursiveScopedJsonObject,
): RecursiveScopedJsonObject {
  return {
    schema: previous.schema,
    phase: "in-flight",
    collectionSourceDigest: previous.collectionSourceDigest,
    itemIdentity: previous.itemIdentity,
    itemOrdinal: previous.itemOrdinal,
    itemValueDigest: previous.itemValueDigest,
    executorCheckpoint,
  };
}

export function bodyCompleteRecursiveForEachItemCheckpointV1(
  previous: RecursiveForEachItemCheckpointV1,
  orderedResult: RecursiveScopedJsonValue,
  commit: RecursiveForEachItemCommitPayloadV1,
): RecursiveScopedJsonObject {
  return {
    schema: previous.schema,
    phase: "body-complete",
    collectionSourceDigest: previous.collectionSourceDigest,
    itemIdentity: previous.itemIdentity,
    itemOrdinal: previous.itemOrdinal,
    itemValueDigest: previous.itemValueDigest,
    executorCheckpoint: previous.executorCheckpoint,
    orderedResult,
    commit: commit as unknown as RecursiveScopedJsonObject,
  };
}

export function parseRecursiveForEachItemCheckpointV1(
  frame: RecursiveScopedFrameV1,
  collectionSourceDigest: RecursiveScopedSha256Digest,
  item: Pick<
    RecursiveForEachPlannedItemV1,
    "itemIdentity" | "itemOrdinal" | "itemValueDigest"
  >,
): RecursiveForEachItemCheckpointParseV1 {
  const value = frame.checkpoint;
  if (
    value.schema !== RECURSIVE_FOR_EACH_ITEM_CHECKPOINT_SCHEMA_V1 ||
    (value.phase !== "in-flight" && value.phase !== "body-complete") ||
    !record(value.executorCheckpoint)
  ) {
    return { status: "corrupt" };
  }
  const expectedKeys =
    value.phase === "in-flight"
      ? [
          "schema",
          "phase",
          "collectionSourceDigest",
          "itemIdentity",
          "itemOrdinal",
          "itemValueDigest",
          "executorCheckpoint",
        ]
      : [
          "schema",
          "phase",
          "collectionSourceDigest",
          "itemIdentity",
          "itemOrdinal",
          "itemValueDigest",
          "executorCheckpoint",
          "orderedResult",
          "commit",
        ];
  if (!exactKeys(value, expectedKeys)) return { status: "corrupt" };
  if (
    value.collectionSourceDigest !== collectionSourceDigest ||
    value.itemIdentity !== item.itemIdentity ||
    value.itemOrdinal !== item.itemOrdinal ||
    value.itemValueDigest !== item.itemValueDigest
  ) {
    return { status: "drift" };
  }
  if (value.phase === "body-complete" && !commitPayload(value.commit)) {
    return { status: "corrupt" };
  }
  return {
    status: "valid",
    checkpoint: value as unknown as RecursiveForEachItemCheckpointV1,
  };
}

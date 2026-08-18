import { canonicalInputDigest } from "@dzupagent/runtime-contracts";
import {
  deserializeRecursiveScopedFrameV1,
  materializeRecursiveScopedFrameV1,
  recursiveScopedFrameBindingV1,
  serializeRecursiveScopedFrameV1,
  type RecursiveScopedSha256Digest,
} from "@dzupagent/runtime-contracts/recursive-scope";

import { initialRecursiveForEachItemCheckpointV1 } from "./for-each-item-checkpoint.js";
import type {
  RecursiveForEachItemDefinitionV1,
  RecursiveForEachItemPlanInputV1,
  RecursiveForEachItemPlanV1,
  RecursiveForEachPlannedItemV1,
} from "./for-each-item-types.js";

export class RecursiveForEachItemPlanError extends Error {
  override readonly name = "RecursiveForEachItemPlanError";
}

function digest(value: unknown): RecursiveScopedSha256Digest {
  return canonicalInputDigest(value) as RecursiveScopedSha256Digest;
}

function requireNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new RecursiveForEachItemPlanError(`${field} must be non-empty.`);
  }
}

export function deriveRecursiveForEachItemIdentityV1(input: {
  readonly collectionSourceDigest: RecursiveScopedSha256Digest;
  readonly forEachNodeId: string;
  readonly itemOrdinal: number;
  readonly itemValueDigest: RecursiveScopedSha256Digest;
}): RecursiveScopedSha256Digest {
  return digest({
    schema: "dzupagent.recursiveForEachItemIdentity/v1",
    collectionSourceDigest: input.collectionSourceDigest,
    forEachNodeId: input.forEachNodeId,
    itemOrdinal: input.itemOrdinal,
    itemValueDigest: input.itemValueDigest,
  });
}

function validateEconomics(
  item: RecursiveForEachItemDefinitionV1,
  index: number,
): void {
  const economics = item.economics;
  if (economics === undefined) return;
  requireNonEmpty(economics.chargeKey, `items[${index}].economics.chargeKey`);
  requireNonEmpty(economics.currency, `items[${index}].economics.currency`);
  if (
    !Number.isSafeInteger(economics.hardCeilingMicros) ||
    economics.hardCeilingMicros < 0
  ) {
    throw new RecursiveForEachItemPlanError(
      `items[${index}].economics.hardCeilingMicros must be a non-negative safe integer.`,
    );
  }
}

/** Materialize all source-bound recursive item frames before dispatch. */
export function materializeRecursiveForEachItemPlanV1(
  input: RecursiveForEachItemPlanInputV1,
): RecursiveForEachItemPlanV1 {
  requireNonEmpty(input.rootDefinitionId, "rootDefinitionId");
  requireNonEmpty(input.forEachNodeId, "forEachNodeId");
  if (input.ownerPath.at(-1) !== input.forEachNodeId) {
    throw new RecursiveForEachItemPlanError(
      "ownerPath must end at the definition-owned for_each node.",
    );
  }
  if (input.items.length === 0) {
    throw new RecursiveForEachItemPlanError("At least one item is required.");
  }
  if (
    !Number.isSafeInteger(input.maxConcurrency) ||
    input.maxConcurrency <= 0
  ) {
    throw new RecursiveForEachItemPlanError(
      "maxConcurrency must be a positive safe integer.",
    );
  }

  const items = [...input.items].sort(
    (left, right) => left.itemOrdinal - right.itemOrdinal,
  );
  if (digest(items.map(({ itemValue }) => itemValue)) !== input.collectionSourceDigest) {
    throw new RecursiveForEachItemPlanError(
      "collectionSourceDigest does not match the ordinal item source.",
    );
  }

  const itemIdentities = new Set<string>();
  const childScopeIds = new Set<string>();
  const reservationIdentities = new Set<string>();
  const chargeKeys = new Set<string>();

  const plannedItems = items.map((item, index): RecursiveForEachPlannedItemV1 => {
    if (!Number.isSafeInteger(item.itemOrdinal) || item.itemOrdinal < 0) {
      throw new RecursiveForEachItemPlanError(
        `itemOrdinal at index ${index} must be a non-negative safe integer.`,
      );
    }
    if (item.itemOrdinal !== index) {
      throw new RecursiveForEachItemPlanError(
        "Item ordinals must be unique and contiguous from zero.",
      );
    }
    requireNonEmpty(item.childScopeId, `items[${index}].childScopeId`);
    requireNonEmpty(
      item.scopedDefinitionId,
      `items[${index}].scopedDefinitionId`,
    );
    if (item.continuation.kind !== "for-each-join") {
      throw new RecursiveForEachItemPlanError(
        `items[${index}].continuation must target a for-each-join.`,
      );
    }
    validateEconomics(item, index);

    const itemValueDigest = digest(item.itemValue);
    const expectedItemIdentity = deriveRecursiveForEachItemIdentityV1({
      collectionSourceDigest: input.collectionSourceDigest,
      forEachNodeId: input.forEachNodeId,
      itemOrdinal: item.itemOrdinal,
      itemValueDigest,
    });
    if (item.itemIdentity !== expectedItemIdentity) {
      throw new RecursiveForEachItemPlanError(
        `items[${index}].itemIdentity does not match its source binding.`,
      );
    }
    if (itemIdentities.has(item.itemIdentity)) {
      throw new RecursiveForEachItemPlanError("Duplicate item identity.");
    }
    if (childScopeIds.has(item.childScopeId)) {
      throw new RecursiveForEachItemPlanError("Duplicate child scope ID.");
    }
    itemIdentities.add(item.itemIdentity);
    childScopeIds.add(item.childScopeId);

    if (item.economics !== undefined) {
      if (reservationIdentities.has(item.economics.reservationIdentity)) {
        throw new RecursiveForEachItemPlanError(
          "Duplicate strict reservation identity.",
        );
      }
      if (chargeKeys.has(item.economics.chargeKey)) {
        throw new RecursiveForEachItemPlanError("Duplicate strict charge key.");
      }
      reservationIdentities.add(item.economics.reservationIdentity);
      chargeKeys.add(item.economics.chargeKey);
    }

    const checkpointItem = {
      itemOrdinal: item.itemOrdinal,
      itemIdentity: item.itemIdentity,
      itemValueDigest,
    };
    const materialized = materializeRecursiveScopedFrameV1({
      frameKind: "for-each-item",
      definition: {
        rootDefinitionId: input.rootDefinitionId,
        rootDefinitionDigest: input.rootDefinitionDigest,
        scopedDefinitionId: item.scopedDefinitionId,
        scopedDefinitionDigest: item.scopedDefinitionDigest,
      },
      ownerPath: input.ownerPath,
      childScopeId: item.childScopeId,
      ownership: {
        kind: "for-each-item",
        forEachNodeId: input.forEachNodeId,
        itemOrdinal: item.itemOrdinal,
        itemIdentity: item.itemIdentity,
      },
      nodeInventory: item.nodeInventory,
      continuation: {
        ...item.continuation,
        edgeOrdinal: item.itemOrdinal,
      },
      parentCommitIdentity: input.parentCommitIdentity,
      checkpoint: initialRecursiveForEachItemCheckpointV1(
        input.collectionSourceDigest,
        checkpointItem,
        item.checkpoint,
      ),
    });
    const frame = deserializeRecursiveScopedFrameV1(
      serializeRecursiveScopedFrameV1(materialized),
      recursiveScopedFrameBindingV1(materialized),
    );
    return {
      itemOrdinal: item.itemOrdinal,
      itemIdentity: item.itemIdentity,
      itemValue: item.itemValue,
      itemValueDigest,
      frame,
      ...(item.economics === undefined ? {} : { economics: item.economics }),
    };
  });

  return {
    rootDefinitionId: input.rootDefinitionId,
    rootDefinitionDigest: input.rootDefinitionDigest,
    ownerPath: [...input.ownerPath],
    forEachNodeId: input.forEachNodeId,
    parentCommitIdentity: input.parentCommitIdentity,
    collectionSourceDigest: input.collectionSourceDigest,
    maxConcurrency: input.maxConcurrency,
    items: plannedItems,
    frames: plannedItems.map(({ frame }) => frame),
  };
}

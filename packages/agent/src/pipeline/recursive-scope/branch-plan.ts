import {
  deserializeRecursiveScopedFrameV1,
  materializeRecursiveScopedFrameV1,
  recursiveScopedFrameBindingV1,
  serializeRecursiveScopedFrameV1,
  type RecursiveScopedOwnershipInputV1,
} from "@dzupagent/runtime-contracts/recursive-scope";

import type {
  RecursiveBranchDefinitionV1,
  RecursiveBranchPlanInputV1,
  RecursiveBranchPlanV1,
} from "./types.js";

export class RecursiveBranchPlanError extends Error {
  override readonly name = "RecursiveBranchPlanError";
}

function requireNonEmpty(value: string, field: string): void {
  if (value.length === 0) {
    throw new RecursiveBranchPlanError(`${field} must be non-empty.`);
  }
}

function ownershipFor(
  input: RecursiveBranchPlanInputV1,
  branch: RecursiveBranchDefinitionV1,
): RecursiveScopedOwnershipInputV1 {
  return input.frameKind === "branch"
    ? {
        kind: "branch",
        branchNodeId: input.ownerNodeId,
        branchOrdinal: branch.branchOrdinal,
        branchIdentity: branch.branchIdentity,
      }
    : {
        kind: "fork-branch",
        forkNodeId: input.ownerNodeId,
        branchOrdinal: branch.branchOrdinal,
        branchIdentity: branch.branchIdentity,
      };
}

/** Materialize every definition-owned child frame before dispatch is possible. */
export function materializeRecursiveBranchPlanV1(
  input: RecursiveBranchPlanInputV1,
): RecursiveBranchPlanV1 {
  requireNonEmpty(input.rootDefinitionId, "rootDefinitionId");
  requireNonEmpty(input.ownerNodeId, "ownerNodeId");
  if (input.ownerPath.at(-1) !== input.ownerNodeId) {
    throw new RecursiveBranchPlanError(
      "ownerPath must end at the definition-owned branch node.",
    );
  }
  if (input.branches.length === 0) {
    throw new RecursiveBranchPlanError("At least one branch is required.");
  }

  const branches = [...input.branches].sort(
    (left, right) => left.branchOrdinal - right.branchOrdinal,
  );
  const ordinals = new Set<number>();
  const identities = new Set<string>();
  const childScopeIds = new Set<string>();

  branches.forEach((branch, index) => {
    if (!Number.isSafeInteger(branch.branchOrdinal) || branch.branchOrdinal < 0) {
      throw new RecursiveBranchPlanError(
        `branchOrdinal at index ${index} must be a non-negative safe integer.`,
      );
    }
    if (branch.branchOrdinal !== index) {
      throw new RecursiveBranchPlanError(
        "Branch ordinals must be unique and contiguous from zero.",
      );
    }
    requireNonEmpty(branch.branchIdentity, `branches[${index}].branchIdentity`);
    requireNonEmpty(branch.childScopeId, `branches[${index}].childScopeId`);
    requireNonEmpty(
      branch.scopedDefinitionId,
      `branches[${index}].scopedDefinitionId`,
    );
    if (ordinals.has(branch.branchOrdinal)) {
      throw new RecursiveBranchPlanError("Duplicate branch ordinal.");
    }
    if (identities.has(branch.branchIdentity)) {
      throw new RecursiveBranchPlanError("Duplicate branch identity.");
    }
    if (childScopeIds.has(branch.childScopeId)) {
      throw new RecursiveBranchPlanError("Duplicate child scope ID.");
    }
    ordinals.add(branch.branchOrdinal);
    identities.add(branch.branchIdentity);
    childScopeIds.add(branch.childScopeId);
  });

  const frames = branches.map((branch) => {
    const materialized = materializeRecursiveScopedFrameV1({
      frameKind: input.frameKind,
      definition: {
        rootDefinitionId: input.rootDefinitionId,
        rootDefinitionDigest: input.rootDefinitionDigest,
        scopedDefinitionId: branch.scopedDefinitionId,
        scopedDefinitionDigest: branch.scopedDefinitionDigest,
      },
      ownerPath: input.ownerPath,
      childScopeId: branch.childScopeId,
      ownership: ownershipFor(input, branch),
      nodeInventory: branch.nodeInventory,
      continuation: {
        ...branch.continuation,
        edgeOrdinal: branch.branchOrdinal,
      },
      parentCommitIdentity: input.parentCommitIdentity,
      checkpoint: branch.checkpoint,
    });

    return deserializeRecursiveScopedFrameV1(
      serializeRecursiveScopedFrameV1(materialized),
      recursiveScopedFrameBindingV1(materialized),
    );
  });

  return {
    frameKind: input.frameKind,
    rootDefinitionId: input.rootDefinitionId,
    rootDefinitionDigest: input.rootDefinitionDigest,
    ownerPath: [...input.ownerPath],
    ownerNodeId: input.ownerNodeId,
    parentCommitIdentity: input.parentCommitIdentity,
    frames,
  };
}

import type {
  RecursiveScopedCommitInputV1,
  RecursiveScopedCommitV1,
  RecursiveScopedContinuationV1,
  RecursiveScopedFrameV1,
  RecursiveScopedJsonObject,
  RecursiveScopedJsonValue,
  RecursiveScopedMergeV1,
  RecursiveScopedSha256Digest,
} from "@dzupagent/runtime-contracts/recursive-scope";

import type {
  RecursiveBranchBlockedReasonV1,
  RecursiveBranchCorruptReasonV1,
  RecursiveDeferredControlV1,
  RecursiveScopedDurablePortV1,
} from "./types.js";
import type {
  RecursiveControlCoordinatorV1,
  RecursiveControlDecisionV1,
  RecursiveControlIntentV1,
  RecursiveControlPolicyV1,
} from "./control-types.js";

export interface RecursiveForEachItemEconomicsBindingV1 {
  readonly chargeKey: string;
  readonly reservationIdentity: RecursiveScopedSha256Digest;
  readonly hardCeilingMicros: number;
  readonly currency: string;
}

export interface RecursiveForEachItemDefinitionV1 {
  readonly itemOrdinal: number;
  readonly itemIdentity: RecursiveScopedSha256Digest;
  readonly itemValue: RecursiveScopedJsonValue;
  readonly childScopeId: string;
  readonly scopedDefinitionId: string;
  readonly scopedDefinitionDigest: RecursiveScopedSha256Digest;
  readonly nodeInventory: readonly string[];
  readonly continuation: Omit<RecursiveScopedContinuationV1, "edgeOrdinal">;
  readonly checkpoint: RecursiveScopedJsonObject;
  readonly economics?: RecursiveForEachItemEconomicsBindingV1;
}

export interface RecursiveForEachItemPlanInputV1 {
  readonly rootDefinitionId: string;
  readonly rootDefinitionDigest: RecursiveScopedSha256Digest;
  readonly ownerPath: readonly string[];
  readonly forEachNodeId: string;
  readonly parentCommitIdentity: RecursiveScopedSha256Digest;
  readonly collectionSourceDigest: RecursiveScopedSha256Digest;
  readonly maxConcurrency: number;
  readonly items: readonly RecursiveForEachItemDefinitionV1[];
}

export interface RecursiveForEachPlannedItemV1 {
  readonly itemOrdinal: number;
  readonly itemIdentity: RecursiveScopedSha256Digest;
  readonly itemValue: RecursiveScopedJsonValue;
  readonly itemValueDigest: RecursiveScopedSha256Digest;
  readonly economicsDigest: RecursiveScopedSha256Digest;
  readonly frame: RecursiveScopedFrameV1;
  readonly economics?: RecursiveForEachItemEconomicsBindingV1;
}

export interface RecursiveForEachItemPlanV1 {
  readonly rootDefinitionId: string;
  readonly rootDefinitionDigest: RecursiveScopedSha256Digest;
  readonly ownerPath: readonly string[];
  readonly forEachNodeId: string;
  readonly parentCommitIdentity: RecursiveScopedSha256Digest;
  readonly collectionSourceDigest: RecursiveScopedSha256Digest;
  readonly maxConcurrency: number;
  /** Strictly ordered by the definition-owned item ordinal. */
  readonly items: readonly RecursiveForEachPlannedItemV1[];
  readonly frames: readonly RecursiveScopedFrameV1[];
}

export type RecursiveForEachItemCommitPayloadV1 = Omit<
  RecursiveScopedCommitInputV1,
  "frame"
>;

export type RecursiveForEachItemExecutionV1 =
  | {
      readonly status: "completed";
      readonly orderedResult: RecursiveScopedJsonValue;
      readonly commit: RecursiveForEachItemCommitPayloadV1;
    }
  | {
      readonly status: "suspended-for-later";
      readonly control: RecursiveDeferredControlV1;
      readonly checkpoint?: RecursiveScopedJsonObject;
      /** W3-C3 definition-bound evidence. Omission retains the W3-C2 boundary. */
      readonly intent?: RecursiveControlIntentV1;
      readonly commit?: RecursiveForEachItemCommitPayloadV1;
    }
  | {
      readonly status: "blocked";
      readonly reason: "child-policy-blocked" | "invalid-child-state";
    };

export interface RecursiveForEachItemExecutionInputV1 {
  readonly frame: RecursiveScopedFrameV1;
  readonly itemValue: RecursiveScopedJsonValue;
  readonly checkpoint: RecursiveScopedJsonObject;
  readonly persistCheckpoint: (
    checkpoint: RecursiveScopedJsonObject,
  ) => Promise<RecursiveScopedFrameV1>;
}

export interface RecursiveForEachItemExecutorV1 {
  execute(
    input: RecursiveForEachItemExecutionInputV1,
  ): Promise<RecursiveForEachItemExecutionV1>;
}

export type RecursiveForEachItemExecutorFactoryV1 = (
  input: Readonly<{
    frame: RecursiveScopedFrameV1;
    itemValue: RecursiveScopedJsonValue;
    checkpoint: RecursiveScopedJsonObject;
  }>,
) => RecursiveForEachItemExecutorV1;

export interface RecursiveForEachItemDispatcherDepsV1 {
  readonly durable: RecursiveScopedDurablePortV1;
  readonly createItemExecutor: RecursiveForEachItemExecutorFactoryV1;
  readonly control?: RecursiveControlCoordinatorV1;
}

export interface RecursiveForEachItemDispatchInputV1 {
  readonly mode: "initial" | "restart";
  readonly plan: RecursiveForEachItemPlanInputV1;
  readonly controlPolicy?: RecursiveControlPolicyV1;
}

export interface RecursiveForEachItemDispatchProgressV1 {
  readonly dispatchedChildScopeIds: readonly string[];
  readonly restoredChildScopeIds: readonly string[];
  readonly skippedBodyCompleteChildScopeIds: readonly string[];
  readonly skippedCommittedChildScopeIds: readonly string[];
}

export type RecursiveForEachItemBlockedReasonV1 =
  | RecursiveBranchBlockedReasonV1
  | "item-economics-policy-blocked";

export type RecursiveForEachItemCorruptReasonV1 =
  | RecursiveBranchCorruptReasonV1
  | "item-checkpoint-corrupt"
  | "item-checkpoint-drift"
  | "body-complete-commit-drift";

export type RecursiveForEachItemDispatchOutcomeV1 =
  | {
      readonly status: "completed";
      readonly progress: RecursiveForEachItemDispatchProgressV1;
      readonly orderedResults: readonly RecursiveScopedJsonValue[];
      readonly commits: readonly RecursiveScopedCommitV1[];
      readonly merge: RecursiveScopedMergeV1;
    }
  | {
      readonly status: "retryable-before-dispatch";
      readonly progress: RecursiveForEachItemDispatchProgressV1;
      readonly childScopeId: string;
      readonly reason: "frame-acknowledgement-lost-without-evidence";
    }
  | {
      readonly status: "suspended-for-later";
      readonly progress: RecursiveForEachItemDispatchProgressV1;
      readonly childScopeId: string;
      readonly control: RecursiveDeferredControlV1;
      readonly decision?: RecursiveControlDecisionV1;
    }
  | {
      readonly status: "blocked";
      readonly progress: RecursiveForEachItemDispatchProgressV1;
      readonly childScopeId: string | undefined;
      readonly reason: RecursiveForEachItemBlockedReasonV1;
    }
  | {
      readonly status: "corrupt";
      readonly progress: RecursiveForEachItemDispatchProgressV1;
      readonly childScopeId: string | undefined;
      readonly reason: RecursiveForEachItemCorruptReasonV1;
    };

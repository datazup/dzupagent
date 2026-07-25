import type { PrimitivePolicyLimits } from "@dzupagent/flow-dsl/v2-policy-narrowing";

import type { V2InactiveLocalTargetQualificationRequest } from "./contracts.js";

export const V2_INACTIVE_LOCAL_HOST_ID =
  "dzupagent.local-v2-multi-step-host@1" as const;

export type V2InactiveLocalHandlerResult =
  | {
      readonly status: "success";
      readonly outputs: Readonly<Record<string, unknown>>;
      readonly durationMs: number;
      readonly costCents: number;
    }
  | {
      readonly status: "error";
      readonly code: string;
      readonly durationMs: number;
      readonly costCents: number;
    };

export interface V2InactiveLocalHandlerInvocation {
  readonly runId: string;
  readonly stepIndex: number;
  readonly stepId: string;
  readonly authoredPath: string;
  readonly attempt: number;
  readonly input: Readonly<Record<string, unknown>>;
  readonly state: Readonly<Record<string, unknown>>;
  readonly authority: {
    readonly providerDispatch: false;
    readonly externalStateMutation: false;
    readonly deployment: false;
    readonly activation: false;
  };
}

export interface V2InactiveLocalHandlerBinding {
  readonly ref: `primitive://${string}@${string}`;
  readonly semanticHash: `sha256:${string}`;
  /**
   * A pure local handler. The host passes frozen snapshots and accepts only a
   * deterministic JSON result. External effects are outside this contract.
   */
  readonly invoke: (
    invocation: V2InactiveLocalHandlerInvocation
  ) => Promise<V2InactiveLocalHandlerResult> | V2InactiveLocalHandlerResult;
}

export interface V2InactiveLocalHostAttemptReceipt {
  readonly attempt: number;
  readonly status: "success" | "retryable-error" | "terminal-error";
  readonly durationMs: number;
  readonly costCents: number;
  readonly cumulativeDurationMs: number;
  readonly cumulativeCostCents: number;
  readonly errorCode?: string;
  readonly outputSha256?: `sha256:${string}`;
  readonly scheduledBackoffMs?: number;
  readonly rawProviderContent: "excluded";
}

export type V2InactiveLocalHostStepStatus =
  | "completed"
  | "skipped"
  | "caught-continue"
  | "caught-complete"
  | "failed"
  | "cancelled"
  | "approval-required";

export interface V2InactiveLocalHostStepReceipt {
  readonly index: number;
  readonly id: string;
  readonly authoredPath: string;
  readonly primitiveRef: `primitive://${string}@${string}`;
  readonly primitiveSemanticHash: `sha256:${string}`;
  readonly status: V2InactiveLocalHostStepStatus;
  readonly condition: {
    readonly value: boolean;
    readonly resolvedReferences: readonly string[];
  };
  readonly effectivePolicy: PrimitivePolicyLimits;
  readonly attempts: readonly V2InactiveLocalHostAttemptReceipt[];
  readonly stateBeforeSha256: `sha256:${string}`;
  readonly stateAfterSha256: `sha256:${string}`;
  readonly terminal?: {
    readonly code: string;
    readonly catchAction?: "continue" | "complete" | "fail";
  };
  readonly stepSha256: `sha256:${string}`;
}

export type V2InactiveLocalHostStatus =
  | "completed"
  | "suspended"
  | "cancelled"
  | "approval-required"
  | "failed";

export interface V2InactiveLocalHostCheckpoint {
  readonly schema: "dzupagent.v2InactiveLocalHostCheckpoint/v1";
  readonly target: typeof V2_INACTIVE_LOCAL_HOST_ID;
  readonly runId: string;
  readonly sourceSha256: `sha256:${string}`;
  readonly qualificationSha256: `sha256:${string}`;
  readonly planSha256: `sha256:${string}`;
  readonly revision: number;
  readonly status: V2InactiveLocalHostStatus | "running";
  readonly nextStepIndex: number;
  readonly state: Readonly<Record<string, unknown>>;
  readonly steps: readonly V2InactiveLocalHostStepReceipt[];
  readonly previousCheckpointSha256: `sha256:${string}` | null;
  readonly checkpointSha256: `sha256:${string}`;
}

export type V2InactiveLocalHostClaimResult =
  | {
      readonly ok: true;
      readonly leaseToken: string;
      readonly checkpoint: V2InactiveLocalHostCheckpoint | null;
    }
  | { readonly ok: false; readonly reason: "already-claimed" };

export interface V2InactiveLocalHostCheckpointStore {
  claim(input: {
    readonly runId: string;
    readonly ownerId: string;
  }): Promise<V2InactiveLocalHostClaimResult>;
  commit(input: {
    readonly runId: string;
    readonly leaseToken: string;
    readonly expectedPreviousSha256: `sha256:${string}` | null;
    readonly checkpoint: V2InactiveLocalHostCheckpoint;
  }): Promise<boolean>;
  release(input: {
    readonly runId: string;
    readonly leaseToken: string;
  }): Promise<boolean>;
}

export interface V2InactiveLocalHostRequest
  extends V2InactiveLocalTargetQualificationRequest {
  readonly runId: string;
  readonly ownerId: string;
  readonly handlers: readonly V2InactiveLocalHandlerBinding[];
  readonly checkpointStore: V2InactiveLocalHostCheckpointStore;
  readonly initialState?: Readonly<Record<string, unknown>>;
  readonly inheritedPolicy?: PrimitivePolicyLimits;
  readonly cancelBeforeStep?: number;
  readonly cancellation?: { readonly aborted: boolean };
  /** Checkpoint and release after this many newly processed steps. */
  readonly maxStepsThisRun?: number;
}

export interface V2InactiveLocalHostReceipt {
  readonly schema: "dzupagent.v2InactiveLocalHost/v1";
  readonly target: typeof V2_INACTIVE_LOCAL_HOST_ID;
  readonly runId: string;
  readonly status: V2InactiveLocalHostStatus;
  readonly sourceSha256: `sha256:${string}`;
  readonly qualificationSha256: `sha256:${string}`;
  readonly planSha256: `sha256:${string}`;
  readonly checkpointSha256: `sha256:${string}`;
  readonly state: Readonly<Record<string, unknown>>;
  readonly steps: readonly V2InactiveLocalHostStepReceipt[];
  readonly hostSha256: `sha256:${string}`;
  readonly authority: {
    readonly localHandlerInvocation: true;
    readonly localCheckpointMutation: true;
    readonly providerDispatch: false;
    readonly externalStateMutation: false;
    readonly externalContinuation: false;
    readonly deployment: false;
    readonly promotion: false;
    readonly activation: false;
  };
}

export type V2InactiveLocalHostErrorCode =
  | "V2_LOCAL_HOST_REQUEST_INVALID"
  | "V2_LOCAL_HOST_QUALIFICATION_FAILED"
  | "V2_LOCAL_HOST_PLAN_INVALID"
  | "V2_LOCAL_HOST_HANDLER_BINDING_INVALID"
  | "V2_LOCAL_HOST_HANDLER_RESULT_INVALID"
  | "V2_LOCAL_HOST_OUTPUT_INVALID"
  | "V2_LOCAL_HOST_CHECKPOINT_DRIFT"
  | "V2_LOCAL_HOST_CONCURRENT_RUN";

export interface V2InactiveLocalHostError {
  readonly code: V2InactiveLocalHostErrorCode;
  readonly message: string;
  readonly path: string;
  readonly causes?: readonly string[];
}

export type V2InactiveLocalHostResult =
  | { readonly ok: true; readonly receipt: V2InactiveLocalHostReceipt }
  | { readonly ok: false; readonly errors: readonly V2InactiveLocalHostError[] };

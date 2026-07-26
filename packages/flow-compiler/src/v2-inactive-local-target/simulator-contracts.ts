import type { PrimitivePolicyLimits } from "@dzupagent/flow-dsl/v2-policy-narrowing";

import type { V2InactiveLocalTargetQualificationRequest } from "./contracts.js";

export const V2_INACTIVE_LOCAL_SIMULATOR_ID =
  "dzupagent.local-v2-simulator@1" as const;

export type V2InactiveLocalScriptedAttempt =
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

export interface V2InactiveLocalSimulationCheckpoint {
  readonly schema: "dzupagent.v2InactiveLocalSimulationCheckpoint/v1";
  readonly target: typeof V2_INACTIVE_LOCAL_SIMULATOR_ID;
  readonly sourceSha256: `sha256:${string}`;
  readonly qualificationSha256: `sha256:${string}`;
  readonly planSha256: `sha256:${string}`;
  readonly nextAttempt: number;
  readonly cumulativeDurationMs: number;
  readonly cumulativeCostCents: number;
  readonly state: Readonly<Record<string, unknown>>;
  readonly attempts: readonly V2InactiveLocalAttemptReceipt[];
  readonly checkpointSha256: `sha256:${string}`;
}

export interface V2InactiveLocalSimulationRequest
  extends V2InactiveLocalTargetQualificationRequest {
  /** Scripted local outcomes. No runtime handler or provider is invoked. */
  readonly attempts: readonly V2InactiveLocalScriptedAttempt[];
  readonly initialState?: Readonly<Record<string, unknown>>;
  readonly inheritedPolicy?: PrimitivePolicyLimits;
  /** Deterministic cooperative cancellation boundary, one-based. */
  readonly cancelBeforeAttempt?: number;
  /** Stop and checkpoint after this many attempts in the current process. */
  readonly maxAttemptsThisRun?: number;
  readonly resumeFrom?: V2InactiveLocalSimulationCheckpoint;
  readonly resumeSha256?: `sha256:${string}`;
}

export interface V2InactiveLocalAttemptReceipt {
  readonly attempt: number;
  readonly attemptIdentity: "same-invocation";
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

export type V2InactiveLocalSimulationStatus =
  | "completed"
  | "skipped"
  | "caught-continue"
  | "caught-complete"
  | "failed"
  | "cancelled"
  | "approval-required"
  | "suspended";

export interface V2InactiveLocalSimulationReceipt {
  readonly schema: "dzupagent.v2InactiveLocalSimulation/v1";
  readonly target: typeof V2_INACTIVE_LOCAL_SIMULATOR_ID;
  readonly status: V2InactiveLocalSimulationStatus;
  readonly sourceSha256: `sha256:${string}`;
  readonly qualificationSha256: `sha256:${string}`;
  readonly planSha256: `sha256:${string}`;
  readonly simulationSha256: `sha256:${string}`;
  readonly primitive: {
    readonly authoredPath: string;
    readonly ref: `primitive://${string}@${string}`;
    readonly semanticHash: `sha256:${string}`;
  };
  readonly condition: {
    readonly value: boolean;
    readonly resolvedReferences: readonly string[];
  };
  readonly effectivePolicy: PrimitivePolicyLimits;
  readonly attempts: readonly V2InactiveLocalAttemptReceipt[];
  readonly stateBeforeSha256: `sha256:${string}`;
  readonly stateAfterSha256: `sha256:${string}`;
  readonly state: Readonly<Record<string, unknown>>;
  readonly terminal?: {
    readonly code: string;
    readonly catchAction?: "continue" | "complete" | "fail";
  };
  readonly checkpoint?: V2InactiveLocalSimulationCheckpoint;
  readonly authority: {
    readonly scriptedLocalExecution: true;
    readonly runtimeHandlerInvocation: false;
    readonly providerDispatch: false;
    readonly externalStateMutation: false;
    readonly continuation: false;
    readonly deployment: false;
    readonly promotion: false;
    readonly activation: false;
  };
}

export type V2InactiveLocalSimulationErrorCode =
  | "V2_SIMULATOR_REQUEST_INVALID"
  | "V2_SIMULATOR_QUALIFICATION_FAILED"
  | "V2_SIMULATOR_SINGLE_STEP_REQUIRED"
  | "V2_SIMULATOR_ATTEMPT_PLAN_INVALID"
  | "V2_SIMULATOR_RESUME_INVALID"
  | "V2_SIMULATOR_OUTPUT_INVALID";

export interface V2InactiveLocalSimulationError {
  readonly code: V2InactiveLocalSimulationErrorCode;
  readonly message: string;
  readonly path: string;
  readonly causes?: readonly string[];
}

export type V2InactiveLocalSimulationResult =
  | {
      readonly ok: true;
      readonly receipt: V2InactiveLocalSimulationReceipt;
    }
  | {
      readonly ok: false;
      readonly errors: readonly V2InactiveLocalSimulationError[];
    };

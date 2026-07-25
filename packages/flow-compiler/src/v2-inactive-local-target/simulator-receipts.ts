import { deepFreeze, digest, stableStringify } from "./evidence.js";
import type {
  MutableSimulationProgress,
  SimulationContext,
  SimulationTerminalResult,
} from "./simulator-internal.js";
import {
  V2_INACTIVE_LOCAL_SIMULATOR_ID,
  type V2InactiveLocalSimulationCheckpoint,
  type V2InactiveLocalSimulationError,
  type V2InactiveLocalSimulationReceipt,
  type V2InactiveLocalSimulationResult,
  type V2InactiveLocalSimulationStatus,
} from "./simulator-contracts.js";

export type RestoreSimulationProgressResult =
  | { readonly ok: true; readonly progress: MutableSimulationProgress }
  | { readonly ok: false; readonly error: V2InactiveLocalSimulationError };

export function restoreSimulationProgress(
  context: SimulationContext
): RestoreSimulationProgressResult {
  const checkpoint = context.request.resumeFrom;
  if (checkpoint === undefined) {
    return {
      ok: true,
      progress: {
        state: cloneRecord(context.stateBefore),
        attempts: [],
        nextAttempt: 1,
        cumulativeDurationMs: 0,
        cumulativeCostCents: 0,
      },
    };
  }
  const actualSha256 = digest(stableStringify(checkpointCore(checkpoint)));
  const totals = validateAttemptChain(checkpoint);
  const valid =
    context.request.resumeSha256 === checkpoint.checkpointSha256 &&
    actualSha256 === checkpoint.checkpointSha256 &&
    checkpoint.target === V2_INACTIVE_LOCAL_SIMULATOR_ID &&
    checkpoint.sourceSha256 === context.sourceSha256 &&
    checkpoint.qualificationSha256 === context.qualificationSha256 &&
    checkpoint.planSha256 === context.planSha256 &&
    checkpoint.nextAttempt === checkpoint.attempts.length + 1 &&
    checkpoint.nextAttempt <= context.retry.maxAttempts &&
    checkpoint.nextAttempt <= context.request.attempts.length &&
    totals.valid &&
    checkpoint.cumulativeDurationMs === totals.durationMs &&
    checkpoint.cumulativeCostCents === totals.costCents &&
    isJsonRecord(checkpoint.state);
  if (!valid) {
    return {
      ok: false,
      error: {
        code: "V2_SIMULATOR_RESUME_INVALID",
        message:
          "checkpoint digest, source, qualification, plan, state, or cumulative attempt chain drifted",
        path: "resumeFrom",
      },
    };
  }
  return {
    ok: true,
    progress: {
      state: cloneRecord(checkpoint.state),
      attempts: checkpoint.attempts.map((attempt) => ({ ...attempt })),
      nextAttempt: checkpoint.nextAttempt,
      cumulativeDurationMs: checkpoint.cumulativeDurationMs,
      cumulativeCostCents: checkpoint.cumulativeCostCents,
    },
  };
}

export function suspendSimulation(
  context: SimulationContext,
  progress: MutableSimulationProgress
): V2InactiveLocalSimulationResult {
  const core = {
    schema: "dzupagent.v2InactiveLocalSimulationCheckpoint/v1" as const,
    target: V2_INACTIVE_LOCAL_SIMULATOR_ID,
    sourceSha256: context.sourceSha256,
    qualificationSha256: context.qualificationSha256,
    planSha256: context.planSha256,
    nextAttempt: progress.nextAttempt,
    cumulativeDurationMs: progress.cumulativeDurationMs,
    cumulativeCostCents: progress.cumulativeCostCents,
    state: deepFreeze(cloneRecord(progress.state)),
    attempts: deepFreeze(progress.attempts.map((attempt) => ({ ...attempt }))),
  };
  const checkpoint = deepFreeze({
    ...core,
    checkpointSha256: digest(stableStringify(core)),
  });
  return completeSimulation(
    context,
    progress,
    "suspended",
    undefined,
    checkpoint
  );
}

export function completeSimulation(
  context: SimulationContext,
  progress: MutableSimulationProgress,
  status: V2InactiveLocalSimulationStatus,
  terminalResult?: SimulationTerminalResult,
  checkpoint?: V2InactiveLocalSimulationCheckpoint
): V2InactiveLocalSimulationResult {
  const state = deepFreeze(cloneRecord(progress.state));
  const receiptCore = {
    schema: "dzupagent.v2InactiveLocalSimulation/v1" as const,
    target: V2_INACTIVE_LOCAL_SIMULATOR_ID,
    status,
    sourceSha256: context.sourceSha256,
    qualificationSha256: context.qualificationSha256,
    planSha256: context.planSha256,
    primitive: Object.freeze({
      authoredPath: context.authoredPath,
      ref: context.primitive.ref,
      semanticHash: context.primitive.compatibility.semanticHash,
    }),
    condition: deepFreeze({ ...context.condition }),
    effectivePolicy: deepFreeze({ ...context.policy }),
    attempts: deepFreeze(progress.attempts.map((attempt) => ({ ...attempt }))),
    stateBeforeSha256: digest(stableStringify(context.stateBefore)),
    stateAfterSha256: digest(stableStringify(state)),
    state,
    ...(terminalResult === undefined
      ? {}
      : { terminal: deepFreeze({ ...terminalResult }) }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
    authority: Object.freeze({
      scriptedLocalExecution: true as const,
      runtimeHandlerInvocation: false as const,
      providerDispatch: false as const,
      externalStateMutation: false as const,
      continuation: false as const,
      deployment: false as const,
      promotion: false as const,
      activation: false as const,
    }),
  };
  const receipt: V2InactiveLocalSimulationReceipt = deepFreeze({
    ...receiptCore,
    simulationSha256: digest(stableStringify(receiptCore)),
  });
  return { ok: true, receipt };
}

export function simulationFailure(
  error: V2InactiveLocalSimulationError
): V2InactiveLocalSimulationResult {
  return { ok: false, errors: deepFreeze([error]) };
}

function validateAttemptChain(
  checkpoint: V2InactiveLocalSimulationCheckpoint
): {
  readonly valid: boolean;
  readonly durationMs: number;
  readonly costCents: number;
} {
  let durationMs = 0;
  let costCents = 0;
  let valid = true;
  checkpoint.attempts.forEach((attempt, index) => {
    durationMs += attempt.durationMs + (attempt.scheduledBackoffMs ?? 0);
    costCents += attempt.costCents;
    if (
      attempt.attempt !== index + 1 ||
      attempt.status !== "retryable-error" ||
      attempt.cumulativeDurationMs !== durationMs ||
      attempt.cumulativeCostCents !== costCents
    ) {
      valid = false;
    }
  });
  return { valid, durationMs, costCents };
}

function checkpointCore(checkpoint: V2InactiveLocalSimulationCheckpoint) {
  const { checkpointSha256: _checkpointSha256, ...core } = checkpoint;
  return core;
}

function cloneRecord(
  value: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonRecord(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

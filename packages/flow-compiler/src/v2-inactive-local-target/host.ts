import { deepFreeze, digest, stableStringify } from "./evidence.js";
import type {
  V2InactiveLocalHostCheckpoint,
  V2InactiveLocalHostClaimResult,
  V2InactiveLocalHostError,
  V2InactiveLocalHostReceipt,
  V2InactiveLocalHostRequest,
  V2InactiveLocalHostResult,
  V2InactiveLocalHostStatus,
  V2InactiveLocalHostStepReceipt,
} from "./host-contracts.js";
import { V2_INACTIVE_LOCAL_HOST_ID } from "./host-contracts.js";
import {
  prepareV2InactiveLocalHost,
  type V2InactiveLocalHostContext,
} from "./host-plan.js";
import { executeV2InactiveLocalKernelStep } from "./host-kernel.js";

interface MutableHostProgress {
  state: Record<string, unknown>;
  stepOutputs: Record<string, unknown>;
  branchDecisions: Record<string, boolean>;
  completionResult?: unknown;
  steps: V2InactiveLocalHostStepReceipt[];
  nextStepIndex: number;
  revision: number;
  previousCheckpointSha256: `sha256:${string}` | null;
}

/**
 * Execute a strictly qualified, top-level multi-step V2 flow through exact
 * pure-local handlers. Every processed step is committed through the supplied
 * CAS store before the next handler can run. The host has no provider,
 * external mutation, deployment, promotion, or activation authority.
 */
export async function runV2InactiveLocalHost(
  input: V2InactiveLocalHostRequest
): Promise<V2InactiveLocalHostResult> {
  const prepared = await prepareV2InactiveLocalHost(input);
  if (!prepared.ok) return failure(prepared.error);
  const { context } = prepared;
  let claim: V2InactiveLocalHostClaimResult;
  try {
    claim = await input.checkpointStore.claim({
      runId: input.runId,
      ownerId: input.ownerId,
    });
  } catch (error) {
    return checkpointStoreFailure("claim", error);
  }
  if (!claim.ok) {
    return failure({
      code: "V2_LOCAL_HOST_CONCURRENT_RUN",
      message: "runId already has an active local-host claim",
      path: "runId",
    });
  }

  let result: V2InactiveLocalHostResult;
  try {
    const restored = restoreProgress(context, claim.checkpoint);
    if (!restored.ok) {
      result = failure(restored.error);
    } else if (
      claim.checkpoint !== null &&
      claim.checkpoint.status !== "running" &&
      claim.checkpoint.status !== "suspended"
    ) {
      result = successReceipt(context, claim.checkpoint);
    } else {
      result = await executeHost(context, restored.progress, claim.leaseToken);
    }
  } catch (error) {
    result = checkpointStoreFailure("commit", error);
  }
  try {
    const released = await input.checkpointStore.release({
      runId: input.runId,
      leaseToken: claim.leaseToken,
    });
    return released ? result : checkpointStoreFailure("release");
  } catch (error) {
    return checkpointStoreFailure("release", error);
  }
}

async function executeHost(
  context: V2InactiveLocalHostContext,
  progress: MutableHostProgress,
  leaseToken: string
): Promise<V2InactiveLocalHostResult> {
  let processed = 0;
  while (progress.nextStepIndex < context.steps.length) {
    if (
      context.request.cancellation?.aborted === true ||
      context.request.cancelBeforeStep === progress.nextStepIndex + 1
    ) {
      return commitTerminal(context, progress, leaseToken, "cancelled");
    }
    if (processed > 0 && processed === context.request.maxStepsThisRun) {
      return commitTerminal(context, progress, leaseToken, "suspended");
    }

    const step = context.steps[progress.nextStepIndex]!;
    const executed = await executeV2InactiveLocalKernelStep(context, step, {
      state: progress.state,
      stepOutputs: progress.stepOutputs,
      branchDecisions: progress.branchDecisions,
    });
    if (!executed.ok) return failure(executed.error);
    progress.state = cloneRecord(executed.state);
    progress.stepOutputs = cloneRecord(executed.stepOutputs);
    progress.branchDecisions = { ...executed.branchDecisions };
    if ("completionResult" in executed) {
      progress.completionResult = structuredClone(executed.completionResult);
    }
    progress.steps.push(executed.receipt);
    progress.nextStepIndex += 1;
    processed += 1;

    const status = stepTerminalStatus(executed.receipt, executed.terminal);
    const exhausted = progress.nextStepIndex === context.steps.length;
    const shouldSuspend =
      !executed.terminal &&
      !exhausted &&
      processed === context.request.maxStepsThisRun;
    const checkpointStatus =
      status ??
      (exhausted ? "completed" : shouldSuspend ? "suspended" : "running");
    const committed = await commitCheckpoint(
      context,
      progress,
      leaseToken,
      checkpointStatus
    );
    if (!committed.ok) return committed;
    if (checkpointStatus !== "running") {
      return successReceipt(context, committed.checkpoint);
    }
  }
  return commitTerminal(context, progress, leaseToken, "completed");
}

function stepTerminalStatus(
  receipt: V2InactiveLocalHostStepReceipt,
  terminal: boolean
): V2InactiveLocalHostStatus | undefined {
  if (!terminal) return undefined;
  switch (receipt.status) {
    case "caught-complete":
    case "complete":
      return "completed";
    case "approval-required":
      return "approval-required";
    case "cancelled":
      return "cancelled";
    default:
      return "failed";
  }
}

async function commitTerminal(
  context: V2InactiveLocalHostContext,
  progress: MutableHostProgress,
  leaseToken: string,
  status: V2InactiveLocalHostStatus
): Promise<V2InactiveLocalHostResult> {
  const committed = await commitCheckpoint(
    context,
    progress,
    leaseToken,
    status
  );
  return committed.ok
    ? successReceipt(context, committed.checkpoint)
    : committed;
}

async function commitCheckpoint(
  context: V2InactiveLocalHostContext,
  progress: MutableHostProgress,
  leaseToken: string,
  status: V2InactiveLocalHostCheckpoint["status"]
): Promise<
  | { readonly ok: true; readonly checkpoint: V2InactiveLocalHostCheckpoint }
  | { readonly ok: false; readonly errors: readonly V2InactiveLocalHostError[] }
> {
  const core = {
    schema: "dzupagent.v2InactiveLocalHostCheckpoint/v1" as const,
    target: V2_INACTIVE_LOCAL_HOST_ID,
    runId: context.request.runId,
    sourceSha256: context.sourceSha256,
    qualificationSha256: context.qualificationSha256,
    planSha256: context.planSha256,
    revision: progress.revision + 1,
    status,
    nextStepIndex: progress.nextStepIndex,
    state: deepFreeze(cloneRecord(progress.state)),
    stepOutputs: deepFreeze(cloneRecord(progress.stepOutputs)),
    branchDecisions: deepFreeze({ ...progress.branchDecisions }),
    ...(progress.completionResult === undefined
      ? {}
      : { completionResult: deepFreeze(structuredClone(progress.completionResult)) }),
    steps: deepFreeze(progress.steps.map((step) => ({ ...step }))),
    previousCheckpointSha256: progress.previousCheckpointSha256,
  };
  const checkpoint = deepFreeze({
    ...core,
    checkpointSha256: digest(stableStringify(core)),
  });
  const committed = await context.request.checkpointStore.commit({
    runId: context.request.runId,
    leaseToken,
    expectedPreviousSha256: progress.previousCheckpointSha256,
    checkpoint,
  });
  if (!committed) {
    return {
      ok: false,
      errors: deepFreeze([
        {
          code: "V2_LOCAL_HOST_CHECKPOINT_DRIFT" as const,
          message:
            "atomic checkpoint commit rejected the lease, revision, or previous digest",
          path: "checkpointStore",
        },
      ]),
    };
  }
  progress.revision = checkpoint.revision;
  progress.previousCheckpointSha256 = checkpoint.checkpointSha256;
  return { ok: true, checkpoint };
}

function restoreProgress(
  context: V2InactiveLocalHostContext,
  checkpoint: V2InactiveLocalHostCheckpoint | null
):
  | { readonly ok: true; readonly progress: MutableHostProgress }
  | { readonly ok: false; readonly error: V2InactiveLocalHostError } {
  if (checkpoint === null) {
    return {
      ok: true,
      progress: {
        state: cloneRecord(context.stateBefore),
        stepOutputs: {},
        branchDecisions: {},
        steps: [],
        nextStepIndex: 0,
        revision: 0,
        previousCheckpointSha256: null,
      },
    };
  }
  const { checkpointSha256: _checkpointSha256, ...core } = checkpoint;
  const valid =
    digest(stableStringify(core)) === checkpoint.checkpointSha256 &&
    checkpoint.target === V2_INACTIVE_LOCAL_HOST_ID &&
    checkpoint.runId === context.request.runId &&
    checkpoint.sourceSha256 === context.sourceSha256 &&
    checkpoint.qualificationSha256 === context.qualificationSha256 &&
    checkpoint.planSha256 === context.planSha256 &&
    Number.isInteger(checkpoint.revision) &&
    checkpoint.revision >= 1 &&
    checkpoint.nextStepIndex === checkpoint.steps.length &&
    checkpoint.nextStepIndex <= context.steps.length &&
    isJsonRecord(checkpoint.state) &&
    isJsonRecord(checkpoint.stepOutputs) &&
    isBooleanRecord(checkpoint.branchDecisions) &&
    validateCheckpointProjection(context, checkpoint) &&
    checkpoint.steps.every(
      (step, index) =>
        step.index === index &&
        step.authoredPath === context.steps[index]?.authoredPath &&
        step.kind === context.steps[index]?.kind &&
        step.use === context.steps[index]?.use &&
        (context.steps[index]?.kind !== "primitive" ||
          (step.primitiveRef === context.steps[index]?.primitive.ref &&
            step.primitiveSemanticHash ===
              context.steps[index]?.primitive.compatibility.semanticHash))
    );
  if (!valid) {
    return {
      ok: false,
      error: {
        code: "V2_LOCAL_HOST_CHECKPOINT_DRIFT",
        message:
          "checkpoint digest, run, source, qualification, plan, state, or step chain drifted",
        path: "checkpointStore",
      },
    };
  }
  return {
    ok: true,
    progress: {
      state: cloneRecord(checkpoint.state),
      stepOutputs: cloneRecord(checkpoint.stepOutputs),
      branchDecisions: { ...checkpoint.branchDecisions },
      ...(checkpoint.completionResult === undefined
        ? {}
        : { completionResult: structuredClone(checkpoint.completionResult) }),
      steps: checkpoint.steps.map((step) => ({ ...step })),
      nextStepIndex: checkpoint.nextStepIndex,
      revision: checkpoint.revision,
      previousCheckpointSha256: checkpoint.checkpointSha256,
    },
  };
}

function validateCheckpointProjection(
  context: V2InactiveLocalHostContext,
  checkpoint: V2InactiveLocalHostCheckpoint
): boolean {
  let previousStateSha256 = digest(stableStringify(context.stateBefore));
  const decisions: Record<string, boolean> = {};
  const outputIds = new Set<string>();
  let completionResultSha256: `sha256:${string}` | undefined;
  for (const [index, receipt] of checkpoint.steps.entries()) {
    const { stepSha256: _stepSha256, ...core } = receipt;
    if (
      digest(stableStringify(core)) !== receipt.stepSha256 ||
      receipt.stateBeforeSha256 !== previousStateSha256
    ) return false;
    previousStateSha256 = receipt.stateAfterSha256;
    const plan = context.steps[index];
    if (plan === undefined) return false;
    const branchActive = plan.branchRequirements.every(
      (required) => decisions[required.id] === required.outcome
    );
    if (
      (branchActive && receipt.status === "skipped-branch") ||
      (!branchActive && receipt.status !== "skipped-branch")
    ) return false;
    if (receipt.kind === "branch" && receipt.status !== "skipped-branch") {
      if (
        receipt.branchDecision === undefined ||
        (receipt.status !== "branch-then" && receipt.status !== "branch-else") ||
        receipt.branchDecision !== (receipt.status === "branch-then")
      ) return false;
      decisions[receipt.id] = receipt.branchDecision;
    }
    if (receipt.outputSha256 !== undefined) {
      const output = checkpoint.stepOutputs[receipt.id];
      if (
        output === undefined ||
        digest(stableStringify(output)) !== receipt.outputSha256
      ) return false;
      outputIds.add(receipt.id);
    }
    if (receipt.completionResultSha256 !== undefined) {
      completionResultSha256 = receipt.completionResultSha256;
    }
  }
  if (
    previousStateSha256 !== digest(stableStringify(checkpoint.state)) ||
    stableStringify(decisions) !== stableStringify(checkpoint.branchDecisions) ||
    Object.keys(checkpoint.stepOutputs).some((id) => !outputIds.has(id))
  ) return false;
  return completionResultSha256 === undefined
    ? checkpoint.completionResult === undefined
    : checkpoint.completionResult !== undefined &&
        digest(stableStringify(checkpoint.completionResult)) ===
          completionResultSha256;
}

function successReceipt(
  context: V2InactiveLocalHostContext,
  checkpoint: V2InactiveLocalHostCheckpoint
): V2InactiveLocalHostResult {
  if (checkpoint.status === "running") {
    return failure({
      code: "V2_LOCAL_HOST_CHECKPOINT_DRIFT",
      message: "a running checkpoint cannot be projected as terminal evidence",
      path: "checkpointStore",
    });
  }
  const core = {
    schema: "dzupagent.v2InactiveLocalHost/v1" as const,
    target: V2_INACTIVE_LOCAL_HOST_ID,
    runId: context.request.runId,
    status: checkpoint.status,
    sourceSha256: context.sourceSha256,
    qualificationSha256: context.qualificationSha256,
    planSha256: context.planSha256,
    checkpointSha256: checkpoint.checkpointSha256,
    state: checkpoint.state,
    stepOutputs: checkpoint.stepOutputs,
    branchDecisions: checkpoint.branchDecisions,
    ...(checkpoint.completionResult === undefined
      ? {}
      : { result: checkpoint.completionResult }),
    steps: checkpoint.steps,
    authority: Object.freeze({
      localHandlerInvocation: true as const,
      checkpointStoreMutation: true as const,
      handlerDeclaredEffects: "none" as const,
      providerDispatch: false as const,
      workflowExternalStateMutation: false as const,
      externalContinuation: false as const,
      deployment: false as const,
      promotion: false as const,
      activation: false as const,
    }),
  };
  const receipt: V2InactiveLocalHostReceipt = deepFreeze({
    ...core,
    hostSha256: digest(stableStringify(core)),
  });
  return { ok: true, receipt };
}

function failure(error: V2InactiveLocalHostError): V2InactiveLocalHostResult {
  return { ok: false, errors: deepFreeze([error]) };
}

function checkpointStoreFailure(
  operation: "claim" | "commit" | "release",
  error?: unknown
): V2InactiveLocalHostResult {
  return failure({
    code: "V2_LOCAL_HOST_CHECKPOINT_DRIFT",
    message: `checkpoint store ${operation} failed closed`,
    path: "checkpointStore",
    ...(error === undefined
      ? {}
      : { causes: [error instanceof Error ? error.message : String(error)] }),
  });
}

function cloneRecord(
  value: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && Object.values(value).every(isJsonValue);
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return isPlainRecord(value) &&
    Object.values(value).every((item) => typeof item === "boolean");
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

/**
 * Delegation lifecycle helpers extracted from the `SimpleDelegationTracker`
 * composition root.
 *
 * These are free functions that receive their persistence and event-bus
 * dependencies explicitly, keeping the tracker class a thin orchestrator over
 * cohesive start / finalize / wait seams. Behavior is identical to the prior
 * private methods.
 */

import type { RunStore } from "@dzupagent/core/persistence";
import type { DzupEventBus } from "@dzupagent/core/events";
import { OrchestrationError } from "../orchestration-error.js";
import { omitUndefined } from "../../utils/exact-optional.js";
import type {
  ActiveDelegation,
  DelegationMetadata,
  DelegationRequest,
  DelegationResult,
} from "./types.js";

/**
 * Create the run record, register the active-delegation entry, and emit the
 * `delegation:started` event. Returns the run and its tracking entry.
 */
export async function startDelegation(
  deps: { runStore: RunStore; eventBus: DzupEventBus | undefined },
  active: Map<string, ActiveDelegation & { abort: AbortController }>,
  request: DelegationRequest,
  delegationId: string,
  parentRunId: string
): Promise<{
  run: Awaited<ReturnType<RunStore["create"]>>;
  entry: ActiveDelegation & { abort: AbortController };
}> {
  // Create a run record in the store
  const run = await deps.runStore.create({
    agentId: request.targetAgentId,
    input: {
      task: request.task,
      ...request.input,
      delegationContext: request.context,
    },
    metadata: {
      delegationId,
      parentRunId,
      priority: request.priority ?? 5,
    },
  });

  // Set up abort controller for timeout and cancellation
  const abortController = new AbortController();

  // Track the active delegation
  const entry: ActiveDelegation & { abort: AbortController } = {
    delegationId,
    runId: run.id,
    request,
    status: "pending",
    startedAt: new Date(),
    abort: abortController,
  };
  active.set(delegationId, entry);

  // Emit started event
  deps.eventBus?.emit({
    type: "delegation:started",
    parentRunId,
    targetAgentId: request.targetAgentId,
    delegationId,
  });

  return { run, entry };
}

/**
 * Persist the terminal run state for a completed executor, emit the
 * `delegation:completed` event, and assemble the final {@link DelegationResult}
 * with duration metadata attached.
 */
export async function finalizeSuccess(
  deps: { runStore: RunStore; eventBus: DzupEventBus | undefined },
  args: {
    request: DelegationRequest;
    entry: ActiveDelegation;
    run: { id: string };
    result: DelegationResult;
    delegationId: string;
    parentRunId: string;
    startTime: number;
  }
): Promise<DelegationResult> {
  const { request, entry, run, result, delegationId, parentRunId, startTime } =
    args;
  const durationMs = Date.now() - startTime;
  entry.status = result.success ? "completed" : "failed";

  // Attach duration to metadata
  const metadata: DelegationMetadata = {
    ...result.metadata,
    durationMs,
  };

  // Update run store
  await deps.runStore.update(
    run.id,
    omitUndefined({
      status: result.success ? "completed" : "failed",
      output: result.output,
      completedAt: new Date(),
      error: result.error,
      tokenUsage: metadata.tokenUsage,
    })
  );

  // Emit completed event
  deps.eventBus?.emit({
    type: "delegation:completed",
    parentRunId,
    targetAgentId: request.targetAgentId,
    delegationId,
    durationMs,
    success: result.success,
  });

  return { ...result, metadata };
}

/**
 * Classify a thrown error into timeout / explicit-cancellation / generic
 * failure, persist the matching terminal run state, emit the corresponding
 * lifecycle event, and return the failed {@link DelegationResult}.
 */
export async function finalizeFailure(
  deps: { runStore: RunStore; eventBus: DzupEventBus | undefined },
  args: {
    err: unknown;
    request: DelegationRequest;
    entry: ActiveDelegation;
    run: { id: string };
    abortController: AbortController;
    delegationId: string;
    parentRunId: string;
    timeoutMs: number;
    startTime: number;
    wasCancelledByUser: (delegationId: string) => boolean;
  }
): Promise<DelegationResult> {
  const {
    err,
    request,
    entry,
    run,
    abortController,
    delegationId,
    parentRunId,
    timeoutMs,
    startTime,
    wasCancelledByUser,
  } = args;
  const durationMs = Date.now() - startTime;
  const isAbort = err instanceof Error && err.name === "AbortError";
  const isTimeout =
    abortController.signal.aborted &&
    abortController.signal.reason instanceof Error &&
    abortController.signal.reason.message.includes("timeout");

  if (isTimeout || (isAbort && !wasCancelledByUser(delegationId))) {
    entry.status = "timeout";

    await deps.runStore.update(run.id, {
      status: "failed",
      error: `Delegation timed out after ${timeoutMs}ms`,
      completedAt: new Date(),
    });

    deps.eventBus?.emit({
      type: "delegation:timeout",
      parentRunId,
      targetAgentId: request.targetAgentId,
      delegationId,
      timeoutMs,
    });

    return {
      success: false,
      output: null,
      error: `Delegation timed out after ${timeoutMs}ms`,
      metadata: { durationMs },
    };
  }

  // Explicit cancellation
  if (isAbort) {
    entry.status = "failed";

    await deps.runStore.update(run.id, {
      status: "cancelled",
      error: "Delegation cancelled",
      completedAt: new Date(),
    });

    deps.eventBus?.emit({
      type: "delegation:cancelled",
      parentRunId,
      targetAgentId: request.targetAgentId,
      delegationId,
    });

    return {
      success: false,
      output: null,
      error: "Delegation cancelled",
      metadata: { durationMs },
    };
  }

  // Generic failure
  const errorMsg = err instanceof Error ? err.message : String(err);
  entry.status = "failed";

  await deps.runStore.update(run.id, {
    status: "failed",
    error: errorMsg,
    completedAt: new Date(),
  });

  deps.eventBus?.emit({
    type: "delegation:failed",
    parentRunId,
    targetAgentId: request.targetAgentId,
    delegationId,
    error: errorMsg,
  });

  return {
    success: false,
    output: null,
    error: errorMsg,
    metadata: { durationMs },
  };
}

/**
 * Wait for the executor to finish, then read the final run state.
 * If the executor updates the run store directly, we read it back.
 * Respects the abort signal for cancellation/timeout.
 */
export async function waitForCompletion(
  runStore: RunStore,
  runId: string,
  executorPromise: Promise<void>,
  signal: AbortSignal
): Promise<DelegationResult> {
  // Wait for executor, but throw on abort
  await Promise.race([executorPromise, waitForAbort(signal)]);

  // Read final state from run store
  const run = await runStore.get(runId);
  if (!run) {
    throw new OrchestrationError(
      `Run ${runId} not found after execution`,
      "delegation",
      { runId }
    );
  }

  const success = run.status === "completed";
  return omitUndefined({
    success,
    output: run.output ?? null,
    error: run.error,
    metadata: run.tokenUsage
      ? {
          durationMs: 0, // will be overwritten by caller
          tokenUsage: run.tokenUsage,
        }
      : undefined,
  });
}

/**
 * Returns a promise that rejects when the signal is aborted.
 * Used in Promise.race to implement cancellation/timeout.
 */
export function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

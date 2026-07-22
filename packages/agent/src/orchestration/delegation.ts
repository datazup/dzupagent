/**
 * Typed delegation protocol for supervisor-to-specialist communication.
 *
 * Provides a `DelegationRequest`/`DelegationResult` contract and a
 * `SimpleDelegationTracker` that manages in-flight delegations with
 * timeout handling, cancellation, and event bus integration.
 *
 * This module is the composition root for the delegation subsystem: the
 * contract surface lives in `./delegation/types.js` and the start / finalize /
 * wait seams live in `./delegation/lifecycle.js`. This file wires them into a
 * thin `SimpleDelegationTracker` and re-exports the public surface unchanged.
 *
 * This module depends ONLY on `@dzupagent/core` (RunStore, DzupEventBus).
 * It does NOT import from `@dzupagent/server` or any other sibling package.
 */

import type { RunStore } from "@dzupagent/core/persistence";
import type { DzupEventBus } from "@dzupagent/core/events";
import {
  finalizeFailure,
  finalizeSuccess,
  startDelegation,
  waitForCompletion,
} from "./delegation/lifecycle.js";
import type {
  ActiveDelegation,
  DelegationExecutor,
  DelegationRequest,
  DelegationResult,
  DelegationTracker,
  SimpleDelegationTrackerConfig,
} from "./delegation/types.js";

export type {
  ActiveDelegation,
  DelegationContext,
  DelegationExecutor,
  DelegationMetadata,
  DelegationRequest,
  DelegationResult,
  DelegationStatus,
  DelegationTracker,
  SimpleDelegationTrackerConfig,
} from "./delegation/types.js";

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Simple delegation tracker that creates runs in a RunStore and polls
 * for completion. Supports timeout via AbortController and cancellation.
 */
export class SimpleDelegationTracker implements DelegationTracker {
  private readonly runStore: RunStore;
  private readonly eventBus: DzupEventBus | undefined;
  private readonly executor: DelegationExecutor;
  private readonly defaultTimeoutMs: number;

  /** Map of delegationId -> active delegation state */
  private readonly active = new Map<
    string,
    ActiveDelegation & { abort: AbortController }
  >();

  /** Track which delegations were cancelled explicitly (vs timeout). */
  private readonly cancelledByUser = new Set<string>();

  constructor(config: SimpleDelegationTrackerConfig) {
    this.runStore = config.runStore;
    this.eventBus = config.eventBus;
    this.executor = config.executor;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 300_000;
  }

  async delegate(request: DelegationRequest): Promise<DelegationResult> {
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const delegationId = crypto.randomUUID();
    const parentRunId = request.context?.parentRunId ?? "unknown";
    const startTime = Date.now();

    // Create the run record and register the active delegation entry.
    const { run, entry } = await startDelegation(
      { runStore: this.runStore, eventBus: this.eventBus },
      this.active,
      request,
      delegationId,
      parentRunId
    );
    const abortController = entry.abort;

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      abortController.abort(
        new Error(`Delegation timeout after ${timeoutMs}ms`)
      );
    }, timeoutMs);

    try {
      // Update status to running
      entry.status = "running";
      await this.runStore.update(run.id, { status: "running" });

      // Execute the delegation (non-blocking — executor runs in background)
      const executorPromise = this.executor(
        run.id,
        request.targetAgentId,
        {
          task: request.task,
          ...request.input,
          delegationContext: request.context,
        },
        abortController.signal
      );

      // Wait for either executor completion or abort
      const result = await waitForCompletion(
        this.runStore,
        run.id,
        executorPromise,
        abortController.signal
      );

      return await finalizeSuccess(
        { runStore: this.runStore, eventBus: this.eventBus },
        {
          request,
          entry,
          run,
          result,
          delegationId,
          parentRunId,
          startTime,
        }
      );
    } catch (err: unknown) {
      return await finalizeFailure(
        { runStore: this.runStore, eventBus: this.eventBus },
        {
          err,
          request,
          entry,
          run,
          abortController,
          delegationId,
          parentRunId,
          timeoutMs,
          startTime,
          wasCancelledByUser: (id) => this.wasCancelledByUser(id),
        }
      );
    } finally {
      clearTimeout(timeoutHandle);
      this.active.delete(delegationId);
    }
  }

  getActiveDelegations(): ActiveDelegation[] {
    return [...this.active.values()].map(({ abort: _abort, ...rest }) => rest);
  }

  cancel(targetAgentId: string): boolean {
    for (const [id, entry] of this.active) {
      if (entry.request.targetAgentId === targetAgentId) {
        this.cancelledByUser.add(id);
        entry.abort.abort(new Error("Delegation cancelled by user"));
        return true;
      }
    }
    return false;
  }

  private wasCancelledByUser(delegationId: string): boolean {
    const was = this.cancelledByUser.has(delegationId);
    this.cancelledByUser.delete(delegationId);
    return was;
  }
}

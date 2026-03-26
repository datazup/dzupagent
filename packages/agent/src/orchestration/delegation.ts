/**
 * Typed delegation protocol for supervisor-to-specialist communication.
 *
 * Provides a `DelegationRequest`/`DelegationResult` contract and a
 * `SimpleDelegationTracker` that manages in-flight delegations with
 * timeout handling, cancellation, and event bus integration.
 *
 * This module depends ONLY on `@forgeagent/core` (RunStore, ForgeEventBus).
 * It does NOT import from `@forgeagent/server` or any other sibling package.
 */

import type { RunStore, ForgeEventBus } from '@forgeagent/core'
import { OrchestrationError } from './orchestration-error.js'

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/** Typed contract for delegating work to a specialist agent. */
export interface DelegationRequest {
  /** ID of the specialist agent to delegate to */
  targetAgentId: string
  /** The task to delegate */
  task: string
  /** Structured input for the specialist */
  input: Record<string, unknown>
  /** Context from the supervisor (prior decisions, constraints) */
  context?: DelegationContext
  /** Max time to wait for specialist completion (ms, default: 300_000) */
  timeoutMs?: number
  /** Priority (lower = higher, default: 5) */
  priority?: number
}

/** Contextual information passed from supervisor to specialist. */
export interface DelegationContext {
  parentRunId: string
  decisions: string[]
  constraints: string[]
  relevantFiles: string[]
}

/** Result returned from a completed delegation. */
export interface DelegationResult {
  /** Whether the delegation succeeded */
  success: boolean
  /** Output from the specialist */
  output: unknown
  /** Structured metadata from the specialist */
  metadata?: DelegationMetadata
  /** Error if delegation failed */
  error?: string
}

/** Metadata about a completed delegation. */
export interface DelegationMetadata {
  modelTier?: string
  tokenUsage?: { input: number; output: number }
  durationMs: number
  filesModified?: string[]
}

// ---------------------------------------------------------------------------
// Status tracking
// ---------------------------------------------------------------------------

/** Delegation lifecycle status. */
export type DelegationStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout'

/** An in-flight delegation entry visible via `getActiveDelegations()`. */
export interface ActiveDelegation {
  delegationId: string
  runId: string
  request: DelegationRequest
  status: DelegationStatus
  startedAt: Date
}

// ---------------------------------------------------------------------------
// Tracker interface
// ---------------------------------------------------------------------------

/** Tracks and executes delegations from a supervisor to specialist agents. */
export interface DelegationTracker {
  /** Delegate work to a specialist. Resolves when the specialist finishes. */
  delegate(request: DelegationRequest): Promise<DelegationResult>
  /** Return all currently active (pending/running) delegations. */
  getActiveDelegations(): ActiveDelegation[]
  /** Cancel an active delegation by target agent ID. Returns true if cancelled. */
  cancel(targetAgentId: string): boolean
}

// ---------------------------------------------------------------------------
// Executor callback
// ---------------------------------------------------------------------------

/**
 * Callback that actually executes a delegated run.
 *
 * The tracker creates a Run record via `RunStore`, then hands the runId
 * to this executor. The executor is responsible for actually running the
 * agent (e.g. via a RunQueue worker, direct ForgeAgent.generate(), etc.).
 *
 * The executor MUST update the Run's `status` and `output` fields via the
 * RunStore when finished, so the tracker's polling loop can detect completion.
 *
 * The `signal` is wired to the delegation's AbortController for cancellation
 * and timeout.
 */
export type DelegationExecutor = (
  runId: string,
  agentId: string,
  input: unknown,
  signal: AbortSignal,
) => Promise<void>

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SimpleDelegationTrackerConfig {
  /** Persistence store for run records. */
  runStore: RunStore
  /** Event bus for delegation lifecycle events. */
  eventBus?: ForgeEventBus
  /** Callback that executes the delegated run. */
  executor: DelegationExecutor
  /** Polling interval for checking run completion (ms, default: 100). */
  pollIntervalMs?: number
  /** Default timeout for delegations (ms, default: 300_000). */
  defaultTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Simple delegation tracker that creates runs in a RunStore and polls
 * for completion. Supports timeout via AbortController and cancellation.
 */
export class SimpleDelegationTracker implements DelegationTracker {
  private readonly runStore: RunStore
  private readonly eventBus?: ForgeEventBus
  private readonly executor: DelegationExecutor
  private readonly defaultTimeoutMs: number

  /** Map of delegationId -> active delegation state */
  private readonly active = new Map<string, ActiveDelegation & { abort: AbortController }>()

  constructor(config: SimpleDelegationTrackerConfig) {
    this.runStore = config.runStore
    this.eventBus = config.eventBus
    this.executor = config.executor
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 300_000
  }

  async delegate(request: DelegationRequest): Promise<DelegationResult> {
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs
    const delegationId = crypto.randomUUID()
    const parentRunId = request.context?.parentRunId ?? 'unknown'
    const startTime = Date.now()

    // Create a run record in the store
    const run = await this.runStore.create({
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
    })

    // Set up abort controller for timeout and cancellation
    const abortController = new AbortController()

    // Track the active delegation
    const entry: ActiveDelegation & { abort: AbortController } = {
      delegationId,
      runId: run.id,
      request,
      status: 'pending',
      startedAt: new Date(),
      abort: abortController,
    }
    this.active.set(delegationId, entry)

    // Emit started event
    this.eventBus?.emit({
      type: 'delegation:started',
      parentRunId,
      targetAgentId: request.targetAgentId,
      delegationId,
    })

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      abortController.abort(new Error(`Delegation timeout after ${timeoutMs}ms`))
    }, timeoutMs)

    try {
      // Update status to running
      entry.status = 'running'
      await this.runStore.update(run.id, { status: 'running' })

      // Execute the delegation (non-blocking — executor runs in background)
      const executorPromise = this.executor(
        run.id,
        request.targetAgentId,
        {
          task: request.task,
          ...request.input,
          delegationContext: request.context,
        },
        abortController.signal,
      )

      // Wait for either executor completion or abort
      const result = await this.waitForCompletion(
        run.id,
        executorPromise,
        abortController.signal,
      )

      const durationMs = Date.now() - startTime
      entry.status = result.success ? 'completed' : 'failed'

      // Attach duration to metadata
      const metadata: DelegationMetadata = {
        ...result.metadata,
        durationMs,
      }

      // Update run store
      await this.runStore.update(run.id, {
        status: result.success ? 'completed' : 'failed',
        output: result.output,
        completedAt: new Date(),
        error: result.error,
        tokenUsage: metadata.tokenUsage,
      })

      // Emit completed event
      this.eventBus?.emit({
        type: 'delegation:completed',
        parentRunId,
        targetAgentId: request.targetAgentId,
        delegationId,
        durationMs,
        success: result.success,
      })

      return { ...result, metadata }
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime
      const isAbort = err instanceof Error && err.name === 'AbortError'
      const isTimeout = abortController.signal.aborted &&
        abortController.signal.reason instanceof Error &&
        abortController.signal.reason.message.includes('timeout')

      if (isTimeout || (isAbort && !this.wasCancelledByUser(delegationId))) {
        entry.status = 'timeout'

        await this.runStore.update(run.id, {
          status: 'failed',
          error: `Delegation timed out after ${timeoutMs}ms`,
          completedAt: new Date(),
        })

        this.eventBus?.emit({
          type: 'delegation:timeout',
          parentRunId,
          targetAgentId: request.targetAgentId,
          delegationId,
          timeoutMs,
        })

        return {
          success: false,
          output: null,
          error: `Delegation timed out after ${timeoutMs}ms`,
          metadata: { durationMs },
        }
      }

      // Explicit cancellation
      if (isAbort) {
        entry.status = 'failed'

        await this.runStore.update(run.id, {
          status: 'cancelled',
          error: 'Delegation cancelled',
          completedAt: new Date(),
        })

        this.eventBus?.emit({
          type: 'delegation:cancelled',
          parentRunId,
          targetAgentId: request.targetAgentId,
          delegationId,
        })

        return {
          success: false,
          output: null,
          error: 'Delegation cancelled',
          metadata: { durationMs },
        }
      }

      // Generic failure
      const errorMsg = err instanceof Error ? err.message : String(err)
      entry.status = 'failed'

      await this.runStore.update(run.id, {
        status: 'failed',
        error: errorMsg,
        completedAt: new Date(),
      })

      this.eventBus?.emit({
        type: 'delegation:failed',
        parentRunId,
        targetAgentId: request.targetAgentId,
        delegationId,
        error: errorMsg,
      })

      return {
        success: false,
        output: null,
        error: errorMsg,
        metadata: { durationMs },
      }
    } finally {
      clearTimeout(timeoutHandle)
      this.active.delete(delegationId)
    }
  }

  getActiveDelegations(): ActiveDelegation[] {
    return [...this.active.values()].map(({ abort: _abort, ...rest }) => rest)
  }

  cancel(targetAgentId: string): boolean {
    for (const [id, entry] of this.active) {
      if (entry.request.targetAgentId === targetAgentId) {
        this.cancelledByUser.add(id)
        entry.abort.abort(new Error('Delegation cancelled by user'))
        return true
      }
    }
    return false
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Track which delegations were cancelled explicitly (vs timeout). */
  private readonly cancelledByUser = new Set<string>()

  private wasCancelledByUser(delegationId: string): boolean {
    const was = this.cancelledByUser.has(delegationId)
    this.cancelledByUser.delete(delegationId)
    return was
  }

  /**
   * Wait for the executor to finish, then read the final run state.
   * If the executor updates the run store directly, we read it back.
   * Respects the abort signal for cancellation/timeout.
   */
  private async waitForCompletion(
    runId: string,
    executorPromise: Promise<void>,
    signal: AbortSignal,
  ): Promise<DelegationResult> {
    // Wait for executor, but throw on abort
    await Promise.race([
      executorPromise,
      this.waitForAbort(signal),
    ])

    // Read final state from run store
    const run = await this.runStore.get(runId)
    if (!run) {
      throw new OrchestrationError(
        `Run ${runId} not found after execution`,
        'delegation',
        { runId },
      )
    }

    const success = run.status === 'completed'
    return {
      success,
      output: run.output ?? null,
      error: run.error,
      metadata: run.tokenUsage
        ? {
            durationMs: 0, // will be overwritten by caller
            tokenUsage: run.tokenUsage,
          }
        : undefined,
    }
  }

  /**
   * Returns a promise that rejects when the signal is aborted.
   * Used in Promise.race to implement cancellation/timeout.
   */
  private waitForAbort(signal: AbortSignal): Promise<never> {
    return new Promise((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        return
      }
      signal.addEventListener('abort', () => {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      }, { once: true })
    })
  }
}

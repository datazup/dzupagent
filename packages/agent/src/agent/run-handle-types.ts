/**
 * RunHandle — the public API for managing a running agent execution.
 *
 * Obtained by calling `agent.launch(input)`. Provides cooperative pause/resume,
 * cancellation, result awaiting, and event subscription.
 *
 * Key design decisions (from spec-panel review):
 * - Pause is COOPERATIVE: waits for current tool call to complete before suspending
 * - Resume is IDEMPOTENT: duplicate resumeToken is silently ignored
 * - Cross-process resume: use RunHandle.fromRunId(runId, journal) to reconstruct
 * - fork() creates a new run from a checkpoint (does not mutate the original)
 */

import type { RunStatus } from '@dzupagent/core'
import type { RunJournalEntry } from '@dzupagent/core'

export type { RunStatus }

// ─── Result Types ─────────────────────────────────────────────────────────────

export interface RunResult<TOutput = unknown, TState = Record<string, unknown>> {
  runId: string
  status: 'completed' | 'failed' | 'cancelled'
  output?: TOutput
  error?: string
  state?: TState
  durationMs?: number
  totalTokens?: number
  totalCostCents?: number
}

// ─── Error Types ──────────────────────────────────────────────────────────────

export class InvalidRunStateError extends Error {
  constructor(
    public readonly runId: string,
    public readonly currentStatus: RunStatus,
    public readonly expectedStatus: RunStatus | RunStatus[],
    message?: string,
  ) {
    const expected = Array.isArray(expectedStatus) ? expectedStatus.join(' | ') : expectedStatus
    super(message ?? `Run ${runId} is in state '${currentStatus}', expected '${expected}'`)
    this.name = 'InvalidRunStateError'
  }
}

export class CheckpointExpiredError extends Error {
  constructor(
    public readonly runId: string,
    public readonly stepId: string,
    public readonly expiredAt: string,
  ) {
    super(`Checkpoint for step '${stepId}' in run '${runId}' expired at ${expiredAt}`)
    this.name = 'CheckpointExpiredError'
  }
}

export class ForkLimitExceededError extends Error {
  constructor(
    public readonly runId: string,
    public readonly maxForks: number,
  ) {
    super(`Run '${runId}' has reached the maximum fork limit of ${maxForks}`)
    this.name = 'ForkLimitExceededError'
  }
}

export class RunNotFoundError extends Error {
  constructor(
    public readonly runId: string,
    message?: string,
  ) {
    super(message ?? `Run '${runId}' not found`)
    this.name = 'RunNotFoundError'
  }
}

// ─── Checkpoint Info ──────────────────────────────────────────────────────────

/** Describes a completed step that can serve as a resume checkpoint. */
export interface CheckpointInfo {
  /** The step ID from the step_completed journal entry */
  stepId: string
  /** Optional human-readable step name (e.g. tool name) */
  stepName?: string
  /** When the step completed */
  completedAt: Date
  /** Journal sequence number of the step_completed entry */
  entrySeq: number
}

// ─── Unsubscribe Function ─────────────────────────────────────────────────────

export type Unsubscribe = () => void

// ─── RunHandle Interface ──────────────────────────────────────────────────────

/**
 * RunHandle — lifecycle manager for a single agent run.
 *
 * Serializable: a RunHandle can be reconstructed from its runId using
 * `RunHandle.fromRunId(runId, journal)` for cross-process resume.
 */
export interface RunHandle<
  TOutput = unknown,
  TState = Record<string, unknown>,
> {
  /** The unique identifier for this run */
  readonly runId: string

  /** Current status of the run (may be stale — call status() for live state) */
  readonly currentStatus: RunStatus

  /**
   * Cooperatively pause the run.
   * Waits for the current tool call to complete before suspending.
   * Returns after the run_paused journal entry is written.
   *
   * @throws {InvalidRunStateError} if the run is already terminal
   * @param options.timeoutMs — max ms to wait for current tool call (default: 30_000)
   */
  pause(options?: { timeoutMs?: number }): Promise<void>

  /**
   * Resume a paused run.
   * Idempotent: duplicate resumeToken is silently ignored.
   *
   * @throws {InvalidRunStateError} if the run is not paused
   * @param input — data to inject into the next step (e.g. human approval response)
   * @param resumeToken — deduplication token (auto-generated UUID if not provided)
   */
  resume(input?: unknown, resumeToken?: string): Promise<void>

  /**
   * Cancel the run.
   * @param reason — optional cancellation reason stored in journal
   */
  cancel(reason?: string): Promise<void>

  /**
   * Fork the run from a checkpoint step.
   * Creates a new run with a new runId, copying journal entries up to the target step.
   * The original run is not affected.
   *
   * @throws {CheckpointExpiredError} if the checkpoint has expired
   * @throws {ForkLimitExceededError} if the max fork count is reached
   */
  fork(targetStepId: string): Promise<RunHandle<TOutput, TState>>

  /**
   * Await the final result of the run.
   * Resolves when the run reaches a terminal state (completed, failed, cancelled).
   */
  result(): Promise<RunResult<TOutput, TState>>

  /**
   * Get the current live status of the run.
   */
  status(): Promise<RunStatus>

  /**
   * Subscribe to journal entry events for this run.
   * Returns an unsubscribe function.
   *
   * @param eventType — specific entry type to listen for, or '*' for all
   * @param handler — called with each matching journal entry
   */
  subscribe(
    eventType: string | '*',
    handler: (entry: RunJournalEntry) => void,
  ): Unsubscribe

  /**
   * Resume the run from a specific completed step (checkpoint-based replay).
   * Creates a forked handle starting from the given step, sets its status
   * to running, and stores resume metadata.
   *
   * @param stepId — the step_completed entry's stepId to resume from
   * @param input — optional data to inject into the resumed run
   * @throws {InvalidRunStateError} if the run is currently running
   * @throws {CheckpointExpiredError} if no step_completed entry matches stepId
   */
  resumeFromStep(stepId: string, input?: unknown): Promise<RunHandle<TOutput, TState>>

  /**
   * List all available checkpoints (completed steps) that this run can be
   * resumed from via `resumeFromStep()`.
   *
   * Returns an empty array if no journal is attached or no steps have completed.
   */
  getCheckpoints(): Promise<CheckpointInfo[]>
}

// ─── Launch Options ────────────────────────────────────────────────────────────

export interface LaunchOptions {
  /** Override the run ID (defaults to auto-generated UUID) */
  runId?: string
  /** Maximum fork count for this run (default: 10) */
  maxForks?: number
  /** Checkpoint TTL in ms (default: 7 days) */
  checkpointTtlMs?: number
  /** Metadata attached to the run_started journal entry */
  metadata?: Record<string, unknown>
}

/**
 * RunHandle — the public API for managing a running agent execution.
 *
 * Obtained by calling `agent.launch(input)`. The handle provides status/journal
 * controls, result awaiting, and event subscription. Inspect
 * `controlCapabilities` before relying on its controls for side-effect safety:
 * - legacy mode (default): pause/resume/cancel change handle/journal state only
 *   and do not control the background execution;
 * - cooperative mode (`LaunchOptions.controlMode: 'cooperative'`): cancel aborts
 *   and pause holds the background `generate()` at the next safe point
 *   (before-model, before-tool, after-tool).
 * In both modes `crossProcessResume` stays `inspection-only`.
 *
 * Key design decisions (from spec-panel review):
 * - Legacy pause changes handle/journal state only
 * - Resume is IDEMPOTENT: duplicate resumeToken is silently ignored
 * - Journal reconstruction is an inspection projection, not execution restart
 * - fork() creates a new run from a checkpoint (does not mutate the original)
 */

import type { RunStatus } from '@dzupagent/core/persistence'
import type { RunJournalEntry } from '@dzupagent/core/persistence'

export type { RunStatus }

export const RUN_HANDLE_CONTROL_CAPABILITIES_SCHEMA =
  'dzupagent.runHandleControlCapabilities/v1' as const

/**
 * Truthful capability marker for the legacy `launch()` handle.
 *
 * `handle-state-only` means the method changes the handle and its journal but
 * does not signal or fence model/tool execution. `inspection-only` means a
 * journal can reconstruct status, not restart-safe execution state.
 */
export interface RunHandleControlCapabilities {
  readonly schema: typeof RUN_HANDLE_CONTROL_CAPABILITIES_SCHEMA
  readonly stability: 'experimental'
  readonly backgroundExecution: 'uncontrolled' | 'cooperative-safe-points'
  readonly pause: 'handle-state-only' | 'execution-authoritative'
  readonly resume: 'handle-state-only' | 'execution-authoritative'
  readonly cancel: 'handle-state-only' | 'execution-authoritative'
  readonly crossProcessResume: 'inspection-only' | 'restart-safe'
}

export const LEGACY_RUN_HANDLE_CONTROL_CAPABILITIES: RunHandleControlCapabilities =
  Object.freeze({
    schema: RUN_HANDLE_CONTROL_CAPABILITIES_SCHEMA,
    stability: 'experimental',
    backgroundExecution: 'uncontrolled',
    pause: 'handle-state-only',
    resume: 'handle-state-only',
    cancel: 'handle-state-only',
    crossProcessResume: 'inspection-only',
  })

/**
 * Capability marker for a handle launched with `controlMode: 'cooperative'`.
 *
 * Controls are honoured by the in-process `generate()` loop at safe points.
 * A journal still reconstructs status only (`inspection-only`), never
 * restart-safe execution state.
 */
export const COOPERATIVE_RUN_HANDLE_CONTROL_CAPABILITIES: RunHandleControlCapabilities =
  Object.freeze({
    schema: RUN_HANDLE_CONTROL_CAPABILITIES_SCHEMA,
    stability: 'experimental',
    backgroundExecution: 'cooperative-safe-points',
    pause: 'execution-authoritative',
    resume: 'execution-authoritative',
    cancel: 'execution-authoritative',
    crossProcessResume: 'inspection-only',
  })

// ─── Cooperative Run Control ──────────────────────────────────────────────────

/** Points in the generate tool loop where run controls are observed. */
export type RunControlSafePoint = 'before-model' | 'before-tool' | 'after-tool'

/**
 * Port the tool loop consults at each safe point. Cancel travels on the run's
 * `AbortSignal`, not on this port.
 */
export interface RunControlPort {
  /** True while a pause has been requested and not yet released. */
  shouldPause(): boolean
  /** Resolves when the pause is released by `resume()` or the run is aborted. */
  waitForResume(): Promise<void>
  /** Report that a control was observed at a safe point. */
  acknowledge(kind: 'pause' | 'cancel' | 'resume', at: RunControlSafePoint): void
}

/**
 * Outcome of a cooperative control request.
 *
 * - `requested`: recorded but not (or no longer) awaiting observation, e.g. a
 *   pause withdrawn by `resume()` before any safe point;
 * - `observed-at-safe-point`: the loop observed it (`safePoint` names where),
 *   or the background `generate()` settled after a cancel (no `safePoint`);
 * - `timed-out`: `timeoutMs` elapsed first; the request stays pending.
 */
export interface ControlAcknowledgement {
  kind: 'pause' | 'cancel' | 'resume'
  state: 'requested' | 'observed-at-safe-point' | 'timed-out'
  safePoint?: RunControlSafePoint
  /** ISO-8601 timestamp of this acknowledgement. */
  at: string
}

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
  /**
   * Per-run memory frame snapshot captured during `prepareMessages()`.
   * Surfaced for observability so callers can inspect exactly which memory
   * context (e.g. Arrow FrozenSnapshot) was attached to this run. Opaque —
   * the shape depends on the configured memory provider.
   */
  memoryFrame?: unknown
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
 * RunHandle — status and journal projection for a single agent run.
 *
 * A handle can be reconstructed from a run journal for inspection. The legacy
 * handle is not restart-safe execution state.
 */
export interface RunHandle<
  TOutput = unknown,
  TState = Record<string, unknown>,
> {
  /** The unique identifier for this run */
  readonly runId: string

  /** Explicit semantics of the lifecycle controls exposed by this handle. */
  readonly controlCapabilities: RunHandleControlCapabilities

  /** Current status of the run (may be stale — call status() for live state) */
  readonly currentStatus: RunStatus

  /**
   * Pause the run.
   *
   * @experimental Legacy mode marks the handle paused and journals
   * `run_paused` without pausing background model/tool work. Cooperative mode
   * holds the loop at the next safe point; status becomes `paused` and
   * `run_paused` (reason `'cooperative'`) is journalled when the loop
   * acknowledges, and the implementation resolves a `ControlAcknowledgement`.
   * Neither mode restarts execution across processes (`inspection-only`).
   *
   * @throws {InvalidRunStateError} if the run is already terminal
   * @param options.timeoutMs — cooperative mode only: resolve `timed-out` if no
   *   safe point is reached in time (no default; legacy mode ignores it)
   */
  pause(options?: { timeoutMs?: number }): Promise<void>

  /**
   * Mark a paused handle running and write a journal entry.
   *
   * @experimental This does not restart execution in another process.
   * Idempotent: duplicate resumeToken is silently ignored.
   *
   * @throws {InvalidRunStateError} if the run is not paused
   * @param input — data to inject into the next step (e.g. human approval response)
   * @param resumeToken — deduplication token (auto-generated UUID if not provided)
   */
  resume(input?: unknown, resumeToken?: string): Promise<void>

  /**
   * Cancel the run.
   *
   * @experimental Legacy mode marks the handle cancelled and resolves its
   * result without aborting background model/tool work. Cooperative mode
   * aborts the run's signal; the loop stops at the next safe point, the run
   * ends `cancelled` and the implementation resolves a
   * `ControlAcknowledgement`. Until then the request is not terminal.
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
  /**
   * Run-control semantics of the returned handle (default `'legacy'`).
   * `'cooperative'` makes pause/resume/cancel authoritative over the
   * background `generate()` at safe points and reports
   * {@link COOPERATIVE_RUN_HANDLE_CONTROL_CAPABILITIES}.
   */
  controlMode?: 'legacy' | 'cooperative'
}

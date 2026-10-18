/**
 * ConcreteRunHandle — production implementation of RunHandle.
 *
 * Status/journal projection for a background agent run. In legacy mode (the
 * default) the capability marker reports that pause/resume/cancel are not
 * authoritative over the execution itself. With `controlMode: 'cooperative'`
 * the handle owns an abort controller and a {@link RunControlPort}
 * (`CooperativeRunController`), and the generate loop honours its controls at
 * safe points. Cross-process resume stays `inspection-only` in both modes.
 *
 * Internal `_complete`, `_fail`, `_updateStatus` methods are called by
 * the agent runner; they are not part of the public RunHandle interface.
 */

import { randomUUID } from 'node:crypto'
import type {
  RunHandle,
  RunResult,
  Unsubscribe,
  LaunchOptions,
  CheckpointInfo,
  ControlAcknowledgement,
  RunHandleControlCapabilities,
  RunControlSafePoint,
} from './run-handle-types.js'
import {
  InvalidRunStateError,
  CheckpointExpiredError,
  ForkLimitExceededError,
  LEGACY_RUN_HANDLE_CONTROL_CAPABILITIES,
  COOPERATIVE_RUN_HANDLE_CONTROL_CAPABILITIES,
} from './run-handle-types.js'
import { CooperativeRunController } from './run-control-safe-points.js'
import type { RunJournal, RunJournalEntry } from '@dzupagent/core/persistence'
import type { RunStatus } from '@dzupagent/core/persistence'
import { omitUndefined } from '../utils/exact-optional.js'

type EventHandler = (entry: RunJournalEntry) => void

/** Terminal statuses that cannot transition to any other state. */
const TERMINAL_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled', 'rejected']

export class ConcreteRunHandle<TOutput = unknown, TState = Record<string, unknown>>
  implements RunHandle<TOutput, TState>
{
  private _currentStatus: RunStatus
  private readonly eventHandlers = new Map<string, Set<EventHandler>>()
  private resultResolvers: Array<(result: RunResult<TOutput, TState>) => void> = []
  private resultRejecters: Array<(err: Error) => void> = []
  private _resultPromise: Promise<RunResult<TOutput, TState>> | null = null
  private _terminalResult: RunResult<TOutput, TState> | null = null
  private readonly forkCount: Map<string, number>
  private readonly maxForks: number
  private readonly checkpointTtlMs: number
  private readonly cooperative: CooperativeRunController | undefined
  private cancelReason: string | undefined
  readonly controlCapabilities: RunHandleControlCapabilities

  constructor(
    public readonly runId: string,
    initialStatus: RunStatus,
    private readonly journal: RunJournal<TState>,
    options: LaunchOptions = {},
  ) {
    this._currentStatus = initialStatus
    this.maxForks = options.maxForks ?? 10
    this.checkpointTtlMs = options.checkpointTtlMs ?? 7 * 24 * 60 * 60 * 1000
    this.forkCount = new Map([[runId, 0]])
    this.cooperative = options.controlMode === 'cooperative'
      ? new CooperativeRunController({
        onPauseObserved: (at) => this.onPauseObserved(at),
        onCancelObserved: () => this.finishCancelled(),
        onAcknowledgement: (ack) => this.emitSynthetic('run_control_acknowledged', { ...ack }),
      })
      : undefined
    this.controlCapabilities = this.cooperative
      ? COOPERATIVE_RUN_HANDLE_CONTROL_CAPABILITIES
      : LEGACY_RUN_HANDLE_CONTROL_CAPABILITIES
  }

  // ---------------------------------------------------------------------------
  // Public interface (RunHandle<TOutput, TState>)
  // ---------------------------------------------------------------------------

  get currentStatus(): RunStatus {
    return this._currentStatus
  }

  /**
   * Legacy: resolves `undefined`. Cooperative: resolves the pause
   * {@link ControlAcknowledgement}; the public signature stays `Promise<void>`
   * because `Promise<ControlAcknowledgement | void>` is not assignable to it.
   */
  pause(options?: { timeoutMs?: number }): Promise<void>
  async pause(options?: { timeoutMs?: number }): Promise<ControlAcknowledgement | void> {
    if (TERMINAL_STATUSES.includes(this._currentStatus)) {
      throw new InvalidRunStateError(this.runId, this._currentStatus, 'running')
    }
    if (this.cooperative) {
      return this.cooperative.requestPause(options?.timeoutMs)
    }
    if (this._currentStatus === 'paused') {
      return // already paused -- no-op
    }

    await this.journal.append(this.runId, {
      type: 'run_paused',
      data: { reason: 'user_request' },
    })
    this._currentStatus = 'paused'
    this.emitSynthetic('run_paused', { reason: 'user_request' })
  }

  async resume(input?: unknown, resumeToken?: string): Promise<void> {
    // Cooperative: an unobserved pause is withdrawn without a journal entry.
    if (this.cooperative?.pausePending && !this.cooperative.isPauseObserved) {
      this.cooperative.release()
      return
    }
    if (this._currentStatus !== 'paused' && this._currentStatus !== 'suspended') {
      throw new InvalidRunStateError(
        this.runId,
        this._currentStatus,
        ['paused', 'suspended'],
      )
    }

    const token = resumeToken ?? randomUUID()

    // Idempotency: check for duplicate resumeToken in journal
    const entries = await this.journal.getAll(this.runId)
    const isDuplicate = entries.some(
      (e) =>
        e.type === 'run_resumed' &&
        (e.data as { resumeToken?: string }).resumeToken === token,
    )
    if (isDuplicate) {
      return // idempotent -- silent no-op
    }

    await this.journal.append(this.runId, {
      type: 'run_resumed',
      data: { resumeToken: token, input },
    })
    this._currentStatus = 'running'
    this.cooperative?.release()
    this.emitSynthetic('run_resumed', { resumeToken: token, input })
  }

  /**
   * Legacy: resolves `undefined`. Cooperative: aborts the run and resolves the
   * cancel acknowledgement (no default timeout); not terminal until observed.
   * The public signature stays `Promise<void>`, as for {@link pause}.
   */
  cancel(reason?: string, options?: { timeoutMs?: number }): Promise<void>
  async cancel(
    reason?: string,
    options?: { timeoutMs?: number },
  ): Promise<ControlAcknowledgement | void> {
    if (TERMINAL_STATUSES.includes(this._currentStatus)) {
      return // already terminal -- no-op
    }
    if (this.cooperative) {
      if (!this.cooperative.cancelRequested) this.cancelReason = reason
      return this.cooperative.requestCancel(options?.timeoutMs)
    }

    await this.journal.append(this.runId, {
      type: 'run_cancelled',
      data: { reason },
    })
    this._currentStatus = 'cancelled'

    const result: RunResult<TOutput, TState> = omitUndefined({
      runId: this.runId,
      status: 'cancelled',
      error: reason,
    })
    this.resolveResult(result)
  }

  async fork(targetStepId: string): Promise<RunHandle<TOutput, TState>> {
    // Enforce fork limit
    const currentForks = this.forkCount.get(this.runId) ?? 0
    if (currentForks >= this.maxForks) {
      throw new ForkLimitExceededError(this.runId, this.maxForks)
    }

    // Find the step_completed checkpoint for the target step
    const entries = await this.journal.getAll(this.runId)
    const checkpointEntry = entries.find(
      (e) =>
        e.type === 'step_completed' &&
        (e.data as { stepId?: string }).stepId === targetStepId,
    )

    if (!checkpointEntry) {
      throw new CheckpointExpiredError(
        this.runId,
        targetStepId,
        new Date(Date.now() - this.checkpointTtlMs).toISOString(),
      )
    }

    // TTL check
    const entryAge = Date.now() - new Date(checkpointEntry.ts).getTime()
    if (entryAge > this.checkpointTtlMs) {
      throw new CheckpointExpiredError(this.runId, targetStepId, checkpointEntry.ts)
    }

    // Increment fork count (shared across forks of same parent run)
    this.forkCount.set(this.runId, currentForks + 1)

    // Copy journal entries up to and including the checkpoint
    const forkRunId = randomUUID()
    const entriesToCopy = entries.filter((e) => e.seq <= checkpointEntry.seq)

    for (const entry of entriesToCopy) {
      await this.journal.append(forkRunId, {
        type: entry.type,
        data: entry.data,
      } as Omit<RunJournalEntry<TState>, 'v' | 'seq' | 'ts' | 'runId'>)
    }

    // Write a run_started entry to track lineage
    await this.journal.append(forkRunId, {
      type: 'run_started',
      data: {
        input: null,
        agentId: `fork:${this.runId}:${targetStepId}`,
      },
    })

    return new ConcreteRunHandle<TOutput, TState>(forkRunId, 'paused', this.journal, {
      maxForks: this.maxForks,
      checkpointTtlMs: this.checkpointTtlMs,
    })
  }

  async result(): Promise<RunResult<TOutput, TState>> {
    if (!this._resultPromise) {
      this._resultPromise = new Promise<RunResult<TOutput, TState>>((resolve, reject) => {
        if (this._terminalResult) {
          resolve(this._terminalResult)
          return
        }
        // If already terminal, resolve immediately
        if (this._currentStatus === 'completed') {
          resolve({ runId: this.runId, status: 'completed' })
          return
        }
        if (this._currentStatus === 'failed') {
          resolve({ runId: this.runId, status: 'failed' })
          return
        }
        if (this._currentStatus === 'cancelled') {
          resolve({ runId: this.runId, status: 'cancelled' })
          return
        }
        this.resultResolvers.push(resolve)
        this.resultRejecters.push(reject)
      })
    }
    return this._resultPromise
  }

  async status(): Promise<RunStatus> {
    return this._currentStatus
  }

  subscribe(eventType: string | '*', handler: EventHandler): Unsubscribe {
    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, new Set())
    }
    this.eventHandlers.get(eventType)!.add(handler)
    return () => {
      this.eventHandlers.get(eventType)?.delete(handler)
    }
  }

  async resumeFromStep(stepId: string, input?: unknown): Promise<RunHandle<TOutput, TState>> {
    // Cannot resume-from-step while the run is actively running
    if (this._currentStatus === 'running') {
      throw new InvalidRunStateError(
        this.runId,
        this._currentStatus,
        ['paused', 'suspended', 'completed', 'failed', 'cancelled'],
      )
    }

    // Verify the step_completed checkpoint exists in the journal
    const entries = await this.journal.getAll(this.runId)
    const stepEntry = entries.find(
      (e) =>
        e.type === 'step_completed' &&
        (e.data as { stepId?: string }).stepId === stepId,
    )

    if (!stepEntry) {
      throw new CheckpointExpiredError(
        this.runId,
        stepId,
        new Date().toISOString(),
      )
    }

    // Fork from the checkpoint step (reuses fork's TTL & limit checks)
    const forkedHandle = await this.fork(stepId) as ConcreteRunHandle<TOutput, TState>

    // Transition the forked handle to running
    forkedHandle._updateStatus('running')

    // Store resume metadata in the forked run's journal
    await this.journal.append(forkedHandle.runId, {
      type: 'run_resumed',
      data: {
        resumeToken: randomUUID(),
        input: {
          resumeFromStep: stepId,
          resumeInput: input,
        },
      },
    })

    return forkedHandle
  }

  async getCheckpoints(): Promise<CheckpointInfo[]> {
    const entries = await this.journal.getAll(this.runId)

    return entries
      .filter((e) => e.type === 'step_completed')
      .map((e) => {
        const data = e.data as {
          stepId: string
          toolName?: string
        }
        return omitUndefined({
          stepId: data.stepId,
          stepName: data.toolName,
          completedAt: new Date(e.ts),
          entrySeq: e.seq,
        })
      })
  }

  // ---------------------------------------------------------------------------
  // Internal methods (called by agent runner, not part of RunHandle interface)
  // ---------------------------------------------------------------------------

  /** Called by the agent runner when the run completes successfully. */
  _complete(output: TOutput, meta?: Partial<RunResult<TOutput, TState>>): void {
    if (TERMINAL_STATUSES.includes(this._currentStatus)) {
      return
    }
    this._currentStatus = 'completed'
    const result: RunResult<TOutput, TState> = {
      runId: this.runId,
      status: 'completed',
      output,
      ...meta,
    }
    this.resolveResult(result)
    this.emitSynthetic('run_completed', { output })
  }

  /** Called by the agent runner when the run fails. */
  _fail(error: string, meta?: Partial<RunResult<TOutput, TState>>): void {
    if (TERMINAL_STATUSES.includes(this._currentStatus)) {
      return
    }
    this._currentStatus = 'failed'
    const result: RunResult<TOutput, TState> = {
      runId: this.runId,
      status: 'failed',
      error,
      ...meta,
    }
    this.resolveResult(result)
    this.emitSynthetic('run_failed', { error })
  }

  /** Called by the agent runner to update status (e.g. queued -> running). */
  _updateStatus(status: RunStatus): void {
    this._currentStatus = status
  }

  /** Cooperative controller (port + cancel signal), or `undefined` in legacy mode. */
  get _cooperativeControl(): CooperativeRunController | undefined {
    return this.cooperative
  }

  /**
   * Called by the launcher when the background `generate()` settles. After a
   * requested cancel, a rejection or an `aborted` result ends the run
   * `cancelled` and returns `true`. Always `false` in legacy mode.
   */
  _settleCooperative(outcome: { stopReason?: string } | 'rejected'): boolean {
    const control = this.cooperative
    if (!control) return false
    control.settleRun()
    if (!control.cancelRequested) return false
    if (outcome !== 'rejected' && outcome.stopReason !== 'aborted') return false
    this.finishCancelled()
    return true
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private resolveResult(result: RunResult<TOutput, TState>): void {
    this._terminalResult = result
    for (const resolve of this.resultResolvers) {
      resolve(result)
    }
    this.resultResolvers = []
    this.resultRejecters = []
  }

  private onPauseObserved(at: RunControlSafePoint): void {
    if (TERMINAL_STATUSES.includes(this._currentStatus)) return
    this._currentStatus = 'paused'
    void this.journal.append(this.runId, { type: 'run_paused', data: { reason: 'cooperative' } })
    this.emitSynthetic('run_paused', { reason: 'cooperative', safePoint: at })
  }

  /** Cooperative terminal transition: journals `run_cancelled` exactly once. */
  private finishCancelled(): void {
    if (TERMINAL_STATUSES.includes(this._currentStatus)) return
    this._currentStatus = 'cancelled'
    void this.journal.append(this.runId, { type: 'run_cancelled', data: { reason: this.cancelReason } })
    this.resolveResult(omitUndefined({ runId: this.runId, status: 'cancelled' as const, error: this.cancelReason }))
  }

  private notifyHandlers(eventType: string, entry: RunJournalEntry): void {
    this.eventHandlers.get(eventType)?.forEach((h) => h(entry))
    this.eventHandlers.get('*')?.forEach((h) => h(entry))
  }

  /** Emit a synthetic journal entry to subscribers without reading from journal. */
  private emitSynthetic(type: string, data: Record<string, unknown>): void {
    const entry = {
      v: 1 as const,
      seq: -1,
      ts: new Date().toISOString(),
      runId: this.runId,
      type,
      data,
    } as RunJournalEntry
    this.notifyHandlers(type, entry)
  }

  // ---------------------------------------------------------------------------
  // Static factory
  // ---------------------------------------------------------------------------

  /**
   * Reconstruct a RunHandle from a runId by reading the journal.
   * Used for cross-process resume scenarios.
   *
   * @throws {InvalidRunStateError} if the run is not found in the journal
   */
  static async fromRunId<TOutput = unknown, TState = Record<string, unknown>>(
    runId: string,
    journal: RunJournal<TState>,
  ): Promise<ConcreteRunHandle<TOutput, TState>> {
    const entries = await journal.getAll(runId)
    if (entries.length === 0) {
      throw new InvalidRunStateError(
        runId,
        'pending',
        'paused',
        `Run '${runId}' not found in journal`,
      )
    }

    // Derive current status from the last lifecycle entry
    const typeToStatus: Record<string, RunStatus> = {
      run_started: 'running',
      run_paused: 'paused',
      run_resumed: 'running',
      run_suspended: 'suspended',
      run_completed: 'completed',
      run_failed: 'failed',
      run_cancelled: 'cancelled',
    }

    let status: RunStatus = 'pending'
    for (const entry of entries) {
      const mapped = typeToStatus[entry.type]
      if (mapped) {
        status = mapped
      }
    }

    return new ConcreteRunHandle<TOutput, TState>(runId, status, journal)
  }
}

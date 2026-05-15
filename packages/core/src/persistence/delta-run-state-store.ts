/**
 * DeltaRunStateStore — append-only delta state with periodic full snapshots.
 *
 * Inspired by Deep Agents v0.6 delta checkpoint channels: instead of
 * overwriting the full run state on every save, we append a compact diff
 * for growing fields (messages, cumulativeUsage) and overwrite scalar
 * fields. Every `fullSnapshotInterval` saves we also persist a full
 * snapshot so replay can seek to a nearby checkpoint rather than replaying
 * from the beginning.
 *
 * Layout (in-memory; subclass to back with Redis/Postgres):
 *   deltas.get(runId) → DeltaEntry[]   (in save order)
 *   snapshots.get(runId) → FullEntry[] (periodic, index aligned to delta seq)
 *
 * Replay contract: call `replay(runId)` to reconstruct the latest
 * DzupRunState by finding the nearest full snapshot and applying subsequent
 * deltas forward. This is O(N/K) where N = total deltas, K = snapshot
 * interval.
 */

import type { DzupRunState, DzupRunStateStore } from './run-state-store.js'
import type { BaseMessage } from '@langchain/core/messages'
import type { TokenUsage } from '../llm/invoke.js'

// ---------------------------------------------------------------------------
// Internal delta types
// ---------------------------------------------------------------------------

/** A single appended change record for a run. */
interface DeltaEntry {
  seq: number
  /** agentId of the run — stored once on the first delta for scratch-replay. */
  agentId: string
  /** Incremental message additions (messages appended since last delta). */
  newMessages: BaseMessage[]
  /** Incremental usage additions (usage records appended since last delta). */
  newUsage: TokenUsage[]
  /** Changed scalar fields stored as a plain object for easy spread. */
  scalars: Record<string, unknown>
  ts: number
}

/** A full snapshot anchored at a specific sequence number. */
interface FullEntry {
  seq: number
  state: DzupRunState
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface DeltaRunStateStoreOptions {
  /**
   * How often (in save calls) to persist a full snapshot.
   * Defaults to 10 — every 10th save writes a full copy.
   */
  fullSnapshotInterval?: number
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * In-memory delta-encoded run state store.
 *
 * `save()` records only the diff since the previous save. `load()` calls
 * `replay()` internally. Suitable for tests and single-process deployments;
 * extend or wrap with a durable backend for production use.
 */
export class DeltaRunStateStore implements DzupRunStateStore {
  private readonly deltas = new Map<string, DeltaEntry[]>()
  private readonly snapshots = new Map<string, FullEntry[]>()
  private readonly seqCounters = new Map<string, number>()
  private readonly prevState = new Map<string, DzupRunState>()
  private readonly fullSnapshotInterval: number

  constructor(options: DeltaRunStateStoreOptions = {}) {
    this.fullSnapshotInterval = options.fullSnapshotInterval ?? 10
  }

  async save(state: DzupRunState): Promise<void> {
    const { runId } = state
    const seq = (this.seqCounters.get(runId) ?? 0) + 1
    this.seqCounters.set(runId, seq)

    const prev = this.prevState.get(runId)

    // Compute message delta: new messages appended since last save.
    const prevMsgCount = prev?.messages.length ?? 0
    const newMessages = state.messages.slice(prevMsgCount)

    // Compute usage delta: new usage entries appended since last save.
    const prevUsageCount = prev?.cumulativeUsage.length ?? 0
    const newUsage = state.cumulativeUsage.slice(prevUsageCount)

    // Scalar diff: everything except growing arrays and immutable ids.
    // Use type assertion to bypass exactOptionalPropertyTypes on the mutable
    // accumulator — we only write defined values and spread into a full state
    // record at replay time where all fields are present.
    const scalars = {} as Record<string, unknown>
    if (state.iteration !== prev?.iteration) scalars['iteration'] = state.iteration
    if (state.tenantId !== prev?.tenantId) scalars['tenantId'] = state.tenantId
    if (state.budget !== prev?.budget) scalars['budget'] = state.budget
    if (state.stuckDetector !== prev?.stuckDetector) scalars['stuckDetector'] = state.stuckDetector
    if (state.pendingApproval !== prev?.pendingApproval) scalars['pendingApproval'] = state.pendingApproval
    if (state.terminalReason !== prev?.terminalReason) scalars['terminalReason'] = state.terminalReason
    scalars['snapshotAt'] = state.snapshotAt

    const entry: DeltaEntry = { seq, agentId: state.agentId, newMessages, newUsage, scalars, ts: Date.now() }

    const runDeltas = this.deltas.get(runId) ?? []
    runDeltas.push(entry)
    this.deltas.set(runId, runDeltas)

    // Periodic full snapshot.
    if (seq % this.fullSnapshotInterval === 0) {
      const runSnapshots = this.snapshots.get(runId) ?? []
      runSnapshots.push({ seq, state: cloneState(state) })
      this.snapshots.set(runId, runSnapshots)
    }

    this.prevState.set(runId, cloneState(state))
  }

  async load(runId: string): Promise<DzupRunState | undefined> {
    return this.replay(runId)
  }

  async delete(runId: string): Promise<void> {
    this.deltas.delete(runId)
    this.snapshots.delete(runId)
    this.seqCounters.delete(runId)
    this.prevState.delete(runId)
  }

  async listRunIds(): Promise<string[]> {
    return [...this.deltas.keys()]
  }

  // ---------------------------------------------------------------------------
  // Replay
  // ---------------------------------------------------------------------------

  /**
   * Reconstruct the latest DzupRunState for a run by:
   * 1. Finding the nearest full snapshot at or before the target seq.
   * 2. Applying all deltas after that snapshot's seq in order.
   *
   * The target seq defaults to the most recent delta (full replay).
   */
  async replay(runId: string, targetSeq?: number): Promise<DzupRunState | undefined> {
    const runDeltas = this.deltas.get(runId)
    if (!runDeltas || runDeltas.length === 0) return undefined

    const maxSeq = targetSeq ?? runDeltas[runDeltas.length - 1]!.seq

    // Find the nearest full snapshot at or before maxSeq.
    const runSnapshots = this.snapshots.get(runId) ?? []
    let base: DzupRunState | undefined
    let baseSeq = 0
    for (const snap of runSnapshots) {
      if (snap.seq <= maxSeq && snap.seq >= baseSeq) {
        base = cloneState(snap.state)
        baseSeq = snap.seq
      }
    }

    // Apply deltas from baseSeq+1 up to maxSeq.
    const deltasToApply = runDeltas.filter(d => d.seq > baseSeq && d.seq <= maxSeq)

    if (!base && deltasToApply.length === 0) return undefined

    // If no snapshot found, we need the initial identity; synthesise it from
    // the first delta's scalars + empty arrays.
    let state: DzupRunState
    if (base) {
      state = base
    } else {
      // Reconstruct from scratch using first delta (must contain all scalars).
      // Apply first delta's messages/usage directly into the base state.
      const first = deltasToApply[0]!
      state = {
        version: 1,
        runId,
        agentId: first.agentId,
        messages: [...first.newMessages],
        cumulativeUsage: [...first.newUsage],
        iteration: (first.scalars['iteration'] as number | undefined) ?? 0,
        snapshotAt: (first.scalars['snapshotAt'] as number | undefined) ?? first.ts,
        ...first.scalars,
      } as DzupRunState
      deltasToApply.shift()
    }

    for (const delta of deltasToApply) {
      state = {
        ...state,
        ...delta.scalars,
        messages: [...state.messages, ...delta.newMessages],
        cumulativeUsage: [...state.cumulativeUsage, ...delta.newUsage],
      }
    }

    return state
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  /** Number of delta entries stored for a run (for testing/ops). */
  deltaCount(runId: string): number {
    return this.deltas.get(runId)?.length ?? 0
  }

  /** Number of full snapshots stored for a run (for testing/ops). */
  snapshotCount(runId: string): number {
    return this.snapshots.get(runId)?.length ?? 0
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cloneState(state: DzupRunState): DzupRunState {
  return {
    ...state,
    messages: [...state.messages],
    cumulativeUsage: [...state.cumulativeUsage],
    ...(state.budget ? { budget: { ...state.budget, emittedThresholds: [...state.budget.emittedThresholds] } } : {}),
    ...(state.stuckDetector ? { stuckDetector: { ...state.stuckDetector, recentCallKeys: [...state.stuckDetector.recentCallKeys] } } : {}),
    ...(state.pendingApproval ? { pendingApproval: { ...state.pendingApproval } } : {}),
  }
}

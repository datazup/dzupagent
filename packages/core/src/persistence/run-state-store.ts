/**
 * DzupRunState — unified, serialisable snapshot of an agent run.
 *
 * Phase 1 of MC-AGT-04: introduces the snapshot interface and the
 * {@link DzupRunStateStore} contract. The agent run loop writes a
 * snapshot at iteration boundaries (and on suspension/termination)
 * when a store is configured. Subsequent phases replace the per-
 * subsystem stores (approvals, journal, budget) with this unified
 * surface.
 *
 * Snapshots are intentionally serialisable: the message history is
 * captured as raw LangChain `BaseMessage` instances (which serialise
 * cleanly to/from JSON via LangChain's standard mappers) and budget /
 * stuck-detector state are reduced to small POJOs that can be
 * transported across processes or persisted to disk.
 */
import type { BaseMessage } from '@langchain/core/messages'
import type { TokenUsage } from '../llm/invoke.js'

/** Serialisable snapshot of a stopped/paused agent run. */
export interface DzupRunState {
  version: 1
  runId: string
  agentId: string
  tenantId?: string
  /** Full message history at the snapshot point (serialisable LC messages). */
  messages: BaseMessage[]
  /** Current iteration count. */
  iteration: number
  /** Cumulative token usage across all invocations. */
  cumulativeUsage: TokenUsage[]
  /** Snapshot of the budget state (iteration counts, thresholds emitted). */
  budget?: BudgetSnapshot
  /** Snapshot of the stuck-detector state (call counts, error rates). */
  stuckDetector?: StuckDetectorSnapshot
  /** Pending approval context (if the run is suspended awaiting approval). */
  pendingApproval?: {
    approvalId: string
    requestedAt: number
    timeoutMs?: number
  }
  /** Terminal reason if the run ended. */
  terminalReason?: string
  /** Wall-clock time of snapshot creation (ms since epoch). */
  snapshotAt: number
}

/** Minimal serialisable budget state. */
export interface BudgetSnapshot {
  iterations: number
  emittedThresholds: number[]
}

/** Minimal serialisable stuck-detector state. */
export interface StuckDetectorSnapshot {
  recentCallKeys: string[]
  errorCount: number
}

/** Store contract for DzupRunState snapshots. */
export interface DzupRunStateStore {
  /** Write or overwrite the snapshot for a run. */
  save(state: DzupRunState): Promise<void>
  /** Retrieve the latest snapshot for a run, or undefined if not found. */
  load(runId: string): Promise<DzupRunState | undefined>
  /** Delete the snapshot for a run. */
  delete(runId: string): Promise<void>
  /** List all run IDs with snapshots (for ops/debug). */
  listRunIds(): Promise<string[]>
}

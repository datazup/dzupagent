/**
 * @dzupagent/core/persistence — Checkpointer, sessions, working memory,
 * run journals, run state snapshots, run record store, event log.
 *
 * @example
 * ```ts
 * import {
 *   createCheckpointer,
 *   InMemoryRunStore,
 *   InMemoryRunJournal,
 * } from '@dzupagent/core/persistence'
 * ```
 */

// ---------------------------------------------------------------------------
// Checkpointer + sessions + working memory
// ---------------------------------------------------------------------------
export { createCheckpointer } from "./persistence/checkpointer.js";
export type { CheckpointerConfig } from "./persistence/checkpointer.js";
export { SessionManager } from "./persistence/session.js";
export {
  WorkingMemory,
  createWorkingMemory,
} from "./persistence/working-memory.js";
export type {
  WorkingMemoryConfig,
  WorkingMemorySnapshot,
} from "./persistence/working-memory-types.js";

// ---------------------------------------------------------------------------
// Run + agent execution stores
// ---------------------------------------------------------------------------
export {
  InMemoryRunStore,
  InMemoryAgentStore,
} from "./persistence/in-memory-store.js";
export type {
  RunStore,
  Run,
  CreateRunInput,
  RunFilter,
  RunStatus,
  LogEntry,
  AgentExecutionSpecStore,
  AgentExecutionSpec,
  AgentExecutionSpecFilter,
} from "./persistence/store-interfaces.js";

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------
export { InMemoryEventLog, EventLogSink } from "./persistence/event-log.js";
export type { RunEvent, EventLogStore } from "./persistence/event-log.js";

// ---------------------------------------------------------------------------
// Run journal
// ---------------------------------------------------------------------------
export { InMemoryRunJournal } from "./persistence/in-memory-run-journal.js";
export { RunJournalBridgeRunStore } from "./persistence/run-journal-bridge.js";
export {
  InMemoryDurableNodeLedger,
  FencedOutError,
} from "./persistence/durable-node-ledger.js";
export type {
  DurableNodeLedger,
  DurableNodeLease,
  DurableNodeCompletion,
  DurableNodeFailure,
  DurableNodeStatus,
  LedgerIdempotencyMode,
} from "./persistence/durable-node-ledger.js";
export {
  createEntryBase,
  isTerminalEntry,
  deserializeEntry,
} from "./persistence/run-journal.js";
export type {
  RunJournalEntryType,
  RunJournalEntryBase,
  RunJournalEntry,
  RunStartedEntry,
  StepStartedEntry,
  StepCompletedEntry,
  StepFailedEntry,
  StateUpdatedEntry,
  RunCompletedEntry,
  RunFailedEntry,
  RunPausedEntry,
  RunResumedEntry,
  RunSuspendedEntry,
  RunCancelledEntry,
  SnapshotEntry,
  UnknownEntry,
  RunJournalQuery,
  RunJournalPage,
  RunJournal,
  RunJournalConfig,
} from "./persistence/run-journal-types.js";

// ---------------------------------------------------------------------------
// Run state snapshot (MC-AGT-04 Phase 1)
// ---------------------------------------------------------------------------
export { InMemoryRunStateStore } from "./persistence/in-memory-run-state-store.js";
export type {
  DzupRunState,
  DzupRunStateStore,
  BudgetSnapshot,
  StuckDetectorSnapshot,
} from "./persistence/run-state-store.js";

// ---------------------------------------------------------------------------
// Run record persistence (legacy LLM execution records)
// ---------------------------------------------------------------------------
export { InMemoryRunRecordStore } from "./persistence/in-memory-run-store.js";
export type {
  RunRecordStore,
  RunRecord,
  StoredRunEvent,
  RunFilters,
  RunStatus as RunRecordStatus,
} from "./persistence/run-store.js";

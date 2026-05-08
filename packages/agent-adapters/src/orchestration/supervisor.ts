/**
 * SupervisorOrchestrator -- Supervisor multi-agent pattern.
 *
 * A supervisor decomposes a goal into subtasks and delegates each to the
 * best-suited adapter via the ProviderAdapterRegistry. Dependencies between
 * subtasks are respected: independent subtasks run in parallel (up to
 * `maxConcurrentDelegations`), while dependent subtasks wait for their
 * prerequisites to complete.
 *
 * Events emitted (all defined in @dzupagent/core DzupEvent):
 *   supervisor:plan_created
 *   supervisor:delegating
 *   supervisor:delegation_complete
 *
 * This module is now a thin coordinator that re-exports the focused
 * sibling modules:
 *   - `supervisor-types.ts`         — shared types
 *   - `supervisor-decomposition.ts` — `KeywordTaskDecomposer`
 *   - `supervisor-feedback.ts`      — event-bus emission helpers
 *   - `supervisor-executor.ts`      — `SupervisorOrchestrator` class
 */

export { KeywordTaskDecomposer } from './supervisor-decomposition.js'
export { SupervisorOrchestrator } from './supervisor-executor.js'
export type {
  SubTask,
  SubTaskResult,
  SupervisorConfig,
  SupervisorLifecycleEvent,
  SupervisorOptions,
  SupervisorResult,
  TaskDecomposer,
} from './supervisor-types.js'

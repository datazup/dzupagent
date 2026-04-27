/**
 * @dzupagent/agent-adapters/persistence
 *
 * Persistence plane: file-backed checkpoint stores, run manager, and run event store.
 */

export { FileCheckpointStore } from './persistence/persistent-checkpoint-store.js'
export type { FileCheckpointStoreConfig } from './persistence/persistent-checkpoint-store.js'

export { RunManager } from './persistence/run-manager.js'
export type {
  AdapterRun,
  RunStatus,
  RunManagerConfig,
  RunStats,
} from './persistence/run-manager.js'

export { RunEventStore } from './runs/run-event-store.js'
export { runLogRoot } from './runs/run-log-root.js'
export type {
  RawAgentEvent,
  ProviderRawStreamEvent,
  AgentArtifactEvent,
  RunSummary,
} from '@dzupagent/adapter-types'

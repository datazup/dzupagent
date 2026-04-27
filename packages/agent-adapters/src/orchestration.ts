/**
 * @dzupagent/agent-adapters/orchestration
 *
 * Multi-agent orchestration plane: facade, supervisors, parallel/map-reduce/contract-net
 * patterns, sessions, context routing, and the agent integration bridge.
 */

// --- Facade ---
export { OrchestratorFacade, createOrchestrator } from './facade/orchestrator-facade.js'
export type { OrchestratorConfig } from './facade/orchestrator-facade.js'

// --- Orchestration patterns ---
export { SupervisorOrchestrator, KeywordTaskDecomposer } from './orchestration/supervisor.js'
export type {
  SupervisorConfig,
  SupervisorOptions,
  SupervisorResult,
  SubTask,
  SubTaskResult,
  TaskDecomposer,
} from './orchestration/supervisor.js'
export { ParallelExecutor } from './orchestration/parallel-executor.js'
export type {
  ParallelExecutorConfig,
  ParallelExecutionOptions,
  ParallelExecutionResult,
  ProviderResult,
  MergeStrategy,
} from './orchestration/parallel-executor.js'
export { MapReduceOrchestrator, LineChunker, DirectoryChunker } from './orchestration/map-reduce.js'
export type {
  MapReduceConfig,
  MapReduceOptions,
  MapReduceResult,
  MapChunkResult,
  Chunker,
  MapperFn,
  ReducerFn,
} from './orchestration/map-reduce.js'
export { ContractNetOrchestrator, StaticBidStrategy } from './orchestration/contract-net.js'
export type {
  ContractNetConfig,
  ContractNetOptions,
  ContractNetResult,
  Bid,
  BidStrategy,
  BidSelectionCriteria,
} from './orchestration/contract-net.js'

// --- Session & State Management ---
export { SessionRegistry } from './session/session-registry.js'
export type {
  WorkflowSession,
  ProviderSession,
  ConversationEntry,
  SessionRegistryConfig,
  MultiTurnOptions,
} from './session/session-registry.js'
export { WorkflowCheckpointer, InMemoryCheckpointStore } from './session/workflow-checkpointer.js'
export type {
  WorkflowCheckpoint,
  StepDefinition,
  StepResult,
  SerializedProviderSession,
  CheckpointStore,
  CheckpointerConfig,
} from './session/workflow-checkpointer.js'
export { ConversationCompressor } from './session/conversation-compressor.js'
export type { ConversationTurn, ConversationCompressorOptions } from './session/conversation-compressor.js'
export { DefaultCompactionStrategy } from './session/compaction-strategy.js'
export type {
  CompactionStrategy,
  CompactionRequest,
  CompactionType,
  CompactionSessionInfo,
  DefaultCompactionConfig,
} from './session/compaction-strategy.js'

// --- Event Bus Bridge ---
export { EventBusBridge } from './registry/event-bus-bridge.js'

// --- Context-Aware Routing ---
export { ContextAwareRouter, ContextInjectionMiddleware } from './context/context-aware-router.js'
export type {
  ContextEstimate,
  ContextAwareRouterConfig,
  ContextInjection,
  ContextInjectionConfig,
} from './context/context-aware-router.js'

// --- Integration Bridge ---
export { AgentIntegrationBridge, AdapterAsToolWrapper } from './integration/agent-bridge.js'
export type {
  AdapterToolConfig,
  ToolInvocationResult,
  AdapterToolSchema,
  ToolInvocationArgs,
} from './integration/agent-bridge.js'
export { RegistryExecutionPort } from './integration/index.js'

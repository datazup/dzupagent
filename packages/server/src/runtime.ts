/**
 * @dzupagent/server/runtime — runtime / control-plane facade.
 *
 * This subpath consolidates run-execution workers, run lifecycle helpers,
 * trace stores, control-plane services, and tool/agent resolution helpers.
 * It is intended for hosts that embed the run worker or wire custom executors
 * without pulling the entire root API.
 *
 * The root `@dzupagent/server` entrypoint continues to re-export these symbols
 * (deprecated) during the migration compatibility window.
 */

// --- Run worker / executors ---
export { startRunWorker } from './runtime/run-worker.js'
export { createDefaultRunExecutor } from './runtime/default-run-executor.js'
export { createDzupAgentRunExecutor } from './runtime/dzip-agent-run-executor.js'
export type {
  RunExecutionContext,
  RunExecutor,
  StartRunWorkerOptions,
  RunExecutorResult,
  RunReflectorLike,
  ReflectionInput,
  ReflectionScore,
  ReflectionDimensions,
} from './runtime/run-worker.js'
export type { DzupAgentRunExecutorOptions } from './runtime/dzip-agent-run-executor.js'

// --- Tool resolution ---
export { resolveAgentTools, ToolResolutionError, getToolProfileConfig } from './runtime/tool-resolver.js'
export type {
  ToolResolverContext,
  ToolResolverResult,
  ToolResolverOptions,
  ToolSource,
  CustomToolResolver,
  ToolProfile,
  ToolProfileConfig,
} from './runtime/tool-resolver.js'

// --- Runtime utilities ---
export { isStructuredResult } from './runtime/utils.js'

// --- Consolidation scheduler ---
export { ConsolidationScheduler } from './runtime/consolidation-scheduler.js'
export type {
  ConsolidationTask,
  ConsolidationReport,
  ConsolidationSchedulerConfig,
} from './runtime/consolidation-scheduler.js'

// --- Run trace stores ---
export { InMemoryRunTraceStore, computeStepDistribution } from './persistence/run-trace-store.js'
export { DrizzleRunTraceStore } from './persistence/drizzle-run-trace-store.js'
export type {
  TraceStep,
  RunTrace,
  TraceStepDistribution,
  RunTraceStore,
  InMemoryRunTraceStoreOptions,
} from './persistence/run-trace-store.js'

// --- Control plane services ---
export { AgentControlPlaneService } from './services/agent-control-plane-service.js'
export type { AgentControlPlaneServiceConfig } from './services/agent-control-plane-service.js'
export {
  ControlPlaneExecutableAgentResolver,
  AgentStoreExecutableAgentResolver,
} from './services/executable-agent-resolver.js'
export type { ExecutableAgentResolver } from './services/executable-agent-resolver.js'

// --- Lifecycle helpers (advanced) ---
export { HumanContactTimeoutScheduler } from './lifecycle/human-contact-timeout.js'
export type { HumanContactTimeoutConfig } from './lifecycle/human-contact-timeout.js'

// --- Event streaming adapters ---
export { streamRunHandleToSSE } from './streaming/sse-streaming-adapter.js'
export type { SSEStreamLike, StreamRunHandleToSSEOptions } from './streaming/sse-streaming-adapter.js'

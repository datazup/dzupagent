/**
 * @dzupagent/agent/runtime — embeddable agent runtime facade.
 *
 * Use this subpath for hosts that need concrete run handles, tool-loop
 * execution, context compression, or pipeline runtime primitives. Root exports
 * continue to re-export these APIs during the migration window.
 */

export { DzupAgent } from './agent/dzip-agent.js'
export { createAgentWithMemory } from './agent/agent-factory.js'
export type {
  DzupAgentConfig,
  AgentMailboxConfig,
  ArrowMemoryConfig,
  GenerateOptions,
  GenerateResult,
  AgentStreamEvent,
  CompressionLogEntry,
  ToolExecutionConfig,
  PerToolTimeoutMap,
  ArgumentValidator,
  ToolTracer,
} from './agent/agent-types.js'
export { getMemoryProfilePreset, resolveArrowMemoryConfig } from './agent/memory-profiles.js'
export type { MemoryProfile, MemoryProfilePreset } from './agent/memory-profiles.js'
export { runToolLoop } from './agent/tool-loop.js'
export type { ToolLoopConfig, ToolLoopResult, ToolStat, StopReason } from './agent/tool-loop.js'
export {
  TOOL_TIMEOUT_ERROR_CODE,
  ToolTimeoutError,
  isToolTimeoutError,
} from './agent/tool-timeout-error.js'
export {
  InvalidRunStateError,
  CheckpointExpiredError,
  ForkLimitExceededError,
  RunNotFoundError,
} from './agent/run-handle-types.js'
export type {
  RunHandle,
  RunResult,
  LaunchOptions,
  Unsubscribe,
  CheckpointInfo,
} from './agent/run-handle-types.js'
export { ConcreteRunHandle } from './agent/run-handle.js'
export { executeToolsParallel } from './agent/parallel-executor.js'
export type {
  ParallelToolCall,
  ToolExecutionResult,
  ToolLookup,
  ParallelExecutorOptions,
} from './agent/parallel-executor.js'
export { validateAndRepairToolArgs, formatSchemaHint } from './agent/tool-arg-validator.js'
export type { ValidationResult, ToolArgValidatorConfig } from './agent/tool-arg-validator.js'
export { autoCompress, FrozenSnapshot } from './context/auto-compress.js'
export type { AutoCompressConfig, CompressResult } from './context/auto-compress.js'
export { withTokenLifecycle } from './context/token-lifecycle-integration.js'
export type {
  TokenLifecycleHooks,
  TokenLifecyclePhase,
  TokenPressureListener,
} from './context/token-lifecycle-integration.js'
export * from './pipeline/index.js'
export * from './observability/index.js'


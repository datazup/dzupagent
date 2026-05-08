/**
 * Core types for DzupAgent — the top-level agent abstraction.
 *
 * This file is a thin barrel (MC-029): all type definitions live in focused
 * sibling modules and are re-exported from here so existing import paths
 * (`@dzupagent/agent/agent/agent-types`) continue to work unchanged.
 *
 * Logical groupings:
 * - `agent-types-config`         — {@link DzupAgentConfig} (composes the slices below)
 * - `agent-types-memory`         — memory wiring slice + helper interfaces
 * - `agent-types-observability`  — audit / fallback / tokenizer slice
 * - `agent-types-security`       — OWASP content scanning configuration
 * - `agent-types-tool-execution` — {@link ToolExecutionConfig} + helpers
 * - `agent-types-failover`       — {@link ProviderFailoverPolicy}
 * - `agent-types-mailbox`        — {@link AgentMailboxConfig}
 * - `agent-types-generate`       — {@link GenerateOptions}, {@link GenerateResult},
 *                                  {@link CompressionLogEntry}, {@link AgentStreamEvent}
 */

export type { ArrowMemoryConfig } from './arrow-memory-types.js'

export type { DzupAgentConfig } from './agent-types-config.js'

export type {
  MemoryConfigSlice,
  MemoryPolicyConfig,
  MemoryContextLimitsConfig,
} from './agent-types-memory.js'

export type {
  ObservabilityConfigSlice,
  FallbackDetailEvent,
} from './agent-types-observability.js'

export type {
  SecurityConfig,
  PromptInjectionMode,
  PiiScanMode,
} from './agent-types-security.js'

export type {
  PerToolTimeoutMap,
  ArgumentValidator,
  ToolTracer,
  ToolExecutionConfig,
} from './agent-types-tool-execution.js'

export type { ProviderFailoverPolicy } from './agent-types-failover.js'

export type { AgentMailboxConfig } from './agent-types-mailbox.js'

export type {
  GenerateOptions,
  CompressionLogEntry,
  GenerateResult,
  AgentStreamEvent,
} from './agent-types-generate.js'

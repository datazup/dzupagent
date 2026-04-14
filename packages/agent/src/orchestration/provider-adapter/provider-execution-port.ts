/**
 * ProviderExecutionPort — dependency-inverted interface that
 * `@dzupagent/agent` exposes for provider-adapter execution.
 *
 * This module imports ONLY from `@dzupagent/adapter-types` (a pure type
 * package). It does NOT import from `@dzupagent/agent-adapters`.
 *
 * Consumers (e.g. `@dzupagent/agent-adapters`) implement this port
 * and inject it into orchestration configs. This keeps the dependency
 * arrow pointing inward: adapters depend on agent, not vice-versa.
 */

import type {
  AgentInput,
  AgentEvent,
  TaskDescriptor,
  AdapterProviderId,
} from '@dzupagent/adapter-types'

// Re-export adapter-types used by consumers of this port
export type { AgentInput, AgentEvent, TaskDescriptor, AdapterProviderId }

/** Result returned by `ProviderExecutionPort.run()`. */
export interface ProviderExecutionResult {
  /** The final content/output produced by the provider */
  content: string
  /** The provider that ultimately handled the task */
  providerId: AdapterProviderId
  /** All providers that were attempted (in order) */
  attemptedProviders: AdapterProviderId[]
  /** Number of fallback attempts before success (0 = first provider succeeded) */
  fallbackAttempts: number
}

/**
 * Port interface for routing execution through external provider adapters.
 *
 * Implementations live in `@dzupagent/agent-adapters` or third-party packages.
 * The orchestrator calls this port when `executionMode` is `'provider-adapter'`.
 */
export interface ProviderExecutionPort {
  /**
   * Stream execution events from a provider adapter.
   *
   * Yields unified `AgentEvent` objects as the adapter processes the task.
   * Supports cancellation via `options.signal`.
   */
  stream(
    input: AgentInput,
    task: TaskDescriptor,
    options?: { runId?: string; signal?: AbortSignal },
  ): AsyncGenerator<AgentEvent, void, undefined>

  /**
   * Run a task to completion and return the aggregated result.
   *
   * Internally consumes the event stream and extracts the final content.
   * Supports cancellation via `options.signal`.
   */
  run(
    input: AgentInput,
    task: TaskDescriptor,
    options?: { runId?: string; signal?: AbortSignal },
  ): Promise<ProviderExecutionResult>
}

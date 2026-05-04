/**
 * ProviderExecutionPort — dependency-inverted interface that
 * the agent orchestration layer exposes for provider-adapter execution.
 *
 * This is the canonical home for the port definition. It lives in
 * `@dzupagent/adapter-types` (a layer-0 type-only package) so that:
 *
 *   - `@dzupagent/agent` (orchestrator) can declare it as a port
 *   - `@dzupagent/agent-adapters` (implementation) can implement it
 *   - Third-party adapter packages can implement it without depending
 *     on the full agent package
 *
 * The dependency arrow always points inward to this layer-0 contract.
 */
import type { AgentInput } from './contracts/execution.js'
import type { AgentEvent } from './contracts/events.js'
import type { TaskDescriptor } from './contracts/routing.js'
import type { AdapterProviderId } from './contracts/provider.js'

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
  /** Additional provider-neutral execution metadata */
  metadata?: Record<string, unknown>
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

/**
 * Module-level helpers extracted from OrchestratorFacade to keep the class
 * body small and focused. All helpers are pure / stateless and accept their
 * dependencies as arguments.
 */

import { ForgeError } from '@dzupagent/core/events'

import type { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterProviderId,
  AgentCompletedEvent,
  AgentEvent,
  AgentInput,
  TaskDescriptor,
} from '../types.js'
import { resolveFallbackProviderId } from '../utils/provider-helpers.js'

import type { ChatOptions, RunOptions, RunResult } from './orchestrator-facade-types.js'

export function resolveRunFallbackProviderId(
  registry: { listAdapters(): AdapterProviderId[] },
  preferredProvider?: AdapterProviderId,
  lastFailureProviderId?: AdapterProviderId,
): AdapterProviderId {
  return lastFailureProviderId
    ?? preferredProvider
    ?? resolveFallbackProviderId(registry.listAdapters())
    ?? ('unknown' as AdapterProviderId)
}

export function buildRunInput(prompt: string, options: RunOptions | undefined, signal: AbortSignal): AgentInput {
  return {
    prompt,
    workingDirectory: options?.workingDirectory,
    systemPrompt: options?.systemPrompt,
    maxTurns: options?.maxTurns,
    signal,
  }
}

export function buildRunTask(prompt: string, options: RunOptions | undefined): TaskDescriptor {
  return {
    prompt,
    tags: options?.tags ?? [],
    preferredProvider: options?.preferredProvider,
    workingDirectory: options?.workingDirectory,
  }
}

export function buildChatInput(prompt: string, options: ChatOptions | undefined): AgentInput {
  const adapterOptions: Record<string, unknown> = {}
  if (options?.temperature != null) adapterOptions.temperature = options.temperature
  if (options?.maxTokens != null) adapterOptions.maxTokens = options.maxTokens
  if (options?.topP != null) adapterOptions.topP = options.topP
  if (options?.reasoning != null) adapterOptions.reasoning = options.reasoning
  if (options?.timeoutMs != null) adapterOptions.timeoutMs = options.timeoutMs
  return {
    prompt,
    workingDirectory: options?.workingDirectory,
    systemPrompt: options?.systemPrompt,
    maxTurns: options?.maxTurns,
    ...(Object.keys(adapterOptions).length > 0 && { options: adapterOptions }),
  }
}

export interface HandleRunErrorContext {
  registry: ProviderAdapterRegistry
  startMs: number
  timeoutMs: number
  timeoutAborted: boolean
  task: TaskDescriptor
  lastFailure: Extract<AgentEvent, { type: 'adapter:failed' }> | undefined
  completion: AgentCompletedEvent | undefined
}

export function handleRunError(err: unknown, ctx: HandleRunErrorContext): RunResult {
  if (ctx.timeoutAborted) {
    const elapsed = Date.now() - ctx.startMs
    const providerId = resolveRunFallbackProviderId(
      ctx.registry,
      ctx.task.preferredProvider,
      ctx.lastFailure?.providerId,
    )
    throw new ForgeError({
      code: 'ADAPTER_EXECUTION_FAILED',
      message: `Adapter timed out after ${elapsed}ms (limit: ${ctx.timeoutMs}ms)`,
      recoverable: false,
      context: { source: 'OrchestratorFacade.run', providerId, timeoutMs: ctx.timeoutMs },
    })
  }
  if (ForgeError.is(err) && err.code === 'AGENT_ABORTED') {
    return {
      result: '',
      providerId: resolveRunFallbackProviderId(
        ctx.registry,
        ctx.task.preferredProvider,
        ctx.lastFailure?.providerId,
      ),
      durationMs: Date.now() - ctx.startMs,
      usage: ctx.completion?.usage,
      cancelled: true,
      error: err.message,
    }
  }
  throw err
}

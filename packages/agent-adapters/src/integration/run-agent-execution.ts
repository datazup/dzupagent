import { ForgeError } from '@dzupagent/core/events'

import { createClaudeAdapter } from '../claude/claude-adapter.js'
import { createCodexAdapter } from '../codex/codex-adapter.js'
import { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterConfig,
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentFailedEvent,
  AgentInput,
  InteractionPolicy,
  TaskDescriptor,
  TokenUsage,
} from '../types.js'

export type AgentExecutionProviderId = Extract<AdapterProviderId, 'codex' | 'claude'>
export type AgentExecutionReasoning = NonNullable<AdapterConfig['reasoning']>
export type AgentExecutionSandboxMode = NonNullable<AdapterConfig['sandboxMode']>

export interface AgentExecutionRequest {
  providerId?: AgentExecutionProviderId | undefined
  /** Explicit legacy cross-provider fallback authorization. */
  approvedFallbackProviders?: AgentExecutionProviderId[] | undefined
  prompt: string
  workingDirectory?: string | undefined
  model?: string | undefined
  reasoning?: AgentExecutionReasoning | undefined
  timeoutMs?: number | undefined
  correlationId?: string | undefined
  runId?: string | undefined
  packetId?: string | undefined
  sandboxMode?: AgentExecutionSandboxMode | undefined
  interactionPolicy?: InteractionPolicy | undefined
}

export interface AgentExecutionError {
  code: string
  message: string
  providerId?: AdapterProviderId | undefined
}

export interface AgentExecutionResult {
  ok: boolean
  providerId?: AdapterProviderId | undefined
  model?: string | undefined
  text: string
  events: AgentEvent[]
  usage?: TokenUsage | undefined
  durationMs: number
  attemptedProviders: AdapterProviderId[]
  error?: AgentExecutionError | undefined
  code?: string | undefined
}

export interface RunAgentExecutionOptions {
  registry?: ProviderAdapterRegistry | undefined
  adapters?: AgentCLIAdapter[] | undefined
  now?: (() => number) | undefined
}

function createDefaultRegistry(request: AgentExecutionRequest): ProviderAdapterRegistry {
  const registry = new ProviderAdapterRegistry({ executionTimeoutMs: request.timeoutMs })
  const config = projectAdapterConfig(request)
  registry.registerProductionAdapters([
    createCodexAdapter(config),
    createClaudeAdapter(config),
  ])
  return registry
}

function resolveRegistry(
  request: AgentExecutionRequest,
  options: RunAgentExecutionOptions,
): ProviderAdapterRegistry {
  const registry = options.registry ?? new ProviderAdapterRegistry({ executionTimeoutMs: request.timeoutMs })

  if (options.adapters) {
    registry.registerProductionAdapters(options.adapters)
  }

  if (!options.registry && !options.adapters) {
    return createDefaultRegistry(request)
  }

  return registry
}

function projectAdapterConfig(request: AgentExecutionRequest): AdapterConfig {
  const providerOptions: Record<string, unknown> = {}
  if (request.runId) providerOptions['runId'] = request.runId
  if (request.packetId) providerOptions['packetId'] = request.packetId
  if (request.correlationId) providerOptions['correlationId'] = request.correlationId

  return {
    ...(request.model ? { model: request.model } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    ...(request.workingDirectory ? { workingDirectory: request.workingDirectory } : {}),
    ...(request.sandboxMode ? { sandboxMode: request.sandboxMode } : {}),
    ...(request.reasoning ? { reasoning: request.reasoning } : {}),
    ...(request.interactionPolicy ? { interactionPolicy: request.interactionPolicy } : {}),
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
  }
}

function projectAgentInput(request: AgentExecutionRequest): AgentInput {
  const options: Record<string, unknown> = {}
  if (request.timeoutMs !== undefined) options['timeoutMs'] = request.timeoutMs
  if (request.model) options['model'] = request.model
  if (request.reasoning) options['reasoning'] = request.reasoning
  if (request.sandboxMode) options['sandboxMode'] = request.sandboxMode
  if (request.runId) options['runId'] = request.runId
  if (request.packetId) options['packetId'] = request.packetId
  if (request.interactionPolicy) options['interactionPolicy'] = request.interactionPolicy

  return {
    prompt: request.prompt,
    ...(request.workingDirectory ? { workingDirectory: request.workingDirectory } : {}),
    ...(request.correlationId ? { correlationId: request.correlationId } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  }
}

function projectTaskDescriptor(request: AgentExecutionRequest): TaskDescriptor {
  return {
    prompt: request.prompt,
    tags: ['agent-execution', 'execute', 'code'],
    ...(request.providerId ? { preferredProvider: request.providerId } : {}),
    ...(request.approvedFallbackProviders ? { approvedFallbackProviders: request.approvedFallbackProviders } : {}),
    requiresExecution: true,
    ...(request.reasoning === 'high' ? { requiresReasoning: true } : {}),
    ...(request.workingDirectory ? { workingDirectory: request.workingDirectory } : {}),
  }
}

function collectProviderId(event: AgentEvent, attempted: Set<AdapterProviderId>): void {
  if ('providerId' in event) attempted.add(event.providerId)
}

function extractFailure(err: unknown, failedEvent: AgentFailedEvent | undefined): AgentExecutionError {
  if (failedEvent) {
    return {
      code: failedEvent.code ?? 'ADAPTER_EXECUTION_FAILED',
      message: failedEvent.error,
      providerId: failedEvent.providerId,
    }
  }

  if (ForgeError.is(err)) {
    return {
      code: err.code,
      message: err.message,
    }
  }

  return {
    code: 'ADAPTER_EXECUTION_FAILED',
    message: err instanceof Error ? err.message : String(err),
  }
}

export async function runAgentExecution(
  request: AgentExecutionRequest,
  options: RunAgentExecutionOptions = {},
): Promise<AgentExecutionResult> {
  const now = options.now ?? Date.now
  const startMs = now()
  const registry = resolveRegistry(request, options)
  const input = projectAgentInput(request)
  const task = projectTaskDescriptor(request)
  const events: AgentEvent[] = []
  const attempted = new Set<AdapterProviderId>()
  let lastFailedEvent: AgentFailedEvent | undefined

  try {
    for await (const event of registry.executeWithFallback(input, task)) {
      events.push(event)
      collectProviderId(event, attempted)

      if (event.type === 'adapter:failed') {
        lastFailedEvent = event
      }

      if (event.type === 'adapter:completed') {
        return {
          ok: true,
          providerId: event.providerId,
          ...(request.model ? { model: request.model } : {}),
          text: event.result,
          events,
          ...(event.usage ? { usage: event.usage } : {}),
          durationMs: now() - startMs,
          attemptedProviders: [...attempted],
        }
      }
    }

    const error: AgentExecutionError = {
      code: lastFailedEvent?.code ?? 'ADAPTER_EXECUTION_FAILED',
      message: lastFailedEvent?.error ?? 'Adapter stream ended without adapter:completed',
      ...(lastFailedEvent ? { providerId: lastFailedEvent.providerId } : {}),
    }

    return {
      ok: false,
      ...(lastFailedEvent ? { providerId: lastFailedEvent.providerId } : {}),
      ...(request.model ? { model: request.model } : {}),
      text: '',
      events,
      durationMs: now() - startMs,
      attemptedProviders: [...attempted],
      error,
      code: error.code,
    }
  } catch (err: unknown) {
    const error = extractFailure(err, lastFailedEvent)
    return {
      ok: false,
      ...(error.providerId ? { providerId: error.providerId } : {}),
      ...(request.model ? { model: request.model } : {}),
      text: '',
      events,
      durationMs: now() - startMs,
      attemptedProviders: [...attempted],
      error,
      code: error.code,
    }
  }
}

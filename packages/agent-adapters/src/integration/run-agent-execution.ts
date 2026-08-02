import { ForgeError } from '@dzupagent/core/events'
import type { McpServerDescriptor } from '@dzupagent/runtime-contracts'

import { createClaudeBackendAdapter } from '../claude/claude-backend.js'
import { createCodexBackendAdapter } from '../codex/codex-backend.js'
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
export type AgentExecutionBackend = 'cli' | 'sdk'
export type AgentExecutionAuthMode = 'subscription_cli' | 'api_key'
export type AgentExecutionReasoning = NonNullable<AdapterConfig['reasoning']>
export type AgentExecutionSandboxMode = NonNullable<AdapterConfig['sandboxMode']>

export interface AgentExecutionRequest {
  providerId?: AgentExecutionProviderId | undefined
  /** Required when this runner materializes an adapter. Never inferred from providerId. */
  backend?: AgentExecutionBackend | undefined
  /** Required when this runner materializes an adapter. */
  authMode?: AgentExecutionAuthMode | undefined
  /** Opaque operator-owned identity; raw profile paths stay in the materializer. */
  profileRef?: string | undefined
  /** Explicit legacy cross-provider fallback authorization. */
  approvedFallbackProviders?: AgentExecutionProviderId[] | undefined
  prompt: string
  workingDirectory?: string | undefined
  model?: string | undefined
  reasoning?: AgentExecutionReasoning | undefined
  timeoutMs?: number | undefined
  maxTurns?: number | undefined
  correlationId?: string | undefined
  runId?: string | undefined
  packetId?: string | undefined
  sandboxMode?: AgentExecutionSandboxMode | undefined
  interactionPolicy?: InteractionPolicy | undefined
  signal?: AbortSignal | undefined
  systemPrompt?: string | undefined
  outputSchema?: Record<string, unknown> | undefined
  mcpServers?: readonly McpServerDescriptor[] | undefined
  /** Run-local resolved values keyed by opaque MCP references. */
  mcpReferenceValues?: Readonly<Record<string, string>> | undefined
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
  /** Private host hook for explicit binary/profile materialization. */
  materializeAdapter?: ((input: {
    providerId: AgentExecutionProviderId
    backend: AgentExecutionBackend
    authMode: AgentExecutionAuthMode
    profileRef?: string | undefined
    config: AdapterConfig
  }) => AgentCLIAdapter) | undefined
  /** Called only for authMode=api_key; the returned value is never retained. */
  resolveApiKey?: ((providerId: AgentExecutionProviderId) => string | undefined) | undefined
  onEvent?: ((event: AgentEvent) => void | Promise<void>) | undefined
  now?: (() => number) | undefined
}

class AgentExecutionConfigurationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'AgentExecutionConfigurationError'
  }
}

function createDefaultRegistry(
  request: AgentExecutionRequest,
  options: RunAgentExecutionOptions,
): ProviderAdapterRegistry {
  if (!request.providerId) {
    throw new AgentExecutionConfigurationError(
      'AGENT_EXECUTION_PROVIDER_REQUIRED',
      'providerId is required when runAgentExecution materializes an adapter',
    )
  }
  if (!request.backend) {
    throw new AgentExecutionConfigurationError(
      'AGENT_EXECUTION_BACKEND_REQUIRED',
      'backend must be explicit; providerId does not imply sdk or cli',
    )
  }
  if (!request.authMode) {
    throw new AgentExecutionConfigurationError(
      'AGENT_EXECUTION_AUTH_MODE_REQUIRED',
      'authMode must be explicit; providerId does not imply authentication',
    )
  }
  if (request.backend === 'cli' && request.authMode !== 'subscription_cli') {
    throw new AgentExecutionConfigurationError(
      'AGENT_EXECUTION_SELECTION_INVALID',
      'The cli backend requires subscription_cli authentication',
    )
  }
  if (request.authMode === 'subscription_cli' && !request.profileRef) {
    throw new AgentExecutionConfigurationError(
      'AGENT_EXECUTION_PROFILE_REQUIRED',
      'subscription_cli authentication requires an opaque profileRef',
    )
  }
  if (request.authMode === 'subscription_cli' && !options.materializeAdapter) {
    throw new AgentExecutionConfigurationError(
      'AGENT_EXECUTION_SUBSCRIPTION_MATERIALIZER_REQUIRED',
      'subscription_cli authentication requires an injected, operator-qualified profile materializer',
    )
  }
  const registry = new ProviderAdapterRegistry({ executionTimeoutMs: request.timeoutMs })
  const config: AdapterConfig = {
    ...projectAdapterConfig(request),
    ...(request.authMode === 'api_key'
      ? { apiKey: requireApiKey(request.providerId, options) }
      : { env: stripApiAuthenticationEnvironment(process.env) }),
  }
  const selection = {
    providerId: request.providerId,
    backend: request.backend,
    authMode: request.authMode,
    ...(request.profileRef ? { profileRef: request.profileRef } : {}),
    config,
  }
  const adapter = options.materializeAdapter
    ? options.materializeAdapter(selection)
    : request.providerId === 'codex'
      ? createCodexBackendAdapter({ ...config, backend: request.backend })
      : createClaudeBackendAdapter({ ...config, backend: request.backend })
  registry.registerProductionAdapters([adapter])
  return registry
}

function requireApiKey(
  providerId: AgentExecutionProviderId,
  options: RunAgentExecutionOptions,
): string {
  const value = options.resolveApiKey?.(providerId)
  if (!value) {
    throw new AgentExecutionConfigurationError(
      'AGENT_EXECUTION_API_KEY_REQUIRED',
      `An injected API key is required for ${providerId} because authMode=api_key`,
    )
  }
  return value
}

const API_AUTH_ENV_KEYS = new Set([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
])

/** Subscription adapters receive ambient process state with API fallback stripped. */
export function stripApiAuthenticationEnvironment(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !API_AUTH_ENV_KEYS.has(entry[0]),
    ),
  )
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
    return createDefaultRegistry(request, options)
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
  if (request.maxTurns !== undefined) options['maxTurns'] = request.maxTurns
  if (request.model) options['model'] = request.model
  if (request.reasoning) options['reasoning'] = request.reasoning
  if (request.sandboxMode) options['sandboxMode'] = request.sandboxMode
  if (request.runId) options['runId'] = request.runId
  if (request.packetId) options['packetId'] = request.packetId
  if (request.interactionPolicy) options['interactionPolicy'] = request.interactionPolicy
  if (request.mcpServers) options['mcpServers'] = request.mcpServers
  if (request.mcpReferenceValues) options['mcpReferenceValues'] = request.mcpReferenceValues

  return {
    prompt: request.prompt,
    ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
    ...(request.workingDirectory ? { workingDirectory: request.workingDirectory } : {}),
    ...(request.maxTurns !== undefined ? { maxTurns: request.maxTurns } : {}),
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

  if (err instanceof AgentExecutionConfigurationError) {
    return { code: err.code, message: err.message }
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
  const events: AgentEvent[] = []
  const attempted = new Set<AdapterProviderId>()
  let lastFailedEvent: AgentFailedEvent | undefined

  try {
    const registry = resolveRegistry(request, options)
    const input = projectAgentInput(request)
    const task = projectTaskDescriptor(request)
    for await (const event of registry.executeWithFallback(input, task)) {
      events.push(event)
      await options.onEvent?.(event)
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

import { ForgeError } from '@dzupagent/core/events'
import type { McpServerDescriptor } from '@dzupagent/runtime-contracts'

import { createClaudeBackendAdapter } from '../claude/claude-backend.js'
import { createCodexBackendAdapter } from '../codex/codex-backend.js'
import { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type {
  AdapterConfig,
  AdapterCapabilityProfile,
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
  /** Opaque secret identity required for api_key auth; raw keys stay in the resolver. */
  secretRef?: string | undefined
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
  runnerAttestation?: PreparedAgentExecutionAttestation | undefined
}

export interface RunAgentExecutionOptions {
  /** Private host hook for explicit binary/profile materialization. */
  materializeAdapter?: PrepareAgentExecutionRunnerOptions['materializeAdapter']
  /** Resolves only the explicitly selected secretRef; returned values are never retained. */
  resolveApiKey?: PrepareAgentExecutionRunnerOptions['resolveApiKey']
  requiredCapabilities?: PrepareAgentExecutionRunnerOptions['requiredCapabilities']
  projectInput?: PrepareAgentExecutionRunnerOptions['projectInput']
  projectEvent?: PrepareAgentExecutionRunnerOptions['projectEvent']
  onEvent?: ((event: AgentEvent) => void | Promise<void>) | undefined
  now?: (() => number) | undefined
}

export interface RunPreparedAgentExecutionOptions {
  onEvent?: ((event: AgentEvent) => void | Promise<void>) | undefined
  now?: (() => number) | undefined
}

export type AgentExecutionBooleanCapability =
  | 'supportsResume'
  | 'supportsFork'
  | 'supportsToolCalls'
  | 'emitsToolCalls'
  | 'executesToolLoop'
  | 'supportsStreaming'
  | 'supportsCostUsage'

export interface PreparedAgentExecutionAttestation {
  schema: 'dzupagent/prepared-agent-execution-runner-attestation/v1'
  selection: {
    providerId: AgentExecutionProviderId
    backend: AgentExecutionBackend
    authMode: AgentExecutionAuthMode
    profileRef?: string | undefined
    secretRef?: string | undefined
  }
  capabilityEvidence: {
    required: Readonly<Partial<Record<AgentExecutionBooleanCapability, true>>>
    observed: Readonly<AdapterCapabilityProfile>
    exactMatch: true
  }
  provenance: 'agent-adapters-module-private-weakmap'
}

export interface PreparedAgentExecutionRunner {
  readonly attestation: PreparedAgentExecutionAttestation
}

export interface PreparedAgentExecutionEventProjection {
  events: readonly AgentEvent[]
  terminal?: boolean | undefined
}

export interface PrepareAgentExecutionRunnerOptions {
  /** Private host hook for explicit binary/profile materialization. */
  materializeAdapter?: ((input: {
    providerId: AgentExecutionProviderId
    backend: AgentExecutionBackend
    authMode: AgentExecutionAuthMode
    profileRef?: string | undefined
    secretRef?: string | undefined
    config: AdapterConfig
  }) => AgentCLIAdapter) | undefined
  /** Called only for authMode=api_key; the returned value is never retained. */
  resolveApiKey?: ((input: {
    providerId: AgentExecutionProviderId
    secretRef: string
  }) => string | undefined) | undefined
  /** Capabilities that must be observed as true before execution can be prepared. */
  requiredCapabilities?: readonly AgentExecutionBooleanCapability[] | undefined
  /** Host projection applied before the attested registry sees the request. */
  projectInput?: ((input: AgentInput, task: TaskDescriptor) => AgentInput) | undefined
  /** Host event policy; terminal=true closes the underlying adapter stream. */
  projectEvent?: (
    (event: AgentEvent) =>
      | PreparedAgentExecutionEventProjection
      | Promise<PreparedAgentExecutionEventProjection>
  ) | undefined
}

class AgentExecutionConfigurationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'AgentExecutionConfigurationError'
  }
}

function materializeSelectedAdapter(
  request: AgentExecutionRequest,
  options: PrepareAgentExecutionRunnerOptions,
): AgentCLIAdapter {
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
  if (request.authMode === 'api_key' && !request.secretRef) {
    throw new AgentExecutionConfigurationError(
      'AGENT_EXECUTION_SECRET_REF_REQUIRED',
      'api_key authentication requires an opaque secretRef',
    )
  }
  if (request.authMode === 'subscription_cli' && !options.materializeAdapter) {
    throw new AgentExecutionConfigurationError(
      'AGENT_EXECUTION_SUBSCRIPTION_MATERIALIZER_REQUIRED',
      'subscription_cli authentication requires an injected, operator-qualified profile materializer',
    )
  }
  const config: AdapterConfig = {
    ...projectAdapterConfig(request),
    ...(request.authMode === 'api_key'
      ? { apiKey: requireApiKey(request as AgentExecutionRequest & { providerId: AgentExecutionProviderId }, options) }
      : { env: stripApiAuthenticationEnvironment(process.env) }),
  }
  const selection = {
    providerId: request.providerId,
    backend: request.backend,
    authMode: request.authMode,
    ...(request.profileRef ? { profileRef: request.profileRef } : {}),
    ...(request.secretRef ? { secretRef: request.secretRef } : {}),
    config,
  }
  return options.materializeAdapter
    ? options.materializeAdapter(selection)
    : request.providerId === 'codex'
      ? createCodexBackendAdapter({ ...config, backend: request.backend })
      : createClaudeBackendAdapter({ ...config, backend: request.backend })
}

function requireApiKey(
  request: AgentExecutionRequest & { providerId: AgentExecutionProviderId },
  options: PrepareAgentExecutionRunnerOptions,
): string {
  if (!request.secretRef) {
    throw new AgentExecutionConfigurationError(
      'AGENT_EXECUTION_SECRET_REF_REQUIRED',
      'api_key authentication requires an opaque secretRef',
    )
  }
  const value = options.resolveApiKey?.({
    providerId: request.providerId,
    secretRef: request.secretRef,
  })
  if (!value) {
    throw new AgentExecutionConfigurationError(
      'AGENT_EXECUTION_API_KEY_REQUIRED',
      `An injected API key is required for ${request.providerId} because authMode=api_key`,
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

type PreparedRunnerState = {
  executeWithFallback: (
    input: AgentInput,
    task: TaskDescriptor,
  ) => AsyncGenerator<AgentEvent, void, undefined>
}

const PREPARED_RUNNER_STATE = new WeakMap<PreparedAgentExecutionRunner, PreparedRunnerState>()

function capabilityValue(
  profile: AdapterCapabilityProfile,
  capability: AgentExecutionBooleanCapability,
): boolean {
  return profile[capability] === true
}

function frozenCapabilityProfile(profile: AdapterCapabilityProfile): Readonly<AdapterCapabilityProfile> {
  return Object.freeze({
    ...profile,
    ...(profile.nativeToolControls
      ? { nativeToolControls: Object.freeze({ ...profile.nativeToolControls }) }
      : {}),
    ...(profile.providerRequestCorrelation
      ? {
          providerRequestCorrelation: Object.freeze({
            ...profile.providerRequestCorrelation,
            idempotencyKey: Object.freeze({ ...profile.providerRequestCorrelation.idempotencyKey }),
            restartLookup: Object.freeze({
              ...profile.providerRequestCorrelation.restartLookup,
              lookupBy: Object.freeze([...profile.providerRequestCorrelation.restartLookup.lookupBy]),
            }),
          }),
        }
      : {}),
  })
}

export function prepareAgentExecutionRunner(
  request: AgentExecutionRequest,
  options: PrepareAgentExecutionRunnerOptions = {},
): PreparedAgentExecutionRunner {
  const adapter = materializeSelectedAdapter(request, options)
  if (adapter.providerId !== request.providerId) {
    throw new AgentExecutionConfigurationError(
      'AGENT_EXECUTION_ADAPTER_PROVIDER_MISMATCH',
      `Materialized adapter provider ${adapter.providerId} does not match ${request.providerId}`,
    )
  }

  const observed = frozenCapabilityProfile(adapter.getCapabilities())
  const required = Object.fromEntries(
    (options.requiredCapabilities ?? []).map((capability) => [capability, true]),
  ) as Partial<Record<AgentExecutionBooleanCapability, true>>
  for (const capability of options.requiredCapabilities ?? []) {
    if (!capabilityValue(observed, capability)) {
      throw new AgentExecutionConfigurationError(
        'AGENT_EXECUTION_CAPABILITY_REQUIRED',
        `Materialized ${request.providerId} adapter does not attest required capability ${capability}`,
      )
    }
  }

  const registry = new ProviderAdapterRegistry({ executionTimeoutMs: request.timeoutMs })
  registry.registerProductionAdapters([adapter])
  const attestation: PreparedAgentExecutionAttestation = Object.freeze({
    schema: 'dzupagent/prepared-agent-execution-runner-attestation/v1',
    selection: Object.freeze({
      providerId: request.providerId!,
      backend: request.backend!,
      authMode: request.authMode!,
      ...(request.profileRef ? { profileRef: request.profileRef } : {}),
      ...(request.secretRef ? { secretRef: request.secretRef } : {}),
    }),
    capabilityEvidence: Object.freeze({
      required: Object.freeze(required),
      observed,
      exactMatch: true as const,
    }),
    provenance: 'agent-adapters-module-private-weakmap' as const,
  })
  const preparedRunner: PreparedAgentExecutionRunner = Object.freeze({ attestation })
  PREPARED_RUNNER_STATE.set(preparedRunner, {
    async *executeWithFallback(input, task) {
      const projectedInput = options.projectInput?.(input, task) ?? input
      for await (const event of registry.executeWithFallback(projectedInput, task)) {
        const projection = options.projectEvent
          ? await options.projectEvent(event)
          : { events: [event] }
        for (const projectedEvent of projection.events) yield projectedEvent
        if (projection.terminal === true) return
      }
    },
  })
  return preparedRunner
}

function requirePreparedRunner(
  request: AgentExecutionRequest,
  preparedRunner: PreparedAgentExecutionRunner | undefined,
): { runner: PreparedAgentExecutionRunner; state: PreparedRunnerState } {
  const state = preparedRunner ? PREPARED_RUNNER_STATE.get(preparedRunner) : undefined
  if (!preparedRunner || !state) {
    throw new AgentExecutionConfigurationError(
      'AGENT_EXECUTION_PREPARED_RUNNER_REQUIRED',
      'runAgentExecution requires an in-process runner from prepareAgentExecutionRunner',
    )
  }
  const selection = preparedRunner.attestation.selection
  if (
    selection.providerId !== request.providerId ||
    selection.backend !== request.backend ||
    selection.authMode !== request.authMode ||
    selection.profileRef !== request.profileRef ||
    selection.secretRef !== request.secretRef
  ) {
    throw new AgentExecutionConfigurationError(
      'AGENT_EXECUTION_PREPARED_RUNNER_SELECTION_MISMATCH',
      'Prepared runner selection does not exactly match the execution request',
    )
  }
  return { runner: preparedRunner, state }
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

export async function runPreparedAgentExecution(
  request: AgentExecutionRequest,
  preparedRunner: PreparedAgentExecutionRunner,
  options: RunPreparedAgentExecutionOptions = {},
): Promise<AgentExecutionResult> {
  const now = options.now ?? Date.now
  const startMs = now()
  const events: AgentEvent[] = []
  const attempted = new Set<AdapterProviderId>()
  let lastFailedEvent: AgentFailedEvent | undefined

  try {
    const prepared = requirePreparedRunner(request, preparedRunner)
    const input = projectAgentInput(request)
    const task = projectTaskDescriptor(request)
    for await (const event of prepared.state.executeWithFallback(input, task)) {
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
          runnerAttestation: prepared.runner.attestation,
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
      runnerAttestation: prepared.runner.attestation,
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

/** Normal public entry point: materialize an exact selection, attest it, then execute it. */
export async function runAgentExecution(
  request: AgentExecutionRequest,
  options: RunAgentExecutionOptions = {},
): Promise<AgentExecutionResult> {
  const {
    onEvent,
    now,
    materializeAdapter,
    resolveApiKey,
    requiredCapabilities,
    projectInput,
    projectEvent,
  } = options
  try {
    const preparedRunner = prepareAgentExecutionRunner(request, {
      materializeAdapter,
      resolveApiKey,
      requiredCapabilities,
      projectInput,
      projectEvent,
    })
    return runPreparedAgentExecution(request, preparedRunner, { onEvent, now })
  } catch (err: unknown) {
    const error = extractFailure(err, undefined)
    return {
      ok: false,
      ...(request.model ? { model: request.model } : {}),
      text: '',
      events: [],
      durationMs: 0,
      attemptedProviders: [],
      error,
      code: error.code,
    }
  }
}

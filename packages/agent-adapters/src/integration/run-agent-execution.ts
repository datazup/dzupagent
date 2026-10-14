import { ForgeError } from '@dzupagent/core/events'
import type { McpServerDescriptor } from '@dzupagent/runtime-contracts'

import { createClaudeBackendAdapter } from '../claude/claude-backend.js'
import { createCodexBackendAdapter } from '../codex/codex-backend.js'
import { ProviderAdapterRegistry } from '../registry/adapter-registry.js'
import type { AdapterPipeline } from '../pipeline/adapter-pipeline.js'
import type {
  AdapterConfig,
  AdapterCapabilityProfile,
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentFailedEvent,
  AgentInput,
  AgentStreamEvent,
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
  /** Exact provider-native session selected by the owning host; never an inferred fence ID. */
  resumeSessionId?: string | undefined
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

/**
 * Per-event listener, declared as returning plain `void` — not
 * `void | Promise<void>`.
 *
 * TypeScript's void-returning-function leniency lets a callback that returns a
 * value satisfy a `=> void` position, so `onEvent: (e) => events.push(e)`
 * type-checks even though `push` returns `number`. That leniency does not
 * survive a union: under `=> void | Promise<void>` the same expression is
 * rejected with TS2322 ("Type 'number' is not assignable to type
 * 'void | Promise<void>'"), which is why callers had to write block bodies.
 * The sibling `AdapterWorkflowRunOptions.onEvent` has always been plain `void`,
 * and its callers do write the concise form.
 *
 * `void` still accepts `async` listeners — a `Promise<void>` return is
 * assignable to a `void` return position — and `runPreparedAgentExecution`
 * awaits what the listener actually returned, so an async listener still
 * settles before the next event is processed.
 */
export type AgentExecutionEventListener = (event: AgentEvent) => void

export interface RunAgentExecutionOptions {
  pipeline?: AdapterPipeline | undefined
  /** Lazy host preparation, after approval and before construction. */
  beforePrepare?: (() => void | Promise<void>) | undefined
  assertPreparedInput?: PrepareAgentExecutionRunnerOptions['assertPreparedInput']
  /** Private host hook for explicit binary/profile materialization. */
  materializeAdapter?: PrepareAgentExecutionRunnerOptions['materializeAdapter']
  /** Resolves only the explicitly selected secretRef; returned values are never retained. */
  resolveApiKey?: PrepareAgentExecutionRunnerOptions['resolveApiKey']
  requiredCapabilities?: PrepareAgentExecutionRunnerOptions['requiredCapabilities']
  projectInput?: PrepareAgentExecutionRunnerOptions['projectInput']
  projectEvent?: PrepareAgentExecutionRunnerOptions['projectEvent']
  guardAdapterStart?: PrepareAgentExecutionRunnerOptions['guardAdapterStart']
  /** See {@link AgentExecutionEventListener} for why this is plain `void`. */
  onEvent?: AgentExecutionEventListener | undefined
  now?: (() => number) | undefined
}

export interface RunPreparedAgentExecutionOptions {
  /** See {@link AgentExecutionEventListener} for why this is plain `void`. */
  onEvent?: AgentExecutionEventListener | undefined
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
  /** Same-registry controls supplied by the admitted in-process host. */
  pipeline?: AdapterPipeline | undefined
  /** Final input accounting runs after allowed UCL/policy enrichment. */
  assertPreparedInput?: ((input: AgentInput, task: TaskDescriptor) => void | Promise<void>) | undefined
  /**
   * Invocation boundary after routing, progress listeners and policy warnings.
   * The guard must call invoke only while admission is current. Preparation
   * remains separate: no adapter execute/raw/resume method has run yet.
   */
  guardAdapterStart?: ((
    invoke: () => AsyncGenerator<AgentStreamEvent, void, undefined>,
    input?: AgentInput,
  ) => AsyncGenerator<AgentStreamEvent, void, undefined>) | undefined
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

export class AgentExecutionConfigurationError extends Error {
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
  resumeSessionId: string | undefined
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

const APPROVED_PREPARATIONS = new WeakSet<PrepareAgentExecutionRunnerOptions>()

/** Gate the whole preparation, including adapter construction, in the same
 * pipeline. Only this lazy boundary can mark preparation as already approved. */
async function runGovernedAgentExecution(
  request: AgentExecutionRequest,
  pipeline: AdapterPipeline,
  prepare: () => PrepareAgentExecutionRunnerOptions | Promise<PrepareAgentExecutionRunnerOptions>,
  runOptions: RunPreparedAgentExecutionOptions = {},
): Promise<AgentExecutionResult> {
  let result: AgentExecutionResult | undefined
  const operation = async function* (): AsyncGenerator<AgentEvent, void, undefined> {
    const options = await prepare()
    if (options.pipeline !== pipeline) {
      throw new AgentExecutionConfigurationError('AGENT_EXECUTION_PIPELINE_DRIFT', 'Preparation changed the approved pipeline')
    }
    APPROVED_PREPARATIONS.add(options)
    try {
      result = await runPreparedAgentExecution(request, prepareAgentExecutionRunner(request, options), runOptions)
    } finally { APPROVED_PREPARATIONS.delete(options) }
  }
  for await (const _event of pipeline.approval.wrap(operation(), {
    prompt: request.prompt, providerId: request.providerId, signal: request.signal, requireApproval: true,
  })) { /* runPreparedAgentExecution owns awaited event delivery */ }
  if (!result) throw new AgentExecutionConfigurationError('AGENT_EXECUTION_APPROVAL_REQUIRED', 'Execution did not pass approval')
  return result
}

export function prepareAgentExecutionRunner(
  request: AgentExecutionRequest,
  options: PrepareAgentExecutionRunnerOptions = {},
): PreparedAgentExecutionRunner {
  const resumeSessionId = request.resumeSessionId
  if (resumeSessionId !== undefined && (
    typeof resumeSessionId !== 'string' || resumeSessionId.length === 0 || resumeSessionId.length > 512
    || resumeSessionId.trim() !== resumeSessionId || /[\x00-\x1f\x7f]/u.test(resumeSessionId)
    || (request.approvedFallbackProviders?.length ?? 0) > 0
  )) {
    throw new AgentExecutionConfigurationError('AGENT_EXECUTION_RESUME_INVALID', 'Resume requires an exact native session and no fallback')
  }
  const adapter = materializeSelectedAdapter(request, options)
  if (adapter.providerId !== request.providerId) {
    throw new AgentExecutionConfigurationError(
      'AGENT_EXECUTION_ADAPTER_PROVIDER_MISMATCH',
      `Materialized adapter provider ${adapter.providerId} does not match ${request.providerId}`,
    )
  }

  const observed = frozenCapabilityProfile(adapter.getCapabilities())
  const requiredCapabilities = [...new Set([
    ...(options.requiredCapabilities ?? []),
    ...(resumeSessionId !== undefined ? ['supportsResume' as const] : []),
  ])]
  const required = Object.fromEntries(
    requiredCapabilities.map((capability) => [capability, true]),
  ) as Partial<Record<AgentExecutionBooleanCapability, true>>
  for (const capability of requiredCapabilities) {
    if (!capabilityValue(observed, capability)) {
      throw new AgentExecutionConfigurationError(
        'AGENT_EXECUTION_CAPABILITY_REQUIRED',
        `Materialized ${request.providerId} adapter does not attest required capability ${capability}`,
      )
    }
  }
  if (resumeSessionId !== undefined && typeof adapter.resumeSession !== 'function') {
    throw new AgentExecutionConfigurationError('AGENT_EXECUTION_CAPABILITY_REQUIRED', 'Resume method is required')
  }

  const registry = new ProviderAdapterRegistry({ executionTimeoutMs: request.timeoutMs })
  // DZUPAGENT-GAP4-01-20261003-R1: keep the guard next to the actual
  // invocation, including raw execution and resume. Bind methods to the real
  // adapter so class private fields and optional methods keep their semantics.
  const guard = options.guardAdapterStart
  const guardedAdapter = guard || resumeSessionId !== undefined ? new Proxy(adapter, {
    get(target, key) {
      const value = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      if (key === 'execute' || key === 'executeWithRaw' || key === 'resumeSession') {
        return (...args: unknown[]) => {
          const invoke = (): AsyncGenerator<AgentStreamEvent, void, undefined> => {
            if (resumeSessionId !== undefined && (key !== 'resumeSession' || args[0] !== resumeSessionId
              || (args[1] as AgentInput | undefined)?.resumeSessionId !== resumeSessionId)) {
              throw new AgentExecutionConfigurationError('AGENT_EXECUTION_RESUME_MISMATCH', 'Prepared native resume identity changed')
            }
            return Reflect.apply(value, target, args) as AsyncGenerator<AgentStreamEvent, void, undefined>
          }
          return guard ? guard(invoke, args[key === 'resumeSession' ? 1 : 0] as AgentInput) : invoke()
        }
      }
      return value.bind(target)
    },
  }) : adapter
  registry.registerProductionAdapters([guardedAdapter])
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
    resumeSessionId,
    async *executeWithFallback(input, task) {
      const delegate = async function* (): AsyncGenerator<AgentEvent, void, undefined> {
        const projectedInput = options.projectInput?.(input, task) ?? input
        if (options.pipeline) await options.pipeline.prepare({ input: projectedInput, preferredProvider: request.providerId })
        if (resumeSessionId !== undefined && projectedInput.resumeSessionId !== resumeSessionId) {
          throw new AgentExecutionConfigurationError('AGENT_EXECUTION_RESUME_MISMATCH', 'Host projection changed the prepared native session')
        }
        // The registry clones each attempt, so a later write to the validated
        // projection would otherwise be silently dropped. Pin the identity so a
        // host start guard cannot rewrite it after validation.
        const pinned = Object.getOwnPropertyDescriptor(projectedInput, 'resumeSessionId')
        if (resumeSessionId !== undefined && pinned?.configurable !== false) {
          Object.defineProperty(projectedInput, 'resumeSessionId', {
            enumerable: true,
            configurable: false,
            get: () => resumeSessionId,
            set: () => {
              throw new AgentExecutionConfigurationError('AGENT_EXECUTION_RESUME_MISMATCH', 'Host start guard changed the prepared native session')
            },
          })
        } else if (resumeSessionId !== undefined && pinned?.writable === true) {
          // A sealed projection can still be made read-only.
          Object.defineProperty(projectedInput, 'resumeSessionId', { writable: false })
        }
        const stream = registry.executeWithFallback(projectedInput, task)
        // Guardrail wrapping installs the cancellation signal on this same input.
        // Freeze/account only after every predispatch projection is materialized.
        const controlledStream = options.pipeline ? options.pipeline.wrapStream(stream, projectedInput,
          { prompt: projectedInput.prompt, providerId: request.providerId, signal: projectedInput.signal, requireApproval: false }) : stream
        try { await options.assertPreparedInput?.(projectedInput, task) }
        catch (error) { await controlledStream.return(); throw error }
        yield* controlledStream
      }
      // The lazy delegate ensures approval settles before projection/UCL/router.
      const stream = options.pipeline && !APPROVED_PREPARATIONS.has(options) ? options.pipeline.approval.wrap(delegate(),
        { prompt: input.prompt, providerId: request.providerId, signal: input.signal, requireApproval: true }) : delegate()
      for await (const event of stream) {
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
  if (state.resumeSessionId !== request.resumeSessionId
    || (state.resumeSessionId !== undefined && (request.approvedFallbackProviders?.length ?? 0) > 0)) {
    throw new AgentExecutionConfigurationError('AGENT_EXECUTION_RESUME_MISMATCH', 'Execution request differs from the prepared native session')
  }
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
    ...(request.resumeSessionId !== undefined ? { resumeSessionId: request.resumeSessionId } : {}),
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
  // `onEvent` is declared `(event) => void` so callers can supply an
  // expression-bodied arrow; read through a widened view here because the
  // await below is load-bearing for async listeners.
  const onEvent: ((event: AgentEvent) => unknown) | undefined = options.onEvent
  const startMs = now()
  const events: AgentEvent[] = []
  const attempted = new Set<AdapterProviderId>()
  let lastFailedEvent: AgentFailedEvent | undefined
  let completedEvent: Extract<AgentEvent, { type: 'adapter:completed' }> | undefined

  try {
    const prepared = requirePreparedRunner(request, preparedRunner)
    const input = projectAgentInput(request)
    const task = projectTaskDescriptor(request)
    for await (const event of prepared.state.executeWithFallback(input, task)) {
      if (completedEvent) throw new AgentExecutionConfigurationError('AGENT_EXECUTION_TERMINAL_DRIFT', 'Event followed completed execution')
      events.push(event)
      await onEvent?.(event)
      collectProviderId(event, attempted)

      if (event.type === 'adapter:failed') {
        lastFailedEvent = event
      }

      if (event.type === 'adapter:completed') {
        completedEvent = event
      }
    }
    // Success is provisional until the entire stream, async listeners and
    // generator finalizers settle. A late failure must remain unsuccessful.
    if (completedEvent && !lastFailedEvent) {
      return { ok: true, providerId: completedEvent.providerId,
        ...(request.model ? { model: request.model } : {}), text: completedEvent.result,
        events, ...(completedEvent.usage ? { usage: completedEvent.usage } : {}),
        durationMs: now() - startMs, attemptedProviders: [...attempted],
        runnerAttestation: prepared.runner.attestation }
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
      ...(lastFailedEvent?.usage ? { usage: lastFailedEvent.usage } : {}),
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
      ...(lastFailedEvent?.usage ? { usage: lastFailedEvent.usage } : {}),
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
    guardAdapterStart,
    pipeline,
    assertPreparedInput,
    beforePrepare,
  } = options
  try {
    const prepare = async (): Promise<PrepareAgentExecutionRunnerOptions> => {
      await beforePrepare?.()
      return {
      materializeAdapter,
      resolveApiKey,
      requiredCapabilities,
      projectInput,
      projectEvent,
      guardAdapterStart,
      pipeline,
      assertPreparedInput,
      }
    }
    if (pipeline) return await runGovernedAgentExecution(request, pipeline, prepare, { onEvent, now })
    const preparedRunner = prepareAgentExecutionRunner(request, await prepare())
    return await runPreparedAgentExecution(request, preparedRunner, { onEvent, now })
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

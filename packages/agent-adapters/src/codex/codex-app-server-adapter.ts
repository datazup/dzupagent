import { isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'

import type { ProviderSessionAdapter } from '@dzupagent/adapter-types/provider-session'
import {
  PROVIDER_SESSION_OPERATION_SCHEMA,
  PROVIDER_SESSION_REFERENCE_SCHEMA,
  validateProviderSessionAttemptBinding,
  type ProviderSessionAttemptBinding,
  type ProviderSessionGoalClearRequest,
  type ProviderSessionGoalGetRequest,
  type ProviderSessionGoalSetRequest,
  type ProviderSessionInterruptTurnRequest,
  type ProviderSessionOperationResult,
} from '@dzupagent/runtime-contracts/provider-session'

import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  HealthStatus,
  TokenUsage,
} from '../types.js'
import {
  CodexAppServerClientError,
  CodexAppServerStdioClient,
  qualifyCodexAppServerExecutable,
  type CodexAppServerClientDependencies,
  type CodexAppServerClientLimits,
  type CodexAppServerInboundEvent,
  type CodexAppServerSpawn,
} from './codex-app-server-client.js'
import {
  createCodexGoalControlAdapter,
  type CodexGoalControlAdapter,
} from './codex-goal-control.js'
import { toCodexSandboxMode } from './codex-helpers.js'
import type { ResolvedProbeExecutable } from '../introspection/index.js'

type InterruptTurnResult = ProviderSessionOperationResult & {
  readonly kind: 'interrupt-turn'
}

export interface CodexAppServerAdapterOptions extends AdapterConfig {
  readonly attemptBinding: ProviderSessionAttemptBinding
  /** Private identity used for observation and requalified immediately before spawn. */
  readonly executable: ResolvedProbeExecutable
  readonly clientLimits?: CodexAppServerClientLimits | undefined
  /** Tight interrupt acknowledgement grace, separate from ordinary RPC timeouts. */
  readonly interruptGraceMs?: number | undefined
  readonly dependencies?: {
    readonly spawn?: CodexAppServerSpawn | undefined
    readonly now?: (() => number) | undefined
    readonly monotonicNow?: (() => number) | undefined
    readonly realpath?: CodexAppServerClientDependencies['realpath']
    readonly stat?: CodexAppServerClientDependencies['stat']
    readonly access?: CodexAppServerClientDependencies['access']
  } | undefined
}

interface LocalTerminalDecision {
  readonly code: 'CODEX_APP_SERVER_CANCELLED' | 'CODEX_APP_SERVER_EXECUTION_TIMEOUT'
  readonly message: string
}

interface RunLifecycle {
  readonly deadline: number
  terminalDecision?: LocalTerminalDecision | undefined
}

interface RunningExecution {
  cancel(): void
}

interface ActiveRun {
  readonly client: CodexAppServerStdioClient
  readonly threadId: string
  readonly turnId: string
  readonly timeoutMs: number
  readonly lifecycle: RunLifecycle
  interruptPromise?: Promise<void> | undefined
}

const REQUIRED_BASE_CAPABILITIES = [
  'execute',
  'resume',
  'cancel',
  'stream',
  'usage',
] as const
const MAX_PROMPT_LENGTH = 1_000_000
const MAX_REFERENCE_LENGTH = 512
const MAX_RESULT_LENGTH = 2_000_000
const MAX_DELTA_LENGTH = 512_000
const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000
const MAX_EXECUTION_TIMEOUT_MS = 30 * 60_000
const DEFAULT_INTERRUPT_GRACE_MS = 250
const MAX_INTERRUPT_GRACE_MS = DEFAULT_INTERRUPT_GRACE_MS
const HUMAN_REQUEST_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'applyPatchApproval',
  'execCommandApproval',
])

/**
 * Experimental provider-session backend for the exact admitted App Server
 * descriptor. It emits normalized events but never emits raw frames or answers
 * a provider-initiated request.
 */
export class CodexAppServerAdapter implements AgentCLIAdapter, ProviderSessionAdapter {
  readonly providerId = 'codex' as const
  readonly attemptBinding: ProviderSessionAttemptBinding

  private config: AdapterConfig
  private readonly executable: ResolvedProbeExecutable
  private readonly clientLimits: CodexAppServerClientLimits | undefined
  private readonly clientDependencies: CodexAppServerClientDependencies | undefined
  private readonly now: () => number
  private readonly monotonicNow: () => number
  private readonly interruptGraceMs: number
  private readonly runningExecutions = new Set<RunningExecution>()
  private readonly activeRuns = new Set<ActiveRun>()
  private readonly goalControl: CodexGoalControlAdapter | undefined

  constructor(options: CodexAppServerAdapterOptions) {
    assertAppServerAdmission(options)
    this.attemptBinding = options.attemptBinding
    this.executable = options.executable
    this.clientLimits = options.clientLimits
    this.now = options.dependencies?.now ?? Date.now
    this.monotonicNow = options.dependencies?.monotonicNow ?? (() => performance.now())
    this.interruptGraceMs = interruptGrace(options.interruptGraceMs)
    this.clientDependencies = clientDependencies(options)
    this.config = adapterConfig(options)
    this.goalControl = options.attemptBinding.descriptor.capabilities['goal-control'].status === 'native'
      ? createCodexGoalControlAdapter({
          attemptBinding: options.attemptBinding,
          executable: options.executable,
          timeoutMs: options.clientLimits?.requestTimeoutMs,
          ...(options.env ? { env: options.env } : {}),
          ...(this.clientDependencies ? { dependencies: this.clientDependencies } : {}),
        })
      : undefined
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    yield* this.run(input)
  }

  async *resumeSession(
    sessionId: string,
    input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    if (!boundedText(sessionId, MAX_REFERENCE_LENGTH)) {
      yield failedEvent(
        this.now(),
        input.correlationId,
        'CODEX_APP_SERVER_SESSION_INVALID',
        'Codex app-server session reference is invalid',
      )
      return
    }
    yield* this.run(input, sessionId)
  }

  interrupt(): void {
    for (const execution of this.runningExecutions) execution.cancel()
  }

  configure(options: Partial<AdapterConfig>): void {
    this.config = { ...this.config, ...options }
  }

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: false,
      emitsToolCalls: false,
      executesToolLoop: true,
      supportsStreaming: true,
      supportsCostUsage: true,
      nativeToolControls: {
        mode: false,
        allowlist: false,
        blocklist: false,
      },
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await qualifyCodexAppServerExecutable({
        executable: this.executable,
        ...(this.clientLimits ? { limits: this.clientLimits } : {}),
        ...(this.clientDependencies ? { dependencies: this.clientDependencies } : {}),
      })
      return {
        healthy: true,
        providerId: this.providerId,
        sdkInstalled: false,
        cliAvailable: true,
        lastSuccessTimestamp: this.now(),
      }
    } catch {
      return {
        healthy: false,
        providerId: this.providerId,
        sdkInstalled: false,
        cliAvailable: false,
        lastError: 'Qualified Codex executable is unavailable',
      }
    }
  }

  async interruptTurn(
    request: ProviderSessionInterruptTurnRequest,
  ): Promise<InterruptTurnResult> {
    assertInterruptRequest(request, this.attemptBinding)
    const run = [...this.activeRuns].find((candidate) =>
      candidate.threadId === request.session.opaqueId
      && candidate.turnId === request.turn.opaqueId)
    if (!run) throw new Error('Codex app-server interrupt rejected a stale turn')
    this.decideActiveRun(run, cancellationDecision())
    await this.interruptActiveRun(run)
    return { kind: 'interrupt-turn', accepted: true }
  }

  async getGoal(
    request: ProviderSessionGoalGetRequest,
  ): Promise<ReturnType<NonNullable<CodexGoalControlAdapter['getGoal']>> extends Promise<infer T> ? T : never> {
    if (!this.goalControl) throw new Error('Codex app-server goal control is unsupported')
    return this.goalControl.getGoal(request)
  }

  async setGoal(
    request: ProviderSessionGoalSetRequest,
  ): Promise<ReturnType<NonNullable<CodexGoalControlAdapter['setGoal']>> extends Promise<infer T> ? T : never> {
    if (!this.goalControl) throw new Error('Codex app-server goal control is unsupported')
    return this.goalControl.setGoal(request)
  }

  async clearGoal(
    request: ProviderSessionGoalClearRequest,
  ): Promise<ReturnType<NonNullable<CodexGoalControlAdapter['clearGoal']>> extends Promise<infer T> ? T : never> {
    if (!this.goalControl) throw new Error('Codex app-server goal control is unsupported')
    return this.goalControl.clearGoal(request)
  }

  private async *run(
    input: AgentInput,
    resumeThreadId?: string,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    let client: CodexAppServerStdioClient | undefined
    let activeRun: ActiveRun | undefined
    let terminal: AgentEvent | undefined
    let cleanupError: Error | undefined
    const startedAt = this.now()
    const timeoutMs = executionTimeout(input, this.config)
    const lifecycle: RunLifecycle = {
      deadline: this.monotonicNow() + timeoutMs,
    }
    const setupAbortController = new AbortController()
    const signal = input.signal
    let signalListener: (() => void) | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined

    const decide = (decision: LocalTerminalDecision): void => {
      if (lifecycle.terminalDecision) return
      lifecycle.terminalDecision = decision
      setupAbortController.abort()
      if (activeRun) {
        this.beginTerminalCleanup(activeRun)
      } else if (client) {
        void client.close().catch(() => undefined)
      }
    }
    const runningExecution: RunningExecution = {
      cancel: () => decide(cancellationDecision()),
    }
    const requireRemaining = (): number => {
      if (signal?.aborted) decide(cancellationDecision())
      const remaining = Math.ceil(lifecycle.deadline - this.monotonicNow())
      if (remaining < 1) decide(timeoutDecision())
      if (lifecycle.terminalDecision) throw decisionError(lifecycle.terminalDecision)
      return remaining
    }

    try {
      this.runningExecutions.add(runningExecution)
      assertInput(input)
      signalListener = () => decide(cancellationDecision())
      signal?.addEventListener('abort', signalListener, { once: true })
      timeout = setTimeout(() => decide(timeoutDecision()), requireRemaining())
      client = await CodexAppServerStdioClient.connect({
        executable: this.executable,
        ...(effectiveWorkingDirectory(input, this.config)
          ? { cwd: effectiveWorkingDirectory(input, this.config) }
          : {}),
        ...(this.config.env ? { env: this.config.env } : {}),
        ...(this.clientLimits ? { limits: this.clientLimits } : {}),
        ...(this.clientDependencies ? { dependencies: this.clientDependencies } : {}),
      }, {
        timeoutMs: requireRemaining(),
        signal: setupAbortController.signal,
      })
      requireRemaining()

      const threadResult = objectValue(await client.request(
        resumeThreadId ? 'thread/resume' : 'thread/start',
        resumeThreadId
          ? threadResumeParams(resumeThreadId, input, this.config)
          : threadStartParams(input, this.config),
        { timeoutMs: requireRemaining() },
      ))
      requireRemaining()
      const thread = objectValue(threadResult['thread'])
      const threadId = stringValue(thread['id'])
      if (!boundedText(threadId, MAX_REFERENCE_LENGTH)
        || (resumeThreadId !== undefined && threadId !== resumeThreadId)) {
        throw adapterError(
          'CODEX_APP_SERVER_THREAD_INVALID',
          'Codex app-server returned an invalid thread reference',
        )
      }

      const turnResult = objectValue(await client.request(
        'turn/start',
        turnStartParams(threadId, input, this.config),
        { timeoutMs: requireRemaining() },
      ))
      requireRemaining()
      const turn = objectValue(turnResult['turn'])
      const turnId = stringValue(turn['id'])
      if (!boundedText(turnId, MAX_REFERENCE_LENGTH) || turn['status'] !== 'inProgress') {
        throw adapterError(
          'CODEX_APP_SERVER_TURN_INVALID',
          'Codex app-server returned an invalid turn reference',
        )
      }

      activeRun = {
        client,
        threadId,
        turnId,
        timeoutMs,
        lifecycle,
      }
      this.activeRuns.add(activeRun)
      const run = activeRun
      requireRemaining()

      yield withCorrelation({
        type: 'adapter:started',
        providerId: this.providerId,
        sessionId: threadId,
        timestamp: this.now(),
        ...(effectiveModel(input, this.config) ? { model: effectiveModel(input, this.config) } : {}),
        ...(resumeThreadId ? { isResume: true } : {}),
      }, input.correlationId)

      let result = ''
      let usage: TokenUsage | undefined
      let sawTurnStarted = false
      for await (const event of client.events()) {
        requireRemaining()
        if (event.kind === 'request') {
          assertRunEventIdentity(event.params, run, false)
          if (!HUMAN_REQUEST_METHODS.has(event.method)) {
            throw adapterError(
              'CODEX_APP_SERVER_REQUEST_UNSUPPORTED',
              'Codex app-server requested an unsupported host operation',
            )
          }
          yield interactionEvent(event, run, input.correlationId, this.now())
          continue
        }
        if (event.method === 'thread/started') {
          const observedThread = objectValue(event.params['thread'])
          if (stringValue(observedThread['id']) !== run.threadId) throw staleTurnError()
          continue
        }
        if (event.method === 'turn/started') {
          assertRunEventIdentity(event.params, run, true)
          if (sawTurnStarted) throw adapterError(
            'CODEX_APP_SERVER_DUPLICATE_EVENT',
            'Codex app-server emitted a duplicate turn start',
          )
          sawTurnStarted = true
          continue
        }
        if (event.method === 'item/agentMessage/delta') {
          assertRunEventIdentity(event.params, run, false)
          const delta = stringValue(event.params['delta'])
          if (delta.length === 0 || delta.length > MAX_DELTA_LENGTH) {
            throw adapterError(
              'CODEX_APP_SERVER_DELTA_INVALID',
              'Codex app-server emitted an invalid message delta',
            )
          }
          result += delta
          if (result.length > MAX_RESULT_LENGTH) throw adapterError(
            'CODEX_APP_SERVER_RESULT_LIMIT',
            'Codex app-server result exceeded its limit',
          )
          yield withCorrelation({
            type: 'adapter:stream_delta',
            providerId: this.providerId,
            content: delta,
            timestamp: this.now(),
          }, input.correlationId)
          continue
        }
        if (event.method === 'thread/tokenUsage/updated') {
          assertRunEventIdentity(event.params, run, false)
          usage = tokenUsage(event.params['tokenUsage'])
          continue
        }
        if (event.method === 'turn/completed') {
          assertRunEventIdentity(event.params, run, true)
          const completedTurn = objectValue(event.params['turn'])
          const status = stringValue(completedTurn['status'])
          if (status === 'completed') {
            terminal = usage
              ? withCorrelation({
                  type: 'adapter:completed',
                  providerId: this.providerId,
                  sessionId: run.threadId,
                  result,
                  usage,
                  durationMs: Math.max(0, this.now() - startedAt),
                  timestamp: this.now(),
                }, input.correlationId)
              : failedEvent(
                  this.now(),
                  input.correlationId,
                  'CODEX_APP_SERVER_USAGE_MISSING',
                  'Codex app-server completed without terminal usage evidence',
                  run.threadId,
                )
          } else if (status === 'interrupted') {
            terminal = failedEvent(
              this.now(),
              input.correlationId,
              'CODEX_APP_SERVER_CANCELLED',
              'Codex app-server execution was interrupted',
              run.threadId,
            )
          } else if (status === 'failed') {
            terminal = failedEvent(
              this.now(),
              input.correlationId,
              'CODEX_APP_SERVER_TURN_FAILED',
              'Codex app-server turn failed',
              run.threadId,
            )
          } else {
            throw adapterError(
              'CODEX_APP_SERVER_TURN_INVALID',
              'Codex app-server emitted an invalid terminal turn',
            )
          }
          break
        }
        if (event.method === 'error') {
          throw adapterError(
            'CODEX_APP_SERVER_PROTOCOL_ERROR',
            'Codex app-server emitted a protocol error',
          )
        }
      }
      if (lifecycle.terminalDecision) throw decisionError(lifecycle.terminalDecision)
      if (!terminal) throw adapterError(
        'CODEX_APP_SERVER_STREAM_ENDED',
        'Codex app-server stream ended before terminal completion',
      )
    } catch (error) {
      if (!lifecycle.terminalDecision) {
        if (signal?.aborted) decide(cancellationDecision())
        else if (this.monotonicNow() >= lifecycle.deadline) decide(timeoutDecision())
      }
      const normalized = lifecycle.terminalDecision
        ? decisionError(lifecycle.terminalDecision)
        : sanitizedError(error)
      terminal = failedEvent(
        this.now(),
        input.correlationId,
        errorCode(normalized),
        normalized.message,
        activeRun?.threadId,
      )
    } finally {
      if (timeout) clearTimeout(timeout)
      if (signal && signalListener) signal.removeEventListener('abort', signalListener)
      this.runningExecutions.delete(runningExecution)
      if (activeRun) this.activeRuns.delete(activeRun)
      if (client) {
        try {
          await client.close()
        } catch (error) {
          cleanupError = sanitizedError(error)
        }
      }
    }

    if (lifecycle.terminalDecision) {
      yield failedEvent(
        this.now(),
        input.correlationId,
        lifecycle.terminalDecision.code,
        lifecycle.terminalDecision.message,
        activeRun?.threadId,
      )
      return
    }
    if (cleanupError) {
      yield failedEvent(
        this.now(),
        input.correlationId,
        errorCode(cleanupError),
        cleanupError.message,
        activeRun?.threadId,
      )
      return
    }
    if (terminal) yield terminal
  }

  private decideActiveRun(run: ActiveRun, decision: LocalTerminalDecision): void {
    if (run.lifecycle.terminalDecision) return
    run.lifecycle.terminalDecision = decision
    this.beginTerminalCleanup(run)
  }

  private beginTerminalCleanup(run: ActiveRun): void {
    const acknowledgement = this.interruptActiveRun(run)
    void acknowledgement.then(
      () => run.client.close().catch(() => undefined),
      () => run.client.close().catch(() => undefined),
    )
  }

  private interruptActiveRun(run: ActiveRun): Promise<void> {
    if (!run.interruptPromise) {
      run.interruptPromise = run.client.request('turn/interrupt', {
        threadId: run.threadId,
        turnId: run.turnId,
      }, { timeoutMs: this.interruptGraceMs }).then(() => undefined)
    }
    return run.interruptPromise
  }
}

export function createCodexAppServerAdapter(
  options: CodexAppServerAdapterOptions,
): CodexAppServerAdapter {
  return new CodexAppServerAdapter(options)
}

function assertAppServerAdmission(options: CodexAppServerAdapterOptions): void {
  const admission = validateProviderSessionAttemptBinding(
    options.attemptBinding,
    REQUIRED_BASE_CAPABILITIES,
  )
  const descriptor = options.attemptBinding.descriptor
  if (
    !admission.valid
    || descriptor.providerId !== 'codex'
    || descriptor.backend.kind !== 'app-server'
    || !boundedText(descriptor.backend.version, 128)
    || !boundedText(descriptor.backend.protocolSchemaRef, 512)
    || !/^sha256:[a-f0-9]{64}$/u.test(descriptor.backend.protocolSchemaDigest ?? '')
  ) {
    throw new Error('Codex app-server requires an admitted exact base-capability binding')
  }
  const executable = options.executable
  if (
    !executable
    || executable.name !== 'codex'
    || !isAbsolute(executable.path)
    || !isAbsolute(executable.realPath)
  ) {
    throw new Error('Codex app-server requires a resolved qualified executable identity')
  }
}

function adapterConfig(options: CodexAppServerAdapterOptions): AdapterConfig {
  const {
    attemptBinding: _attemptBinding,
    executable: _executable,
    clientLimits: _clientLimits,
    interruptGraceMs: _interruptGraceMs,
    dependencies: _dependencies,
    ...config
  } = options
  return config
}

function clientDependencies(
  options: CodexAppServerAdapterOptions,
): CodexAppServerClientDependencies | undefined {
  const dependencies = options.dependencies
  if (!dependencies) return undefined
  const selected: CodexAppServerClientDependencies = {
    ...(dependencies.spawn ? { spawn: dependencies.spawn } : {}),
    ...(dependencies.realpath ? { realpath: dependencies.realpath } : {}),
    ...(dependencies.stat ? { stat: dependencies.stat } : {}),
    ...(dependencies.access ? { access: dependencies.access } : {}),
    ...(dependencies.monotonicNow ? { monotonicNow: dependencies.monotonicNow } : {}),
  }
  return Object.keys(selected).length > 0 ? selected : undefined
}

function interruptGrace(value: number | undefined): number {
  if (value === undefined) return DEFAULT_INTERRUPT_GRACE_MS
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_INTERRUPT_GRACE_MS) {
    throw new Error(`Codex app-server interrupt grace must be an integer between 1 and ${MAX_INTERRUPT_GRACE_MS}`)
  }
  return value
}

function timeoutDecision(): LocalTerminalDecision {
  return {
    code: 'CODEX_APP_SERVER_EXECUTION_TIMEOUT',
    message: 'Codex app-server execution exceeded its time limit',
  }
}

function cancellationDecision(): LocalTerminalDecision {
  return {
    code: 'CODEX_APP_SERVER_CANCELLED',
    message: 'Codex app-server execution was cancelled',
  }
}

function decisionError(
  decision: LocalTerminalDecision,
): Error & { readonly code: LocalTerminalDecision['code'] } {
  return adapterError(decision.code, decision.message) as Error & {
    readonly code: LocalTerminalDecision['code']
  }
}

function threadStartParams(
  input: AgentInput,
  config: AdapterConfig,
): Record<string, unknown> {
  const cwd = effectiveWorkingDirectory(input, config)
  const model = effectiveModel(input, config)
  return {
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    ...(input.systemPrompt ? { developerInstructions: input.systemPrompt } : {}),
    ...(config.sandboxMode ? { sandbox: toCodexSandboxMode(config.sandboxMode) } : {}),
  }
}

function threadResumeParams(
  threadId: string,
  input: AgentInput,
  config: AdapterConfig,
): Record<string, unknown> {
  return { threadId, ...threadStartParams(input, config) }
}

function turnStartParams(
  threadId: string,
  input: AgentInput,
  config: AdapterConfig,
): Record<string, unknown> {
  const cwd = effectiveWorkingDirectory(input, config)
  const model = effectiveModel(input, config)
  return {
    threadId,
    input: [{ type: 'text', text: input.prompt }],
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
    ...(config.reasoning ? { effort: config.reasoning } : {}),
  }
}

function effectiveWorkingDirectory(input: AgentInput, config: AdapterConfig): string | undefined {
  return input.workingDirectory ?? config.workingDirectory
}

function effectiveModel(input: AgentInput, config: AdapterConfig): string | undefined {
  return typeof input.options?.['model'] === 'string'
    ? input.options['model']
    : config.model
}

function executionTimeout(input: AgentInput, config: AdapterConfig): number {
  const candidate = typeof input.options?.['timeoutMs'] === 'number'
    ? input.options['timeoutMs']
    : config.timeoutMs
  if (candidate === undefined) return DEFAULT_EXECUTION_TIMEOUT_MS
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAX_EXECUTION_TIMEOUT_MS) {
    throw new Error('Codex app-server execution timeout is invalid')
  }
  return candidate
}

function assertInput(input: AgentInput): void {
  if (!boundedText(input.prompt, MAX_PROMPT_LENGTH)) {
    throw adapterError(
      'CODEX_APP_SERVER_PROMPT_INVALID',
      'Codex app-server prompt must be non-empty and bounded',
    )
  }
  const cwd = input.workingDirectory
  if (cwd !== undefined && (!isAbsolute(cwd) || cwd.length > 4_096)) {
    throw adapterError(
      'CODEX_APP_SERVER_CWD_INVALID',
      'Codex app-server working directory is invalid',
    )
  }
}

function assertRunEventIdentity(
  params: Readonly<Record<string, unknown>>,
  run: ActiveRun,
  nestedTurn: boolean,
): void {
  if (stringValue(params['threadId']) !== run.threadId) throw staleTurnError()
  const turnId = nestedTurn
    ? stringValue(objectValue(params['turn'])['id'])
    : stringValue(params['turnId'])
  if (turnId !== run.turnId) throw staleTurnError()
}

function assertInterruptRequest(
  request: ProviderSessionInterruptTurnRequest,
  binding: ProviderSessionAttemptBinding,
): void {
  if (
    request.schema !== PROVIDER_SESSION_OPERATION_SCHEMA
    || request.kind !== 'interrupt-turn'
    || request.attemptBindingId !== binding.bindingId
    || !boundedText(request.operationId, MAX_REFERENCE_LENGTH)
    || request.session.schema !== PROVIDER_SESSION_REFERENCE_SCHEMA
    || request.session.kind !== 'session'
    || !boundedText(request.session.opaqueId, MAX_REFERENCE_LENGTH)
    || request.turn.schema !== PROVIDER_SESSION_REFERENCE_SCHEMA
    || request.turn.kind !== 'turn'
    || !boundedText(request.turn.opaqueId, MAX_REFERENCE_LENGTH)
  ) {
    throw new Error('Invalid provider-session interrupt-turn request')
  }
}

function tokenUsage(value: unknown): TokenUsage {
  const usage = objectValue(value)
  const last = tokenBreakdown(usage['last'])
  if (!last || !tokenBreakdown(usage['total'])) {
    throw adapterError(
      'CODEX_APP_SERVER_USAGE_INVALID',
      'Codex app-server emitted invalid token usage',
    )
  }
  return {
    inputTokens: last.inputTokens,
    outputTokens: last.outputTokens,
    cachedInputTokens: last.cachedInputTokens,
    ...(last.cacheWriteTokens !== undefined ? { cacheWriteTokens: last.cacheWriteTokens } : {}),
  }
}

function tokenBreakdown(value: unknown): {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedInputTokens: number
  readonly cacheWriteTokens?: number | undefined
} | undefined {
  const breakdown = objectValue(value)
  const inputTokens = nonNegativeInteger(breakdown['inputTokens'])
  const outputTokens = nonNegativeInteger(breakdown['outputTokens'])
  const cachedInputTokens = nonNegativeInteger(breakdown['cachedInputTokens'])
  const reasoningOutputTokens = nonNegativeInteger(breakdown['reasoningOutputTokens'])
  const totalTokens = nonNegativeInteger(breakdown['totalTokens'])
  const cacheWriteTokens = breakdown['cacheWriteInputTokens'] === undefined
    ? undefined
    : nonNegativeInteger(breakdown['cacheWriteInputTokens'])
  if (
    inputTokens === undefined
    || outputTokens === undefined
    || cachedInputTokens === undefined
    || reasoningOutputTokens === undefined
    || totalTokens === undefined
    || (breakdown['cacheWriteInputTokens'] !== undefined && cacheWriteTokens === undefined)
  ) return undefined
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  }
}

function interactionEvent(
  event: CodexAppServerInboundEvent,
  run: ActiveRun,
  correlationId: string | undefined,
  timestamp: number,
): AgentEvent {
  const autoResolutionMs = nonNegativeInteger(event.params['autoResolutionMs'])
  const permission = event.method.includes('Approval') || event.method.includes('permissions')
  return withCorrelation({
    type: 'adapter:interaction_required',
    providerId: 'codex',
    interactionId: `codex-app-server-request:${String(event.requestId)}`,
    question: permission
      ? 'Codex requires an explicit approval decision.'
      : 'Codex requires explicit user input.',
    kind: permission ? 'permission' : 'clarification',
    timestamp,
    expiresAt: timestamp + Math.min(autoResolutionMs ?? run.timeoutMs, run.timeoutMs),
  }, correlationId)
}

function failedEvent(
  timestamp: number,
  correlationId: string | undefined,
  code: string,
  message: string,
  sessionId?: string,
): AgentEvent {
  return withCorrelation({
    type: 'adapter:failed',
    providerId: 'codex',
    error: message,
    code,
    timestamp,
    ...(sessionId ? { sessionId } : {}),
  }, correlationId)
}

function withCorrelation<T extends AgentEvent>(
  event: T,
  correlationId: string | undefined,
): T {
  return correlationId ? { ...event, correlationId } : event
}

function staleTurnError(): Error {
  return adapterError(
    'CODEX_APP_SERVER_STALE_TURN',
    'Codex app-server emitted an event for a stale turn',
  )
}

function adapterError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code })
}

function sanitizedError(error: unknown): Error & { readonly code?: string } {
  if (error instanceof CodexAppServerClientError) return error
  if (error instanceof Error) {
    const candidate = error as Error & { readonly code?: unknown }
    const code = typeof candidate.code === 'string'
      ? candidate.code
      : undefined
    return Object.assign(new Error(error.message), code ? { code } : {})
  }
  return new Error('Codex app-server adapter failed')
}

function errorCode(error: Error & { readonly code?: string }): string {
  return error.code ?? 'CODEX_APP_SERVER_FAILED'
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

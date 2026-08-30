/**
 * Claude Agent SDK adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query() and normalizes
 * its events into the unified AgentEvent stream.
 */
import { ForgeError, type LlmAuditSink } from '@dzupagent/core/events'
import type {
  AdapterCapabilityProfile, AdapterConfig, AdapterExecutionControlAdmission,
  AdapterExecutionControlRequirement, AgentEvent, AgentInput,
  HealthStatus, InteractionPolicy, SessionInfo, TokenUsage,
} from '../types.js'
import {
  assertAdapterExecutionControlsAdmitted,
  buildExecutionControlAdmission,
} from '../execution-control-admission.js'
import { InteractionResolver } from '../interaction/interaction-resolver.js'
import { getDefaultMonitorStatus } from '../provider-catalog.js'
import { BaseSdkAdapter } from '../base/base-sdk-adapter.js'
import { AdapterStreamRunner } from '../base/stream-runner.js'
import type { AdapterStreamSource, StreamContext, ThreadStartResult } from '../base/stream-runner.js'
import {
  type ToolProgressState,
  extractTokenUsage,
  mapAssistantMessage,
  mapResultMessage,
  mapStreamEventMessage,
  mapToolProgressMessage,
} from './claude-event-mapper.js'
import {
  type BuiltClaudeQuery,
  buildQueryOptions,
  toSessionInfo,
} from './claude-query-builder.js'
import {
  forkClaudeSession,
  interruptClaudeConversation,
  isClaudeCliAvailable,
  openClaudeConversation,
} from './claude-session-helpers.js'
import {
  type ClaudeConversation,
  type ClaudeSDKMessage,
  type ClaudeSDKModule,
  isAssistantMessage,
  isResultMessage,
  isStreamEvent,
  isSystemMessage,
  isToolProgressMessage,
} from './claude-sdk-types.js'

/**
 * Claude-specific extension of {@link AdapterConfig}. Adds an optional
 * `auditSink` so callers can wire LLM-invocation audit records onto a
 * `DzupEventBus`, mirroring the OpenAI adapter pattern.
 */
export interface ClaudeAdapterConfig extends AdapterConfig {
  /** Optional best-effort audit sink — see `OpenAIConfig.auditSink` for contract. */
  auditSink?: LlmAuditSink
}

interface AdmittedClaudeQuerySnapshot {
  readonly admission: AdapterExecutionControlAdmission
  readonly interactionPolicy: InteractionPolicy
  readonly queryOptions: BuiltClaudeQuery
  readonly requirementSha256: string
  readonly resumeSessionId?: string
}

export class ClaudeAgentAdapter
  extends BaseSdkAdapter<ClaudeSDKModule>
{
  readonly providerId = 'claude' as const

  private sdk: ClaudeSDKModule | null = null
  private readonly activeConversations = new Set<ClaudeConversation>()
  private readonly activeControllers = new Set<AbortController>()
  private readonly activeResolvers = new Set<InteractionResolver>()
  private readonly admittedQuerySnapshots = new WeakMap<
    AgentInput,
    AdmittedClaudeQuerySnapshot
  >()

  /** Audit sink resolved at construction; never read off the shared config. */
  private readonly auditSink?: LlmAuditSink

  constructor(config: ClaudeAdapterConfig = {}) {
    const { auditSink, ...rest } = config
    super(rest)
    if (auditSink !== undefined) this.auditSink = auditSink
  }

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: true,
      supportsFork: true,
      supportsToolCalls: true,
      // CLI/SDK adapter: runs its own in-subprocess/agentic tool loop.
      emitsToolCalls: true,
      executesToolLoop: true,
      supportsStreaming: true,
      supportsCostUsage: true,
      supportsZeroToolDispatch: true,
      providerRequestCorrelation: {
        idempotencyKey: { accepted: false, enforcement: 'none' },
        restartLookup: { supported: false, lookupBy: [] },
      },
    }
  }

  admitExecutionControls(
    input: AgentInput,
    requirement: AdapterExecutionControlRequirement,
  ): AdapterExecutionControlAdmission {
    this.admittedQuerySnapshots.delete(input)
    const finalQuery = this.buildFinalQuery(input)
    const { queryOptions } = finalQuery
    const tools = queryOptions.options['tools']
    const admitted = Array.isArray(tools) && tools.length === 0
    const admission = buildExecutionControlAdmission({
      providerId: 'claude',
      requirement,
      status: admitted ? 'admitted' : 'rejected',
      enforcement: admitted ? 'provider-pre-dispatch' : 'unsupported',
      ...(admitted ? {} : { blockers: ['zero_tool_dispatch_not_enforced'] }),
    })
    if (admission.status === 'admitted') {
      const resumeSessionId = queryOptions.options['resume']
      this.admittedQuerySnapshots.set(input, {
        ...finalQuery,
        admission,
        requirementSha256: admission.requirementSha256,
        ...(typeof resumeSessionId === 'string' ? { resumeSessionId } : {}),
      })
    }
    return admission
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    const finalQuery = this.resolveFinalQuery(input)
    yield* this.executeFinalQuery(input, finalQuery)
  }

  private async *executeFinalQuery(
    input: AgentInput,
    finalQuery: {
      readonly interactionPolicy: InteractionPolicy
      readonly queryOptions: BuiltClaudeQuery
    },
  ): AsyncGenerator<AgentEvent, void, undefined> {
    const { interactionPolicy: policy, queryOptions } = finalQuery
    const sdk = await this.loadSdk()
    const resolver = policy.mode !== 'auto-approve' ? new InteractionResolver(policy) : null
    if (resolver) this.activeResolvers.add(resolver)
    const startTime = Date.now()
    const toolProgressState: ToolProgressState = { lastToolStartTime: 0, lastToolName: '' }
    let activeConversation: ClaudeConversation | null = null
    let runController: AbortController | null = null
    const adapter = this

    const source: AdapterStreamSource<ClaudeSDKMessage> = {
      providerId: 'claude',
      async *open(runInput: AgentInput, signal: AbortSignal): AsyncIterable<ClaudeSDKMessage> {
        yield* openClaudeConversation({
          sdk,
          queryOptions,
          signal,
          errorContext: { model: adapter.config.model, promptLength: runInput.prompt.length },
          onConversation: (conversation) => {
            if (activeConversation) adapter.activeConversations.delete(activeConversation)
            activeConversation = conversation as ClaudeConversation | null
            if (activeConversation) adapter.activeConversations.add(activeConversation)
          },
        })
      },
      detectThreadStart(raw: ClaudeSDKMessage): ThreadStartResult | null {
        if (!isSystemMessage(raw)) return null
        const resolvedModel = adapter.config.model ?? (typeof raw.model === 'string' ? raw.model : undefined)
        const resolvedWorkingDirectory = input.workingDirectory ?? adapter.config.workingDirectory
        return {
          threadId: raw.session_id,
          extra: {
            ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
            ...(resolvedWorkingDirectory !== undefined ? { workingDirectory: resolvedWorkingDirectory } : {}),
          },
        }
      },
      extractUsage(raw: ClaudeSDKMessage): TokenUsage | undefined {
        return isResultMessage(raw) ? extractTokenUsage(raw.usage) : undefined
      },
      mapRawEvent(raw: ClaudeSDKMessage, context: StreamContext): AgentEvent | AgentEvent[] | null {
        if (isSystemMessage(raw)) { context.sessionId = raw.session_id; return null }
        if (isAssistantMessage(raw)) return mapAssistantMessage(raw, context.input)
        if (isToolProgressMessage(raw)) return mapToolProgressMessage(raw, context.input, toolProgressState, resolver, policy)
        if (isStreamEvent(raw)) return mapStreamEventMessage(raw, context.input)
        if (isResultMessage(raw)) return mapResultMessage(raw, context.input, context, startTime)
        return null
      },
    }

    const runner = new AdapterStreamRunner<ClaudeSDKMessage>({
      onAbortController: (ctrl) => {
        runController = ctrl
        this.activeControllers.add(ctrl)
      },
      ...(this.auditSink ? { auditSink: this.auditSink } : {}),
      ...(this.config.model !== undefined ? { auditModel: this.config.model } : {}),
    })

    try {
      yield* runner.run(source, input, input.signal)
    } finally {
      if (activeConversation) this.activeConversations.delete(activeConversation)
      if (runController) this.activeControllers.delete(runController)
      if (resolver) { resolver.dispose(); this.activeResolvers.delete(resolver) }
    }
  }

  async *resumeSession(
    sessionId: string,
    input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    const storedSnapshot = this.takeAdmittedQuerySnapshot(input)
    if (storedSnapshot !== undefined) {
      const finalQuery = this.validateStoredQuerySnapshot(input, storedSnapshot)
      this.assertResumeSnapshotMatches(finalQuery, sessionId)
      yield* this.executeFinalQuery(input, finalQuery)
      return
    }

    const admission = assertAdapterExecutionControlsAdmitted(this, input)
    if (admission !== undefined) {
      this.consumeAdmittedQuerySnapshot(input, admission)
    }
    const resumeInput: AgentInput = {
      ...input,
      resumeSessionId: sessionId,
      options: {
        ...input.options,
        resume: sessionId,
      },
    }
    const finalQuery = this.resolveFinalQuery(resumeInput)
    if ('admission' in finalQuery) {
      this.assertResumeSnapshotMatches(finalQuery, sessionId)
    }
    yield* this.executeFinalQuery(resumeInput, finalQuery)
  }

  private resolveFinalQuery(input: AgentInput):
  | AdmittedClaudeQuerySnapshot
  | {
    readonly interactionPolicy: InteractionPolicy
    readonly queryOptions: BuiltClaudeQuery
  } {
    const storedSnapshot = this.takeAdmittedQuerySnapshot(input)
    if (storedSnapshot !== undefined) {
      return this.validateStoredQuerySnapshot(input, storedSnapshot)
    }

    const admission = assertAdapterExecutionControlsAdmitted(this, input)
    return admission === undefined
      ? this.buildFinalQuery(input)
      : this.consumeAdmittedQuerySnapshot(input, admission)
  }

  private validateStoredQuerySnapshot(
    input: AgentInput,
    snapshot: AdmittedClaudeQuerySnapshot,
  ): AdmittedClaudeQuerySnapshot {
    const validationFacade = new Proxy(this, {
      get: (target, property, receiver) => {
        if (property === 'admitExecutionControls') {
          return () => snapshot.admission
        }
        if (property === 'getCapabilities') {
          return target.getCapabilities.bind(target)
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const admission = assertAdapterExecutionControlsAdmitted(validationFacade, input)
    if (
      admission === undefined
      || admission.requirementSha256 !== snapshot.requirementSha256
    ) {
      throw this.executionControlSnapshotError(
        snapshot.admission,
        'execution_control_request_snapshot_mismatch',
      )
    }
    return snapshot
  }

  private assertResumeSnapshotMatches(
    snapshot: AdmittedClaudeQuerySnapshot,
    sessionId: string,
  ): void {
    if (snapshot.resumeSessionId !== sessionId) {
      throw this.executionControlSnapshotError(
        snapshot.admission,
        'execution_control_request_snapshot_mismatch',
      )
    }
  }

  private takeAdmittedQuerySnapshot(
    input: AgentInput,
  ): AdmittedClaudeQuerySnapshot | undefined {
    const snapshot = this.admittedQuerySnapshots.get(input)
    this.admittedQuerySnapshots.delete(input)
    return snapshot
  }

  private consumeAdmittedQuerySnapshot(
    input: AgentInput,
    admission: AdapterExecutionControlAdmission,
  ): AdmittedClaudeQuerySnapshot {
    const snapshot = this.takeAdmittedQuerySnapshot(input)
    if (
      snapshot === undefined
      || snapshot.requirementSha256 !== admission.requirementSha256
    ) {
      throw this.executionControlSnapshotError(
        admission,
        'execution_control_request_snapshot_missing',
      )
    }
    return snapshot
  }

  private executionControlSnapshotError(
    admission: AdapterExecutionControlAdmission,
    blocker: 'execution_control_request_snapshot_mismatch'
    | 'execution_control_request_snapshot_missing',
  ): ForgeError {
    return new ForgeError({
      code: 'CAPABILITY_DENIED',
      message: 'Claude SDK admission has no matching final request snapshot',
      recoverable: false,
      context: {
        providerId: 'claude',
        executionControlBlocker: blocker,
        admission,
      },
    })
  }

  private buildFinalQuery(input: AgentInput): {
    readonly interactionPolicy: InteractionPolicy
    readonly queryOptions: BuiltClaudeQuery
  } {
    const interactionPolicy = this.resolveInteractionPolicy(input)
    return {
      interactionPolicy,
      queryOptions: buildQueryOptions({
        input,
        config: this.config,
        interactionPolicy,
      }),
    }
  }

  interrupt(): void {
    for (const conversation of this.activeConversations) interruptClaudeConversation(conversation, null)
    for (const controller of this.activeControllers) controller.abort()
    this.activeConversations.clear()
    this.activeControllers.clear()
  }

  override respondInteraction(interactionId: string, answer: string): boolean {
    for (const resolver of this.activeResolvers) if (resolver.respond(interactionId, answer)) return true
    return false
  }

  async healthCheck(): Promise<HealthStatus> {
    let sdkInstalled = false
    let cliAvailable = false
    let lastError: string | undefined

    // Check SDK importability
    try {
      await this.loadSdk()
      sdkInstalled = true
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err)
    }

    // Check if the claude CLI binary is available
    cliAvailable = await isClaudeCliAvailable()
    if (!cliAvailable && !lastError) {
      lastError = 'Claude CLI binary not found in PATH'
    }

    return {
      healthy: sdkInstalled,
      providerId: 'claude',
      sdkInstalled,
      cliAvailable,
      ...(!sdkInstalled && lastError !== undefined ? { lastError } : {}),
      monitorStatus: getDefaultMonitorStatus('claude'),
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    const sdk = await this.loadSdk()

    if (typeof sdk.listSessions !== 'function') {
      return []
    }

    try {
      const rawSessions = await sdk.listSessions()
      return rawSessions.map(toSessionInfo)
    } catch (err: unknown) {
      throw ForgeError.wrap(err, {
        code: 'ADAPTER_EXECUTION_FAILED',
        suggestion: 'Failed to list Claude sessions',
        context: { providerId: 'claude', operation: 'listSessions' },
      })
    }
  }

  async forkSession(sessionId: string): Promise<string> {
    const sdk = await this.loadSdk()
    return forkClaudeSession(sdk, sessionId)
  }

  /** Delegates to the legacy {@link loadSDK} so tests that spy on the original name still work. */
  override async loadSdk(): Promise<ClaudeSDKModule> {
    return this.loadSDK()
  }

  /** @internal @deprecated retained for test fixtures; call {@link loadSdk}. */
  private async loadSDK(): Promise<ClaudeSDKModule> {
    if (this.sdk) return this.sdk
    this.sdk = await this.loadOptionalSdkModule<ClaudeSDKModule>(
      '@anthropic-ai/claude-agent-sdk',
      { providerId: 'claude' },
    )
    return this.sdk
  }
}

/**
 * Functional entry point for {@link ClaudeAgentAdapter}. The CJS-to-ESM
 * `scripts/lib/agent-bridge/run.mjs` resolves adapters by `create<Provider>Adapter`
 * before falling back to class exports.
 */
export function createClaudeAdapter(config: AdapterConfig = {}): ClaudeAgentAdapter {
  return new ClaudeAgentAdapter(config)
}

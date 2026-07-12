/**
 * Claude Agent SDK adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query() and normalizes
 * its events into the unified AgentEvent stream.
 */
import { ForgeError, type LlmAuditSink } from '@dzupagent/core/events'
import type {
  AdapterCapabilityProfile, AdapterConfig, AgentEvent, AgentInput,
  HealthStatus, SessionInfo, TokenUsage,
} from '../types.js'
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

export class ClaudeAgentAdapter
  extends BaseSdkAdapter<ClaudeSDKModule>
{
  readonly providerId = 'claude' as const

  private sdk: ClaudeSDKModule | null = null
  private readonly activeConversations = new Set<ClaudeConversation>()
  private readonly activeControllers = new Set<AbortController>()
  private readonly activeResolvers = new Set<InteractionResolver>()

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
      supportsStreaming: true,
      supportsCostUsage: true,
    }
  }

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    const sdk = await this.loadSdk()
    const policy = this.resolveInteractionPolicy(input)
    const resolver = policy.mode !== 'auto-approve' ? new InteractionResolver(policy) : null
    if (resolver) this.activeResolvers.add(resolver)
    const startTime = Date.now()
    const queryOptions = buildQueryOptions({
      input,
      config: this.config,
      interactionPolicy: policy,
    })
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
    const resumeInput: AgentInput = {
      ...input,
      resumeSessionId: sessionId,
      options: {
        ...input.options,
        resume: sessionId,
      },
    }
    yield* this.execute(resumeInput)
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

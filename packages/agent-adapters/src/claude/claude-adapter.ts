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
  implements AdapterStreamSource<ClaudeSDKMessage>
{
  readonly providerId = 'claude' as const

  private sdk: ClaudeSDKModule | null = null
  private activeConversation: ClaudeConversation | null = null

  /** Audit sink resolved at construction; never read off the shared config. */
  private readonly auditSink?: LlmAuditSink

  // Per-execution state populated by execute() before the runner starts.
  // mapRawEvent / detectThreadStart / open consume these fields.
  private currentInput: AgentInput | null = null
  private currentQueryOptions: Record<string, unknown> | null = null
  private currentStartTime = 0
  private readonly toolProgressState: ToolProgressState = {
    lastToolStartTime: 0,
    lastToolName: '',
  }

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
    this.resolver = policy.mode !== 'auto-approve' ? new InteractionResolver(policy) : null

    this.currentInput = input
    this.currentStartTime = Date.now()
    this.currentQueryOptions = buildQueryOptions({
      input,
      config: this.config,
      interactionPolicy: policy,
    })
    this.toolProgressState.lastToolStartTime = 0
    this.toolProgressState.lastToolName = ''
    // sdk reference held via this.sdk (loadSdk caches it)
    this.sdk = sdk

    const runner = new AdapterStreamRunner<ClaudeSDKMessage>({
      onAbortController: (ctrl) => {
        this.abortController = ctrl
      },
      ...(this.auditSink ? { auditSink: this.auditSink } : {}),
      ...(this.config.model !== undefined ? { auditModel: this.config.model } : {}),
    })

    try {
      yield* runner.run(this, input, input.signal)
    } finally {
      this.activeConversation = null
      this.abortController = null
      this.currentInput = null
      this.currentQueryOptions = null
      this.disposeResolver()
    }
  }

  // AdapterStreamSource<ClaudeSDKMessage> implementation ----------------

  async *open(input: AgentInput, signal: AbortSignal): AsyncIterable<ClaudeSDKMessage> {
    const sdk = this.sdk
    const queryOptions = this.currentQueryOptions
    if (!sdk || !queryOptions) {
      throw new ForgeError({
        code: 'ADAPTER_EXECUTION_FAILED',
        message: 'ClaudeAgentAdapter.open invoked outside execute()',
        recoverable: false,
      })
    }
    yield* openClaudeConversation({
      sdk,
      queryOptions,
      signal,
      errorContext: { model: this.config.model, promptLength: input.prompt.length },
      onConversation: (conv) => {
        this.activeConversation = conv as ClaudeConversation | null
      },
    })
  }

  detectThreadStart(raw: ClaudeSDKMessage): ThreadStartResult | null {
    if (!isSystemMessage(raw)) return null
    const input = this.currentInput
    const resolvedModel = this.config.model ?? (typeof raw.model === 'string' ? raw.model : undefined)
    const resolvedWorkingDirectory = input?.workingDirectory ?? this.config.workingDirectory
    return {
      threadId: raw.session_id,
      extra: {
        ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
        ...(resolvedWorkingDirectory !== undefined ? { workingDirectory: resolvedWorkingDirectory } : {}),
      },
    }
  }

  extractUsage(raw: ClaudeSDKMessage): TokenUsage | undefined {
    if (!isResultMessage(raw)) return undefined
    return extractTokenUsage(raw.usage)
  }

  mapRawEvent(raw: ClaudeSDKMessage, context: StreamContext): AgentEvent | AgentEvent[] | null {
    const input = context.input

    if (isSystemMessage(raw)) {
      // Thread start handled via detectThreadStart; capture session id locally.
      context.sessionId = raw.session_id
      return null
    }

    if (isAssistantMessage(raw)) {
      return mapAssistantMessage(raw, input)
    }

    if (isToolProgressMessage(raw)) {
      const policy = this.resolveInteractionPolicy(input)
      return mapToolProgressMessage(raw, input, this.toolProgressState, this.resolver, policy)
    }

    if (isStreamEvent(raw)) {
      return mapStreamEventMessage(raw, input)
    }

    if (isResultMessage(raw)) {
      return mapResultMessage(raw, input, context, this.currentStartTime)
    }

    return null
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
    interruptClaudeConversation(this.activeConversation, this.abortController)
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

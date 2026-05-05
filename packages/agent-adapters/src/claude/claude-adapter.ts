/**
 * Claude Agent SDK adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query() and normalizes
 * its events into the unified AgentEvent stream.
 */
import { randomUUID } from 'node:crypto'
import { ForgeError } from '@dzupagent/core'
import { SystemPromptBuilder } from '../prompts/system-prompt-builder.js'
import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AgentEvent,
  AgentInput,
  HealthStatus,
  SessionInfo,
  TokenUsage,
} from '../types.js'
import { InteractionResolver } from '../interaction/interaction-resolver.js'
import { classifyInteractionText } from '../interaction/interaction-detector.js'
import { getDefaultMonitorStatus } from '../provider-catalog.js'
import { BaseSdkAdapter } from '../base/base-sdk-adapter.js'
import { extractTokenUsage as extractTokenUsageShared } from '../base/extract-token-usage.js'
import { AdapterStreamRunner } from '../base/stream-runner.js'
import type { AdapterStreamSource, StreamContext } from '../base/stream-runner.js'

// ---------------------------------------------------------------------------
// SDK type declarations (optional peer dep — cannot import statically)
// ---------------------------------------------------------------------------

/** Shape of the object returned by query(). */
interface ClaudeConversation {
  [Symbol.asyncIterator](): AsyncIterator<ClaudeSDKMessage>
  interrupt(): void
}

/** Union of SDK message types we handle. */
interface ClaudeSDKMessage {
  type: 'system' | 'assistant' | 'result' | 'tool_progress' | 'stream_event'
  [key: string]: unknown
}

/** Resolved SDK module shape. */
interface ClaudeSDKModule {
  query(opts: Record<string, unknown>): ClaudeConversation
  listSessions?(): Promise<unknown[]>
  getSessionInfo?(sessionId: string): Promise<unknown>
}

// ---------------------------------------------------------------------------
// Type guards for SDK messages
// ---------------------------------------------------------------------------

function isSystemMessage(
  msg: ClaudeSDKMessage,
): msg is ClaudeSDKMessage & { session_id: string; tools?: unknown[]; model?: string } {
  return msg.type === 'system' && typeof (msg as Record<string, unknown>)['session_id'] === 'string'
}

function isAssistantMessage(
  msg: ClaudeSDKMessage,
): msg is ClaudeSDKMessage & { content: unknown[] } {
  return msg.type === 'assistant' && Array.isArray((msg as Record<string, unknown>)['content'])
}

interface ResultMessage extends ClaudeSDKMessage {
  subtype: string
  result?: string
  session_id?: string
  usage?: Record<string, unknown>
  duration_ms?: number
  error?: string
}

function isResultMessage(msg: ClaudeSDKMessage): msg is ResultMessage {
  return msg.type === 'result' && typeof (msg as Record<string, unknown>)['subtype'] === 'string'
}

interface ToolProgressMessage extends ClaudeSDKMessage {
  tool_name: string
  input?: unknown
  output?: string
  status: 'started' | 'completed' | 'failed'
  duration_ms?: number
}

function isToolProgressMessage(msg: ClaudeSDKMessage): msg is ToolProgressMessage {
  return msg.type === 'tool_progress' && typeof (msg as Record<string, unknown>)['tool_name'] === 'string'
}

interface StreamEventMessage extends ClaudeSDKMessage {
  delta?: string
}

function isStreamEvent(msg: ClaudeSDKMessage): msg is StreamEventMessage {
  return msg.type === 'stream_event'
}

// ---------------------------------------------------------------------------
// Content block helpers
// ---------------------------------------------------------------------------

interface ContentBlock {
  type: string
  text?: string
  tool_use?: { name: string; input: unknown }
}

function extractTextFromContentBlocks(blocks: unknown[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (isContentBlock(block)) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text)
      }
    }
  }
  return parts.join('\n')
}

function isContentBlock(value: unknown): value is ContentBlock {
  return typeof value === 'object' && value !== null && 'type' in value
}

// ---------------------------------------------------------------------------
// Permission mode mapping
// ---------------------------------------------------------------------------

function mapSandboxMode(mode: AdapterConfig['sandboxMode']): string {
  switch (mode) {
    case 'read-only':
      return 'default'
    case 'workspace-write':
      // Claude SDK has no granular cwd-write mode. Route to 'default' (restricted)
      // rather than 'bypassPermissions' (full access). Callers that need unrestricted
      // file writes must explicitly use 'full-access'.
      return 'default'
    case 'full-access':
      return 'bypassPermissions'
    default:
      return 'default'
  }
}

// ---------------------------------------------------------------------------
// Token usage extraction
// ---------------------------------------------------------------------------

function extractTokenUsage(usage: Record<string, unknown> | undefined): TokenUsage | undefined {
  return extractTokenUsageShared(usage) as TokenUsage | undefined
}

// ---------------------------------------------------------------------------
// Interaction tool helpers
// ---------------------------------------------------------------------------

/** Tool names the Claude SDK uses when it needs to ask the user something. */
const INTERACTION_TOOL_NAMES = new Set([
  'user_confirmation',
  'request_permission',
  'ask_user',
  'clarification',
  'confirm',
])

function isInteractionToolName(name: string): boolean {
  return INTERACTION_TOOL_NAMES.has(name)
}

/** Extract question text from the tool input object. */
function extractQuestionFromToolInput(input: unknown): string {
  if (input === null || typeof input !== 'object') return String(input ?? '')
  const obj = input as Record<string, unknown>
  for (const key of ['question', 'message', 'prompt', 'text', 'description', 'reason']) {
    if (typeof obj[key] === 'string' && (obj[key] as string).length > 0) {
      return obj[key] as string
    }
  }
  return JSON.stringify(input)
}

// ---------------------------------------------------------------------------
// ClaudeAgentAdapter
// ---------------------------------------------------------------------------

export class ClaudeAgentAdapter extends BaseSdkAdapter<ClaudeSDKModule> {
  readonly providerId = 'claude' as const

  private sdk: ClaudeSDKModule | null = null
  private activeConversation: ClaudeConversation | null = null

  // -----------------------------------------------------------------------
  // AgentCLIAdapter.getCapabilities
  // -----------------------------------------------------------------------

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: true,
      supportsFork: true,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: true,
    }
  }

  // -----------------------------------------------------------------------
  // AgentCLIAdapter.execute
  // -----------------------------------------------------------------------

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    const sdk = await this.loadSdk()
    const startTime = Date.now()

    const policy = this.resolveInteractionPolicy(input)
    this.resolver = policy.mode !== 'auto-approve' ? new InteractionResolver(policy) : null

    const runner = new AdapterStreamRunner<ClaudeSDKMessage>({
      onAbortController: (ctrl) => { this.abortController = ctrl },
    })

    const queryOptions = this.buildQueryOptions(input)
    const source = this.buildClaudeStreamSource(sdk, queryOptions, input, startTime)

    try {
      yield* runner.run(source, input, input.signal)
    } finally {
      this.activeConversation = null
      this.abortController = null
      this.disposeResolver()
    }
  }

  // -----------------------------------------------------------------------
  // Stream source implementation for AdapterStreamRunner
  // -----------------------------------------------------------------------

  private buildClaudeStreamSource(
    sdk: ClaudeSDKModule,
    queryOptions: Record<string, unknown>,
    input: AgentInput,
    startTime: number,
  ): AdapterStreamSource<ClaudeSDKMessage> {
    const adapter = this
    let lastToolStartTime = 0
    let lastToolName = ''

    return {
      providerId: 'claude' as const,

      async *open(_input: AgentInput, signal: AbortSignal): AsyncIterable<ClaudeSDKMessage> {
        // Inject the runner's AbortController signal into the SDK query options
        const opts = queryOptions.options as Record<string, unknown>
        opts['abortController'] = { signal, abort: () => { /* runner owns abort */ } }

        let conversation: ClaudeConversation
        try {
          conversation = sdk.query(queryOptions)
          adapter.activeConversation = conversation
        } catch (err: unknown) {
          throw ForgeError.wrap(err, {
            code: 'ADAPTER_EXECUTION_FAILED',
            suggestion: 'Verify Claude Agent SDK is correctly installed and configured',
            context: {
              providerId: 'claude',
              model: adapter.config.model,
              promptLength: input.prompt.length,
            },
          })
        }

        try {
          for await (const message of conversation as AsyncIterable<ClaudeSDKMessage>) {
            if (signal.aborted) break
            yield message
          }
        } finally {
          adapter.activeConversation = null
        }
      },

      mapRawEvent(raw: ClaudeSDKMessage, context: StreamContext): AgentEvent | null {
        if (isSystemMessage(raw)) {
          // Thread start is detected via detectThreadStart; here we also capture
          // model from the system message for the started event enrichment.
          context.sessionId = raw.session_id
          return null
        }

        if (isAssistantMessage(raw)) {
          const text = extractTextFromContentBlocks(raw.content as unknown[])
          if (text.length === 0) return null
          return {
            type: 'adapter:message',
            providerId: 'claude',
            content: text,
            role: 'assistant',
            timestamp: Date.now(),
            ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          }
        }

        if (isToolProgressMessage(raw)) {
          if (raw.status === 'started') {
            lastToolStartTime = Date.now()
            lastToolName = raw.tool_name

            if (adapter.resolver && isInteractionToolName(raw.tool_name)) {
              const questionText = extractQuestionFromToolInput(raw.input)
              const interactionId = randomUUID()
              const kind = classifyInteractionText(questionText)
              const nowMs = Date.now()
              const policy = adapter.resolveInteractionPolicy(input)

              // Schedule async interaction handling — emit interaction events after return
              // by returning a special marker. We handle this inline via a yielded promise
              // through a side-channel: emit interaction_required synchronously if ask-caller.
              if (policy.mode === 'ask-caller') {
                // Return interaction_required as the mapped event; the resolver runs async.
                // We use a void promise to allow the interaction to complete before yielding more.
                void adapter.resolver.resolve({ interactionId, question: questionText, kind })
                return {
                  type: 'adapter:interaction_required',
                  providerId: 'claude',
                  interactionId,
                  question: questionText,
                  kind,
                  timestamp: nowMs,
                  expiresAt: nowMs + (policy.askCaller?.timeoutMs ?? 60_000),
                  ...(input.correlationId ? { correlationId: input.correlationId } : {}),
                } as AgentEvent
              }
              return null
            }

            return {
              type: 'adapter:tool_call',
              providerId: 'claude',
              toolName: raw.tool_name,
              input: raw.input ?? {},
              timestamp: Date.now(),
              ...(input.correlationId ? { correlationId: input.correlationId } : {}),
            }
          }

          // completed/failed
          if (isInteractionToolName(raw.tool_name) && adapter.resolver) return null
          const durationMs = typeof raw.duration_ms === 'number'
            ? raw.duration_ms
            : (lastToolName === raw.tool_name ? Date.now() - lastToolStartTime : 0)
          return {
            type: 'adapter:tool_result',
            providerId: 'claude',
            toolName: raw.tool_name,
            output: typeof raw.output === 'string' ? raw.output : '',
            durationMs,
            timestamp: Date.now(),
            ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          }
        }

        if (isStreamEvent(raw)) {
          const delta = raw.delta
          if (typeof delta !== 'string' || delta.length === 0) return null
          return {
            type: 'adapter:stream_delta',
            providerId: 'claude',
            content: delta,
            timestamp: Date.now(),
            ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          }
        }

        if (isResultMessage(raw)) {
          const durationMs = typeof raw.duration_ms === 'number'
            ? raw.duration_ms
            : Date.now() - startTime

          if (raw.subtype === 'success') {
            const tokenUsage = extractTokenUsage(raw.usage)
            const sessionId = raw.session_id ?? context.sessionId
            const completedEvent: AgentEvent = {
              type: 'adapter:completed',
              providerId: 'claude',
              sessionId,
              result: typeof raw.result === 'string' ? raw.result : '',
              ...(tokenUsage !== undefined ? { usage: tokenUsage } : {}),
              durationMs,
              timestamp: Date.now(),
              ...(input.correlationId ? { correlationId: input.correlationId } : {}),
            }
            if (tokenUsage && (tokenUsage.cachedInputTokens !== undefined || tokenUsage.cacheWriteTokens !== undefined)) {
              const cacheRead = tokenUsage.cachedInputTokens ?? 0
              const cacheWrite = tokenUsage.cacheWriteTokens ?? 0
              const total = tokenUsage.inputTokens
              const cacheStatsEvent: AgentEvent = {
                type: 'adapter:cache_stats',
                providerId: 'claude',
                sessionId,
                cacheReadTokens: cacheRead,
                cacheWriteTokens: cacheWrite,
                totalInputTokens: total,
                cacheHitRatio: total > 0 ? cacheRead / total : 0,
                timestamp: Date.now(),
                ...(input.correlationId ? { correlationId: input.correlationId } : {}),
              } as AgentEvent
              return [completedEvent, cacheStatsEvent]
            }
            return completedEvent
          }

          const failedSessionId = raw.session_id ?? (context.sessionId || undefined)
          return {
            type: 'adapter:failed',
            providerId: 'claude',
            ...(failedSessionId !== undefined ? { sessionId: failedSessionId } : {}),
            error: typeof raw.error === 'string'
              ? raw.error
              : `Claude agent failed with subtype: ${raw.subtype}`,
            code: raw.subtype,
            timestamp: Date.now(),
            ...(input.correlationId ? { correlationId: input.correlationId } : {}),
          }
        }

        return null
      },

      detectThreadStart(raw: ClaudeSDKMessage): { threadId: string; sessionId?: string; extra?: Record<string, unknown> } | null {
        if (isSystemMessage(raw)) {
          const resolvedModel = adapter.config.model ?? (typeof raw.model === 'string' ? raw.model : undefined)
          const resolvedWorkingDirectory = input.workingDirectory ?? adapter.config.workingDirectory
          return {
            threadId: raw.session_id,
            extra: {
              ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
              ...(resolvedWorkingDirectory !== undefined ? { workingDirectory: resolvedWorkingDirectory } : {}),
            },
          }
        }
        return null
      },
    }
  }

  // -----------------------------------------------------------------------
  // AgentCLIAdapter.resumeSession
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // AgentCLIAdapter.interrupt
  // -----------------------------------------------------------------------

  interrupt(): void {
    // Attach a no-op catch to the active conversation's async iterator before
    // calling interrupt() so the SDK's internal abort rejection ("Claude Code
    // process aborted by user") never surfaces as an unhandledRejection.
    if (this.activeConversation) {
      const conv = this.activeConversation as unknown as AsyncIterator<unknown>
      if (typeof conv.return === 'function') {
        conv.return(undefined).catch(() => {})
      }
    }

    try {
      if (this.activeConversation) {
        this.activeConversation.interrupt()
      }
    } catch {
      // SDK interrupt may throw — already covered by abort below
    }
    try {
      if (this.abortController) {
        this.abortController.abort()
      }
    } catch {
      // Ignore synchronous throws raised by abort listeners
    }
  }

  // -----------------------------------------------------------------------
  // AgentCLIAdapter.healthCheck
  // -----------------------------------------------------------------------

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
    try {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)
      await execFileAsync('claude', ['--version'], { timeout: 5000 })
      cliAvailable = true
    } catch {
      // CLI not found — not fatal
      if (!lastError) {
        lastError = 'Claude CLI binary not found in PATH'
      }
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

  // -----------------------------------------------------------------------
  // AgentCLIAdapter.listSessions
  // -----------------------------------------------------------------------

  async listSessions(): Promise<SessionInfo[]> {
    const sdk = await this.loadSdk()

    if (typeof sdk.listSessions !== 'function') {
      return []
    }

    try {
      const rawSessions = await sdk.listSessions()
      return rawSessions.map((raw) => this.toSessionInfo(raw))
    } catch (err: unknown) {
      throw ForgeError.wrap(err, {
        code: 'ADAPTER_EXECUTION_FAILED',
        suggestion: 'Failed to list Claude sessions',
        context: { providerId: 'claude', operation: 'listSessions' },
      })
    }
  }

  // -----------------------------------------------------------------------
  // AgentCLIAdapter.forkSession
  // -----------------------------------------------------------------------

  async forkSession(sessionId: string): Promise<string> {
    const sdk = await this.loadSdk()

    // Fork is implemented by starting a new query with forkSession option
    // and capturing the new session_id from the system event.
    return new Promise<string>((resolve, reject) => {
      const abortController = new AbortController()
      const conversation = sdk.query({
        prompt: '',
        options: {
          resume: sessionId,
          forkSession: true,
          abortController,
        },
      })

      const iterate = async (): Promise<void> => {
        try {
          for await (const message of conversation as AsyncIterable<ClaudeSDKMessage>) {
            if (isSystemMessage(message)) {
              // We got the new session ID from the forked session
              abortController.abort()
              resolve(message.session_id)
              return
            }
          }
          reject(
            new ForgeError({
              code: 'ADAPTER_SESSION_NOT_FOUND',
              message: `Failed to fork session ${sessionId}: no system event received`,
            }),
          )
        } catch (err: unknown) {
          // Abort errors are expected after we resolve
          if (abortController.signal.aborted) {
            return
          }
          reject(
            ForgeError.wrap(err, {
              code: 'ADAPTER_EXECUTION_FAILED',
              context: { providerId: 'claude', sessionId, operation: 'forkSession' },
            }),
          )
        }
      }

      void iterate()
    })
  }

  // -----------------------------------------------------------------------
  // BaseSdkAdapter.loadSdk — concrete implementation
  // -----------------------------------------------------------------------

  /**
   * Implements {@link BaseSdkAdapter.loadSdk}. Delegates to the existing
   * {@link loadSDK} accessor so test fixtures that spy on the original
   * method name continue to work.
   */
  override async loadSdk(): Promise<ClaudeSDKModule> {
    return this.loadSDK()
  }

  /** @internal Backward-compatible accessor for tests that spy on this method. */
  private async loadSDK(): Promise<ClaudeSDKModule> {
    if (this.sdk) return this.sdk
    this.sdk = await this.loadOptionalSdkModule<ClaudeSDKModule>(
      '@anthropic-ai/claude-agent-sdk',
      { providerId: 'claude' },
    )
    return this.sdk
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private buildQueryOptions(input: AgentInput): Record<string, unknown> {
    const options: Record<string, unknown> = {}

    if (input.systemPrompt) {
      const mode = (input.options?.['systemPromptMode'] as string | undefined) ?? 'append'
      const builder = new SystemPromptBuilder(input.systemPrompt, {
        claudeMode: mode === 'replace' ? 'replace' : 'append',
      })
      options['systemPrompt'] = builder.buildFor('claude')
    }
    if (input.maxTurns !== undefined) {
      options['maxTurns'] = input.maxTurns
    }
    if (input.maxBudgetUsd !== undefined) {
      options['maxBudgetUsd'] = input.maxBudgetUsd
    }
    if (input.workingDirectory ?? this.config.workingDirectory) {
      options['cwd'] = input.workingDirectory ?? this.config.workingDirectory
    }
    // Determine permissionMode:
    // - sandboxMode takes priority for explicit permission control
    // - interaction policy 'auto-approve' bypasses permissions only when no sandboxMode is set
    const interactionPolicy = this.resolveInteractionPolicy(input)
    if (this.config.sandboxMode) {
      options['permissionMode'] = mapSandboxMode(this.config.sandboxMode)
    } else if (interactionPolicy.mode === 'auto-approve') {
      options['permissionMode'] = 'bypassPermissions'
    }
    // Extended thinking for Claude: reasoning='high' or explicit thinkingBudgetTokens
    const thinkingBudget = this.config.thinkingBudgetTokens ?? (this.config.reasoning === 'high' ? 10000 : 0)
    if (thinkingBudget > 0) {
      options['thinking'] = { type: 'enabled', budget_tokens: thinkingBudget }
    }

    // Prompt caching: enabled by default ('auto') unless explicitly disabled.
    // Adds cache_control markers on the system prompt so repeated runs with the
    // same persona/tools pay write cost once and read cost (~10%) thereafter.
    if (this.config.promptCache !== 'off') {
      options['promptCaching'] = true
    }

    if (input.resumeSessionId) {
      options['resume'] = input.resumeSessionId
    }

    // Merge adapter-specific options from input
    if (input.options) {
      for (const [key, value] of Object.entries(input.options)) {
        if (key === 'continue' || key === 'forkSession' || key === 'resume') {
          options[key] = value
        }
      }
    }

    // Merge provider-specific config options (may override promptCaching if needed)
    if (this.config.providerOptions) {
      for (const [key, value] of Object.entries(this.config.providerOptions)) {
        options[key] = value
      }
    }

    return {
      prompt: input.prompt,
      options,
    }
  }

  private toSessionInfo(raw: unknown): SessionInfo {
    const obj = raw as Record<string, unknown>
    return {
      sessionId: typeof obj['session_id'] === 'string' ? obj['session_id'] : String(obj['id'] ?? ''),
      providerId: 'claude',
      createdAt: obj['created_at'] instanceof Date
        ? obj['created_at']
        : new Date(typeof obj['created_at'] === 'string' || typeof obj['created_at'] === 'number'
          ? obj['created_at']
          : 0),
      lastActiveAt: obj['last_active_at'] instanceof Date
        ? obj['last_active_at']
        : new Date(typeof obj['last_active_at'] === 'string' || typeof obj['last_active_at'] === 'number'
          ? obj['last_active_at']
          : Date.now()),
      ...(typeof obj['cwd'] === 'string' ? { workingDirectory: obj['cwd'] } : {}),
      ...(typeof obj['metadata'] === 'object' && obj['metadata'] !== null
        ? { metadata: obj['metadata'] as Record<string, unknown> }
        : {}),
    }
  }
}

/**
 * Factory function for {@link ClaudeAgentAdapter}.
 *
 * Provides a stable functional entry point for callers that prefer not to
 * instantiate the class directly (for example, the CJS-to-ESM
 * `scripts/lib/agent-bridge/run.mjs` resolves adapters by `create<Provider>Adapter`
 * before falling back to class exports).
 */
export function createClaudeAdapter(config: AdapterConfig = {}): ClaudeAgentAdapter {
  return new ClaudeAgentAdapter(config)
}

/**
 * Claude Agent SDK adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query() and normalizes
 * its events into the unified AgentEvent stream.
 */
import { ForgeError } from '@dzipagent/core'
import type {
  AdapterConfig,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  HealthStatus,
  SessionInfo,
  TokenUsage,
} from '../types.js'

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
  if (!usage) return undefined
  const inputTokens = typeof usage['input_tokens'] === 'number' ? usage['input_tokens'] : 0
  const outputTokens = typeof usage['output_tokens'] === 'number' ? usage['output_tokens'] : 0
  const result: TokenUsage = { inputTokens, outputTokens }
  if (typeof usage['cached_input_tokens'] === 'number') {
    result.cachedInputTokens = usage['cached_input_tokens']
  }
  if (typeof usage['cost_cents'] === 'number') {
    result.costCents = usage['cost_cents']
  }
  return result
}

// ---------------------------------------------------------------------------
// ClaudeAgentAdapter
// ---------------------------------------------------------------------------

export class ClaudeAgentAdapter implements AgentCLIAdapter {
  readonly providerId = 'claude' as const

  private config: AdapterConfig
  private sdk: ClaudeSDKModule | null = null
  private activeConversation: ClaudeConversation | null = null
  private abortController: AbortController | null = null

  constructor(config: AdapterConfig = {}) {
    this.config = { ...config }
  }

  // -----------------------------------------------------------------------
  // AgentCLIAdapter.configure
  // -----------------------------------------------------------------------

  configure(opts: Partial<AdapterConfig>): void {
    this.config = { ...this.config, ...opts }
  }

  // -----------------------------------------------------------------------
  // AgentCLIAdapter.execute
  // -----------------------------------------------------------------------

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    const sdk = await this.loadSDK()
    const startTime = Date.now()

    this.abortController = new AbortController()
    if (input.signal) {
      // Forward external abort to our controller
      input.signal.addEventListener('abort', () => this.abortController?.abort(), { once: true })
    }

    const queryOptions = this.buildQueryOptions(input)
    let sessionId = ''
    let lastToolStartTime = 0
    let lastToolName = ''

    let conversation: ClaudeConversation
    try {
      conversation = sdk.query(queryOptions)
      this.activeConversation = conversation
    } catch (err: unknown) {
      throw ForgeError.wrap(err, {
        code: 'ADAPTER_EXECUTION_FAILED',
        suggestion: 'Verify Claude Agent SDK is correctly installed and configured',
        context: { adapter: 'claude' },
      })
    }

    try {
      for await (const message of conversation as AsyncIterable<ClaudeSDKMessage>) {
        if (this.abortController.signal.aborted) {
          break
        }

        if (isSystemMessage(message)) {
          sessionId = message.session_id
          yield {
            type: 'adapter:started',
            providerId: 'claude',
            sessionId,
            timestamp: Date.now(),
          }
          continue
        }

        if (isAssistantMessage(message)) {
          const text = extractTextFromContentBlocks(message.content as unknown[])
          if (text.length > 0) {
            yield {
              type: 'adapter:message',
              providerId: 'claude',
              content: text,
              role: 'assistant',
              timestamp: Date.now(),
            }
          }
          continue
        }

        if (isToolProgressMessage(message)) {
          if (message.status === 'started') {
            lastToolStartTime = Date.now()
            lastToolName = message.tool_name
            yield {
              type: 'adapter:tool_call',
              providerId: 'claude',
              toolName: message.tool_name,
              input: message.input ?? {},
              timestamp: Date.now(),
            }
          } else {
            // completed or failed
            const durationMs = typeof message.duration_ms === 'number'
              ? message.duration_ms
              : (lastToolName === message.tool_name ? Date.now() - lastToolStartTime : 0)
            yield {
              type: 'adapter:tool_result',
              providerId: 'claude',
              toolName: message.tool_name,
              output: typeof message.output === 'string' ? message.output : '',
              durationMs,
              timestamp: Date.now(),
            }
          }
          continue
        }

        if (isStreamEvent(message)) {
          const delta = message.delta
          if (typeof delta === 'string' && delta.length > 0) {
            yield {
              type: 'adapter:stream_delta',
              providerId: 'claude',
              content: delta,
              timestamp: Date.now(),
            }
          }
          continue
        }

        if (isResultMessage(message)) {
          const durationMs = typeof message.duration_ms === 'number'
            ? message.duration_ms
            : Date.now() - startTime

          if (message.subtype === 'success') {
            yield {
              type: 'adapter:completed',
              providerId: 'claude',
              sessionId: message.session_id ?? sessionId,
              result: typeof message.result === 'string' ? message.result : '',
              usage: extractTokenUsage(message.usage),
              durationMs,
              timestamp: Date.now(),
            }
          } else {
            // error_* subtypes
            yield {
              type: 'adapter:failed',
              providerId: 'claude',
              sessionId: message.session_id ?? (sessionId || undefined),
              error: typeof message.error === 'string'
                ? message.error
                : `Claude agent failed with subtype: ${message.subtype}`,
              code: message.subtype,
              timestamp: Date.now(),
            }
          }
          continue
        }
      }
    } catch (err: unknown) {
      // If we were aborted, do not re-throw
      if (this.abortController.signal.aborted) {
        return
      }
      throw ForgeError.wrap(err, {
        code: 'ADAPTER_EXECUTION_FAILED',
        context: { adapter: 'claude', sessionId },
      })
    } finally {
      this.activeConversation = null
      this.abortController = null
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
    if (this.activeConversation) {
      this.activeConversation.interrupt()
    }
    if (this.abortController) {
      this.abortController.abort()
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
      await this.loadSDK()
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
      lastError: sdkInstalled ? undefined : lastError,
    }
  }

  // -----------------------------------------------------------------------
  // AgentCLIAdapter.listSessions
  // -----------------------------------------------------------------------

  async listSessions(): Promise<SessionInfo[]> {
    const sdk = await this.loadSDK()

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
        context: { adapter: 'claude' },
      })
    }
  }

  // -----------------------------------------------------------------------
  // AgentCLIAdapter.forkSession
  // -----------------------------------------------------------------------

  async forkSession(sessionId: string): Promise<string> {
    const sdk = await this.loadSDK()

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
              context: { adapter: 'claude', sessionId },
            }),
          )
        }
      }

      void iterate()
    })
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async loadSDK(): Promise<ClaudeSDKModule> {
    if (this.sdk) return this.sdk

    try {
      // Use a variable to prevent TypeScript from resolving the optional peer dep at compile time
      const sdkPackage = '@anthropic-ai/claude-agent-sdk'
      const mod = (await import(/* webpackIgnore: true */ sdkPackage)) as unknown
      this.sdk = mod as ClaudeSDKModule
      return this.sdk
    } catch {
      throw new ForgeError({
        code: 'ADAPTER_SDK_NOT_INSTALLED',
        message:
          'The @anthropic-ai/claude-agent-sdk package is not installed. ' +
          'Install it with: npm install @anthropic-ai/claude-agent-sdk',
        recoverable: false,
        suggestion: 'Run: npm install @anthropic-ai/claude-agent-sdk',
        context: { adapter: 'claude' },
      })
    }
  }

  private buildQueryOptions(input: AgentInput): Record<string, unknown> {
    const options: Record<string, unknown> = {}

    if (input.systemPrompt) {
      options['systemPrompt'] = input.systemPrompt
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
    if (this.config.sandboxMode) {
      options['permissionMode'] = mapSandboxMode(this.config.sandboxMode)
    }
    if (this.abortController) {
      options['abortController'] = this.abortController
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

    // Merge provider-specific config options
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
      workingDirectory: typeof obj['cwd'] === 'string' ? obj['cwd'] : undefined,
      metadata: typeof obj['metadata'] === 'object' && obj['metadata'] !== null
        ? obj['metadata'] as Record<string, unknown>
        : undefined,
    }
  }
}

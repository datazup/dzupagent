/**
 * CodexAdapter — wraps the @openai/codex-sdk package and normalizes
 * its streaming events to the unified AgentEvent types.
 *
 * The SDK is an optional peer dependency, loaded lazily via dynamic import.
 */

import { ForgeError } from '@dzipagent/core'
import type {
  AdapterConfig,
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentInput,
  HealthStatus,
  TokenUsage,
} from '../types.js'

// ---------------------------------------------------------------------------
// SDK type declarations (mirrors the shapes we consume from @openai/codex-sdk)
// ---------------------------------------------------------------------------

/** Codex thread item discriminated by type */
interface CodexAgentMessageItem {
  type: 'agent_message'
  content: string
}

interface CodexCommandExecutionItem {
  type: 'command_execution'
  command: string
  output: string
  exitCode: number
}

interface CodexFileChangeItem {
  type: 'file_change'
  filePath: string
  diff: string
  action: string
}

interface CodexMcpToolCallItem {
  type: 'mcp_tool_call'
  toolName: string
  input: unknown
  output: string
}

interface CodexWebSearchItem {
  type: 'web_search'
  query: string
  results: string
}

interface CodexReasoningItem {
  type: 'reasoning'
  content: string
}

interface CodexTodoListItem {
  type: 'todo_list'
  items: ReadonlyArray<{ text: string; completed: boolean }>
}

interface CodexErrorItem {
  type: 'error'
  message: string
}

type CodexThreadItem =
  | CodexAgentMessageItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexMcpToolCallItem
  | CodexWebSearchItem
  | CodexReasoningItem
  | CodexTodoListItem
  | CodexErrorItem

/** Streaming event emitted by codex.runStreamed() */
interface CodexStreamEvent {
  type: string
  thread_id?: string
  usage?: { input_tokens: number; output_tokens: number; cached_input_tokens?: number }
  item?: CodexThreadItem
  error?: string
  message?: string
}

/** Shape of a Codex thread returned by startThread / resumeThread */
interface CodexThread {
  runStreamed(
    prompt: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{
    events: AsyncIterable<CodexStreamEvent>
    finalResponse?: string
  }>
}

/** Shape of the Codex class constructor options */
interface CodexCtorOptions {
  apiKey?: string
  codexPathOverride?: string
  env?: Record<string, string>
}

/** Shape of startThread / resumeThread options */
interface CodexThreadOptions {
  model?: string
  sandboxMode?: string
  workingDirectory?: string
  approvalPolicy?: string
  networkAccessEnabled?: boolean
}

/** The Codex class from the SDK */
interface CodexClass {
  new (opts: CodexCtorOptions): CodexInstance
}

interface CodexInstance {
  startThread(opts: CodexThreadOptions): CodexThread
  resumeThread(threadId: string, opts: CodexThreadOptions): CodexThread
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): number {
  return Date.now()
}

function isCodexItemOfType<T extends CodexThreadItem['type']>(
  item: CodexThreadItem,
  type: T,
): item is Extract<CodexThreadItem, { type: T }> {
  return item.type === type
}

/** Map SDK sandbox mode string to the Codex-specific format */
function toCodexSandboxMode(
  mode: AdapterConfig['sandboxMode'],
): string {
  switch (mode) {
    case 'read-only':
      return 'read-only'
    case 'full-access':
      return 'full-access'
    case 'workspace-write':
    default:
      return 'workspace-write'
  }
}

function toTokenUsage(
  usage: CodexStreamEvent['usage'],
): TokenUsage | undefined {
  if (!usage) return undefined
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedInputTokens: usage.cached_input_tokens,
  }
}

// ---------------------------------------------------------------------------
// CodexAdapter
// ---------------------------------------------------------------------------

export class CodexAdapter implements AgentCLIAdapter {
  readonly providerId: AdapterProviderId = 'codex'

  private config: AdapterConfig
  private abortController: AbortController | null = null
  private currentSessionId: string | null = null
  private sdkModule: { Codex: CodexClass } | null = null

  constructor(config: AdapterConfig = {}) {
    this.config = { ...config }
  }

  // ---- AgentCLIAdapter interface ------------------------------------------

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    const sdk = await this.loadSdk()
    const codex = this.createInstance(sdk)
    const threadOpts = this.buildThreadOptions(input)

    const thread = codex.startThread(threadOpts)

    yield* this.runStreamedThread(thread, input)
  }

  async *resumeSession(
    sessionId: string,
    input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    const sdk = await this.loadSdk()
    const codex = this.createInstance(sdk)
    const threadOpts = this.buildThreadOptions(input)

    const thread = codex.resumeThread(sessionId, threadOpts)

    yield* this.runStreamedThread(thread, input)
  }

  interrupt(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.loadSdk()
      return {
        healthy: true,
        providerId: this.providerId,
        sdkInstalled: true,
        cliAvailable: true,
        lastSuccessTimestamp: now(),
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        healthy: false,
        providerId: this.providerId,
        sdkInstalled: false,
        cliAvailable: false,
        lastError: message,
      }
    }
  }

  configure(opts: Partial<AdapterConfig>): void {
    this.config = { ...this.config, ...opts }
  }

  // ---- Private helpers ----------------------------------------------------

  /**
   * Dynamically import the Codex SDK. Caches the module after first load.
   * Throws ForgeError with ADAPTER_SDK_NOT_INSTALLED if the package is missing.
   */
  private async loadSdk(): Promise<{ Codex: CodexClass }> {
    if (this.sdkModule) return this.sdkModule

    try {
      // Dynamic import of optional peer dependency.
      // We use a variable to prevent TypeScript from resolving the module at compile time.
      const sdkName = '@openai/codex-sdk'
      const mod = (await import(/* webpackIgnore: true */ sdkName)) as { Codex: CodexClass }
      this.sdkModule = mod
      return mod
    } catch (cause: unknown) {
      throw new ForgeError({
        code: 'ADAPTER_SDK_NOT_INSTALLED',
        message:
          '@openai/codex-sdk is not installed. Install it with: npm install @openai/codex-sdk',
        recoverable: false,
        suggestion: 'Run `npm install @openai/codex-sdk` or `yarn add @openai/codex-sdk`',
        cause: cause instanceof Error ? cause : undefined,
      })
    }
  }

  /** Create a Codex instance from the loaded SDK module */
  private createInstance(sdk: { Codex: CodexClass }): CodexInstance {
    const ctorOpts: CodexCtorOptions = {}

    if (this.config.apiKey) {
      ctorOpts.apiKey = this.config.apiKey
    }

    const providerOpts = this.config.providerOptions ?? {}
    if (typeof providerOpts['codexPathOverride'] === 'string') {
      ctorOpts.codexPathOverride = providerOpts['codexPathOverride']
    }

    if (this.config.env) {
      ctorOpts.env = this.config.env
    }

    return new sdk.Codex(ctorOpts)
  }

  /** Build thread options from AgentInput + stored config */
  private buildThreadOptions(input: AgentInput): CodexThreadOptions {
    const opts: CodexThreadOptions = {
      model: this.config.model ?? 'o4-mini',
      sandboxMode: toCodexSandboxMode(this.config.sandboxMode),
      approvalPolicy: 'never',
      networkAccessEnabled: true,
    }

    const workDir = input.workingDirectory ?? this.config.workingDirectory
    if (workDir) {
      opts.workingDirectory = workDir
    }

    // Merge adapter-specific thread options from input.options
    const inputOpts = input.options ?? {}
    if (typeof inputOpts['model'] === 'string') {
      opts.model = inputOpts['model']
    }
    if (typeof inputOpts['sandboxMode'] === 'string') {
      opts.sandboxMode = inputOpts['sandboxMode']
    }
    if (typeof inputOpts['approvalPolicy'] === 'string') {
      opts.approvalPolicy = inputOpts['approvalPolicy']
    }
    if (typeof inputOpts['networkAccessEnabled'] === 'boolean') {
      opts.networkAccessEnabled = inputOpts['networkAccessEnabled']
    }

    return opts
  }

  /**
   * Run a streamed thread and yield unified AgentEvent items.
   *
   * Tracks timing for durationMs and maps every SDK event to the
   * corresponding AgentEvent discriminated union variant.
   */
  private async *runStreamedThread(
    thread: CodexThread,
    input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    this.abortController = new AbortController()
    const startTime = now()
    let sessionId = this.currentSessionId ?? `codex-${Date.now()}`
    let lastUsage: TokenUsage | undefined
    let finalResponse = ''

    // Combine caller signal with our internal abort controller
    const signal = this.combineSignals(input.signal, this.abortController.signal)

    let streamedTurn: { events: AsyncIterable<CodexStreamEvent>; finalResponse?: string }

    try {
      streamedTurn = await thread.runStreamed(input.prompt, { signal })
    } catch (err: unknown) {
      yield {
        type: 'adapter:failed',
        providerId: this.providerId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
        code: 'ADAPTER_EXECUTION_FAILED',
        timestamp: now(),
      }
      return
    }

    try {
      for await (const event of streamedTurn.events) {
        const mapped = this.mapEvent(event, sessionId, startTime)

        // Capture session ID from thread.started
        if (event.type === 'thread.started' && event.thread_id) {
          sessionId = event.thread_id
          this.currentSessionId = sessionId
        }

        // Track usage from turn.completed
        if (event.type === 'turn.completed' && event.usage) {
          lastUsage = toTokenUsage(event.usage)
        }

        // Yield all mapped events (some SDK events map to multiple AgentEvents)
        for (const agentEvent of mapped) {
          yield agentEvent

          // Capture final response content from messages
          if (agentEvent.type === 'adapter:message' && agentEvent.role === 'assistant') {
            finalResponse = agentEvent.content
          }
        }
      }
    } catch (err: unknown) {
      // If aborted, treat as non-error completion
      if (signal.aborted) {
        yield {
          type: 'adapter:completed',
          providerId: this.providerId,
          sessionId,
          result: finalResponse || '(interrupted)',
          usage: lastUsage,
          durationMs: now() - startTime,
          timestamp: now(),
        }
        return
      }

      yield {
        type: 'adapter:failed',
        providerId: this.providerId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
        code: 'ADAPTER_EXECUTION_FAILED',
        timestamp: now(),
      }
      return
    } finally {
      this.abortController = null
    }

    // If we got a finalResponse from the streamed turn object, prefer it
    if (streamedTurn.finalResponse) {
      finalResponse = streamedTurn.finalResponse
    }

    // Emit completion if the stream didn't already produce one via turn.completed
    // (turn.completed mapping already yields adapter:completed, but if the SDK
    // doesn't emit it, we still close out)
    if (!lastUsage && finalResponse) {
      yield {
        type: 'adapter:completed',
        providerId: this.providerId,
        sessionId,
        result: finalResponse,
        durationMs: now() - startTime,
        timestamp: now(),
      }
    }
  }

  /**
   * Map a single Codex SDK event to zero or more AgentEvents.
   *
   * Returns an array because some SDK events (e.g. item.completed with
   * CommandExecutionItem) produce two AgentEvents (tool_call + tool_result).
   */
  private mapEvent(
    event: CodexStreamEvent,
    sessionId: string,
    turnStartTime: number,
  ): AgentEvent[] {
    const ts = now()

    switch (event.type) {
      case 'thread.started':
        return [
          {
            type: 'adapter:started',
            providerId: this.providerId,
            sessionId: event.thread_id ?? sessionId,
            timestamp: ts,
          },
        ]

      case 'item.completed': {
        if (!event.item) return []
        return this.mapItemCompleted(event.item, ts)
      }

      case 'turn.completed':
        return [
          {
            type: 'adapter:completed',
            providerId: this.providerId,
            sessionId,
            result: '',
            usage: toTokenUsage(event.usage),
            durationMs: ts - turnStartTime,
            timestamp: ts,
          },
        ]

      case 'turn.failed':
        return [
          {
            type: 'adapter:failed',
            providerId: this.providerId,
            sessionId,
            error: event.error ?? 'Turn failed (unknown reason)',
            code: 'ADAPTER_EXECUTION_FAILED',
            timestamp: ts,
          },
        ]

      case 'error':
        return [
          {
            type: 'adapter:failed',
            providerId: this.providerId,
            sessionId,
            error: event.message ?? 'Unknown error',
            code: 'ADAPTER_EXECUTION_FAILED',
            timestamp: ts,
          },
        ]

      // Events we acknowledge but don't map to AgentEvents:
      // turn.started, item.started — no unified equivalent needed
      default:
        return []
    }
  }

  /**
   * Map a completed ThreadItem to AgentEvent(s).
   *
   * CommandExecutionItem produces both a tool_call and a tool_result event.
   */
  private mapItemCompleted(item: CodexThreadItem, ts: number): AgentEvent[] {
    if (isCodexItemOfType(item, 'agent_message')) {
      return [
        {
          type: 'adapter:message',
          providerId: this.providerId,
          content: item.content,
          role: 'assistant',
          timestamp: ts,
        },
      ]
    }

    if (isCodexItemOfType(item, 'command_execution')) {
      return [
        {
          type: 'adapter:tool_call',
          providerId: this.providerId,
          toolName: 'shell',
          input: { command: item.command },
          timestamp: ts,
        },
        {
          type: 'adapter:tool_result',
          providerId: this.providerId,
          toolName: 'shell',
          output: item.output,
          durationMs: 0, // SDK doesn't provide per-command timing
          timestamp: ts,
        },
      ]
    }

    if (isCodexItemOfType(item, 'file_change')) {
      return [
        {
          type: 'adapter:tool_result',
          providerId: this.providerId,
          toolName: 'file_edit',
          output: `${item.action}: ${item.filePath}\n${item.diff}`,
          durationMs: 0,
          timestamp: ts,
        },
      ]
    }

    if (isCodexItemOfType(item, 'mcp_tool_call')) {
      return [
        {
          type: 'adapter:tool_call',
          providerId: this.providerId,
          toolName: item.toolName,
          input: item.input,
          timestamp: ts,
        },
        {
          type: 'adapter:tool_result',
          providerId: this.providerId,
          toolName: item.toolName,
          output: item.output,
          durationMs: 0,
          timestamp: ts,
        },
      ]
    }

    if (isCodexItemOfType(item, 'web_search')) {
      return [
        {
          type: 'adapter:tool_call',
          providerId: this.providerId,
          toolName: 'web_search',
          input: { query: item.query },
          timestamp: ts,
        },
        {
          type: 'adapter:tool_result',
          providerId: this.providerId,
          toolName: 'web_search',
          output: item.results,
          durationMs: 0,
          timestamp: ts,
        },
      ]
    }

    if (isCodexItemOfType(item, 'reasoning')) {
      return [
        {
          type: 'adapter:message',
          providerId: this.providerId,
          content: item.content,
          role: 'assistant',
          timestamp: ts,
        },
      ]
    }

    if (isCodexItemOfType(item, 'error')) {
      return [
        {
          type: 'adapter:failed',
          providerId: this.providerId,
          error: item.message,
          code: 'ADAPTER_EXECUTION_FAILED',
          timestamp: ts,
        },
      ]
    }

    // todo_list and any future item types — silently skip
    return []
  }

  /**
   * Combine two optional AbortSignals into one.
   * If either fires, the combined signal aborts.
   */
  private combineSignals(
    external: AbortSignal | undefined,
    internal: AbortSignal,
  ): AbortSignal {
    if (!external) return internal

    // Create a new AbortController whose signal aborts when either input fires
    const combined = new AbortController()

    const onAbort = () => {
      combined.abort()
    }

    if (external.aborted || internal.aborted) {
      combined.abort()
      return combined.signal
    }

    external.addEventListener('abort', onAbort, { once: true })
    internal.addEventListener('abort', onAbort, { once: true })

    return combined.signal
  }
}

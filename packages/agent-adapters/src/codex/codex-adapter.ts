/**
 * CodexAdapter — wraps the @openai/codex-sdk package and normalizes
 * its streaming events to the unified AgentEvent types.
 *
 * The SDK is an optional peer dependency, loaded lazily via dynamic import.
 */

import { randomUUID } from 'node:crypto'
import { ForgeError } from '@dzupagent/core'
import { SystemPromptBuilder } from '../prompts/system-prompt-builder.js'
import type { CodexPromptPayload } from '../prompts/system-prompt-builder.js'
import type {
  AdapterCapabilityProfile,
  AdapterConfig,
  AdapterProviderId,
  AgentCLIAdapter,
  AgentEvent,
  AgentStreamEvent,
  AgentInput,
  HealthStatus,
  InteractionPolicy,
  ProviderRawStreamEvent,
  RawAgentEvent,
  TokenUsage,
} from '../types.js'
import { withCorrelationId } from '../types.js'
import { InteractionResolver } from '../interaction/interaction-resolver.js'

// ---------------------------------------------------------------------------
// SDK type declarations (mirrors the shapes we consume from @openai/codex-sdk)
// ---------------------------------------------------------------------------

/** Codex thread item discriminated by type — mirrors @openai/codex-sdk ThreadItem */
interface CodexAgentMessageItem {
  type: 'agent_message'
  id: string
  text: string  // SDK uses .text, not .content
}

interface CodexCommandExecutionItem {
  type: 'command_execution'
  id: string
  command: string
  aggregated_output: string  // SDK uses .aggregated_output, not .output
  exit_code?: number
  status: string
}

interface CodexFileChangeItem {
  type: 'file_change'
  id: string
  changes: ReadonlyArray<{ path: string; kind: string }>  // SDK has .changes[], not .filePath/.diff/.action
  status: string
}

interface CodexMcpToolCallItem {
  type: 'mcp_tool_call'
  id: string
  server: string
  tool: string        // SDK uses .tool, not .toolName
  arguments: unknown  // SDK uses .arguments, not .input
  result?: { content: unknown[]; structured_content: unknown }
  error?: { message: string }
  status: string
}

interface CodexWebSearchItem {
  type: 'web_search'
  id: string
  query: string
  // results are not a direct field; SDK doesn't expose them in the item type
}

interface CodexReasoningItem {
  type: 'reasoning'
  id: string
  text: string  // SDK uses .text, not .content
}

interface CodexTodoListItem {
  type: 'todo_list'
  id: string
  items: ReadonlyArray<{ text: string; completed: boolean }>
}

interface CodexErrorItem {
  type: 'error'
  id: string
  message: string
}

/** Forward-compatible: emitted by Codex SDK when it needs user approval mid-execution */
interface CodexApprovalRequestItem {
  type: 'approval_request'
  id: string
  message: string
  kind: 'permission' | 'clarification' | 'confirmation'
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
  | CodexApprovalRequestItem

/** Streaming event emitted by codex.runStreamed() — mirrors @openai/codex-sdk ThreadEvent */
interface CodexStreamEvent {
  type: string
  thread_id?: string
  usage?: { input_tokens: number; output_tokens: number; cached_input_tokens?: number }
  item?: CodexThreadItem
  error?: { message: string } | string
  message?: string
}

/** Shape of a Codex thread returned by startThread / resumeThread */
interface CodexThread {
  runStreamed(
    input: string | unknown[],
    opts?: { signal?: AbortSignal },
  ): Promise<{
    events: AsyncIterable<CodexStreamEvent>
    // NOTE: real SDK StreamedTurn has no finalResponse field
  }>
}

/** Shape of the Codex class constructor options */
interface CodexCtorOptions {
  apiKey?: string
  codexPathOverride?: string
  env?: Record<string, string>
  config?: Record<string, unknown>
}

/** Shape of startThread / resumeThread options */
interface CodexThreadOptions {
  model?: string
  sandboxMode?: string
  workingDirectory?: string
  approvalPolicy?: string
  networkAccessEnabled?: boolean
  skipGitRepoCheck?: boolean
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

function annotateProviderIdentity<T extends AgentEvent>(
  event: T,
  providerEventId: string | null,
  parentProviderEventId: string | null,
): T {
  if (!providerEventId && !parentProviderEventId) return event
  return {
    ...event,
    ...(providerEventId ? { providerEventId } : {}),
    ...(parentProviderEventId ? { parentProviderEventId } : {}),
  } as T
}

/** Map AdapterConfig sandbox mode to the Codex SDK SandboxMode enum values */
function toCodexSandboxMode(
  mode: AdapterConfig['sandboxMode'],
): string {
  switch (mode) {
    case 'read-only':
      return 'read-only'
    case 'full-access':
      return 'danger-full-access'  // SDK uses 'danger-full-access', not 'full-access'
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
    ...(usage.cached_input_tokens !== undefined ? { cachedInputTokens: usage.cached_input_tokens } : {}),
  }
}

function summarizeTodoList(
  items: ReadonlyArray<{ text: string; completed: boolean }>,
): {
  current: number
  total: number
  percentage: number
  message: string
} {
  const total = items.length
  const current = items.filter((item) => item.completed).length
  const percentage = total > 0 ? Math.round((current / total) * 100) : 100
  const nextPending = items
    .find((item) => !item.completed && item.text.trim().length > 0)
    ?.text
    .trim()

  if (total === 0) {
    return {
      current,
      total,
      percentage,
      message: 'Todo list updated',
    }
  }

  return {
    current,
    total,
    percentage,
    message: nextPending
      ? `Todo list updated (${current}/${total} completed). Next: ${nextPending}`
      : `Todo list updated (${current}/${total} completed)`,
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
  private currentInput: AgentInput | null = null
  private currentIsResume = false
  private resolver: InteractionResolver | null = null

  constructor(config: AdapterConfig = {}) {
    this.config = { ...config }
  }

  // ---- AgentCLIAdapter interface ------------------------------------------

  async *execute(input: AgentInput): AsyncGenerator<AgentEvent, void, undefined> {
    for await (const event of this.executeWithRaw(input)) {
      if (event.type !== 'adapter:provider_raw') {
        yield event
      }
    }
  }

  async *executeWithRaw(input: AgentInput): AsyncGenerator<AgentStreamEvent, void, undefined> {
    const sdk = await this.loadSdk()
    const codex = this.createInstance(sdk, input.systemPrompt)
    const threadOpts = this.buildThreadOptions(input)

    const thread = codex.startThread(threadOpts)

    this.currentInput = input
    this.currentIsResume = false
    yield* this.runStreamedThread(thread, input, codex)
  }

  async *resumeSession(
    sessionId: string,
    input: AgentInput,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    const sdk = await this.loadSdk()
    const codex = this.createInstance(sdk, input.systemPrompt)
    const threadOpts = this.buildThreadOptions(input)

    const thread = codex.resumeThread(sessionId, threadOpts)

    this.currentInput = input
    this.currentIsResume = true
    for await (const event of this.runStreamedThread(thread, input, codex)) {
      if (event.type !== 'adapter:provider_raw') {
        yield event
      }
    }
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

  getCapabilities(): AdapterCapabilityProfile {
    return {
      supportsResume: true,
      supportsFork: false,
      supportsToolCalls: true,
      supportsStreaming: true,
      supportsCostUsage: true,
    }
  }

  respondInteraction(interactionId: string, answer: string): boolean {
    return this.resolver?.respond(interactionId, answer) ?? false
  }

  async warmup(): Promise<void> {
    await this.loadSdk()
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
        context: { providerId: 'codex', sdkPackage: '@openai/codex-sdk' },
      })
    }
  }

  /** Create a Codex instance from the loaded SDK module */
  private createInstance(sdk: { Codex: CodexClass }, systemPrompt?: string): CodexInstance {
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

    // systemPrompt is passed via the CLI's `instructions` config key.
    // Per-request systemPrompt (from AgentInput) takes priority over
    // the static default in providerOptions.systemPrompt.
    // We merge with any caller-supplied providerOptions.config overrides.
    const staticSystemPrompt =
      typeof providerOpts['systemPrompt'] === 'string' ? providerOpts['systemPrompt'] : undefined
    const effectiveSystemPrompt = systemPrompt ?? staticSystemPrompt
    const callerConfig = (providerOpts['config'] as Record<string, unknown> | undefined) ?? {}
    // developerInstructions sets meta-level agent behavior (separate from user-facing instructions).
    const developerInstructions =
      typeof providerOpts['developerInstructions'] === 'string'
        ? providerOpts['developerInstructions']
        : undefined

    const configOverrides: Record<string, unknown> = { ...callerConfig }
    if (effectiveSystemPrompt) {
      const builder = new SystemPromptBuilder(effectiveSystemPrompt, {
        codexDeveloperInstructions: developerInstructions,
      })
      const payload = builder.buildFor('codex') as CodexPromptPayload
      configOverrides['instructions'] = payload.instructions
      if (payload.developer_instructions) {
        configOverrides['developer_instructions'] = payload.developer_instructions
      }
    } else if (developerInstructions) {
      // No system prompt but developerInstructions is set — pass it through directly
      configOverrides['developer_instructions'] = developerInstructions
    }
    if (Object.keys(configOverrides).length > 0) {
      ctorOpts.config = configOverrides
    }

    return new sdk.Codex(ctorOpts)
  }

  /** Build thread options from AgentInput + stored config */
  private buildThreadOptions(input: AgentInput): CodexThreadOptions {
    const opts: CodexThreadOptions = {
      model: this.config.model ?? 'gpt-5.4',
      sandboxMode: toCodexSandboxMode(this.config.sandboxMode),
      approvalPolicy: this.resolveCodexApprovalPolicy(input),
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
    // Direct approvalPolicy override still respected (already applied above, but per-call wins)
    if (typeof inputOpts['approvalPolicy'] === 'string') {
      opts.approvalPolicy = inputOpts['approvalPolicy']
    }
    if (typeof inputOpts['networkAccessEnabled'] === 'boolean') {
      opts.networkAccessEnabled = inputOpts['networkAccessEnabled']
    }
    if (typeof inputOpts['skipGitRepoCheck'] === 'boolean') {
      opts.skipGitRepoCheck = inputOpts['skipGitRepoCheck']
    } else if (typeof this.config.skipGitRepoCheck === 'boolean') {
      opts.skipGitRepoCheck = this.config.skipGitRepoCheck
    }

    return opts
  }

  /**
   * Map the InteractionPolicy to the Codex SDK approvalPolicy string.
   * 'auto-approve' → 'never' (Codex auto-proceeds, never pauses).
   * All other modes → 'on-failure' so Codex pauses on permission boundaries,
   * allowing the InteractionResolver to intercept via turn.failed detection.
   */
  private resolveCodexApprovalPolicy(input: AgentInput): string {
    // Explicit per-call override takes priority (checked again in buildThreadOptions)
    if (typeof input.options?.['approvalPolicy'] === 'string') {
      return input.options['approvalPolicy']
    }
    const policy = this.resolveInteractionPolicy(input)
    return policy.mode === 'auto-approve' ? 'never' : 'on-failure'
  }

  /** Resolve the effective InteractionPolicy (per-call → config → default). */
  private resolveInteractionPolicy(input: AgentInput): InteractionPolicy {
    const perCall = input.options?.['interactionPolicy']
    if (
      perCall !== null &&
      typeof perCall === 'object' &&
      'mode' in (perCall as object)
    ) {
      return perCall as InteractionPolicy
    }
    return this.config.interactionPolicy ?? { mode: 'auto-approve' }
  }

  /** Get or create the InteractionResolver for the current execution. */
  private getOrCreateResolver(input: AgentInput): InteractionResolver {
    if (!this.resolver) {
      this.resolver = new InteractionResolver(this.resolveInteractionPolicy(input))
    }
    return this.resolver
  }

  /** Default timeout for a single adapter call (2 minutes) */
  private static readonly DEFAULT_TIMEOUT_MS = 120_000

  /**
   * Run a streamed thread and yield unified AgentEvent items.
   *
   * Tracks timing for durationMs and maps every SDK event to the
   * corresponding AgentEvent discriminated union variant.
   *
   * Enforces a per-call timeout (config.timeoutMs or DEFAULT_TIMEOUT_MS)
   * so the stream never hangs indefinitely.
   */
  private async *runStreamedThread(
    thread: CodexThread,
    input: AgentInput,
    codex: CodexInstance,
  ): AsyncGenerator<AgentStreamEvent, void, undefined> {
    this.abortController = new AbortController()
    const startTime = now()
    let sessionId = this.currentSessionId ?? `codex-${Date.now()}`
    let lastUsage: TokenUsage | undefined
    let finalResponse = ''
    const inputTimeoutMs =
      typeof input.options?.['timeoutMs'] === 'number'
        ? input.options['timeoutMs']
        : undefined
    const configuredTimeoutMs = (this.config as Record<string, unknown>).timeoutMs as number | undefined
    const timeoutMs = inputTimeoutMs ?? configuredTimeoutMs ?? CodexAdapter.DEFAULT_TIMEOUT_MS
    let eventCount = 0
    let lastEventAt = startTime
    let lastEventType = 'none'
    let rawEventOrdinal = 0
    let threadProviderEventId: string | null = null

    // Auto-abort after timeout so we never hang
    let didTimeout = false
    const timeoutHandle = setTimeout(() => {
      didTimeout = true
      console.error(`[codex-adapter.ts:runStreamedThread] timeout after ${timeoutMs}ms — aborting`, { sessionId })
      this.abortController?.abort()
    }, timeoutMs)

    // Combine caller signal with our internal abort controller
    const signal = this.combineSignals(input.signal, this.abortController.signal)

    console.debug('[codex-adapter.ts:runStreamedThread] starting', {
      sessionId, promptLength: input.prompt.length, timeoutMs,
      timeoutSource: inputTimeoutMs != null ? 'input.options.timeoutMs' : configuredTimeoutMs != null ? 'adapter.config.timeoutMs' : 'default',
    })

    let streamedTurn: { events: AsyncIterable<CodexStreamEvent> }

    try {
      streamedTurn = await thread.runStreamed(input.prompt, { signal })
      console.debug('[codex-adapter.ts:runStreamedThread] runStreamed returned — consuming events', { sessionId })
    } catch (err: unknown) {
      clearTimeout(timeoutHandle)
      const errMsg = err instanceof Error ? err.message : String(err)
      if (didTimeout || signal.aborted) {
        const reason = didTimeout ? 'timeout_before_stream_start' : 'caller_abort_before_stream_start'
        const durationMs = now() - startTime
        console.warn('[codex-adapter.ts:runStreamedThread] runStreamed() aborted before stream events', {
          sessionId,
          reason,
          durationMs,
          error: errMsg,
        })
        yield withCorrelationId({
          type: 'adapter:failed',
          providerId: this.providerId,
          sessionId,
          error: didTimeout ? `Codex adapter timed out after ${durationMs}ms` : errMsg,
          code: didTimeout ? 'ADAPTER_TIMEOUT' : 'ADAPTER_EXECUTION_FAILED',
          timestamp: now(),
        }, input.correlationId)
        return
      }

      console.error('[codex-adapter.ts:runStreamedThread] runStreamed() threw', { sessionId, error: errMsg })
      yield withCorrelationId({
        type: 'adapter:failed',
        providerId: this.providerId,
        sessionId,
        error: errMsg,
        code: 'ADAPTER_EXECUTION_FAILED',
        timestamp: now(),
      }, input.correlationId)
      return
    }

    try {
      for await (const event of streamedTurn.events) {
        if (event.type === 'thread.started' && event.thread_id) {
          sessionId = event.thread_id
          this.currentSessionId = sessionId
          console.debug('[codex-adapter.ts:runStreamedThread] session assigned', { sessionId })
        }

        rawEventOrdinal += 1
        const rawProviderEvent = this.wrapRawProviderEvent(
          event,
          sessionId,
          input,
          rawEventOrdinal,
          threadProviderEventId,
        )
        if (event.type === 'thread.started') {
          threadProviderEventId = rawProviderEvent.rawEvent.providerEventId ?? threadProviderEventId
        }
        yield rawProviderEvent

        const eventNow = now()
        const gapMs = eventNow - lastEventAt
        eventCount += 1
        lastEventAt = eventNow
        lastEventType = event.type
        if (gapMs > 15_000) {
          console.debug('[codex-adapter.ts:runStreamedThread] slow stream gap observed', {
            sessionId,
            eventType: event.type,
            eventCount,
            gapMs,
          })
        }

        const mapped = this.mapEvent(
          event,
          sessionId,
          startTime,
          rawProviderEvent.rawEvent.providerEventId ?? null,
          rawProviderEvent.rawEvent.parentProviderEventId ?? null,
        )

        if (event.type === 'turn.completed' && event.usage) {
          lastUsage = toTokenUsage(event.usage)
          console.debug('[codex-adapter.ts:runStreamedThread] turn.completed — usage captured', { sessionId, usage: lastUsage })
        }

        // Handle approval_request items (SDK forward-compat) and turn.failed with approval text
        if (event.type === 'item.completed' && event.item?.type === 'approval_request') {
          const item = event.item as CodexApprovalRequestItem
          const resolver = this.getOrCreateResolver(input)
          const interactionId = randomUUID()
          const policy = this.resolveInteractionPolicy(input)
          const now2 = now()

          if (policy.mode === 'ask-caller') {
            const interactionEvent = annotateProviderIdentity(withCorrelationId({
              type: 'adapter:interaction_required',
              providerId: this.providerId,
              interactionId,
              question: item.message,
              kind: item.kind,
              timestamp: now2,
              expiresAt: now2 + (policy.askCaller?.timeoutMs ?? 60_000),
            }, input.correlationId), rawProviderEvent.rawEvent.providerEventId ?? null, rawProviderEvent.rawEvent.parentProviderEventId ?? null)
            yield interactionEvent
          }

          const result = await resolver.resolve({ interactionId, question: item.message, kind: item.kind })
          const resolvedEvent = annotateProviderIdentity(withCorrelationId({
            type: 'adapter:interaction_resolved',
            providerId: this.providerId,
            interactionId,
            question: item.message,
            answer: result.answer,
            resolvedBy: result.resolvedBy,
            timestamp: now(),
          }, input.correlationId), rawProviderEvent.rawEvent.providerEventId ?? null, rawProviderEvent.rawEvent.parentProviderEventId ?? null)
          yield resolvedEvent
          continue
        }

        // Detect turn.failed caused by Codex approval-pause when using 'on-failure' policy
        if (event.type === 'turn.failed') {
          const errObj = event.error
          const errMsg =
            typeof errObj === 'object' && errObj !== null && 'message' in errObj
              ? (errObj as { message: string }).message
              : typeof errObj === 'string'
                ? errObj
                : ''

          const isApprovalPause =
            this.resolveInteractionPolicy(input).mode !== 'auto-approve' &&
            /requires approval|user confirmation|permission denied|approval required/i.test(errMsg)

          if (isApprovalPause) {
            const resolver = this.getOrCreateResolver(input)
            const interactionId = randomUUID()
            const policy = this.resolveInteractionPolicy(input)
            const now2 = now()

            if (policy.mode === 'ask-caller') {
              const interactionEvent = annotateProviderIdentity(withCorrelationId({
                type: 'adapter:interaction_required',
                providerId: this.providerId,
                interactionId,
                question: errMsg,
                kind: 'permission',
                timestamp: now2,
                expiresAt: now2 + (policy.askCaller?.timeoutMs ?? 60_000),
              }, input.correlationId), rawProviderEvent.rawEvent.providerEventId ?? null, rawProviderEvent.rawEvent.parentProviderEventId ?? null)
              yield interactionEvent
            }

            const result = await resolver.resolve({ interactionId, question: errMsg, kind: 'permission' })
            yield annotateProviderIdentity(withCorrelationId({
              type: 'adapter:interaction_resolved',
              providerId: this.providerId,
              interactionId,
              question: errMsg,
              answer: result.answer,
              resolvedBy: result.resolvedBy,
              timestamp: now(),
            }, input.correlationId), rawProviderEvent.rawEvent.providerEventId ?? null, rawProviderEvent.rawEvent.parentProviderEventId ?? null)

            if (result.answer === 'yes' || result.answer === 'approve') {
              // Resume the thread with an approval message
              const approvalThread = codex.resumeThread(sessionId, this.buildThreadOptions(input))
              yield* this.runStreamedThread(approvalThread, input, codex)
            } else {
              yield withCorrelationId({
                type: 'adapter:failed',
                providerId: this.providerId,
                sessionId,
                error: `Interaction denied by policy: ${errMsg}`,
                code: 'INTERACTION_DENIED',
                timestamp: now(),
              }, input.correlationId)
            }
            return
          }
        }

        for (const rawAgentEvent of mapped) {
          const agentEvent = withCorrelationId(rawAgentEvent, input.correlationId)
          yield agentEvent

          if (agentEvent.type === 'adapter:message' && agentEvent.role === 'assistant') {
            finalResponse = agentEvent.content ?? ''
          }
        }
      }
    } catch (err: unknown) {
      clearTimeout(timeoutHandle)

      // Aborted — either by our timeout or by the caller's signal
      if (signal.aborted) {
        const reason = didTimeout ? 'timeout' : 'caller_abort'
        console.warn('[codex-adapter.ts:runStreamedThread] aborted', {
          sessionId, reason, durationMs: now() - startTime, finalResponseLength: finalResponse.length,
          eventCount, lastEventType, lastEventAgeMs: now() - lastEventAt,
        })
        yield withCorrelationId({
          type: didTimeout ? 'adapter:failed' : 'adapter:completed',
          providerId: this.providerId,
          sessionId,
          ...(didTimeout
            ? { error: `Codex adapter timed out after ${now() - startTime}ms`, code: 'ADAPTER_TIMEOUT' as const }
            : { result: finalResponse || '(interrupted)' }),
          ...(lastUsage !== undefined ? { usage: lastUsage } : {}),
          durationMs: now() - startTime,
          timestamp: now(),
        } as AgentEvent, input.correlationId)
        return
      }

      const errMsg = err instanceof Error ? err.message : String(err)
      console.error('[codex-adapter.ts:runStreamedThread] event loop threw', { sessionId, error: errMsg })
      yield withCorrelationId({
        type: 'adapter:failed',
        providerId: this.providerId,
        sessionId,
        error: errMsg,
        code: 'ADAPTER_EXECUTION_FAILED',
        timestamp: now(),
      }, input.correlationId)
      return
    } finally {
      clearTimeout(timeoutHandle)
      this.abortController = null
      this.resolver?.dispose()
      this.resolver = null
    }

    console.debug('[codex-adapter.ts:runStreamedThread] completed normally', {
      sessionId, durationMs: now() - startTime, responseLength: finalResponse.length,
      usage: lastUsage, eventCount, lastEventType,
    })

    // Always emit a single adapter:completed with the accumulated response
    // and any usage data captured from turn.completed events.
    yield withCorrelationId({
      type: 'adapter:completed',
      providerId: this.providerId,
      sessionId,
      result: finalResponse || '',
      ...(lastUsage !== undefined ? { usage: lastUsage } : {}),
      durationMs: now() - startTime,
      timestamp: now(),
    }, input.correlationId)
  }

  private wrapRawProviderEvent(
    event: CodexStreamEvent,
    sessionId: string,
    input: AgentInput,
    ordinal: number,
    threadProviderEventId: string | null,
  ): ProviderRawStreamEvent {
    const providerEventId = this.buildProviderEventId(event, sessionId, ordinal)
    const rawEvent: RawAgentEvent = {
      providerId: this.providerId,
      runId: sessionId,
      sessionId,
      providerEventId,
      ...(event.type === 'thread.started' ? {} : { parentProviderEventId: threadProviderEventId ?? undefined }),
      timestamp: now(),
      source: 'sdk',
      payload: event,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    }

    return {
      type: 'adapter:provider_raw',
      rawEvent,
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
    _turnStartTime: number,
    providerEventId: string | null,
    parentProviderEventId: string | null,
  ): AgentEvent[] {
    const ts = now()

    switch (event.type) {
      case 'thread.started':
        return [
          annotateProviderIdentity({
            type: 'adapter:started',
            providerId: this.providerId,
            sessionId: event.thread_id ?? sessionId,
            timestamp: ts,
            ...(this.currentInput?.prompt !== undefined ? { prompt: this.currentInput.prompt } : {}),
            ...(this.currentInput?.systemPrompt !== undefined ? { systemPrompt: this.currentInput.systemPrompt } : {}),
            model: this.config.model ?? 'gpt-5.4',
            ...((() => { const wd = this.currentInput?.workingDirectory ?? this.config.workingDirectory; return wd !== undefined ? { workingDirectory: wd } : {} })()),
            isResume: this.currentIsResume,
          }, providerEventId, parentProviderEventId),
        ]

      case 'item.completed': {
        if (!event.item) return []
        return this.mapItemCompleted(event.item, ts, providerEventId, parentProviderEventId)
      }

      case 'turn.completed': {
        // Do NOT emit adapter:completed here — runStreamedThread will emit
        // the final completion with the accumulated finalResponse text.
        // We only extract usage; it's consumed via the lastUsage tracking
        // in runStreamedThread.
        return []
      }

      case 'turn.failed': {
        // SDK TurnFailedEvent.error is { message: string }, not a raw string
        const errObj = event.error
        const errMsg =
          typeof errObj === 'object' && errObj !== null && 'message' in errObj
            ? (errObj as { message: string }).message
            : typeof errObj === 'string'
              ? errObj
              : 'Turn failed (unknown reason)'
        return [
          annotateProviderIdentity({
            type: 'adapter:failed',
            providerId: this.providerId,
            sessionId,
            error: errMsg,
            code: 'ADAPTER_EXECUTION_FAILED',
            timestamp: ts,
          }, providerEventId, parentProviderEventId),
        ]
      }

      case 'error':
        return [
          annotateProviderIdentity({
            type: 'adapter:failed',
            providerId: this.providerId,
            sessionId,
            error: event.message ?? 'Unknown error',
            code: 'ADAPTER_EXECUTION_FAILED',
            timestamp: ts,
          }, providerEventId, parentProviderEventId),
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
  private mapItemCompleted(
    item: CodexThreadItem,
    ts: number,
    providerEventId: string | null,
    parentProviderEventId: string | null,
  ): AgentEvent[] {
    if (isCodexItemOfType(item, 'agent_message')) {
      return [
        annotateProviderIdentity({
          type: 'adapter:message',
          providerId: this.providerId,
          content: item.text ?? '',  // SDK uses .text, not .content
          role: 'assistant',
          timestamp: ts,
        }, providerEventId, parentProviderEventId),
      ]
    }

    if (isCodexItemOfType(item, 'command_execution')) {
      return [
        annotateProviderIdentity({
          type: 'adapter:tool_call',
          providerId: this.providerId,
          toolName: 'shell',
          input: { command: item.command },
          timestamp: ts,
        }, providerEventId, parentProviderEventId),
        annotateProviderIdentity({
          type: 'adapter:tool_result',
          providerId: this.providerId,
          toolName: 'shell',
          output: item.aggregated_output ?? '',  // SDK uses .aggregated_output, not .output
          durationMs: 0, // SDK doesn't provide per-command timing
          timestamp: ts,
        }, providerEventId, parentProviderEventId),
      ]
    }

    if (isCodexItemOfType(item, 'file_change')) {
      // SDK has .changes[] array with {path, kind} — no .diff field
      const summary = item.changes
        .map((c) => `${c.kind}: ${c.path}`)
        .join('\n')
      return [
        annotateProviderIdentity({
          type: 'adapter:tool_result',
          providerId: this.providerId,
          toolName: 'file_edit',
          output: summary,
          durationMs: 0,
          timestamp: ts,
        }, providerEventId, parentProviderEventId),
      ]
    }

    if (isCodexItemOfType(item, 'mcp_tool_call')) {
      // SDK uses .tool and .arguments (not .toolName and .input)
      const toolName = `${item.server}/${item.tool}`
      const outputContent = item.result?.content
        ? JSON.stringify(item.result.content)
        : (item.error?.message ?? '')
      return [
        annotateProviderIdentity({
          type: 'adapter:tool_call',
          providerId: this.providerId,
          toolName,
          input: item.arguments,
          timestamp: ts,
        }, providerEventId, parentProviderEventId),
        annotateProviderIdentity({
          type: 'adapter:tool_result',
          providerId: this.providerId,
          toolName,
          output: outputContent,
          durationMs: 0,
          timestamp: ts,
        }, providerEventId, parentProviderEventId),
      ]
    }

    if (isCodexItemOfType(item, 'web_search')) {
      return [
        annotateProviderIdentity({
          type: 'adapter:tool_call',
          providerId: this.providerId,
          toolName: 'web_search',
          input: { query: item.query },
          timestamp: ts,
        }, providerEventId, parentProviderEventId),
      ]
    }

    if (isCodexItemOfType(item, 'reasoning')) {
      return [
        annotateProviderIdentity({
          type: 'adapter:message',
          providerId: this.providerId,
          content: item.text ?? '',  // SDK uses .text, not .content
          role: 'assistant',
          timestamp: ts,
        }, providerEventId, parentProviderEventId),
      ]
    }

    if (isCodexItemOfType(item, 'todo_list')) {
      const summary = summarizeTodoList(item.items)
      return [
        annotateProviderIdentity({
          type: 'adapter:progress',
          providerId: this.providerId,
          phase: 'todo_list',
          current: summary.current,
          total: summary.total,
          percentage: summary.percentage,
          message: summary.message,
          timestamp: ts,
        }, providerEventId, parentProviderEventId),
      ]
    }

    if (isCodexItemOfType(item, 'error')) {
      return [
        annotateProviderIdentity({
          type: 'adapter:failed',
          providerId: this.providerId,
          error: item.message,
          code: 'ADAPTER_EXECUTION_FAILED',
          timestamp: ts,
        }, providerEventId, parentProviderEventId),
      ]
    }

    // approval_request — handled by runStreamedThread via resolver; emit no events here
    if (isCodexItemOfType(item, 'approval_request')) {
      return []
    }

    // Any future item types we do not recognize are intentionally skipped.
    return []
  }

  private buildProviderEventId(
    event: CodexStreamEvent,
    sessionId: string,
    ordinal: number,
  ): string {
    const itemId =
      event.item && typeof event.item === 'object' && 'id' in event.item && typeof event.item.id === 'string'
        ? event.item.id
        : null
    const threadId = typeof event.thread_id === 'string' ? event.thread_id : sessionId
    return [
      this.providerId,
      threadId,
      event.type,
      itemId ?? ordinal,
    ].join(':')
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

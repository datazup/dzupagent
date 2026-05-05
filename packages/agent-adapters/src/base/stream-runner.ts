/**
 * AdapterStreamRunner — shared stream lifecycle manager for all adapters.
 *
 * Owns:
 *   - AbortController creation + multi-signal combination
 *   - Configurable gap heartbeat detection (default 15s)
 *   - adapter:started / adapter:completed / adapter:failed lifecycle events
 *   - Error classification → structured adapter:failed
 *   - Usage capture passthrough
 *
 * Each adapter implements AdapterStreamSource<TRaw> and delegates all
 * boilerplate to this class, keeping the concrete adapter focused on
 * SDK-specific event mapping.
 */

import { ForgeError } from '@dzupagent/core'
import type { AdapterProviderId, AgentEvent, AgentInput, TokenUsage } from '../types.js'

const DEFAULT_HEARTBEAT_GAP_MS = 15_000

export interface ThreadStartResult {
  threadId: string
  sessionId?: string
  /** Extra fields merged into the adapter:started event (e.g. model, workingDirectory). */
  extra?: Record<string, unknown>
}

/**
 * Implemented by each concrete adapter. Provides the SDK-specific stream
 * and the mapping logic from raw events to AgentEvents.
 */
export interface AdapterStreamSource<TRaw> {
  readonly providerId: AdapterProviderId
  /** Open the SDK stream. The runner owns the AbortController. */
  open(input: AgentInput, signal: AbortSignal): AsyncIterable<TRaw>
  /**
   * Map a raw SDK event to one or more AgentEvents, or null to skip it.
   * Return an array to emit multiple events from a single raw event (e.g. adapter:completed + adapter:cache_stats).
   */
  mapRawEvent(raw: TRaw, context: StreamContext): AgentEvent | AgentEvent[] | null
  /** Extract token usage from a raw event, if any. */
  extractUsage?(raw: TRaw): TokenUsage | undefined
  /** Detect thread/session start from a raw event. */
  detectThreadStart?(raw: TRaw): ThreadStartResult | null
  /** Return true if this raw event counts as a heartbeat (resets gap timer). */
  detectHeartbeat?(raw: TRaw): boolean
}

export interface StreamContext {
  /** Current session ID (populated after thread start). */
  sessionId: string
  /** The original agent input. */
  input: AgentInput
  /** Timestamp when the stream was opened. */
  startedAt: number
  /** Whether the stream was aborted via the external signal. */
  aborted: boolean
}

export interface AdapterStreamRunnerConfig {
  /** How long without events before logging a slow-stream warning (ms). Default: 15_000. */
  heartbeatGapMs?: number
  /** If true, emit adapter:started immediately without waiting for detectThreadStart. */
  emitStartedImmediately?: boolean
  /**
   * Called synchronously with the runner's internal AbortController before the stream opens.
   * Adapters that expose an interrupt() method store this reference so they can abort the runner.
   */
  onAbortController?: (ctrl: AbortController) => void
  /**
   * If true, the runner emits a synthetic `adapter:failed` event when the stream
   * terminates because the abort signal fired (rather than returning silently).
   *
   * SDK-based adapters (Claude, Codex) typically expect `aborted` to mean
   * "consumer cancelled, no terminal needed", so the default is false.
   * Stream-based adapters (OpenAI/OpenRouter) consider aborts as failures
   * since callers expect a terminal event in every execution.
   */
  emitFailedOnAbort?: boolean
  /**
   * Error message used when {@link emitFailedOnAbort} fires.
   * Default: 'Aborted'.
   */
  abortErrorMessage?: string
  /**
   * Error code used when {@link emitFailedOnAbort} fires.
   * Default: 'AGENT_ABORTED'.
   */
  abortErrorCode?: string
  /**
   * Pre-populate the session ID before the stream starts. Used by adapters that
   * generate their own session identifier (e.g. fetch-based providers without
   * SDK thread metadata) so it appears in `adapter:started`/`adapter:failed`.
   */
  initialSessionId?: string
  /**
   * Extra fields merged into the adapter:started event when emitted via
   * {@link emitStartedImmediately}.
   */
  startedExtra?: Record<string, unknown>
}

export class AdapterStreamRunner<TRaw> {
  private readonly heartbeatGapMs: number

  constructor(private readonly config: AdapterStreamRunnerConfig = {}) {
    this.heartbeatGapMs = config.heartbeatGapMs ?? DEFAULT_HEARTBEAT_GAP_MS
  }

  async *run(
    source: AdapterStreamSource<TRaw>,
    input: AgentInput,
    externalSignal?: AbortSignal,
  ): AsyncGenerator<AgentEvent, void, undefined> {
    const abortController = new AbortController()
    this.config.onAbortController?.(abortController)
    let externalAbortListener: (() => void) | null = null
    if (externalSignal) {
      if (externalSignal.aborted) {
        abortController.abort()
      } else {
        externalAbortListener = () => abortController.abort()
        externalSignal.addEventListener('abort', externalAbortListener, { once: true })
      }
    }

    const context: StreamContext = {
      sessionId: this.config.initialSessionId ?? '',
      input,
      startedAt: Date.now(),
      aborted: false,
    }

    let startedEmitted = false
    let lastEventAt = Date.now()

    try {
      const stream = source.open(input, abortController.signal)

      if (this.config.emitStartedImmediately) {
        startedEmitted = true
        yield this.buildStartedEvent(source.providerId, context, this.config.startedExtra)
      }

      for await (const raw of stream) {
        if (abortController.signal.aborted) break

        const now = Date.now()
        const gapMs = now - lastEventAt
        if (gapMs > this.heartbeatGapMs) {
          const isHeartbeat = source.detectHeartbeat?.(raw) ?? true
          if (!isHeartbeat) {
            console.debug('[AdapterStreamRunner] slow stream gap observed', {
              providerId: source.providerId,
              gapMs,
              heartbeatGapMs: this.heartbeatGapMs,
            })
          }
        }
        lastEventAt = now

        // Detect thread start → emit adapter:started
        if (!startedEmitted && source.detectThreadStart) {
          const threadStart = source.detectThreadStart(raw)
          if (threadStart) {
            context.sessionId = threadStart.threadId
            startedEmitted = true
            yield this.buildStartedEvent(source.providerId, context, threadStart.extra)
          }
        }

        // Map the raw event
        const mapped = source.mapRawEvent(raw, context)
        if (mapped !== null) {
          const events = Array.isArray(mapped) ? mapped : [mapped]
          for (const ev of events) {
            // Track session from completed/started events if source didn't use detectThreadStart
            if (!startedEmitted && ev.type === 'adapter:started') {
              startedEmitted = true
            }
            yield ev
          }
        }

        // Extract and store usage for downstream access
        if (source.extractUsage) {
          source.extractUsage(raw) // side-effect: source may store it internally
        }
      }
    } catch (err: unknown) {
      if (abortController.signal.aborted) {
        context.aborted = true
        if (this.config.emitFailedOnAbort) {
          yield this.buildAbortFailedEvent(source.providerId, context)
        }
        return
      }
      const forgeErr = ForgeError.wrap(err, {
        code: 'ADAPTER_EXECUTION_FAILED',
        context: {
          providerId: source.providerId,
          sessionId: context.sessionId || undefined,
          promptLength: input.prompt.length,
        },
      })
      yield {
        type: 'adapter:failed',
        providerId: source.providerId,
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        error: forgeErr.message,
        code: 'ADAPTER_EXECUTION_FAILED',
        timestamp: Date.now(),
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      }
      return
    } finally {
      if (externalAbortListener && externalSignal) {
        externalSignal.removeEventListener('abort', externalAbortListener)
      }
    }

    // Stream ended cleanly. If the abort signal fired but no exception was
    // raised by the source (e.g. the source caught the abort itself and
    // returned), still emit a terminal failed event when configured.
    if (abortController.signal.aborted && this.config.emitFailedOnAbort) {
      context.aborted = true
      yield this.buildAbortFailedEvent(source.providerId, context)
    }
  }

  private buildAbortFailedEvent(
    providerId: AdapterProviderId,
    context: StreamContext,
  ): AgentEvent {
    return {
      type: 'adapter:failed',
      providerId,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      error: this.config.abortErrorMessage ?? 'Aborted',
      code: this.config.abortErrorCode ?? 'AGENT_ABORTED',
      timestamp: Date.now(),
      ...(context.input.correlationId ? { correlationId: context.input.correlationId } : {}),
    }
  }

  private buildStartedEvent(
    providerId: AdapterProviderId,
    context: StreamContext,
    extra?: Record<string, unknown>,
  ): AgentEvent {
    const { input, sessionId } = context
    return {
      type: 'adapter:started',
      providerId,
      sessionId,
      timestamp: Date.now(),
      prompt: input.prompt,
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.workingDirectory !== undefined ? { workingDirectory: input.workingDirectory } : {}),
      isResume: !!input.resumeSessionId,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      ...extra,
    }
  }
}

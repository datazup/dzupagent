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

import {
  ForgeError,
  type LlmAuditSink,
  type LlmInvocationRecord,
  type ToolCallAuditRecord,
  type ToolCallAuditSink,
} from "@dzupagent/core/events";
import { defaultLogger } from "@dzupagent/core/utils";
import type {
  AdapterProviderId,
  AgentEvent,
  AgentInput,
  TokenUsage,
} from "../types.js";

const DEFAULT_HEARTBEAT_GAP_MS = 15_000;

export interface ThreadStartResult {
  threadId: string;
  sessionId?: string;
  /** Extra fields merged into the adapter:started event (e.g. model, workingDirectory). */
  extra?: Record<string, unknown>;
}

/**
 * Implemented by each concrete adapter. Provides the SDK-specific stream
 * and the mapping logic from raw events to AgentEvents.
 */
export interface AdapterStreamSource<TRaw> {
  readonly providerId: AdapterProviderId;
  /** Open the SDK stream. The runner owns the AbortController. */
  open(input: AgentInput, signal: AbortSignal): AsyncIterable<TRaw>;
  /**
   * Map a raw SDK event to one or more AgentEvents, or null to skip it.
   * Return an array to emit multiple events from a single raw event (e.g. adapter:completed + adapter:cache_stats).
   */
  mapRawEvent(
    raw: TRaw,
    context: StreamContext
  ): AgentEvent | AgentEvent[] | null;
  /** Extract token usage from a raw event, if any. */
  extractUsage?(raw: TRaw): TokenUsage | undefined;
  /** Detect thread/session start from a raw event. */
  detectThreadStart?(raw: TRaw): ThreadStartResult | null;
  /** Return true if this raw event counts as a heartbeat (resets gap timer). */
  detectHeartbeat?(raw: TRaw): boolean;
}

export interface StreamContext {
  /** Current session ID (populated after thread start). */
  sessionId: string;
  /** The original agent input. */
  input: AgentInput;
  /** Timestamp when the stream was opened. */
  startedAt: number;
  /** Whether the stream was aborted via the external signal. */
  aborted: boolean;
}

export interface AdapterStreamRunnerConfig {
  /** How long without events before logging a slow-stream warning (ms). Default: 15_000. */
  heartbeatGapMs?: number;
  /** If true, emit adapter:started immediately without waiting for detectThreadStart. */
  emitStartedImmediately?: boolean;
  /**
   * Called synchronously with the runner's internal AbortController before the stream opens.
   * Adapters that expose an interrupt() method store this reference so they can abort the runner.
   */
  onAbortController?: (ctrl: AbortController) => void;
  /**
   * If true, the runner emits a synthetic `adapter:failed` event when the stream
   * terminates because the abort signal fired (rather than returning silently).
   *
   * SDK-based adapters (Claude, Codex) typically expect `aborted` to mean
   * "consumer cancelled, no terminal needed", so the default is false.
   * Stream-based adapters (OpenAI/OpenRouter) consider aborts as failures
   * since callers expect a terminal event in every execution.
   */
  emitFailedOnAbort?: boolean;
  /**
   * Error message used when {@link emitFailedOnAbort} fires.
   * Default: 'Aborted'.
   */
  abortErrorMessage?: string;
  /**
   * Error code used when {@link emitFailedOnAbort} fires.
   * Default: 'AGENT_ABORTED'.
   */
  abortErrorCode?: string;
  /**
   * Pre-populate the session ID before the stream starts. Used by adapters that
   * generate their own session identifier (e.g. fetch-based providers without
   * SDK thread metadata) so it appears in `adapter:started`/`adapter:failed`.
   */
  initialSessionId?: string;
  /**
   * Extra fields merged into the adapter:started event when emitted via
   * {@link emitStartedImmediately}.
   */
  startedExtra?: Record<string, unknown>;
  /**
   * Optional best-effort audit sink invoked once per terminal LLM call
   * (`adapter:completed` or `adapter:failed`). Sink errors are swallowed —
   * audit emission MUST NOT break the LLM call path. Wire via
   * `attachLlmAuditEventBridge` from `@dzupagent/core` to forward records onto
   * a `DzupEventBus`, or pass a `vi.fn()` from tests.
   */
  auditSink?: LlmAuditSink;
  /**
   * Resolved model name for the audit record. Adapters inject this from the
   * config they used to build the request so the sink does not have to sniff
   * the `adapter:started`/`detectThreadStart` extras.
   */
  auditModel?: string;
  /** Optional run id for the audit record. */
  auditRunId?: string;
  /** Optional tenant id for the audit record. */
  auditTenantId?: string;
  /**
   * Optional best-effort sink invoked once per tool call with a
   * {@link ToolCallAuditRecord}. The runner correlates `adapter:tool_call`
   * and `adapter:tool_result` events to compute duration and result status.
   * Sink errors are swallowed — tool audit emission must not break the call path.
   */
  toolCallAuditSink?: ToolCallAuditSink;
}

export class AdapterStreamRunner<TRaw> {
  private readonly heartbeatGapMs: number;

  constructor(private readonly config: AdapterStreamRunnerConfig = {}) {
    this.heartbeatGapMs = config.heartbeatGapMs ?? DEFAULT_HEARTBEAT_GAP_MS;
  }

  async *run(
    source: AdapterStreamSource<TRaw>,
    input: AgentInput,
    externalSignal?: AbortSignal
  ): AsyncGenerator<AgentEvent, void, undefined> {
    const abortController = new AbortController();
    this.config.onAbortController?.(abortController);
    let externalAbortListener: (() => void) | null = null;
    if (externalSignal) {
      if (externalSignal.aborted) {
        abortController.abort();
      } else {
        externalAbortListener = () => abortController.abort();
        externalSignal.addEventListener("abort", externalAbortListener, {
          once: true,
        });
      }
    }

    const context: StreamContext = {
      sessionId: this.config.initialSessionId ?? "",
      input,
      startedAt: Date.now(),
      aborted: false,
    };

    let startedEmitted = false;
    let auditEmitted = false;
    const auditStartedAt = new Date(context.startedAt).toISOString();
    let lastEventAt = Date.now();

    // Per-tool-call correlation: keyed by toolCallId (or toolName as fallback)
    // when toolCallAuditSink is configured.
    const pendingToolCalls = new Map<
      string,
      {
        toolName: string;
        startedAt: number;
        startedAtIso: string;
        argsHash: string;
      }
    >();

    try {
      const stream = source.open(input, abortController.signal);

      if (this.config.emitStartedImmediately) {
        startedEmitted = true;
        yield this.buildStartedEvent(
          source.providerId,
          context,
          this.config.startedExtra
        );
      }

      for await (const raw of stream) {
        if (abortController.signal.aborted) break;

        const now = Date.now();
        const gapMs = now - lastEventAt;
        if (gapMs > this.heartbeatGapMs) {
          const isHeartbeat = source.detectHeartbeat?.(raw) ?? true;
          if (!isHeartbeat) {
            defaultLogger.debug(
              "[AdapterStreamRunner] slow stream gap observed",
              {
                providerId: source.providerId,
                gapMs,
                heartbeatGapMs: this.heartbeatGapMs,
              }
            );
          }
        }
        lastEventAt = now;

        // Detect thread start → emit adapter:started
        if (!startedEmitted && source.detectThreadStart) {
          const threadStart = source.detectThreadStart(raw);
          if (threadStart) {
            context.sessionId = threadStart.threadId;
            startedEmitted = true;
            yield this.buildStartedEvent(
              source.providerId,
              context,
              threadStart.extra
            );
          }
        }

        // Map the raw event
        const mapped = source.mapRawEvent(raw, context);
        if (mapped !== null) {
          const events = Array.isArray(mapped) ? mapped : [mapped];
          for (const ev of events) {
            // Track session from completed/started events if source didn't use detectThreadStart
            if (!startedEmitted && ev.type === "adapter:started") {
              startedEmitted = true;
            }
            if (
              !auditEmitted &&
              (ev.type === "adapter:completed" || ev.type === "adapter:failed")
            ) {
              auditEmitted = true;
              this.emitAudit(source.providerId, context, ev, auditStartedAt);
            }

            // Per-tool-call audit tracking
            if (this.config.toolCallAuditSink) {
              if (ev.type === "adapter:tool_call") {
                const key = ev.toolCallId ?? ev.toolName;
                const now = Date.now();
                // Capture the INPUT args hash at call time — argsHash reflects
                // what was passed TO the tool, not what the tool returned.
                pendingToolCalls.set(key, {
                  toolName: ev.toolName,
                  startedAt: now,
                  startedAtIso: new Date(now).toISOString(),
                  argsHash: this.hashArgs(ev.input),
                });
              } else if (ev.type === "adapter:tool_result") {
                const key = ev.toolCallId ?? ev.toolName;
                const pending = pendingToolCalls.get(key);
                pendingToolCalls.delete(key);
                const startedAt = pending?.startedAt ?? Date.now();
                const durationMs = Math.max(0, Date.now() - startedAt);
                const record: ToolCallAuditRecord = {
                  type: "tool_call",
                  toolName: ev.toolName,
                  // Use the input args hash captured when the call was opened,
                  // not the tool's output — argsHash identifies the call, not the result.
                  argsHash: pending?.argsHash ?? this.hashArgs(undefined),
                  resultStatus: "success",
                  durationMs,
                  ...(ev.toolCallId !== undefined
                    ? { toolCallId: ev.toolCallId }
                    : {}),
                  startedAt:
                    pending?.startedAtIso ?? new Date(startedAt).toISOString(),
                };
                this.emitToolCallAudit(record);
              }
            }

            yield ev;
          }
        }

        // Extract and store usage for downstream access
        if (source.extractUsage) {
          source.extractUsage(raw); // side-effect: source may store it internally
        }
      }
    } catch (err: unknown) {
      if (abortController.signal.aborted) {
        context.aborted = true;
        if (this.config.emitFailedOnAbort) {
          const abortEv = this.buildAbortFailedEvent(
            source.providerId,
            context
          );
          if (!auditEmitted) {
            auditEmitted = true;
            this.emitAudit(source.providerId, context, abortEv, auditStartedAt);
          }
          yield abortEv;
        }
        return;
      }
      const forgeErr = ForgeError.wrap(err, {
        code: "ADAPTER_EXECUTION_FAILED",
        context: {
          providerId: source.providerId,
          sessionId: context.sessionId || undefined,
          promptLength: input.prompt.length,
        },
      });
      const failedEv: AgentEvent = {
        type: "adapter:failed",
        providerId: source.providerId,
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        error: forgeErr.message,
        // ERR-L-03: preserve the ForgeError code rather than hardcoding the wrapper code
        code: forgeErr.code,
        timestamp: Date.now(),
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      };
      if (!auditEmitted) {
        auditEmitted = true;
        this.emitAudit(source.providerId, context, failedEv, auditStartedAt);
      }
      // Flush any in-flight tool calls as errors
      if (this.config.toolCallAuditSink) {
        for (const [, pending] of pendingToolCalls) {
          this.emitToolCallAudit({
            type: "tool_call",
            toolName: pending.toolName,
            argsHash: pending.argsHash,
            resultStatus: "error",
            durationMs: Math.max(0, Date.now() - pending.startedAt),
            startedAt: pending.startedAtIso,
          });
        }
        pendingToolCalls.clear();
      }
      yield failedEv;
      return;
    } finally {
      if (externalAbortListener && externalSignal) {
        externalSignal.removeEventListener("abort", externalAbortListener);
      }
    }

    // Stream ended cleanly. If the abort signal fired but no exception was
    // raised by the source (e.g. the source caught the abort itself and
    // returned), still emit a terminal failed event when configured.
    if (abortController.signal.aborted && this.config.emitFailedOnAbort) {
      context.aborted = true;
      const abortEv = this.buildAbortFailedEvent(source.providerId, context);
      if (!auditEmitted) {
        auditEmitted = true;
        this.emitAudit(source.providerId, context, abortEv, auditStartedAt);
      }
      yield abortEv;
    }
  }

  /**
   * Build and dispatch a {@link LlmInvocationRecord} to the configured
   * `auditSink`. Best-effort: any sink-side error is logged and swallowed so
   * audit failures cannot break the LLM call path.
   *
   * Note: this is the streaming-runner audit emission site. Adapters with
   * non-streaming convenience methods must emit their own equivalent record
   * when they do not flow through this runner.
   */
  private emitAudit(
    providerId: AdapterProviderId,
    context: StreamContext,
    terminal: AgentEvent,
    startedAt: string
  ): void {
    const sink = this.config.auditSink;
    if (!sink) return;
    if (
      terminal.type !== "adapter:completed" &&
      terminal.type !== "adapter:failed"
    )
      return;
    try {
      const durationMs =
        terminal.type === "adapter:completed"
          ? terminal.durationMs
          : Math.max(0, Date.now() - context.startedAt);
      const usage =
        terminal.type === "adapter:completed" && terminal.usage
          ? this.toAuditUsage(terminal.usage)
          : undefined;
      const costCents =
        terminal.type === "adapter:completed" &&
        terminal.usage?.costCents !== undefined
          ? terminal.usage.costCents
          : undefined;
      const errorCode =
        terminal.type === "adapter:failed"
          ? terminal.code ?? "ADAPTER_EXECUTION_FAILED"
          : undefined;

      const record: LlmInvocationRecord = {
        providerId,
        model:
          this.config.auditModel ?? this.resolveModelFromExtras() ?? "unknown",
        promptCharCount: context.input.prompt.length,
        ...(context.input.systemPrompt !== undefined
          ? { systemPromptCharCount: context.input.systemPrompt.length }
          : {}),
        status: terminal.type === "adapter:completed" ? "completed" : "failed",
        ...(errorCode !== undefined ? { errorCode } : {}),
        durationMs,
        ...(usage !== undefined ? { usage } : {}),
        ...(costCents !== undefined ? { costCents } : {}),
        startedAt,
        ...(this.config.auditRunId !== undefined
          ? { runId: this.config.auditRunId }
          : {}),
        ...(this.config.auditTenantId !== undefined
          ? { tenantId: this.config.auditTenantId }
          : {}),
      };
      sink(record);
    } catch (err: unknown) {
      // Best-effort: never break the LLM call because of audit emission.
      const msg = err instanceof Error ? err.message : String(err);
      defaultLogger.warn("[AdapterStreamRunner] audit sink failed:", msg);
    }
  }

  private toAuditUsage(usage: TokenUsage): LlmInvocationRecord["usage"] {
    const promptTokens = usage.inputTokens;
    const completionTokens = usage.outputTokens;
    const out: NonNullable<LlmInvocationRecord["usage"]> = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      ...(usage.cachedInputTokens !== undefined
        ? { cacheReadTokens: usage.cachedInputTokens }
        : {}),
      ...(usage.cacheWriteTokens !== undefined
        ? { cacheWriteTokens: usage.cacheWriteTokens }
        : {}),
    };
    return out;
  }

  private resolveModelFromExtras(): string | undefined {
    const extra = this.config.startedExtra;
    if (extra && typeof extra["model"] === "string") return extra["model"];
    return undefined;
  }

  private buildAbortFailedEvent(
    providerId: AdapterProviderId,
    context: StreamContext
  ): AgentEvent {
    return {
      type: "adapter:failed",
      providerId,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      error: this.config.abortErrorMessage ?? "Aborted",
      code: this.config.abortErrorCode ?? "AGENT_ABORTED",
      timestamp: Date.now(),
      ...(context.input.correlationId
        ? { correlationId: context.input.correlationId }
        : {}),
    };
  }

  private buildStartedEvent(
    providerId: AdapterProviderId,
    context: StreamContext,
    extra?: Record<string, unknown>
  ): AgentEvent {
    const { input, sessionId } = context;
    return {
      type: "adapter:started",
      providerId,
      sessionId,
      timestamp: Date.now(),
      prompt: input.prompt,
      ...(input.systemPrompt !== undefined
        ? { systemPrompt: input.systemPrompt }
        : {}),
      ...(input.workingDirectory !== undefined
        ? { workingDirectory: input.workingDirectory }
        : {}),
      isResume: !!input.resumeSessionId,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      ...extra,
    };
  }

  /**
   * Emit a {@link ToolCallAuditRecord} to the configured sink.
   * Best-effort: any sink error is logged and swallowed.
   */
  private emitToolCallAudit(record: ToolCallAuditRecord): void {
    const sink = this.config.toolCallAuditSink;
    if (!sink) return;
    try {
      sink(record);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      defaultLogger.warn(
        "[AdapterStreamRunner] toolCallAuditSink failed:",
        msg
      );
    }
  }

  /**
   * Derive a short, opaque identifier from tool arguments.
   * Truncates the JSON representation to 64 characters so audit records
   * remain compact without leaking full payload content.
   */
  private hashArgs(args: unknown): string {
    try {
      const json = JSON.stringify(args) ?? "";
      return json.length > 64 ? `${json.slice(0, 61)}...` : json;
    } catch {
      return "<non-serializable>";
    }
  }
}

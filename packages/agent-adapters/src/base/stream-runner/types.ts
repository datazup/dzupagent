/**
 * Public type surface for {@link AdapterStreamRunner}.
 *
 * Extracted verbatim from the former single-file stream-runner.ts as part of
 * the ARCH-M-06 god-module decomposition. Re-exported unchanged from
 * `../stream-runner.js` so every existing consumer import resolves without
 * changes.
 */

import type { LlmAuditSink, ToolCallAuditSink } from "@dzupagent/core/events";
import type {
  AdapterProviderId,
  AgentEvent,
  AgentInput,
  TokenUsage,
} from "../../types.js";

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

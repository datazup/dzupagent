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
 *
 * Composition root only: the audit-emission and lifecycle-event-building
 * concerns live in per-concern leaf modules under `./stream-runner/`
 * (ARCH-M-06 decomposition). The public surface — the `AdapterStreamRunner`
 * class plus the `AdapterStreamSource` / `StreamContext` / `ThreadStartResult`
 * / `AdapterStreamRunnerConfig` types (re-exported below) — is unchanged.
 */

import { ForgeError, type ToolCallAuditRecord } from "@dzupagent/core/events";
import { defaultLogger } from "@dzupagent/core/utils";
import type { AgentEvent, AgentInput } from "../types.js";
import {
  emitAudit,
  emitToolCallAudit,
  hashArgs,
  isToolResultError,
} from "./stream-runner/audit.js";
import {
  buildAbortFailedEvent,
  buildStartedEvent,
} from "./stream-runner/events.js";
import type {
  AdapterStreamRunnerConfig,
  AdapterStreamSource,
  StreamContext,
} from "./stream-runner/types.js";

export type {
  AdapterStreamRunnerConfig,
  AdapterStreamSource,
  StreamContext,
  ThreadStartResult,
} from "./stream-runner/types.js";

const DEFAULT_HEARTBEAT_GAP_MS = 15_000;

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
        yield buildStartedEvent(
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
            yield buildStartedEvent(
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
              emitAudit(
                this.config,
                source.providerId,
                context,
                ev,
                auditStartedAt
              );
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
                  argsHash: hashArgs(ev.input),
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
                  argsHash: pending?.argsHash ?? hashArgs(undefined),
                  // Honor an error marker on the result event rather than
                  // assuming every non-throwing result succeeded.
                  resultStatus: isToolResultError(ev) ? "error" : "success",
                  durationMs,
                  ...(ev.toolCallId !== undefined
                    ? { toolCallId: ev.toolCallId }
                    : {}),
                  startedAt:
                    pending?.startedAtIso ?? new Date(startedAt).toISOString(),
                };
                emitToolCallAudit(this.config, record);
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
          const abortEv = buildAbortFailedEvent(
            this.config,
            source.providerId,
            context
          );
          if (!auditEmitted) {
            auditEmitted = true;
            emitAudit(
              this.config,
              source.providerId,
              context,
              abortEv,
              auditStartedAt
            );
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
        emitAudit(
          this.config,
          source.providerId,
          context,
          failedEv,
          auditStartedAt
        );
      }
      // Flush any in-flight tool calls as errors
      if (this.config.toolCallAuditSink) {
        for (const [, pending] of pendingToolCalls) {
          emitToolCallAudit(this.config, {
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
      const abortEv = buildAbortFailedEvent(
        this.config,
        source.providerId,
        context
      );
      if (!auditEmitted) {
        auditEmitted = true;
        emitAudit(
          this.config,
          source.providerId,
          context,
          abortEv,
          auditStartedAt
        );
      }
      yield abortEv;
    }
  }
}

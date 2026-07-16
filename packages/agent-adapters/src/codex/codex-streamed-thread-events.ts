/**
 * Event-shaping helpers used by the Codex streaming loop.
 *
 * Pure utilities that wrap a raw SDK event into an
 * {@link ProviderRawStreamEvent}, build the `adapter:started` event from
 * `thread.started`, and combine abort signals.
 */
import type {
  AdapterProviderId,
  AgentEvent,
  AgentInput,
  AgentStartedEvent,
  ProviderRawStreamEvent,
  RawAgentEvent,
} from "../types.js";
import type { CodexStreamEvent } from "./codex-types.js";
import {
  annotateProviderIdentity,
  buildProviderEventId,
  now,
} from "./codex-helpers.js";
import { makeStartedEvent } from "../events/event-factories.js";
import type { RunStreamedThreadContext } from "./codex-streamed-thread-types.js";

/**
 * Wrap a raw {@link CodexStreamEvent} in a {@link ProviderRawStreamEvent}
 * with provider-event identity threading.
 */
export function wrapRawProviderEvent(
  providerId: AdapterProviderId,
  event: CodexStreamEvent,
  sessionId: string,
  input: AgentInput,
  ordinal: number,
  threadProviderEventId: string | null,
): ProviderRawStreamEvent {
  const providerEventId = buildProviderEventId(
    providerId,
    event,
    sessionId,
    ordinal,
  );
  const rawEvent: RawAgentEvent = {
    providerId,
    runId: sessionId,
    sessionId,
    providerEventId,
    ...(event.type === "thread.started"
      ? {}
      : { parentProviderEventId: threadProviderEventId ?? undefined }),
    timestamp: now(),
    source: "sdk",
    payload: event,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  };

  return {
    type: "adapter:provider_raw",
    rawEvent,
  };
}

/**
 * Combine two optional AbortSignals into one.
 * If either fires, the combined signal aborts.
 */
export function combineSignals(
  external: AbortSignal | undefined,
  internal: AbortSignal,
): AbortSignal {
  if (!external) return internal;

  const combined = new AbortController();

  if (external.aborted || internal.aborted) {
    combined.abort();
    return combined.signal;
  }

  const onAbort = () => {
    combined.abort();
    external.removeEventListener("abort", onAbort);
    internal.removeEventListener("abort", onAbort);
  };

  external.addEventListener("abort", onAbort, { once: true });
  internal.addEventListener("abort", onAbort, { once: true });

  return combined.signal;
}

/**
 * Build the `adapter:started` event for a `thread.started` SDK event.
 *
 * Lives here (rather than in `codex-helpers.mapCodexEvent`) because it needs
 * adapter-instance state (`currentInput`, `isResume`, `config.model`,
 * `config.workingDirectory`) that is cleaner to read from the streaming
 * context object than to pass through the generic mapping helper.
 */
export function buildAdapterStartedEvent(
  event: CodexStreamEvent,
  sessionId: string,
  ctx: RunStreamedThreadContext,
  providerEventId: string | null,
  parentProviderEventId: string | null,
): AgentEvent[] {
  const ts = now();
  const wd = ctx.currentInput?.workingDirectory ?? ctx.config.workingDirectory;
  const requestedModel = ctx.currentInput?.options?.["model"];
  const model = typeof requestedModel === "string" && requestedModel.trim()
    ? requestedModel.trim()
    : ctx.config.model;
  const started: AgentStartedEvent = makeStartedEvent({
    providerId: ctx.providerId,
    sessionId: event.thread_id ?? sessionId,
    timestamp: ts,
    prompt: ctx.currentInput?.prompt,
    systemPrompt: ctx.currentInput?.systemPrompt,
    ...(model ? { model } : {}),
    workingDirectory: wd,
    isResume: ctx.isResume,
  });

  return [
    annotateProviderIdentity(started, providerEventId, parentProviderEventId),
  ];
}

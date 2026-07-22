import { ForgeError } from "@dzupagent/core/events";
import type {
  AgentEvent,
  AgentInput,
  AgentStreamEvent,
  RawAgentEvent,
} from "../../types.js";

/**
 * Pure AgentEvent construction/decoration helpers for the Codex CLI adapter.
 * Extracted from the adapter class because none of them touch instance state --
 * they map a raw JSONL record or a thrown error into the normalized adapter
 * event shape and thread the optional correlationId through. Keeping them free
 * functions lets the composition root stay a thin coordinator.
 */

/** Stamp input.correlationId onto an event unless it is raw or already stamped. */
export function withCorrelation<T extends AgentStreamEvent>(
  event: T,
  input: AgentInput
): T {
  if (
    !input.correlationId ||
    event.type === "adapter:provider_raw" ||
    "correlationId" in event
  )
    return event;
  return { ...event, correlationId: input.correlationId } as T;
}

/** Wrap a raw provider JSONL record as an adapter:provider_raw stream event. */
export function wrapRawEvent(
  record: Record<string, unknown>,
  sessionId: string,
  input: AgentInput,
  ordinal: number
): AgentStreamEvent {
  const rawEvent: RawAgentEvent = {
    providerId: "codex",
    runId: input.correlationId ?? sessionId,
    sessionId,
    providerEventId: `codex-cli:${sessionId}:${ordinal}`,
    timestamp: Date.now(),
    source: "stdout",
    payload: record,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  };
  return { type: "adapter:provider_raw", rawEvent };
}

/** Map a thrown error to a correlated adapter:failed event, flagging auth failures. */
export function toFailedEvent(
  error: unknown,
  sessionId: string,
  input: AgentInput
): AgentEvent {
  const message = error instanceof Error ? error.message : String(error);
  const code = ForgeError.is(error) ? error.code : undefined;
  const authFailure =
    `${message} ${code ?? ""}`.toLowerCase().match(/auth|login/) !== null;
  return withCorrelation(
    {
      type: "adapter:failed",
      providerId: "codex",
      sessionId,
      error: message,
      code: authFailure ? "ADAPTER_AUTH_FAILED" : code,
      timestamp: Date.now(),
      ...(authFailure
        ? ({ telemetry: { codex_cli_auth_failure: true } } as Record<
            string,
            unknown
          >)
        : {}),
    },
    input
  );
}

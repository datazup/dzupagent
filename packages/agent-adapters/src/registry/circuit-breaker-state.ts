/**
 * Circuit-breaker / fallback-state bookkeeping for {@link AdapterRegistryRouter}.
 *
 * These helpers own the "what happens after an attempt resolves" concern:
 * recording success/failure transitions against the {@link AdapterHealthMonitor}
 * circuit breaker and emitting the corresponding lifecycle + provider events on
 * the host event bus. They are pure functions parameterised by the router's
 * collaborators (health monitor, event emitter) so the routing/selection logic
 * in `registry-router.ts` stays free of breaker bookkeeping.
 */

import type { ForgeErrorCode } from "@dzupagent/core/advanced";

import type {
  AdapterProviderId,
  AgentStreamEvent,
  TokenUsage,
} from "../types.js";
import { classifyAttemptError } from "./adapter-registry-helpers.js";
import type { AdapterHealthMonitor } from "./health-monitor.js";

/** Internal lifecycle events forwarded to the host event bus. */
export type RouterBusEvent =
  | { type: "agent:started"; agentId: string; runId: string }
  | {
      type: "agent:completed";
      agentId: string;
      runId: string;
      durationMs: number;
      usage?: TokenUsage;
    }
  | {
      type: "agent:failed";
      agentId: string;
      runId: string;
      errorCode: ForgeErrorCode;
      message: string;
    }
  | {
      type: "policy:conformance_violation";
      providerId: string;
      field: string;
      reason: string;
      severity: "error" | "warning";
      conformanceMode: "strict" | "warn-only";
      fallbackBehavior:
        | "continue_primary_attempt"
        | "continue_fallback_attempt"
        | "blocked_attempt";
      correlationId?: string;
    }
  | {
      type: "policy:legacy_option_deprecated";
      providerId: string;
      optionKey: "__activePolicy" | "__policyConformanceMode";
      replacement: "policyContext";
      correlationId?: string;
    }
  | { type: "provider:failed"; tier: string; provider: string; message: string }
  | { type: "provider:circuit_opened"; provider: string }
  | { type: "provider:circuit_closed"; provider: string };

/** Emits a {@link RouterBusEvent} onto the host event bus (no-op if absent). */
export type RouterEventEmitter = (event: RouterBusEvent) => void;

/**
 * Record a successful attempt on the circuit breaker and emit
 * `provider:circuit_closed` when the breaker transitions closed.
 */
export function recordSuccessAndEmit(
  health: AdapterHealthMonitor,
  emit: RouterEventEmitter,
  providerId: AdapterProviderId
): void {
  const transition = health.recordSuccess(providerId);
  if (transition.closed)
    emit({ type: "provider:circuit_closed", provider: providerId });
}

/**
 * Record a failed attempt on the circuit breaker and emit
 * `provider:circuit_opened` (when the breaker trips) plus `provider:failed`.
 */
export function recordFailureAndEmit(
  health: AdapterHealthMonitor,
  emit: RouterEventEmitter,
  providerId: AdapterProviderId,
  error: Error
): void {
  const transition = health.recordFailure(providerId);
  if (transition.opened)
    emit({ type: "provider:circuit_opened", provider: providerId });
  emit({
    type: "provider:failed",
    tier: "adapter",
    provider: providerId,
    message: error.message,
  });
}

/**
 * Apply success bookkeeping: record on the circuit breaker and emit the
 * `agent:completed` lifecycle event with optional usage attribution.
 */
export function handleAttemptSuccess(
  health: AdapterHealthMonitor,
  emit: RouterEventEmitter,
  providerId: AdapterProviderId,
  runId: string,
  startMs: number,
  usage: TokenUsage | undefined
): void {
  recordSuccessAndEmit(health, emit, providerId);
  emit({
    type: "agent:completed",
    agentId: providerId,
    runId,
    durationMs: Date.now() - startMs,
    ...(usage ? { usage } : {}),
  });
}

/**
 * Apply terminal-failure bookkeeping for an outcome where the adapter
 * stream ended without `adapter:completed`. Returns the constructed Error
 * so the caller can use it as the loop's `lastError`.
 */
export function handleAttemptFailure(
  health: AdapterHealthMonitor,
  emit: RouterEventEmitter,
  providerId: AdapterProviderId,
  runId: string,
  message: string,
  code: string
): Error {
  const terminalError = new Error(message);
  recordFailureAndEmit(health, emit, providerId, terminalError);
  emit({
    type: "agent:failed",
    agentId: providerId,
    runId,
    errorCode: code as ForgeErrorCode,
    message,
  });
  return terminalError;
}

/**
 * Classify an exception thrown during an attempt; either propagate
 * (caller-initiated abort) or emit a synthesised failure event so the
 * fallback chain can continue with the next provider.
 */
export async function* handleAttemptException(
  health: AdapterHealthMonitor,
  emit: RouterEventEmitter,
  err: unknown,
  providerId: AdapterProviderId,
  runId: string,
  effectiveTimeoutMs: number | undefined,
  didTimeout: boolean
): AsyncGenerator<AgentStreamEvent, Error, undefined> {
  const classification = classifyAttemptError(
    err,
    providerId,
    effectiveTimeoutMs,
    didTimeout
  );
  if (classification.kind === "propagate") throw classification.error;

  recordFailureAndEmit(health, emit, providerId, classification.error);
  emit({
    type: "agent:failed",
    agentId: providerId,
    runId,
    errorCode: classification.code as ForgeErrorCode,
    message: classification.message,
  });
  yield classification.failedEvent;
  return classification.error;
}

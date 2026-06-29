/**
 * MPCO P8a — circuit-gate decision (spec §5.4, §4.3, T16).
 *
 * REUSES the existing registry circuit breaker — it does NOT rebuild one. The
 * real per-provider breaker is `AdapterHealthMonitor.canExecute(providerId)`
 * (@dzupagent/agent-adapters registry/health-monitor.ts), which delegates to
 * the `CircuitBreaker` primitive in @dzupagent/core (circuit-breaker.ts) and
 * returns false while the provider's circuit is OPEN. This helper maps that
 * boolean to the typed block decision the executor records when it blocks an
 * `adapter.run` BEFORE execution. Pure — no breaker state lives here.
 */
import type { AdapterProviderId } from "./provider.js";

export interface CircuitGateResult {
  allowed: boolean;
  provider: AdapterProviderId;
  /** Set only when blocked, so the executor records a typed failure. */
  reason?: "circuit_open";
}

/**
 * Map a per-provider `canExecute` result (from the registry breaker) to a
 * block decision. `canExecute === false` ⇒ circuit open ⇒ not allowed.
 */
export function evaluateCircuitGate(
  canExecute: boolean,
  provider: AdapterProviderId
): CircuitGateResult {
  return canExecute
    ? { allowed: true, provider }
    : { allowed: false, provider, reason: "circuit_open" };
}

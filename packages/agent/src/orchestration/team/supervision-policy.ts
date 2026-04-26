/**
 * SupervisionPolicy — circuit-breaker controls for `TeamRuntime` (H4).
 *
 * Tracks per-agent failure counts and trips a circuit breaker when an agent
 * exceeds the failure threshold. While a breaker is open, the runtime skips
 * the affected agent. After `resetAfterMs` has elapsed since the trip, the
 * breaker resets and the agent is eligible to run again.
 */

export interface SupervisionPolicy {
  /** Number of consecutive failures before the circuit opens. */
  maxFailuresBeforeCircuitBreak: number
  /** Time (ms) after which an open circuit resets back to closed. */
  resetAfterMs: number
  /** Optional callback invoked when an agent's circuit first opens. */
  onCircuitOpen?: (agentId: string) => void
}

/** Internal per-agent circuit-breaker state. */
export interface AgentBreakerState {
  count: number
  /** Wall-clock ms when the breaker tripped open; undefined while closed. */
  openedAt?: number
}

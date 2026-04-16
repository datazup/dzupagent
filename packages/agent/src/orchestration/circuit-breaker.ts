/**
 * AgentCircuitBreaker -- per-agent circuit breaker for orchestration.
 *
 * Tracks consecutive timeouts per agent. After a configurable number of
 * consecutive timeouts (default: 3), the circuit trips and the agent is
 * excluded from routing for a cooldown period (default: 5 minutes).
 *
 * Circuit state is per-supervisor instance (not persisted).
 */

export type CircuitState = 'closed' | 'open' | 'half-open'

export interface CircuitBreakerConfig {
  /** Consecutive timeouts before tripping (default: 3) */
  failureThreshold?: number
  /** Cooldown period in ms after tripping (default: 5 minutes) */
  cooldownMs?: number
}

interface AgentCircuitState {
  state: CircuitState
  consecutiveTimeouts: number
  trippedAt?: number
}

export class AgentCircuitBreaker {
  private readonly circuits = new Map<string, AgentCircuitState>()
  private readonly failureThreshold: number
  private readonly cooldownMs: number

  constructor(config: CircuitBreakerConfig = {}) {
    this.failureThreshold = config.failureThreshold ?? 3
    this.cooldownMs = config.cooldownMs ?? 5 * 60 * 1000
  }

  /** Record a timeout for an agent */
  recordTimeout(agentId: string): void {
    const circuit = this.getOrCreate(agentId)
    circuit.consecutiveTimeouts++
    if (circuit.consecutiveTimeouts >= this.failureThreshold) {
      circuit.state = 'open'
      circuit.trippedAt = Date.now()
    }
    this.circuits.set(agentId, circuit)
  }

  /** Record a success for an agent (resets consecutive timeout count) */
  recordSuccess(agentId: string): void {
    const circuit = this.getOrCreate(agentId)
    circuit.consecutiveTimeouts = 0
    circuit.state = 'closed'
    circuit.trippedAt = undefined
    this.circuits.set(agentId, circuit)
  }

  /** Check if an agent is available for routing */
  isAvailable(agentId: string): boolean {
    const circuit = this.circuits.get(agentId)
    if (!circuit) return true // no data = available

    if (circuit.state === 'closed') return true

    if (circuit.state === 'open') {
      const elapsed = Date.now() - (circuit.trippedAt ?? 0)
      if (elapsed >= this.cooldownMs) {
        // Transition to half-open: allow one trial
        circuit.state = 'half-open'
        circuit.consecutiveTimeouts = 0
        this.circuits.set(agentId, circuit)
        return true
      }
      return false
    }

    // half-open: allow through
    return true
  }

  /** Filter a list of agents to exclude tripped ones */
  filterAvailable<T extends { id: string }>(agents: T[]): T[] {
    return agents.filter((a) => this.isAvailable(a.id))
  }

  /** Get circuit state for an agent (for observability) */
  getState(agentId: string): CircuitState {
    return this.circuits.get(agentId)?.state ?? 'closed'
  }

  /** Reset all circuits (useful for testing) */
  reset(): void {
    this.circuits.clear()
  }

  private getOrCreate(agentId: string): AgentCircuitState {
    const existing = this.circuits.get(agentId)
    if (existing) return existing
    const fresh: AgentCircuitState = { state: 'closed', consecutiveTimeouts: 0 }
    this.circuits.set(agentId, fresh)
    return fresh
  }
}

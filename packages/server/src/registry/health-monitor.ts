/**
 * HealthMonitor — ECO-051.
 *
 * Periodically probes registered agents via HTTP GET, tracks latency
 * percentiles (p50/p95/p99) with a sliding window, and manages circuit
 * breaker state per agent.
 */

import type { AgentRegistry, AgentHealth, DzupEventBus } from '@dzupagent/core'

// ------------------------------------------------------------------ Config

export interface HealthMonitorConfig {
  /** Registry to monitor. */
  registry: AgentRegistry
  /** Probe interval in ms (default: 30000). */
  intervalMs?: number
  /** Timeout for each probe request in ms (default: 5000). */
  probeTimeoutMs?: number
  /** Optional event bus for emitting health change events. */
  eventBus?: DzupEventBus
  /** Maximum number of latency samples to keep in sliding window (default: 100). */
  maxSamples?: number
  /** Number of consecutive failures to open circuit (default: 3). */
  failureThreshold?: number
  /** Custom probe function (overrides default HTTP fetch). */
  probeFn?: (endpoint: string, timeoutMs: number) => Promise<ProbeResult>
}

export interface ProbeResult {
  success: boolean
  latencyMs: number
  statusCode?: number
  error?: string
}

// ------------------------------------------------------------------ Sliding window

class SlidingLatencyWindow {
  private readonly _samples: number[] = []
  private readonly _maxSize: number

  constructor(maxSize: number) {
    this._maxSize = maxSize
  }

  push(latencyMs: number): void {
    this._samples.push(latencyMs)
    if (this._samples.length > this._maxSize) {
      this._samples.shift()
    }
  }

  percentile(p: number): number | undefined {
    if (this._samples.length === 0) return undefined
    const sorted = [...this._samples].sort((a, b) => a - b)
    const idx = Math.ceil((p / 100) * sorted.length) - 1
    return sorted[Math.max(0, idx)]
  }

  get count(): number {
    return this._samples.length
  }
}

// ------------------------------------------------------------------ Circuit state machine

type CircuitState = 'closed' | 'open' | 'half-open'

class CircuitManager {
  private _state: CircuitState = 'closed'
  private _consecutiveFailures = 0
  private _consecutiveSuccesses = 0
  private readonly _failureThreshold: number

  constructor(failureThreshold: number) {
    this._failureThreshold = failureThreshold
  }

  recordSuccess(): void {
    this._consecutiveFailures = 0
    this._consecutiveSuccesses++
    if (this._state === 'half-open') {
      this._state = 'closed'
    }
  }

  recordFailure(): void {
    this._consecutiveSuccesses = 0
    this._consecutiveFailures++
    if (this._consecutiveFailures >= this._failureThreshold) {
      this._state = 'open'
    }
  }

  /** Try to transition from open to half-open (on next probe). */
  tryHalfOpen(): void {
    if (this._state === 'open') {
      this._state = 'half-open'
    }
  }

  get state(): CircuitState { return this._state }
  get consecutiveFailures(): number { return this._consecutiveFailures }
  get consecutiveSuccesses(): number { return this._consecutiveSuccesses }
}

// ------------------------------------------------------------------ Default probe

async function defaultProbeFn(endpoint: string, timeoutMs: number): Promise<ProbeResult> {
  const start = Date.now()
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    const response = await fetch(endpoint, {
      method: 'GET',
      signal: controller.signal,
    })

    clearTimeout(timeout)
    const latencyMs = Date.now() - start

    return {
      success: response.ok,
      latencyMs,
      statusCode: response.status,
    }
  } catch (err) {
    return {
      success: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ------------------------------------------------------------------ HealthMonitor

export class HealthMonitor {
  private readonly _registry: AgentRegistry
  private readonly _intervalMs: number
  private readonly _probeTimeoutMs: number
  private readonly _eventBus: DzupEventBus | undefined
  private readonly _maxSamples: number
  private readonly _failureThreshold: number
  private readonly _probeFn: (endpoint: string, timeoutMs: number) => Promise<ProbeResult>

  private _timer: ReturnType<typeof setInterval> | undefined
  private readonly _windows = new Map<string, SlidingLatencyWindow>()
  private readonly _circuits = new Map<string, CircuitManager>()
  private _running = false

  constructor(config: HealthMonitorConfig) {
    this._registry = config.registry
    this._intervalMs = config.intervalMs ?? 30000
    this._probeTimeoutMs = config.probeTimeoutMs ?? 5000
    this._eventBus = config.eventBus
    this._maxSamples = config.maxSamples ?? 100
    this._failureThreshold = config.failureThreshold ?? 3
    this._probeFn = config.probeFn ?? defaultProbeFn
  }

  /** Start periodic health probing. */
  start(): void {
    if (this._running) return
    this._running = true
    this._timer = setInterval(() => {
      void this._probeAll()
    }, this._intervalMs)
  }

  /** Stop periodic health probing. */
  stop(): void {
    this._running = false
    if (this._timer !== undefined) {
      clearInterval(this._timer)
      this._timer = undefined
    }
  }

  /** Whether the monitor is currently running. */
  get isRunning(): boolean {
    return this._running
  }

  /**
   * Probe a single agent by ID.
   * Returns the health snapshot after probing.
   */
  async probeAgent(agentId: string): Promise<AgentHealth> {
    const agent = await this._registry.getAgent(agentId)
    if (!agent) {
      return { status: 'unknown' }
    }

    if (!agent.endpoint) {
      return { status: 'unknown' }
    }

    // Ensure sliding window and circuit exist
    if (!this._windows.has(agentId)) {
      this._windows.set(agentId, new SlidingLatencyWindow(this._maxSamples))
    }
    if (!this._circuits.has(agentId)) {
      this._circuits.set(agentId, new CircuitManager(this._failureThreshold))
    }

    const window = this._windows.get(agentId)!
    const circuit = this._circuits.get(agentId)!

    // If circuit is open, try half-open on probe
    circuit.tryHalfOpen()

    const result = await this._probeFn(agent.endpoint, this._probeTimeoutMs)

    if (result.success) {
      circuit.recordSuccess()
      window.push(result.latencyMs)
    } else {
      circuit.recordFailure()
    }

    const health: AgentHealth = {
      status: this._deriveStatus(circuit),
      lastCheckedAt: new Date(),
      lastSuccessAt: result.success ? new Date() : undefined,
      latencyP50Ms: window.percentile(50),
      latencyP95Ms: window.percentile(95),
      latencyP99Ms: window.percentile(99),
      consecutiveSuccesses: circuit.consecutiveSuccesses,
      consecutiveFailures: circuit.consecutiveFailures,
      circuitState: circuit.state,
    }

    // Update registry health
    try {
      await this._registry.updateHealth(agentId, health)
    } catch {
      // Non-fatal — registry update failure should not crash the monitor
    }

    // Emit health event to event bus if available
    if (this._eventBus && agent.health.status !== health.status) {
      try {
        this._eventBus.emit({
          type: 'registry:health_changed',
          agentId,
          previousStatus: agent.health.status,
          newStatus: health.status,
        })
      } catch {
        // Non-fatal
      }
    }

    return health
  }

  /** Get the circuit state for an agent. */
  getCircuitState(agentId: string): CircuitState | undefined {
    return this._circuits.get(agentId)?.state
  }

  // --- Private ---

  private async _probeAll(): Promise<void> {
    try {
      const { agents } = await this._registry.listAgents(1000, 0)
      const promises: Promise<void>[] = []

      for (const agent of agents) {
        if (agent.endpoint) {
          promises.push(
            this.probeAgent(agent.id).then(() => undefined).catch(() => undefined),
          )
        }
      }

      await Promise.all(promises)
    } catch {
      // Non-fatal
    }
  }

  private _deriveStatus(circuit: CircuitManager): AgentHealth['status'] {
    switch (circuit.state) {
      case 'closed': return 'healthy'
      case 'half-open': return 'degraded'
      case 'open': return 'unhealthy'
    }
  }
}

/**
 * MCP reliability primitives: heartbeat monitoring, per-server circuit breaking,
 * and tool discovery caching.
 *
 * This module is a standalone composition layer — it does not modify the existing
 * MCPClient but can be used alongside it to add production reliability features.
 */

import { CircuitBreaker } from '../llm/circuit-breaker.js'
import type { CircuitBreakerConfig, CircuitState } from '../llm/circuit-breaker.js'
import type { MCPToolDescriptor } from './mcp-types.js'

/** Health status of an MCP server */
export interface McpServerHealth {
  serverId: string
  healthy: boolean
  lastHeartbeat?: number
  consecutiveFailures: number
  circuitState: CircuitState
  lastError?: string
}

/** Configuration for MCP reliability features */
export interface McpReliabilityConfig {
  /** Heartbeat interval in ms. Default: 30_000 (30s) */
  heartbeatIntervalMs?: number
  /** Max consecutive heartbeat failures before marking unhealthy. Default: 3 */
  maxHeartbeatFailures?: number
  /** Circuit breaker config per server */
  circuitBreaker?: Partial<CircuitBreakerConfig>
  /** Tool discovery cache TTL in ms. Default: 300_000 (5 min) */
  discoveryCacheTtlMs?: number
}

/** Resolved (all-required) reliability config */
interface ResolvedConfig {
  heartbeatIntervalMs: number
  maxHeartbeatFailures: number
  circuitBreaker: Partial<CircuitBreakerConfig>
  discoveryCacheTtlMs: number
}

/** Cached tool discovery result */
interface DiscoveryCache {
  tools: ReadonlyArray<MCPToolDescriptor>
  cachedAt: number
  ttlMs: number
}

/**
 * Reliability wrapper for MCP server connections.
 * Adds heartbeat monitoring, circuit breaking, and discovery caching.
 */
export class McpReliabilityManager {
  private readonly healthMap = new Map<string, McpServerHealth>()
  private readonly circuitBreakers = new Map<string, CircuitBreaker>()
  private readonly discoveryCache = new Map<string, DiscoveryCache>()
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>()
  private readonly config: ResolvedConfig

  constructor(config?: McpReliabilityConfig) {
    this.config = {
      heartbeatIntervalMs: config?.heartbeatIntervalMs ?? 30_000,
      maxHeartbeatFailures: config?.maxHeartbeatFailures ?? 3,
      circuitBreaker: config?.circuitBreaker ?? {},
      discoveryCacheTtlMs: config?.discoveryCacheTtlMs ?? 300_000,
    }
  }

  /** Register a server for monitoring. Creates health entry and circuit breaker. */
  registerServer(serverId: string): void {
    if (this.healthMap.has(serverId)) return // idempotent
    this.healthMap.set(serverId, {
      serverId,
      healthy: true,
      consecutiveFailures: 0,
      circuitState: 'closed',
    })
    this.circuitBreakers.set(serverId, new CircuitBreaker(this.config.circuitBreaker))
  }

  /** Record a successful operation for a server. Resets failure count and updates heartbeat timestamp. */
  recordSuccess(serverId: string): void {
    const health = this.healthMap.get(serverId)
    if (!health) return
    health.healthy = true
    health.consecutiveFailures = 0
    health.lastHeartbeat = Date.now()
    delete health.lastError
    this.circuitBreakers.get(serverId)?.recordSuccess()
  }

  /** Record a failed operation for a server. Increments failure count and may mark unhealthy. */
  recordFailure(serverId: string, error: string): void {
    const health = this.healthMap.get(serverId)
    if (!health) return
    health.consecutiveFailures++
    health.lastError = error
    if (health.consecutiveFailures >= this.config.maxHeartbeatFailures) {
      health.healthy = false
    }
    this.circuitBreakers.get(serverId)?.recordFailure()
  }

  /** Check if a server's circuit breaker is open (calls should not proceed). */
  isCircuitOpen(serverId: string): boolean {
    const cb = this.circuitBreakers.get(serverId)
    return cb ? cb.getState() === 'open' : false
  }

  /**
   * Check if a call can proceed for the given server.
   * Returns false if circuit is open or server is not registered.
   */
  canExecute(serverId: string): boolean {
    const cb = this.circuitBreakers.get(serverId)
    return cb ? cb.canExecute() : false
  }

  /** Get health status for a server. Returns undefined if not registered. */
  getHealth(serverId: string): McpServerHealth | undefined {
    const health = this.healthMap.get(serverId)
    if (!health) return undefined
    // Sync circuit state from breaker (handles open→half-open transitions)
    const cb = this.circuitBreakers.get(serverId)
    if (cb) {
      health.circuitState = cb.getState()
    }
    return { ...health } // Return copy to prevent external mutation
  }

  /** Get health status for all registered servers. */
  getAllHealth(): McpServerHealth[] {
    return [...this.healthMap.keys()]
      .map(id => this.getHealth(id))
      .filter((h): h is McpServerHealth => h !== undefined)
  }

  /** Cache tool discovery results for a server. */
  cacheDiscovery(serverId: string, tools: ReadonlyArray<MCPToolDescriptor>): void {
    this.discoveryCache.set(serverId, {
      tools,
      cachedAt: Date.now(),
      ttlMs: this.config.discoveryCacheTtlMs,
    })
  }

  /** Get cached discovery results. Returns undefined if expired or missing. */
  getCachedDiscovery(serverId: string): ReadonlyArray<MCPToolDescriptor> | undefined {
    const cached = this.discoveryCache.get(serverId)
    if (!cached) return undefined
    if (Date.now() - cached.cachedAt > cached.ttlMs) {
      this.discoveryCache.delete(serverId)
      return undefined
    }
    return cached.tools
  }

  /** Invalidate cached discovery for a server. */
  invalidateDiscovery(serverId: string): void {
    this.discoveryCache.delete(serverId)
  }

  /** Start heartbeat monitoring for a server. Calls pingFn at the configured interval. */
  startHeartbeat(serverId: string, pingFn: () => Promise<boolean>): void {
    this.stopHeartbeat(serverId) // Clear existing timer if any
    const timer = setInterval(() => {
      void (async () => {
        try {
          const ok = await pingFn()
          if (ok) {
            this.recordSuccess(serverId)
          } else {
            this.recordFailure(serverId, 'Heartbeat returned false')
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          this.recordFailure(serverId, message)
        }
      })()
    }, this.config.heartbeatIntervalMs)
    // Prevent timer from keeping the Node.js process alive
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    this.heartbeatTimers.set(serverId, timer)
  }

  /** Stop heartbeat monitoring for a server. */
  stopHeartbeat(serverId: string): void {
    const timer = this.heartbeatTimers.get(serverId)
    if (timer) {
      clearInterval(timer)
      this.heartbeatTimers.delete(serverId)
    }
  }

  /** Check if heartbeat is active for a server. */
  isHeartbeatActive(serverId: string): boolean {
    return this.heartbeatTimers.has(serverId)
  }

  /** Unregister a server, stopping heartbeat and cleaning up all state. */
  unregisterServer(serverId: string): void {
    this.stopHeartbeat(serverId)
    this.healthMap.delete(serverId)
    this.circuitBreakers.delete(serverId)
    this.discoveryCache.delete(serverId)
  }

  /** Cleanup all resources. Stops all heartbeats and clears all state. */
  dispose(): void {
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer)
    }
    this.heartbeatTimers.clear()
    this.healthMap.clear()
    this.circuitBreakers.clear()
    this.discoveryCache.clear()
  }
}

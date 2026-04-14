import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { McpReliabilityManager } from '../mcp/mcp-reliability.js'
import type { MCPToolDescriptor } from '../mcp/mcp-types.js'

function makeTool(name: string): MCPToolDescriptor {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object' as const, properties: {} },
    serverId: 'test-server',
  }
}

describe('McpReliabilityManager', () => {
  let manager: McpReliabilityManager

  beforeEach(() => {
    vi.useFakeTimers()
    manager = new McpReliabilityManager({
      heartbeatIntervalMs: 1000,
      maxHeartbeatFailures: 3,
      discoveryCacheTtlMs: 5000,
      circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 10_000 },
    })
  })

  afterEach(() => {
    manager.dispose()
    vi.useRealTimers()
  })

  // --- Registration ---

  it('registers server with healthy initial state', () => {
    manager.registerServer('s1')
    const health = manager.getHealth('s1')
    expect(health).toBeDefined()
    expect(health!.healthy).toBe(true)
    expect(health!.consecutiveFailures).toBe(0)
    expect(health!.circuitState).toBe('closed')
    expect(health!.lastHeartbeat).toBeUndefined()
  })

  it('registerServer is idempotent', () => {
    manager.registerServer('s1')
    manager.recordFailure('s1', 'err')
    manager.registerServer('s1') // should not reset
    const health = manager.getHealth('s1')
    expect(health!.consecutiveFailures).toBe(1)
  })

  it('returns undefined for unregistered server', () => {
    expect(manager.getHealth('unknown')).toBeUndefined()
  })

  // --- Success / Failure tracking ---

  it('recordSuccess resets failure count and updates heartbeat', () => {
    manager.registerServer('s1')
    manager.recordFailure('s1', 'err1')
    manager.recordFailure('s1', 'err2')
    expect(manager.getHealth('s1')!.consecutiveFailures).toBe(2)

    const now = Date.now()
    manager.recordSuccess('s1')
    const health = manager.getHealth('s1')!
    expect(health.consecutiveFailures).toBe(0)
    expect(health.healthy).toBe(true)
    expect(health.lastError).toBeUndefined()
    expect(health.lastHeartbeat).toBeGreaterThanOrEqual(now)
  })

  it('recordFailure increments consecutive failure count', () => {
    manager.registerServer('s1')
    manager.recordFailure('s1', 'timeout')
    expect(manager.getHealth('s1')!.consecutiveFailures).toBe(1)
    expect(manager.getHealth('s1')!.lastError).toBe('timeout')
    manager.recordFailure('s1', 'connection refused')
    expect(manager.getHealth('s1')!.consecutiveFailures).toBe(2)
    expect(manager.getHealth('s1')!.lastError).toBe('connection refused')
  })

  it('marks server unhealthy after maxHeartbeatFailures', () => {
    manager.registerServer('s1')
    manager.recordFailure('s1', 'err')
    manager.recordFailure('s1', 'err')
    expect(manager.getHealth('s1')!.healthy).toBe(true) // still under threshold
    manager.recordFailure('s1', 'err')
    expect(manager.getHealth('s1')!.healthy).toBe(false) // threshold reached
  })

  it('recordSuccess on unregistered server is a no-op', () => {
    expect(() => manager.recordSuccess('ghost')).not.toThrow()
  })

  it('recordFailure on unregistered server is a no-op', () => {
    expect(() => manager.recordFailure('ghost', 'err')).not.toThrow()
  })

  // --- Circuit breaker ---

  it('isCircuitOpen reflects breaker state', () => {
    manager.registerServer('s1')
    expect(manager.isCircuitOpen('s1')).toBe(false)

    // Trip the breaker (3 failures = threshold)
    manager.recordFailure('s1', 'e1')
    manager.recordFailure('s1', 'e2')
    manager.recordFailure('s1', 'e3')
    expect(manager.isCircuitOpen('s1')).toBe(true)
  })

  it('isCircuitOpen returns false for unregistered server', () => {
    expect(manager.isCircuitOpen('nope')).toBe(false)
  })

  it('canExecute returns true when circuit is closed', () => {
    manager.registerServer('s1')
    expect(manager.canExecute('s1')).toBe(true)
  })

  it('canExecute returns false when circuit is open', () => {
    manager.registerServer('s1')
    manager.recordFailure('s1', 'e1')
    manager.recordFailure('s1', 'e2')
    manager.recordFailure('s1', 'e3')
    expect(manager.canExecute('s1')).toBe(false)
  })

  it('canExecute returns false for unregistered server', () => {
    expect(manager.canExecute('nope')).toBe(false)
  })

  it('circuit transitions to half-open after reset timeout', () => {
    manager.registerServer('s1')
    manager.recordFailure('s1', 'e1')
    manager.recordFailure('s1', 'e2')
    manager.recordFailure('s1', 'e3')
    expect(manager.getHealth('s1')!.circuitState).toBe('open')

    vi.advanceTimersByTime(10_001)
    expect(manager.getHealth('s1')!.circuitState).toBe('half-open')
  })

  // --- Discovery cache ---

  it('cacheDiscovery stores and retrieves tools', () => {
    const tools = [makeTool('read'), makeTool('write')]
    manager.cacheDiscovery('s1', tools)
    const cached = manager.getCachedDiscovery('s1')
    expect(cached).toHaveLength(2)
    expect(cached![0].name).toBe('read')
  })

  it('getCachedDiscovery returns undefined when no cache exists', () => {
    expect(manager.getCachedDiscovery('s1')).toBeUndefined()
  })

  it('cache expires after TTL', () => {
    manager.cacheDiscovery('s1', [makeTool('a')])
    expect(manager.getCachedDiscovery('s1')).toBeDefined()

    vi.advanceTimersByTime(5001) // TTL is 5000
    expect(manager.getCachedDiscovery('s1')).toBeUndefined()
  })

  it('invalidateDiscovery removes cache entry', () => {
    manager.cacheDiscovery('s1', [makeTool('a')])
    manager.invalidateDiscovery('s1')
    expect(manager.getCachedDiscovery('s1')).toBeUndefined()
  })

  // --- getAllHealth ---

  it('getAllHealth returns all registered servers', () => {
    manager.registerServer('s1')
    manager.registerServer('s2')
    manager.registerServer('s3')
    const all = manager.getAllHealth()
    expect(all).toHaveLength(3)
    expect(all.map(h => h.serverId).sort()).toEqual(['s1', 's2', 's3'])
  })

  it('getAllHealth returns empty array when no servers registered', () => {
    expect(manager.getAllHealth()).toEqual([])
  })

  // --- Heartbeat ---

  it('startHeartbeat calls ping function periodically', async () => {
    manager.registerServer('s1')
    const pingFn = vi.fn().mockResolvedValue(true)

    manager.startHeartbeat('s1', pingFn)
    expect(pingFn).not.toHaveBeenCalled()

    // Advance past one interval
    await vi.advanceTimersByTimeAsync(1000)
    expect(pingFn).toHaveBeenCalledTimes(1)
    expect(manager.getHealth('s1')!.healthy).toBe(true)
    expect(manager.getHealth('s1')!.consecutiveFailures).toBe(0)

    // Advance another interval
    await vi.advanceTimersByTimeAsync(1000)
    expect(pingFn).toHaveBeenCalledTimes(2)
  })

  it('heartbeat records failure when ping returns false', async () => {
    manager.registerServer('s1')
    const pingFn = vi.fn().mockResolvedValue(false)

    manager.startHeartbeat('s1', pingFn)
    await vi.advanceTimersByTimeAsync(1000)

    expect(manager.getHealth('s1')!.consecutiveFailures).toBe(1)
    expect(manager.getHealth('s1')!.lastError).toBe('Heartbeat returned false')
  })

  it('heartbeat records failure when ping throws', async () => {
    manager.registerServer('s1')
    const pingFn = vi.fn().mockRejectedValue(new Error('Connection reset'))

    manager.startHeartbeat('s1', pingFn)
    await vi.advanceTimersByTimeAsync(1000)

    expect(manager.getHealth('s1')!.consecutiveFailures).toBe(1)
    expect(manager.getHealth('s1')!.lastError).toBe('Connection reset')
  })

  it('heartbeat records failure with string error', async () => {
    manager.registerServer('s1')
    const pingFn = vi.fn().mockRejectedValue('network failure')

    manager.startHeartbeat('s1', pingFn)
    await vi.advanceTimersByTimeAsync(1000)

    expect(manager.getHealth('s1')!.lastError).toBe('network failure')
  })

  it('stopHeartbeat stops monitoring', async () => {
    manager.registerServer('s1')
    const pingFn = vi.fn().mockResolvedValue(true)

    manager.startHeartbeat('s1', pingFn)
    await vi.advanceTimersByTimeAsync(1000)
    expect(pingFn).toHaveBeenCalledTimes(1)

    manager.stopHeartbeat('s1')
    await vi.advanceTimersByTimeAsync(3000)
    expect(pingFn).toHaveBeenCalledTimes(1) // no further calls
  })

  it('stopHeartbeat is safe on server without active heartbeat', () => {
    manager.registerServer('s1')
    expect(() => manager.stopHeartbeat('s1')).not.toThrow()
  })

  it('isHeartbeatActive returns correct state', () => {
    manager.registerServer('s1')
    expect(manager.isHeartbeatActive('s1')).toBe(false)
    manager.startHeartbeat('s1', vi.fn().mockResolvedValue(true))
    expect(manager.isHeartbeatActive('s1')).toBe(true)
    manager.stopHeartbeat('s1')
    expect(manager.isHeartbeatActive('s1')).toBe(false)
  })

  it('startHeartbeat replaces existing heartbeat', async () => {
    manager.registerServer('s1')
    const ping1 = vi.fn().mockResolvedValue(true)
    const ping2 = vi.fn().mockResolvedValue(true)

    manager.startHeartbeat('s1', ping1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(ping1).toHaveBeenCalledTimes(1)

    manager.startHeartbeat('s1', ping2) // replaces
    await vi.advanceTimersByTimeAsync(1000)
    expect(ping1).toHaveBeenCalledTimes(1) // old not called again
    expect(ping2).toHaveBeenCalledTimes(1)
  })

  // --- Unregister ---

  it('unregisterServer removes all state for a server', async () => {
    manager.registerServer('s1')
    manager.cacheDiscovery('s1', [makeTool('a')])
    manager.startHeartbeat('s1', vi.fn().mockResolvedValue(true))

    manager.unregisterServer('s1')
    expect(manager.getHealth('s1')).toBeUndefined()
    expect(manager.getCachedDiscovery('s1')).toBeUndefined()
    expect(manager.isHeartbeatActive('s1')).toBe(false)
    expect(manager.isCircuitOpen('s1')).toBe(false)
  })

  // --- Dispose ---

  it('dispose cleans up all resources', async () => {
    manager.registerServer('s1')
    manager.registerServer('s2')
    const ping = vi.fn().mockResolvedValue(true)
    manager.startHeartbeat('s1', ping)
    manager.startHeartbeat('s2', ping)
    manager.cacheDiscovery('s1', [makeTool('a')])

    manager.dispose()
    expect(manager.getAllHealth()).toEqual([])
    expect(manager.getCachedDiscovery('s1')).toBeUndefined()
    expect(manager.isHeartbeatActive('s1')).toBe(false)
    expect(manager.isHeartbeatActive('s2')).toBe(false)

    // Timers should be cleared — no further ping calls
    await vi.advanceTimersByTimeAsync(5000)
    expect(ping).not.toHaveBeenCalled()
  })

  // --- getHealth returns a copy ---

  it('getHealth returns a copy that does not mutate internal state', () => {
    manager.registerServer('s1')
    const health = manager.getHealth('s1')!
    health.healthy = false
    health.consecutiveFailures = 999
    // Internal state should be unchanged
    expect(manager.getHealth('s1')!.healthy).toBe(true)
    expect(manager.getHealth('s1')!.consecutiveFailures).toBe(0)
  })

  // --- Default config ---

  it('uses default config values when none provided', () => {
    const defaultManager = new McpReliabilityManager()
    defaultManager.registerServer('s1')
    expect(defaultManager.getHealth('s1')!.healthy).toBe(true)
    defaultManager.dispose()
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  McpConnectionPool,
  hashServerConfig,
  calculateBackoff,
} from '../mcp/mcp-connection-pool.js'
import type { MCPClient } from '../mcp/mcp-client.js'
import type { MCPServerConfig, MCPToolDescriptor } from '../mcp/mcp-types.js'

function makeConfig(overrides?: Partial<MCPServerConfig>): MCPServerConfig {
  return {
    id: 'srv-1',
    name: 'Test Server',
    url: 'http://localhost:3000',
    transport: 'http',
    ...overrides,
  }
}

function makeTool(name: string): MCPToolDescriptor {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    serverId: 'srv-1',
  }
}

function createMockClient(connectResult: boolean = true): MCPClient {
  return {
    addServer: vi.fn(),
    connect: vi.fn().mockResolvedValue(connectResult),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue([]),
    getEagerTools: vi.fn().mockReturnValue([]),
    getDeferredToolNames: vi.fn().mockReturnValue([]),
    findTool: vi.fn().mockReturnValue(null),
    invokeTool: vi.fn(),
    connectAll: vi.fn(),
    disconnectAll: vi.fn(),
    hasConnections: vi.fn().mockReturnValue(false),
    loadDeferredTool: vi.fn().mockReturnValue(null),
  } as unknown as MCPClient
}

// ---------------------------------------------------------------------------
// hashServerConfig
// ---------------------------------------------------------------------------

describe('hashServerConfig', () => {
  it('produces same hash for same config', () => {
    const a = hashServerConfig(makeConfig())
    const b = hashServerConfig(makeConfig())
    expect(a).toBe(b)
  })

  it('produces different hash for different configs', () => {
    const a = hashServerConfig(makeConfig({ url: 'http://a.com' }))
    const b = hashServerConfig(makeConfig({ url: 'http://b.com' }))
    expect(a).not.toBe(b)
  })

  it('returns a 16-char hex string', () => {
    const h = hashServerConfig(makeConfig())
    expect(h).toMatch(/^[0-9a-f]{16}$/)
  })
})

// ---------------------------------------------------------------------------
// calculateBackoff
// ---------------------------------------------------------------------------

describe('calculateBackoff', () => {
  it('increases exponentially', () => {
    const d0 = calculateBackoff(0, 1000, 30_000)
    const d1 = calculateBackoff(1, 1000, 30_000)
    const d2 = calculateBackoff(2, 1000, 30_000)
    // Equal jitter: 50%–100% of capped delay
    expect(d0).toBeGreaterThanOrEqual(500)   // min: 1000 * 0.5
    expect(d0).toBeLessThanOrEqual(1000)     // max: 1000 * 1.0
    expect(d1).toBeGreaterThanOrEqual(1000)  // min: 2000 * 0.5
    expect(d2).toBeGreaterThanOrEqual(2000)  // min: 4000 * 0.5
  })

  it('clamps at maxMs', () => {
    const d = calculateBackoff(20, 1000, 5000)
    expect(d).toBeLessThanOrEqual(5000) // capped at maxMs, then jittered down
    expect(d).toBeGreaterThanOrEqual(2500) // min: 5000 * 0.5
  })
})

// ---------------------------------------------------------------------------
// McpConnectionPool
// ---------------------------------------------------------------------------

describe('McpConnectionPool', () => {
  let client: MCPClient
  let pool: McpConnectionPool

  beforeEach(() => {
    client = createMockClient(true)
    pool = new McpConnectionPool(client, {
      maxRetries: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      toolCacheTtlMs: 500,
    })
  })

  // -----------------------------------------------------------------------
  // acquire / reuse
  // -----------------------------------------------------------------------

  describe('acquire', () => {
    it('connects via client on first acquire', async () => {
      const ok = await pool.acquire(makeConfig())
      expect(ok).toBe(true)
      expect(client.addServer).toHaveBeenCalledOnce()
      expect(client.connect).toHaveBeenCalledWith('srv-1')
    })

    it('reuses existing connection for same config hash', async () => {
      await pool.acquire(makeConfig())
      const ok = await pool.acquire(makeConfig())
      expect(ok).toBe(true)
      // addServer and connect should only be called once
      expect(client.addServer).toHaveBeenCalledOnce()
      expect(client.connect).toHaveBeenCalledOnce()
    })

    it('re-registers when config changes', async () => {
      await pool.acquire(makeConfig())
      await pool.acquire(makeConfig({ url: 'http://other.com' }))
      expect(client.addServer).toHaveBeenCalledTimes(2)
    })
  })

  // -----------------------------------------------------------------------
  // backoff on failure
  // -----------------------------------------------------------------------

  describe('backoff on failure', () => {
    it('returns false after max retries exhausted', async () => {
      const failClient = createMockClient(false)
      const failPool = new McpConnectionPool(failClient, {
        maxRetries: 2,
        baseDelayMs: 1,
        maxDelayMs: 2,
        toolCacheTtlMs: 500,
      })

      const config = makeConfig()

      // First attempt: fails but retryCount becomes 0 initially, then incremented
      const r1 = await failPool.acquire(config)
      expect(r1).toBe(false)

      // Second attempt succeeds in getting past backoff since baseDelay is tiny
      // But still fails to connect
      // We need to wait at least the backoff delay
      await new Promise(resolve => setTimeout(resolve, 10))
      const r2 = await failPool.acquire(config)
      expect(r2).toBe(false)

      await new Promise(resolve => setTimeout(resolve, 10))
      const r3 = await failPool.acquire(config)
      expect(r3).toBe(false)

      // After max retries, should return false immediately
      const r4 = await failPool.acquire(config)
      expect(r4).toBe(false)
    })

    it('resets retries on successful connection', async () => {
      // Start with failure, then make connect succeed
      const connectMock = vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)

      const mixedClient = createMockClient()
      ;(mixedClient.connect as ReturnType<typeof vi.fn>) = connectMock

      const p = new McpConnectionPool(mixedClient, {
        maxRetries: 5,
        baseDelayMs: 1,
        maxDelayMs: 2,
        toolCacheTtlMs: 500,
      })

      const config = makeConfig()
      // First attempt fails; retryCount is 0 (first attempt)
      await p.acquire(config)
      expect(p.getRetryCount('srv-1')).toBe(0)

      // Second attempt: retryCount incremented to 1, but connect succeeds → reset to 0
      await new Promise(resolve => setTimeout(resolve, 10))
      await p.acquire(config)
      // After success, retryCount should be reset
      expect(p.getRetryCount('srv-1')).toBe(0)
      expect(p.isConnected('srv-1')).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Tool cache
  // -----------------------------------------------------------------------

  describe('tool cache', () => {
    it('stores and retrieves cached tools', () => {
      const tools = [makeTool('a'), makeTool('b')]
      pool.cacheTools('srv-1', tools)
      const cached = pool.getCachedTools('srv-1')
      expect(cached).toEqual(tools)
    })

    it('returns undefined for missing cache', () => {
      expect(pool.getCachedTools('nope')).toBeUndefined()
    })

    it('expires cache after TTL', async () => {
      pool.cacheTools('srv-1', [makeTool('a')])
      // Wait for TTL to expire (500ms in test config)
      await new Promise(resolve => setTimeout(resolve, 600))
      expect(pool.getCachedTools('srv-1')).toBeUndefined()
    })

    it('flushes cache for specific server', () => {
      pool.cacheTools('srv-1', [makeTool('a')])
      pool.cacheTools('srv-2', [makeTool('b')])
      pool.flushToolCache('srv-1')
      expect(pool.getCachedTools('srv-1')).toBeUndefined()
      expect(pool.getCachedTools('srv-2')).toBeDefined()
    })

    it('flushes all caches', () => {
      pool.cacheTools('srv-1', [makeTool('a')])
      pool.cacheTools('srv-2', [makeTool('b')])
      pool.flushToolCache()
      expect(pool.getCachedTools('srv-1')).toBeUndefined()
      expect(pool.getCachedTools('srv-2')).toBeUndefined()
    })

    it('invalidates cache on fresh acquire', async () => {
      pool.cacheTools('srv-1', [makeTool('old')])
      await pool.acquire(makeConfig())
      // After acquiring (connecting), stale cache should be cleared
      expect(pool.getCachedTools('srv-1')).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // release / dispose
  // -----------------------------------------------------------------------

  describe('release / dispose', () => {
    it('releases a connection', async () => {
      await pool.acquire(makeConfig())
      expect(pool.isConnected('srv-1')).toBe(true)
      await pool.release('srv-1')
      expect(pool.isConnected('srv-1')).toBe(false)
      expect(client.disconnect).toHaveBeenCalledWith('srv-1')
    })

    it('disposes all connections', async () => {
      await pool.acquire(makeConfig({ id: 'a', name: 'A' }))
      await pool.acquire(makeConfig({ id: 'b', name: 'B' }))
      await pool.dispose()
      expect(pool.isConnected('a')).toBe(false)
      expect(pool.isConnected('b')).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // resetRetries
  // -----------------------------------------------------------------------

  describe('resetRetries', () => {
    it('allows fresh attempts after reset', async () => {
      const failClient = createMockClient(false)
      const p = new McpConnectionPool(failClient, {
        maxRetries: 1,
        baseDelayMs: 1,
        maxDelayMs: 2,
        toolCacheTtlMs: 500,
      })

      const config = makeConfig()
      await p.acquire(config)
      await new Promise(resolve => setTimeout(resolve, 10))
      await p.acquire(config)

      // Should be at max retries now
      expect(p.getRetryCount('srv-1')).toBeGreaterThanOrEqual(1)

      p.resetRetries('srv-1')
      expect(p.getRetryCount('srv-1')).toBe(0)
    })
  })
})

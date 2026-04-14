/**
 * MCP Connection Pool — reuses connections by serverId + config hash,
 * applies exponential backoff on reconnect failures, and caches tool
 * descriptors with TTL-based invalidation.
 */
import { createHash } from 'node:crypto'
import type { MCPClient } from './mcp-client.js'
import type { MCPServerConfig, MCPToolDescriptor } from './mcp-types.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface McpConnectionPoolConfig {
  /** Maximum retry attempts on connection failure. Default: 5 */
  maxRetries?: number | undefined
  /** Base delay in ms for exponential backoff. Default: 1000 */
  baseDelayMs?: number | undefined
  /** Maximum backoff delay in ms. Default: 30_000 */
  maxDelayMs?: number | undefined
  /** TTL in ms for cached tool descriptors. Default: 300_000 (5 min) */
  toolCacheTtlMs?: number | undefined
}

interface ResolvedPoolConfig {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  toolCacheTtlMs: number
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface PooledConnection {
  serverId: string
  configHash: string
  connected: boolean
  retryCount: number
  lastAttemptAt: number
}

interface CachedTools {
  tools: ReadonlyArray<MCPToolDescriptor>
  cachedAt: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute a deterministic hash of an MCPServerConfig for pool key deduplication. */
export function hashServerConfig(config: MCPServerConfig): string {
  const normalized = JSON.stringify({
    id: config.id,
    url: config.url,
    transport: config.transport,
    args: config.args,
    headers: config.headers,
    timeoutMs: config.timeoutMs,
    maxEagerTools: config.maxEagerTools,
  })
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

/** Calculate exponential backoff delay with jitter. */
export function calculateBackoff(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  const exponential = baseMs * Math.pow(2, attempt)
  const clamped = Math.min(exponential, maxMs)
  // Add 0-25% jitter to prevent thundering herd
  const jitter = clamped * 0.25 * Math.random()
  return Math.floor(clamped + jitter)
}

// ---------------------------------------------------------------------------
// Pool implementation
// ---------------------------------------------------------------------------

export class McpConnectionPool {
  private readonly pool = new Map<string, PooledConnection>()
  private readonly toolCache = new Map<string, CachedTools>()
  private readonly config: ResolvedPoolConfig

  constructor(
    private readonly client: MCPClient,
    config?: McpConnectionPoolConfig,
  ) {
    this.config = {
      maxRetries: config?.maxRetries ?? 5,
      baseDelayMs: config?.baseDelayMs ?? 1000,
      maxDelayMs: config?.maxDelayMs ?? 30_000,
      toolCacheTtlMs: config?.toolCacheTtlMs ?? 300_000,
    }
  }

  /**
   * Acquire a connection. Reuses an existing connection if the config hash
   * matches; otherwise creates a new one with backoff-aware retry.
   *
   * Returns true if connected (or already connected), false if all retries
   * were exhausted.
   */
  async acquire(serverConfig: MCPServerConfig): Promise<boolean> {
    const hash = hashServerConfig(serverConfig)
    const existing = this.pool.get(serverConfig.id)

    // Reuse if already connected with the same config
    if (existing?.connected && existing.configHash === hash) {
      return true
    }

    // Check if we've exhausted retries
    if (existing && existing.configHash === hash && existing.retryCount >= this.config.maxRetries) {
      return false
    }

    // Check backoff timing
    if (existing && existing.configHash === hash && existing.retryCount > 0) {
      const delay = calculateBackoff(
        existing.retryCount - 1,
        this.config.baseDelayMs,
        this.config.maxDelayMs,
      )
      const elapsed = Date.now() - existing.lastAttemptAt
      if (elapsed < delay) {
        return false // Still in backoff window
      }
    }

    // Register the server on the client if not present or config changed
    if (!existing || existing.configHash !== hash) {
      this.client.addServer(serverConfig)
    }

    const entry: PooledConnection = {
      serverId: serverConfig.id,
      configHash: hash,
      connected: false,
      retryCount: existing?.configHash === hash ? (existing.retryCount + 1) : 0,
      lastAttemptAt: Date.now(),
    }
    this.pool.set(serverConfig.id, entry)

    const ok = await this.client.connect(serverConfig.id)
    entry.connected = ok

    if (ok) {
      entry.retryCount = 0 // Reset on success
      // Invalidate stale tool cache on fresh connection
      this.toolCache.delete(serverConfig.id)
    }

    return ok
  }

  /**
   * Release (disconnect) a pooled connection.
   */
  async release(serverId: string): Promise<void> {
    await this.client.disconnect(serverId)
    this.pool.delete(serverId)
    this.toolCache.delete(serverId)
  }

  /**
   * Get cached tool descriptors for a server. Returns undefined if
   * the cache is expired or missing.
   */
  getCachedTools(serverId: string): ReadonlyArray<MCPToolDescriptor> | undefined {
    const cached = this.toolCache.get(serverId)
    if (!cached) return undefined
    if (Date.now() - cached.cachedAt > this.config.toolCacheTtlMs) {
      this.toolCache.delete(serverId)
      return undefined
    }
    return cached.tools
  }

  /**
   * Store tool descriptors in the cache for a server.
   */
  cacheTools(serverId: string, tools: ReadonlyArray<MCPToolDescriptor>): void {
    this.toolCache.set(serverId, { tools, cachedAt: Date.now() })
  }

  /**
   * Flush all cached tool descriptors, optionally for a specific server.
   */
  flushToolCache(serverId?: string): void {
    if (serverId) {
      this.toolCache.delete(serverId)
    } else {
      this.toolCache.clear()
    }
  }

  /**
   * Reset retry counters for a server, allowing fresh connection attempts.
   */
  resetRetries(serverId: string): void {
    const entry = this.pool.get(serverId)
    if (entry) {
      entry.retryCount = 0
      entry.lastAttemptAt = 0
    }
  }

  /**
   * Check if a server has an active pooled connection.
   */
  isConnected(serverId: string): boolean {
    return this.pool.get(serverId)?.connected === true
  }

  /**
   * Get the retry count for a server.
   */
  getRetryCount(serverId: string): number {
    return this.pool.get(serverId)?.retryCount ?? 0
  }

  /**
   * Release all pooled connections and clear caches.
   */
  async dispose(): Promise<void> {
    const ids = [...this.pool.keys()]
    await Promise.all(ids.map(id => this.release(id)))
    this.pool.clear()
    this.toolCache.clear()
  }
}

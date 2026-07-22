/**
 * Distributed cost ledger (MC-07).
 *
 * Tracks cumulative LLM spend across a fleet of agent processes by
 * delegating the running total to a shared store (typically Redis).
 * Pairs with {@link DistributedRateLimiter} to give multi-instance
 * deployments a single, fleet-wide spend ceiling instead of N × the
 * configured limit.
 *
 * As with the rate limiter:
 *
 *  - The store interface is structural (`incrByFloat` + the base
 *    `RateLimiterClient` surface) so callers inject whichever Redis
 *    client they already use.
 *  - Graceful degradation is mandatory. On Redis errors the ledger
 *    falls back to an in-process running total (so the agent still
 *    has *some* ceiling) and reports the local total to the caller.
 *  - The ledger never throws on Redis failures — it returns
 *    `{ allowed, totalCostUsd }` so callers can branch deterministically.
 */

import type { RateLimiterClient } from './distributed-rate-limiter.js'
import { defaultLogger, type FrameworkLogger } from '@dzupagent/core/utils'

/**
 * Redis-shaped client extended with `incrByFloat` for accumulating
 * fractional USD amounts.
 */
export interface CostLedgerClient extends RateLimiterClient {
  incrByFloat(key: string, increment: number): Promise<number>
}

export interface DistributedCostLedgerConfig {
  /** Redis-shaped client. */
  client: CostLedgerClient
  /** Key prefix. Defaults to `'dzupagent:cost'`. */
  keyPrefix?: string
  /** Hard spend ceiling in USD. Defaults to `Infinity` (track-only). */
  maxCostUsd?: number
  /**
   * On Redis errors fall back to an in-memory running total (per
   * `tenantId:agentId`) so the agent retains a soft ceiling.
   * Defaults to `true`.
   */
  fallbackToLocal?: boolean
  /** Key TTL in milliseconds. Defaults to 24 hours. */
  ttlMs?: number
  /**
   * Structured logger. On a Redis error the ledger degrades to a
   * per-process running total, so the fleet-wide `maxCostUsd` cap is no
   * longer enforced (N workers each count independently). Every such
   * degradation is logged at `warn` so an operator can alert before the
   * global cap is silently blown. Defaults to {@link defaultLogger}.
   */
  logger?: FrameworkLogger
}

const DEFAULT_KEY_PREFIX = 'dzupagent:cost'
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

/** Result of a {@link DistributedCostLedger.record} call. */
export interface CostLedgerRecordResult {
  /** `false` when the running total is at or above `maxCostUsd`. */
  allowed: boolean
  /** Running total visible to the caller (Redis when reachable, otherwise local). */
  totalCostUsd: number
}

/**
 * Distributed cost ledger. Records LLM spend in a shared store and
 * surfaces `{ allowed, totalCostUsd }` so the agent can short-circuit
 * runs that would breach the fleet-wide ceiling.
 */
export class DistributedCostLedger {
  private readonly client: CostLedgerClient
  private readonly keyPrefix: string
  private readonly maxCostUsd: number
  private readonly fallbackToLocal: boolean
  private readonly ttlSeconds: number
  private readonly localTotals = new Map<string, number>()
  private readonly logger: FrameworkLogger

  constructor(config: DistributedCostLedgerConfig) {
    this.client = config.client
    this.keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX
    this.maxCostUsd = config.maxCostUsd ?? Number.POSITIVE_INFINITY
    this.fallbackToLocal = config.fallbackToLocal ?? true
    const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS
    this.ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000))
    this.logger = config.logger ?? defaultLogger
  }

  /**
   * Add `costUsd` to the running total. Returns `{ allowed, totalCostUsd }`.
   *
   * `allowed` is `false` once the running total reaches or exceeds
   * `maxCostUsd`. The caller decides how to react (block the run,
   * downgrade the model, escalate, etc.).
   */
  async record(
    tenantId: string,
    agentId: string,
    costUsd: number,
  ): Promise<CostLedgerRecordResult> {
    if (!Number.isFinite(costUsd) || costUsd < 0) {
      // Negative / NaN cost is a programmer error upstream; clamp to 0
      // so the ledger never moves backwards on bad input.
      costUsd = 0
    }

    const key = this.buildKey(tenantId, agentId)
    try {
      const total = await this.client.incrByFloat(key, costUsd)
      // Best-effort TTL refresh; failures are logged via fall-through.
      try {
        await this.client.expire(key, this.ttlSeconds)
      } catch (err) {
        // Best-effort TTL refresh; the total is already recorded.
        this.logger.debug('[budget] TTL refresh failed', {
          operation: 'budget.redis.expire',
          tenantId,
          agentId,
          error: String(err),
        })
      }
      // Mirror the running total locally so a future Redis outage
      // continues from a sane baseline rather than zero.
      if (this.fallbackToLocal) {
        this.localTotals.set(key, total)
      }
      return { allowed: total < this.maxCostUsd, totalCostUsd: total }
    } catch (err) {
      // Redis is unreachable: fall back to a per-process total. In a
      // multi-worker deployment the fleet-wide maxCostUsd cap is NO LONGER
      // enforced — surface it so alerting can fire before spend overruns.
      this.logger.warn('[budget] Redis error — degrading to per-process total', {
        operation: 'budget.redis.incrByFloat',
        tenantId,
        agentId,
        degradedToLocal: this.fallbackToLocal,
        capEnforced: false,
        error: String(err),
      })
      return this.recordLocally(key, costUsd)
    }
  }

  /** Read the running total without incrementing it. */
  async read(tenantId: string, agentId: string): Promise<number> {
    const key = this.buildKey(tenantId, agentId)
    try {
      const raw = await this.client.get(key)
      if (raw === null) return this.localTotals.get(key) ?? 0
      const parsed = Number(raw)
      return Number.isFinite(parsed) ? parsed : 0
    } catch (err) {
      this.logger.debug('[budget] read failed — using local total', {
        operation: 'budget.redis.get',
        tenantId,
        agentId,
        error: String(err),
      })
      return this.localTotals.get(key) ?? 0
    }
  }

  /** Reset the ledger for the given (tenant, agent). */
  async reset(tenantId: string, agentId: string): Promise<void> {
    const key = this.buildKey(tenantId, agentId)
    this.localTotals.delete(key)
    try {
      await this.client.del(key)
    } catch (err) {
      this.logger.warn('[budget] reset failed', {
        operation: 'budget.redis.del',
        tenantId,
        agentId,
        error: String(err),
      })
    }
  }

  private buildKey(tenantId: string, agentId: string): string {
    return `${this.keyPrefix}:${tenantId}:${agentId}`
  }

  private recordLocally(key: string, costUsd: number): CostLedgerRecordResult {
    if (!this.fallbackToLocal) {
      // Fail open — let the run proceed but report `0` so callers can
      // tell that no durable ledger value is available.
      return { allowed: true, totalCostUsd: 0 }
    }
    const next = (this.localTotals.get(key) ?? 0) + costUsd
    this.localTotals.set(key, next)
    return { allowed: next < this.maxCostUsd, totalCostUsd: next }
  }
}

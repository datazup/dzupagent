/**
 * Redis implementation of {@link PipelineCheckpointStore}.
 *
 * Uses a minimal `RedisClientLike` adapter interface rather than a hard
 * dependency on `ioredis`, `node-redis`, or similar. Any client that exposes
 * the subset of commands below will work — `ioredis.Redis` and the
 * `redis` v4+ client both satisfy it.
 *
 * Storage layout
 * --------------
 *  checkpoint:{runId}:{version}         → JSON-serialised PipelineCheckpoint
 *  checkpoint:{runId}:versions          → Sorted set (score = version)
 *  checkpoints:runs                     → Set of known runIds (for prune)
 *
 * TTL is applied per-version key when `defaultTtlSeconds` is configured.
 *
 * @module pipeline/redis-checkpoint-store
 */

import type {
  PipelineCheckpoint,
  PipelineCheckpointStore,
  PipelineCheckpointSummary,
} from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/**
 * Minimal command surface compatible with `ioredis` and `node-redis`.
 *
 * Implementations may accept numbers or strings for `zadd` scores — this
 * interface uses the ioredis-style signature (score, member) but the calls
 * use string scores which both libraries accept.
 */
export interface RedisClientLike {
  set(
    key: string,
    value: string,
    ...modifiers: Array<string | number>
  ): Promise<unknown>
  get(key: string): Promise<string | null>
  del(...keys: string[]): Promise<number>
  zadd(key: string, ...scoreMembers: Array<string | number>): Promise<unknown>
  zrange(key: string, start: number, stop: number): Promise<string[]>
  zrevrange(key: string, start: number, stop: number): Promise<string[]>
  zscore(key: string, member: string): Promise<string | null>
  zrem(key: string, ...members: string[]): Promise<number>
  sadd(key: string, ...members: string[]): Promise<number>
  srem(key: string, ...members: string[]): Promise<number>
  smembers(key: string): Promise<string[]>
  exists(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<number>
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RedisPipelineCheckpointStoreOptions {
  client: RedisClientLike
  /** Prefix applied to every key (default: `checkpoint`). */
  keyPrefix?: string
  /**
   * TTL (in seconds) applied to each checkpoint key. When the TTL elapses
   * Redis evicts the key automatically. Leave unset for non-expiring
   * checkpoints — `prune()` will still walk the runs set and drop
   * anything older than `maxAgeMs`.
   */
  defaultTtlSeconds?: number
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class RedisPipelineCheckpointStore implements PipelineCheckpointStore {
  private readonly client: RedisClientLike
  private readonly keyPrefix: string
  private readonly defaultTtlSeconds: number | undefined

  constructor(options: RedisPipelineCheckpointStoreOptions) {
    this.client = options.client
    this.keyPrefix = options.keyPrefix ?? 'checkpoint'
    this.defaultTtlSeconds = options.defaultTtlSeconds
  }

  /**
   * No-op for Redis — there is no schema to create. Provided for API parity
   * with {@link PostgresPipelineCheckpointStore}.
   */
  async setup(): Promise<void> {
    return
  }

  async save(checkpoint: PipelineCheckpoint): Promise<void> {
    const payload = JSON.stringify(checkpoint)
    const versionKey = this.versionKey(checkpoint.pipelineRunId, checkpoint.version)
    const zkey = this.versionsKey(checkpoint.pipelineRunId)
    const runsKey = this.runsKey()

    if (this.defaultTtlSeconds) {
      await this.client.set(versionKey, payload, 'EX', this.defaultTtlSeconds)
    } else {
      await this.client.set(versionKey, payload)
    }

    await this.client.zadd(zkey, String(checkpoint.version), String(checkpoint.version))
    await this.client.sadd(runsKey, checkpoint.pipelineRunId)

    if (this.defaultTtlSeconds) {
      // Keep the version index alive at least as long as the newest entry.
      await this.client.expire(zkey, this.defaultTtlSeconds)
    }
  }

  async load(pipelineRunId: string): Promise<PipelineCheckpoint | undefined> {
    const zkey = this.versionsKey(pipelineRunId)
    // Highest scored version (most recent).
    const members = await this.client.zrevrange(zkey, 0, 0)
    const versionStr = members[0]
    if (!versionStr) return undefined

    const version = Number(versionStr)
    if (!Number.isFinite(version)) return undefined

    return this.loadVersion(pipelineRunId, version)
  }

  async loadVersion(
    pipelineRunId: string,
    version: number,
  ): Promise<PipelineCheckpoint | undefined> {
    const key = this.versionKey(pipelineRunId, version)
    const raw = await this.client.get(key)
    if (!raw) {
      // Key might have been TTL-evicted — ensure the index is consistent.
      await this.client.zrem(this.versionsKey(pipelineRunId), String(version))
      return undefined
    }
    try {
      return JSON.parse(raw) as PipelineCheckpoint
    } catch {
      return undefined
    }
  }

  async listVersions(pipelineRunId: string): Promise<PipelineCheckpointSummary[]> {
    const zkey = this.versionsKey(pipelineRunId)
    const versionStrs = await this.client.zrange(zkey, 0, -1)

    const summaries: PipelineCheckpointSummary[] = []
    for (const vStr of versionStrs) {
      const version = Number(vStr)
      if (!Number.isFinite(version)) continue
      const cp = await this.loadVersion(pipelineRunId, version)
      if (!cp) continue
      summaries.push({
        pipelineRunId: cp.pipelineRunId,
        version: cp.version,
        createdAt: cp.createdAt,
        completedNodeCount: cp.completedNodeIds.length,
      })
    }

    return summaries.sort((a, b) => a.version - b.version)
  }

  async delete(pipelineRunId: string): Promise<void> {
    const zkey = this.versionsKey(pipelineRunId)
    const versions = await this.client.zrange(zkey, 0, -1)

    const keys = versions.map(v => this.versionKey(pipelineRunId, Number(v)))
    keys.push(zkey)
    if (keys.length > 0) await this.client.del(...keys)
    await this.client.srem(this.runsKey(), pipelineRunId)
  }

  async prune(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs
    const runs = await this.client.smembers(this.runsKey())

    let pruned = 0
    for (const runId of runs) {
      const zkey = this.versionsKey(runId)
      const versionStrs = await this.client.zrange(zkey, 0, -1)

      if (versionStrs.length === 0) {
        // Dangling run with no versions — drop from run index.
        await this.client.srem(this.runsKey(), runId)
        continue
      }

      for (const vStr of versionStrs) {
        const version = Number(vStr)
        if (!Number.isFinite(version)) continue
        const cp = await this.loadVersion(runId, version)
        if (!cp) {
          // Underlying data missing (likely evicted) — tidy the index.
          await this.client.zrem(zkey, vStr)
          continue
        }
        const createdMs = new Date(cp.createdAt).getTime()
        if (Number.isFinite(createdMs) && createdMs < cutoff) {
          await this.client.del(this.versionKey(runId, version))
          await this.client.zrem(zkey, vStr)
          pruned++
        }
      }

      const remaining = await this.client.zrange(zkey, 0, -1)
      if (remaining.length === 0) {
        await this.client.del(zkey)
        await this.client.srem(this.runsKey(), runId)
      }
    }

    return pruned
  }

  // -------------------------------------------------------------------------
  // Key helpers
  // -------------------------------------------------------------------------

  private versionKey(runId: string, version: number): string {
    return `${this.keyPrefix}:${runId}:${version}`
  }

  private versionsKey(runId: string): string {
    return `${this.keyPrefix}:${runId}:versions`
  }

  private runsKey(): string {
    return `${this.keyPrefix}:runs`
  }
}

/**
 * P3 — Redis-backed distributed guardrail client.
 *
 * Implements the `CostLedgerClient` contract (which extends `RateLimiterClient`)
 * from `@dzupagent/agent` so a fleet of processes shares one fixed-window rate
 * limit and one running cost total instead of enforcing locally per replica.
 *
 * Redis stays an OPTIONAL dependency: this wrapper takes an injected
 * ioredis/node-redis-shaped connection rather than importing a client library
 * directly (mirrors how `BullMQRunQueue` isolates `bullmq`). The
 * `DistributedRateLimiter` / `DistributedCostLedger` already degrade to local
 * enforcement when the client throws, so a dropped Redis connection never
 * fails a run.
 *
 * See workspace-docs/repos/dzupagent/docs/architecture/plans/P3-distributed-guardrails-redis.md
 */

/**
 * Minimal ioredis/node-redis-shaped surface this client needs. Both libraries
 * satisfy it structurally (`incr`, `pexpire`/`expire`, `get`, `del`,
 * `incrbyfloat`). Methods may return numbers or numeric strings depending on
 * the driver — both are normalized.
 */
export interface RedisLikeConnection {
  incr(key: string): Promise<number | string>;
  expire(key: string, seconds: number): Promise<number | string>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number | string>;
  incrbyfloat(
    key: string,
    increment: number | string
  ): Promise<number | string>;
}

function toNumber(v: number | string): number {
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Wraps a Redis-shaped connection as a `CostLedgerClient` for the distributed
 * guardrails. Throwing on connection failure is intentional — the guardrails
 * catch it and fall back to local enforcement (with an operator-visible event).
 */
export class RedisGuardrailClient {
  constructor(private readonly redis: RedisLikeConnection) {}

  async incr(key: string): Promise<number> {
    return toNumber(await this.redis.incr(key));
  }

  async expire(key: string, seconds: number): Promise<number> {
    return toNumber(await this.redis.expire(key, seconds));
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async del(key: string): Promise<number> {
    return toNumber(await this.redis.del(key));
  }

  async incrByFloat(key: string, increment: number): Promise<number> {
    return toNumber(await this.redis.incrbyfloat(key, increment));
  }
}

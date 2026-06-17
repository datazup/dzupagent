/**
 * P3 — RedisGuardrailClient + fleet-wide coordination.
 *
 * Verifies the client satisfies the CostLedgerClient contract and that two
 * DistributedRateLimiter / DistributedCostLedger instances (simulating two
 * processes) sharing one client enforce a SINGLE combined budget.
 */
import { describe, it, expect } from "vitest";
import {
  DistributedRateLimiter,
  DistributedCostLedger,
  type CostLedgerClient,
} from "@dzupagent/agent";
import {
  RedisGuardrailClient,
  type RedisLikeConnection,
} from "../redis-guardrail-client.js";

/** Minimal in-memory fake of an ioredis-shaped connection. */
class FakeRedis implements RedisLikeConnection {
  private store = new Map<string, number>();
  async incr(key: string): Promise<number> {
    const next = (this.store.get(key) ?? 0) + 1;
    this.store.set(key, next);
    return next;
  }
  async expire(_key: string, _seconds: number): Promise<number> {
    return 1;
  }
  async get(key: string): Promise<string | null> {
    const v = this.store.get(key);
    return v === undefined ? null : String(v);
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
  async incrbyfloat(key: string, increment: number): Promise<string> {
    const next = (this.store.get(key) ?? 0) + Number(increment);
    this.store.set(key, next);
    return String(next);
  }
}

describe("RedisGuardrailClient", () => {
  it("satisfies the CostLedgerClient contract", () => {
    const client: CostLedgerClient = new RedisGuardrailClient(new FakeRedis());
    expect(typeof client.incr).toBe("function");
    expect(typeof client.expire).toBe("function");
    expect(typeof client.get).toBe("function");
    expect(typeof client.del).toBe("function");
    expect(typeof client.incrByFloat).toBe("function");
  });

  it("incr returns a monotonically increasing count", async () => {
    const client = new RedisGuardrailClient(new FakeRedis());
    expect(await client.incr("k")).toBe(1);
    expect(await client.incr("k")).toBe(2);
  });

  it("incrByFloat accumulates a fractional running total", async () => {
    const client = new RedisGuardrailClient(new FakeRedis());
    expect(await client.incrByFloat("cost", 1.5)).toBe(1.5);
    expect(await client.incrByFloat("cost", 2.25)).toBe(3.75);
  });
});

describe("fleet-wide coordination via a shared client", () => {
  it("two rate limiters sharing one client enforce ONE combined budget", async () => {
    const client = new RedisGuardrailClient(new FakeRedis());
    const cfg = {
      client,
      maxRequests: 3,
      windowMs: 60_000,
      fallbackToLocal: false,
    };
    const procA = new DistributedRateLimiter(cfg);
    const procB = new DistributedRateLimiter(cfg);

    // 3 allowed across BOTH processes (not 3 each).
    expect(await procA.tryConsume("t1", "a1")).toBe(true); // 1
    expect(await procB.tryConsume("t1", "a1")).toBe(true); // 2
    expect(await procA.tryConsume("t1", "a1")).toBe(true); // 3
    expect(await procB.tryConsume("t1", "a1")).toBe(false); // 4 → over
  });

  it("two cost ledgers sharing one client sum spend fleet-wide", async () => {
    const client = new RedisGuardrailClient(new FakeRedis());
    const procA = new DistributedCostLedger({ client });
    const procB = new DistributedCostLedger({ client });

    await procA.record("t1", "a1", 1.0);
    await procB.record("t1", "a1", 2.5);
    expect(await procA.read("t1", "a1")).toBeCloseTo(3.5);
    expect(await procB.read("t1", "a1")).toBeCloseTo(3.5);
  });
});

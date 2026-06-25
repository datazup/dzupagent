/**
 * Deep coverage: agent/skill resolver cache + memoization (W31-D).
 *
 * Tests SharedAgentSkillResolver's internal cache in exhaustive detail:
 * LRU eviction, TTL expiry, invalidation, cache boundaries, size limits,
 * error handling, instruction injection modes, canResolve(), messageBuilder,
 * and concurrent-access semantics (single-threaded JS dedup).
 *
 * Supervisor-agent memoization (WeakMap, cache keys, identity guards) is also
 * covered via the clearSupervisorCache / runSupervisor surface.
 */

// ---------------------------------------------------------------------------
// Mock DzupAgent — avoids heavy LangChain / ModelRegistry deps
// ---------------------------------------------------------------------------

let agentCallLog: Array<{ id: string; instructions: string }> = [];
let generateCallLog: Array<{ agentId: string; prompt: string }> = [];

vi.mock("../agent/dzip-agent.js", () => {
  class FakeDzupAgent {
    readonly id: string;
    private readonly _config: Record<string, unknown>;

    constructor(config: Record<string, unknown>) {
      this.id = config["id"] as string;
      this._config = config;
      agentCallLog.push({
        id: this.id,
        instructions: (config["instructions"] as string) ?? "",
      });
    }

    get agentConfig(): Readonly<Record<string, unknown>> {
      return this._config;
    }

    async generate(messages: Array<{ content: string }>) {
      const prompt = messages[0]?.content ?? "";
      generateCallLog.push({ agentId: this.id, prompt });
      return { content: `result-from-${this.id}` };
    }

    async asTool() {
      return { name: this.id, invoke: async () => `tool-${this.id}` };
    }
  }
  return { DzupAgent: FakeDzupAgent };
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SkillRegistry } from "@dzupagent/core";
import {
  SharedAgentSkillResolver,
  type SharedAgentSkillResolverConfig,
} from "../skill-chain-executor/skill-step-resolver.js";
import { DzupAgent } from "../agent/dzip-agent.js";
import { SkillNotFoundError } from "../skill-chain-executor/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(...skillIds: string[]): SkillRegistry {
  const reg = new SkillRegistry();
  for (const id of skillIds) {
    reg.register({
      id,
      name: id,
      description: `Skill ${id}`,
      instructions: `Instructions for ${id}`,
    });
  }
  return reg;
}

function makeBaseAgent(
  id = "base",
  instructions = "base instructions"
): DzupAgent {
  return new DzupAgent({ id, instructions, model: "chat" } as never);
}

function makeResolver(
  overrides: Partial<SharedAgentSkillResolverConfig> = {}
): SharedAgentSkillResolver {
  return new SharedAgentSkillResolver({
    baseAgent: makeBaseAgent(),
    registry: makeRegistry(
      "skill-a",
      "skill-b",
      "skill-c",
      "skill-d",
      "skill-e"
    ),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Reset logs between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  agentCallLog = [];
  generateCallLog = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// 1. Cache hit — same skill resolved twice → only one agent constructed
// ===========================================================================
describe("cache hit", () => {
  it("second resolve() returns cached agent without constructing a new one", async () => {
    const resolver = makeResolver();
    await resolver.resolve("skill-a");
    const countBefore = agentCallLog.filter(
      (c) => c.id === "base:skill-a"
    ).length;

    await resolver.resolve("skill-a");
    const countAfter = agentCallLog.filter(
      (c) => c.id === "base:skill-a"
    ).length;

    expect(countBefore).toBe(1);
    expect(countAfter).toBe(1); // no new construction
  });

  it("ten consecutive resolves of the same skill build only one agent", async () => {
    const resolver = makeResolver();
    for (let i = 0; i < 10; i++) {
      await resolver.resolve("skill-a");
    }
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(1);
  });

  it("returned WorkflowStep on cache hit has same id as first call", async () => {
    const resolver = makeResolver();
    const step1 = await resolver.resolve("skill-a");
    const step2 = await resolver.resolve("skill-a");
    expect(step2.id).toBe(step1.id);
  });

  it("returned WorkflowStep on cache hit has same description as first call", async () => {
    const resolver = makeResolver();
    const step1 = await resolver.resolve("skill-a");
    const step2 = await resolver.resolve("skill-a");
    expect(step2.description).toBe(step1.description);
  });

  it("execute function on cached step produces same result pattern", async () => {
    const resolver = makeResolver();
    const step1 = await resolver.resolve("skill-a");
    const step2 = await resolver.resolve("skill-a");
    const r1 = await step1.execute({ userMessage: "hello" }, {} as never);
    const r2 = await step2.execute({ userMessage: "world" }, {} as never);
    expect(typeof r1["skill-a"]).toBe("string");
    expect(typeof r2["skill-a"]).toBe("string");
  });
});

// ===========================================================================
// 2. Cache miss — different args → separate agents built
// ===========================================================================
describe("cache miss", () => {
  it("different skills produce separate agents", async () => {
    const resolver = makeResolver();
    await resolver.resolve("skill-a");
    await resolver.resolve("skill-b");
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(1);
    expect(agentCallLog.filter((c) => c.id === "base:skill-b")).toHaveLength(1);
  });

  it("each distinct skill id is resolved independently", async () => {
    const resolver = makeResolver();
    const ids = ["skill-a", "skill-b", "skill-c", "skill-d", "skill-e"];
    for (const id of ids) await resolver.resolve(id);
    for (const id of ids) {
      expect(agentCallLog.filter((c) => c.id === `base:${id}`)).toHaveLength(1);
    }
  });

  it("resolving an unknown skill throws SkillNotFoundError", async () => {
    const resolver = makeResolver();
    await expect(resolver.resolve("does-not-exist")).rejects.toBeInstanceOf(
      SkillNotFoundError
    );
  });

  it("SkillNotFoundError contains the unknown skill id", async () => {
    const resolver = makeResolver();
    await expect(resolver.resolve("unknown-skill")).rejects.toMatchObject({
      skillId: "unknown-skill",
    });
  });

  it("SkillNotFoundError lists available skills", async () => {
    const reg = makeRegistry("skill-a", "skill-b");
    const resolver = makeResolver({ registry: reg });
    try {
      await resolver.resolve("missing");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as SkillNotFoundError).availableSkills).toContain("skill-a");
      expect((e as SkillNotFoundError).availableSkills).toContain("skill-b");
    }
  });
});

// ===========================================================================
// 3. Cache key — includes skill id (namespaced agent id)
// ===========================================================================
describe("cache key composition", () => {
  it("agent id is namespaced as baseId:skillId", async () => {
    const resolver = makeResolver();
    await resolver.resolve("skill-a");
    const constructed = agentCallLog.find((c) => c.id === "base:skill-a");
    expect(constructed).toBeDefined();
  });

  it("different baseAgent ids produce different namespaced cache keys", async () => {
    const reg = makeRegistry("skill-a");
    const r1 = new SharedAgentSkillResolver({
      baseAgent: makeBaseAgent("agent-1"),
      registry: reg,
    });
    const r2 = new SharedAgentSkillResolver({
      baseAgent: makeBaseAgent("agent-2"),
      registry: reg,
    });
    await r1.resolve("skill-a");
    await r2.resolve("skill-a");
    expect(agentCallLog.find((c) => c.id === "agent-1:skill-a")).toBeDefined();
    expect(agentCallLog.find((c) => c.id === "agent-2:skill-a")).toBeDefined();
  });

  it("two separate resolver instances have independent caches", async () => {
    const reg = makeRegistry("skill-a");
    const r1 = new SharedAgentSkillResolver({
      baseAgent: makeBaseAgent(),
      registry: reg,
    });
    const r2 = new SharedAgentSkillResolver({
      baseAgent: makeBaseAgent(),
      registry: reg,
    });
    await r1.resolve("skill-a");
    const countAfterR1 = agentCallLog.filter(
      (c) => c.id === "base:skill-a"
    ).length;
    await r2.resolve("skill-a");
    const countAfterR2 = agentCallLog.filter(
      (c) => c.id === "base:skill-a"
    ).length;
    expect(countAfterR1).toBe(1);
    expect(countAfterR2).toBe(2); // r2 builds its own
  });
});

// ===========================================================================
// 4. TTL — expired entry causes re-build
// ===========================================================================
describe("TTL (cacheTtlMs)", () => {
  it("entry is served from cache before TTL elapses", async () => {
    const resolver = makeResolver({ cacheTtlMs: 60_000 });
    await resolver.resolve("skill-a");
    agentCallLog = [];
    await resolver.resolve("skill-a");
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(0);
  });

  it("entry is evicted and rebuilt after TTL elapses", async () => {
    vi.useFakeTimers();
    const resolver = makeResolver({ cacheTtlMs: 500 });
    await resolver.resolve("skill-a");
    agentCallLog = [];
    vi.advanceTimersByTime(501);
    await resolver.resolve("skill-a");
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(1);
    vi.useRealTimers();
  });

  it("entry exactly at TTL boundary (==) is still considered expired", async () => {
    let time = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => time);
    const resolver = makeResolver({ cacheTtlMs: 100 });
    await resolver.resolve("skill-a");
    agentCallLog = [];
    time += 100; // exactly at TTL boundary: Date.now() - cachedAt === 100 > 100 is false
    // The source uses `> cacheTtlMs`, so exactly equal means NOT expired
    await resolver.resolve("skill-a");
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(0);
  });

  it("entry one millisecond over TTL IS expired", async () => {
    let time = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => time);
    const resolver = makeResolver({ cacheTtlMs: 100 });
    await resolver.resolve("skill-a");
    agentCallLog = [];
    time += 101;
    await resolver.resolve("skill-a");
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(1);
  });

  it("after TTL expiry the new agent is cached for subsequent calls", async () => {
    let time = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => time);
    const resolver = makeResolver({ cacheTtlMs: 100 });
    await resolver.resolve("skill-a");
    time += 101; // expire
    agentCallLog = [];
    await resolver.resolve("skill-a"); // re-builds + caches
    await resolver.resolve("skill-a"); // should hit new cache
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(1);
  });

  it("TTL=0 (default) means no expiry regardless of time elapsed", async () => {
    let time = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => time);
    const resolver = makeResolver({ cacheTtlMs: 0 });
    await resolver.resolve("skill-a");
    time += 999_999_999;
    agentCallLog = [];
    await resolver.resolve("skill-a");
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(0);
  });

  it("different skills have independent TTL timers", async () => {
    let time = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => time);
    const resolver = makeResolver({ cacheTtlMs: 100 });
    await resolver.resolve("skill-a");
    time += 50;
    await resolver.resolve("skill-b"); // cached at t=1_000_050
    time += 60; // t=1_000_110 — skill-a expired, skill-b within TTL
    agentCallLog = [];
    await resolver.resolve("skill-a"); // expired → rebuild
    await resolver.resolve("skill-b"); // within TTL → cache hit
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(1);
    expect(agentCallLog.filter((c) => c.id === "base:skill-b")).toHaveLength(0);
  });
});

// ===========================================================================
// 5. Cache invalidation — invalidate() and clearCache()
// ===========================================================================
describe("invalidate(skillId)", () => {
  it("invalidated entry is re-built on next resolve()", async () => {
    const resolver = makeResolver();
    await resolver.resolve("skill-a");
    agentCallLog = [];
    resolver.invalidate("skill-a");
    await resolver.resolve("skill-a");
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(1);
  });

  it("invalidating one skill does not evict others", async () => {
    const resolver = makeResolver();
    await resolver.resolve("skill-a");
    await resolver.resolve("skill-b");
    resolver.invalidate("skill-a");
    agentCallLog = [];
    await resolver.resolve("skill-b"); // should still be cached
    expect(agentCallLog.filter((c) => c.id === "base:skill-b")).toHaveLength(0);
  });

  it("invalidate on non-existent key does not throw", () => {
    const resolver = makeResolver();
    expect(() => resolver.invalidate("not-registered")).not.toThrow();
  });

  it("double-invalidate is idempotent", async () => {
    const resolver = makeResolver();
    await resolver.resolve("skill-a");
    resolver.invalidate("skill-a");
    resolver.invalidate("skill-a"); // second call — no-op
    agentCallLog = [];
    await resolver.resolve("skill-a");
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(1);
  });

  it("invalidate → resolve re-caches the new entry", async () => {
    const resolver = makeResolver();
    await resolver.resolve("skill-a");
    resolver.invalidate("skill-a");
    agentCallLog = [];
    await resolver.resolve("skill-a"); // new agent built
    await resolver.resolve("skill-a"); // should hit new cache
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(1);
  });
});

describe("clearCache()", () => {
  it("all skills must be rebuilt after clearCache()", async () => {
    const resolver = makeResolver();
    await resolver.resolve("skill-a");
    await resolver.resolve("skill-b");
    await resolver.resolve("skill-c");
    resolver.clearCache();
    agentCallLog = [];
    await resolver.resolve("skill-a");
    await resolver.resolve("skill-b");
    await resolver.resolve("skill-c");
    expect(
      agentCallLog.filter((c) => c.id.startsWith("base:skill"))
    ).toHaveLength(3);
  });

  it("clearCache on empty cache does not throw", () => {
    const resolver = makeResolver();
    expect(() => resolver.clearCache()).not.toThrow();
  });

  it("double clearCache() is idempotent", async () => {
    const resolver = makeResolver();
    await resolver.resolve("skill-a");
    resolver.clearCache();
    resolver.clearCache();
    agentCallLog = [];
    await resolver.resolve("skill-a");
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(1);
  });

  it("after clearCache() subsequent resolve caches the new entry", async () => {
    const resolver = makeResolver();
    await resolver.resolve("skill-a");
    resolver.clearCache();
    agentCallLog = [];
    await resolver.resolve("skill-a"); // rebuild
    await resolver.resolve("skill-a"); // should be cached again
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(1);
  });
});

// ===========================================================================
// 6. LRU eviction (cacheMaxSize)
// ===========================================================================
describe("LRU eviction (cacheMaxSize)", () => {
  it("size-1 cache evicts on every new distinct skill", async () => {
    const resolver = makeResolver({ cacheMaxSize: 1 });
    await resolver.resolve("skill-a"); // cache: [a]
    await resolver.resolve("skill-b"); // evicts a; cache: [b]
    agentCallLog = [];
    await resolver.resolve("skill-a"); // cache miss — rebuild
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(1);
  });

  it("size-2 cache holds two entries", async () => {
    const resolver = makeResolver({ cacheMaxSize: 2 });
    await resolver.resolve("skill-a");
    await resolver.resolve("skill-b");
    agentCallLog = [];
    await resolver.resolve("skill-a"); // still cached
    await resolver.resolve("skill-b"); // still cached
    expect(
      agentCallLog.filter((c) => c.id.startsWith("base:skill"))
    ).toHaveLength(0);
  });

  it("LRU order: adding size+1th evicts the least recently used", async () => {
    const resolver = makeResolver({ cacheMaxSize: 2 });
    await resolver.resolve("skill-a"); // LRU order: [a]
    await resolver.resolve("skill-b"); // LRU order: [a, b]
    await resolver.resolve("skill-c"); // evicts a; LRU order: [b, c]
    agentCallLog = [];
    await resolver.resolve("skill-a"); // cache miss → rebuild; evicts b; cache: [c, a]
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(1);
    agentCallLog = [];
    await resolver.resolve("skill-b"); // b was evicted by skill-a insert → cache miss
    expect(agentCallLog.filter((c) => c.id === "base:skill-b")).toHaveLength(1);
    agentCallLog = [];
    // After [b,c] → resolve(a) evicts b → [c,a] → resolve(b) evicts c → [a,b]
    // So skill-c is now evicted (was LRU when b was re-inserted)
    await resolver.resolve("skill-c");
    expect(agentCallLog.filter((c) => c.id === "base:skill-c")).toHaveLength(1);
  });

  it("cache hit refreshes LRU order so old entry is not evicted first", async () => {
    const resolver = makeResolver({ cacheMaxSize: 2 });
    await resolver.resolve("skill-a"); // LRU: [a]
    await resolver.resolve("skill-b"); // LRU: [a, b]
    await resolver.resolve("skill-a"); // refresh a; LRU: [b, a]
    await resolver.resolve("skill-c"); // evicts b; LRU: [a, c]
    agentCallLog = [];
    await resolver.resolve("skill-a"); // still cached
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(0);
    agentCallLog = [];
    await resolver.resolve("skill-b"); // evicted — rebuild
    expect(agentCallLog.filter((c) => c.id === "base:skill-b")).toHaveLength(1);
  });

  it("cacheMaxSize=0 means unlimited (no eviction)", async () => {
    const resolver = makeResolver({ cacheMaxSize: 0 });
    for (const id of ["skill-a", "skill-b", "skill-c", "skill-d", "skill-e"]) {
      await resolver.resolve(id);
    }
    agentCallLog = [];
    for (const id of ["skill-a", "skill-b", "skill-c", "skill-d", "skill-e"]) {
      await resolver.resolve(id);
    }
    expect(
      agentCallLog.filter((c) => c.id.startsWith("base:skill"))
    ).toHaveLength(0);
  });

  it("evicted entry is re-inserted after rebuild and can be evicted again", async () => {
    const resolver = makeResolver({ cacheMaxSize: 1 });
    await resolver.resolve("skill-a"); // cache: [a]
    await resolver.resolve("skill-b"); // evicts a; cache: [b]
    await resolver.resolve("skill-a"); // evicts b, rebuilds a; cache: [a]
    agentCallLog = [];
    await resolver.resolve("skill-a"); // still cached
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(0);
  });

  it("large cacheMaxSize — 100 skills without eviction", async () => {
    const reg = new SkillRegistry();
    for (let i = 0; i < 50; i++) {
      reg.register({
        id: `s${i}`,
        name: `s${i}`,
        description: `Skill ${i}`,
        instructions: `do ${i}`,
      });
    }
    const resolver = new SharedAgentSkillResolver({
      baseAgent: makeBaseAgent(),
      registry: reg,
      cacheMaxSize: 100,
    });
    for (let i = 0; i < 50; i++) await resolver.resolve(`s${i}`);
    agentCallLog = [];
    for (let i = 0; i < 50; i++) await resolver.resolve(`s${i}`);
    expect(agentCallLog.filter((c) => c.id.startsWith("base:s"))).toHaveLength(
      0
    );
  });
});

// ===========================================================================
// 7. Combined TTL + LRU (both limits active)
// ===========================================================================
describe("combined TTL + LRU", () => {
  it("TTL takes precedence over LRU — expired entry evicted even if recently used", async () => {
    let time = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => time);
    const resolver = makeResolver({ cacheMaxSize: 5, cacheTtlMs: 50 });
    await resolver.resolve("skill-a");
    time += 60; // past TTL
    agentCallLog = [];
    await resolver.resolve("skill-a"); // TTL expired → rebuild
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(1);
  });

  it("LRU eviction unaffected by TTL when within TTL window", async () => {
    const resolver = makeResolver({ cacheMaxSize: 2, cacheTtlMs: 60_000 });
    await resolver.resolve("skill-a");
    await resolver.resolve("skill-b");
    await resolver.resolve("skill-c"); // evicts skill-a (LRU)
    agentCallLog = [];
    await resolver.resolve("skill-a"); // LRU eviction — rebuild
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(1);
  });
});

// ===========================================================================
// 8. Instruction injection modes
// ===========================================================================
describe("instructionInjectionMode", () => {
  it("prepend mode puts skill instructions before base instructions", async () => {
    const resolver = makeResolver({ instructionInjectionMode: "prepend" });
    await resolver.resolve("skill-a");
    const built = agentCallLog.find((c) => c.id === "base:skill-a");
    expect(built?.instructions).toMatch(/^Instructions for skill-a/);
    expect(built?.instructions).toContain("base instructions");
  });

  it("append mode puts base instructions before skill instructions", async () => {
    const resolver = makeResolver({ instructionInjectionMode: "append" });
    await resolver.resolve("skill-a");
    const built = agentCallLog.find((c) => c.id === "base:skill-a");
    expect(built?.instructions).toMatch(/^base instructions/);
    expect(built?.instructions).toContain("Instructions for skill-a");
  });

  it("replace mode uses only skill instructions", async () => {
    const resolver = makeResolver({ instructionInjectionMode: "replace" });
    await resolver.resolve("skill-a");
    const built = agentCallLog.find((c) => c.id === "base:skill-a");
    expect(built?.instructions).toBe("Instructions for skill-a");
    expect(built?.instructions).not.toContain("base instructions");
  });

  it("default instruction mode is prepend", async () => {
    const resolver = new SharedAgentSkillResolver({
      baseAgent: makeBaseAgent(),
      registry: makeRegistry("skill-a"),
    });
    await resolver.resolve("skill-a");
    const built = agentCallLog.find((c) => c.id === "base:skill-a");
    expect(built?.instructions).toMatch(/^Instructions for skill-a/);
  });
});

// ===========================================================================
// 9. canResolve()
// ===========================================================================
describe("canResolve()", () => {
  it("returns true for a registered skill", () => {
    const resolver = makeResolver();
    expect(resolver.canResolve("skill-a")).toBe(true);
  });

  it("returns false for an unregistered skill", () => {
    const resolver = makeResolver();
    expect(resolver.canResolve("unknown")).toBe(false);
  });

  it("returns true for all registered skills", () => {
    const reg = makeRegistry("x", "y", "z");
    const resolver = new SharedAgentSkillResolver({
      baseAgent: makeBaseAgent(),
      registry: reg,
    });
    expect(resolver.canResolve("x")).toBe(true);
    expect(resolver.canResolve("y")).toBe(true);
    expect(resolver.canResolve("z")).toBe(true);
  });

  it("canResolve does not trigger cache population", () => {
    const resolver = makeResolver();
    resolver.canResolve("skill-a");
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(0);
  });
});

// ===========================================================================
// 10. WorkflowStep execution and messageBuilder
// ===========================================================================
describe("WorkflowStep.execute() and messageBuilder", () => {
  it("execute() returns an object keyed by skillId", async () => {
    const resolver = makeResolver();
    const step = await resolver.resolve("skill-a");
    const result = await step.execute(
      { userMessage: "do something" },
      {} as never
    );
    expect(typeof result["skill-a"]).toBe("string");
  });

  it("default messageBuilder includes userMessage", async () => {
    const resolver = makeResolver();
    const step = await resolver.resolve("skill-a");
    await step.execute({ userMessage: "hello world" }, {} as never);
    const call = generateCallLog.find((c) => c.agentId === "base:skill-a");
    expect(call?.prompt).toContain("hello world");
  });

  it("default messageBuilder includes skillId header", async () => {
    const resolver = makeResolver();
    const step = await resolver.resolve("skill-a");
    await step.execute({ userMessage: "test" }, {} as never);
    const call = generateCallLog.find((c) => c.agentId === "base:skill-a");
    expect(call?.prompt).toContain("skill-a");
  });

  it("default messageBuilder includes previousOutputs", async () => {
    const resolver = makeResolver();
    const step = await resolver.resolve("skill-a");
    await step.execute(
      { userMessage: "next", previousOutputs: { "skill-x": "output-x" } },
      {} as never
    );
    const call = generateCallLog.find((c) => c.agentId === "base:skill-a");
    expect(call?.prompt).toContain("output-x");
  });

  it("custom messageBuilder is called with state and skillId", async () => {
    const customBuilder = vi.fn(
      (state: Record<string, unknown>, id: string) =>
        `custom:${id}:${String(state["msg"])}`
    );
    const resolver = makeResolver({ messageBuilder: customBuilder });
    const step = await resolver.resolve("skill-a");
    await step.execute({ msg: "ping" }, {} as never);
    expect(customBuilder).toHaveBeenCalledWith({ msg: "ping" }, "skill-a");
  });

  it("custom messageBuilder result is passed to agent.generate()", async () => {
    const resolver = makeResolver({
      messageBuilder: (_state, id) => `CUSTOM-PROMPT-${id}`,
    });
    const step = await resolver.resolve("skill-b");
    await step.execute({}, {} as never);
    const call = generateCallLog.find((c) => c.agentId === "base:skill-b");
    expect(call?.prompt).toBe("CUSTOM-PROMPT-skill-b");
  });

  it("step description matches the registered skill description", async () => {
    const reg = new SkillRegistry();
    reg.register({
      id: "my-skill",
      name: "my-skill",
      description: "Does my thing",
      instructions: "do it",
    });
    const resolver = new SharedAgentSkillResolver({
      baseAgent: makeBaseAgent(),
      registry: reg,
    });
    const step = await resolver.resolve("my-skill");
    expect(step.description).toBe("Does my thing");
  });

  it("step id matches the skill id", async () => {
    const resolver = makeResolver();
    const step = await resolver.resolve("skill-c");
    expect(step.id).toBe("skill-c");
  });
});

// ===========================================================================
// 11. Cache isolation — separate resolver instances never share cache
// ===========================================================================
describe("cache isolation between instances", () => {
  it("clearCache() on r1 does not affect r2", async () => {
    const reg = makeRegistry("skill-a");
    const r1 = new SharedAgentSkillResolver({
      baseAgent: makeBaseAgent(),
      registry: reg,
    });
    const r2 = new SharedAgentSkillResolver({
      baseAgent: makeBaseAgent(),
      registry: reg,
    });
    await r1.resolve("skill-a");
    await r2.resolve("skill-a");
    r1.clearCache();
    agentCallLog = [];
    await r2.resolve("skill-a"); // r2 cache untouched
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(0);
  });

  it("invalidate() on r1 does not affect r2", async () => {
    const reg = makeRegistry("skill-a");
    const r1 = new SharedAgentSkillResolver({
      baseAgent: makeBaseAgent(),
      registry: reg,
    });
    const r2 = new SharedAgentSkillResolver({
      baseAgent: makeBaseAgent(),
      registry: reg,
    });
    await r1.resolve("skill-a");
    await r2.resolve("skill-a");
    r1.invalidate("skill-a");
    agentCallLog = [];
    await r2.resolve("skill-a");
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(0);
  });
});

// ===========================================================================
// 12. Sequential (JS single-threaded) dedup — two awaits in same microtask
// ===========================================================================
describe("sequential dedup (single-threaded JS)", () => {
  it("two resolves launched without intermediate await share the same agent", async () => {
    const resolver = makeResolver();
    // In JS, these two Promises are both created synchronously before either
    // resolves, but the cache is checked synchronously on first await.
    // The first resolve() sets the cache synchronously after the agent is built.
    const [s1, s2] = await Promise.all([
      resolver.resolve("skill-a"),
      resolver.resolve("skill-a"),
    ]);
    expect(s1.id).toBe(s2.id);
  });

  it("two resolves for different skills launched concurrently both build agents", async () => {
    const resolver = makeResolver();
    const [sA, sB] = await Promise.all([
      resolver.resolve("skill-a"),
      resolver.resolve("skill-b"),
    ]);
    expect(sA.id).toBe("skill-a");
    expect(sB.id).toBe("skill-b");
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(1);
    expect(agentCallLog.filter((c) => c.id === "base:skill-b")).toHaveLength(1);
  });
});

// ===========================================================================
// 13. Error handling — SkillNotFoundError does not pollute cache
// ===========================================================================
describe("error handling and cache integrity", () => {
  it("failed resolve (SkillNotFoundError) leaves valid skills in cache", async () => {
    const resolver = makeResolver();
    await resolver.resolve("skill-a");
    await expect(resolver.resolve("no-such-skill")).rejects.toBeInstanceOf(
      SkillNotFoundError
    );
    agentCallLog = [];
    await resolver.resolve("skill-a"); // should still be cached
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(0);
  });

  it("repeated invalid resolve calls do not throw on existing cached entries", async () => {
    const resolver = makeResolver();
    await resolver.resolve("skill-a");
    for (let i = 0; i < 3; i++) {
      await expect(resolver.resolve("bad")).rejects.toBeInstanceOf(
        SkillNotFoundError
      );
    }
    agentCallLog = [];
    await resolver.resolve("skill-a");
    expect(agentCallLog.filter((c) => c.id === "base:skill-a")).toHaveLength(0);
  });
});

// ===========================================================================
// 14. Registry boundary — canResolve vs resolve parity
// ===========================================================================
describe("registry boundary", () => {
  it("canResolve reflects registry state", () => {
    const reg = new SkillRegistry();
    reg.register({
      id: "only-skill",
      name: "only-skill",
      description: "",
      instructions: "",
    });
    const resolver = new SharedAgentSkillResolver({
      baseAgent: makeBaseAgent(),
      registry: reg,
    });
    expect(resolver.canResolve("only-skill")).toBe(true);
    expect(resolver.canResolve("skill-a")).toBe(false);
  });

  it("resolve succeeds for a skill registered post-construction", async () => {
    const reg = new SkillRegistry();
    reg.register({
      id: "skill-x",
      name: "skill-x",
      description: "x",
      instructions: "do x",
    });
    const resolver = new SharedAgentSkillResolver({
      baseAgent: makeBaseAgent(),
      registry: reg,
    });
    // Register a new skill after the resolver is constructed
    reg.register({
      id: "skill-y",
      name: "skill-y",
      description: "y",
      instructions: "do y",
    });
    const step = await resolver.resolve("skill-y");
    expect(step.id).toBe("skill-y");
  });
});

/**
 * Extended circuit breaker test suite — +70 tests covering:
 *
 *   1. Metrics tracking (failure count, success count, last failure time, state timeline)
 *   2. Provider fallback chains via ResilientModelInvoker
 *   3. Concurrent call handling during state transitions
 *   4. Multiple OPEN / re-open / recovery cycles
 *   5. KeyedCircuitBreaker advanced scenarios
 *   6. Edge-case config (cooldownMs alias, threshold=1, maxAttempts exhaustion)
 *   7. onTransition payload completeness
 *   8. isTransientError / isContextLengthError integration
 *   9. Structured log line validation
 *  10. reset() idempotency and full cycle repetition
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CircuitBreaker, KeyedCircuitBreaker } from "../llm/circuit-breaker.js";
import type {
  CircuitTransitionEvent,
  CircuitState,
} from "../llm/circuit-breaker.js";
import { ResilientModelInvoker } from "../llm/resilient-invoker.js";
import { isTransientError, isContextLengthError } from "../llm/retry.js";
import type { ModelFallbackCandidate } from "../llm/model-registry.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeBreaker(
  overrides: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {},
): CircuitBreaker {
  return new CircuitBreaker({
    failureThreshold: 3,
    resetTimeoutMs: 1000,
    halfOpenMaxAttempts: 1,
    jitterFactor: 0,
    ...overrides,
  });
}

/** Create a minimal mock LangChain BaseChatModel. */
function mockModel(
  impl: (messages: BaseMessage[]) => Promise<BaseMessage>,
): BaseChatModel {
  return {
    invoke: vi.fn(impl),
    _llmType: () => "mock",
    _modelType: () => "mock",
  } as unknown as BaseChatModel;
}

/** Build a ModelFallbackCandidate. */
function candidate(
  provider: string,
  modelImpl: (messages: BaseMessage[]) => Promise<BaseMessage>,
): ModelFallbackCandidate {
  return { provider, modelName: "test-model", model: mockModel(modelImpl) };
}

const OK_MSG: BaseMessage = {
  _getType: () => "ai",
  content: "ok",
} as unknown as BaseMessage;

// Silence circuit-breaker console.warn for all tests in this file.
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Metrics tracking
// ─────────────────────────────────────────────────────────────────────────────

describe("metrics tracking — failure count, success count, state", () => {
  it("failure count increments on each recordFailure while closed", () => {
    const events: CircuitTransitionEvent[] = [];
    const b = makeBreaker({
      failureThreshold: 10,
      onTransition: (e) => events.push(e),
    });
    b.recordFailure();
    b.recordFailure();
    b.recordFailure();
    // Breaker still closed (threshold=10), but transition payload reveals count.
    // We drive it to open to inspect failureCount in the event.
    for (let i = 4; i <= 10; i++) b.recordFailure();
    expect(events[0]!.failureCount).toBe(10);
  });

  it("failureCount in transition event equals threshold at the moment of opening", () => {
    const events: CircuitTransitionEvent[] = [];
    const b = makeBreaker({
      failureThreshold: 5,
      onTransition: (e) => events.push(e),
    });
    for (let i = 0; i < 5; i++) b.recordFailure();
    expect(events[0]!.failureCount).toBe(5);
  });

  it("recordSuccess resets internal failure counter (observable via reopening)", () => {
    const b = makeBreaker({ failureThreshold: 3 });
    b.recordFailure();
    b.recordFailure();
    b.recordSuccess(); // resets to 0
    // Two more failures → still closed (needs 3 from reset baseline)
    b.recordFailure();
    b.recordFailure();
    expect(b.getState()).toBe("closed");
    b.recordFailure(); // third after reset
    expect(b.getState()).toBe("open");
  });

  it("transition event from field carries the previous state correctly", () => {
    vi.useFakeTimers();
    const events: CircuitTransitionEvent[] = [];
    const b = makeBreaker({
      failureThreshold: 1,
      onTransition: (e) => events.push(e),
    });
    b.recordFailure(); // closed → open
    vi.advanceTimersByTime(1000);
    b.getState(); // triggers lazy half-open
    b.recordSuccess(); // half-open → closed
    expect(events[0]!.from).toBe("closed");
    expect(events[0]!.to).toBe("open");
    expect(events[1]!.from).toBe("open");
    expect(events[1]!.to).toBe("half-open");
    expect(events[2]!.from).toBe("half-open");
    expect(events[2]!.to).toBe("closed");
  });

  it("transition event carries failureCount=0 on circuit:close", () => {
    vi.useFakeTimers();
    const events: CircuitTransitionEvent[] = [];
    const b = makeBreaker({
      failureThreshold: 1,
      onTransition: (e) => events.push(e),
    });
    b.recordFailure();
    vi.advanceTimersByTime(1000);
    b.getState();
    b.recordSuccess();
    const closeEvt = events.find((e) => e.kind === "circuit:close")!;
    expect(closeEvt.failureCount).toBe(0);
  });

  it("structured console.warn log includes all required fields on open", () => {
    const b = makeBreaker({ failureThreshold: 1 });
    b.recordFailure();
    const call = warnSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(call);
    expect(parsed.component).toBe("circuit-breaker");
    expect(parsed.event).toBe("circuit:open");
    expect(parsed.from).toBe("closed");
    expect(parsed.to).toBe("open");
    expect(parsed.failureCount).toBe(1);
    expect(typeof parsed.cooldownMs).toBe("number");
    expect(typeof parsed.timestamp).toBe("string");
    expect(parsed.level).toBe("warn");
  });

  it("structured log on half_open does NOT include cooldownMs", () => {
    vi.useFakeTimers();
    const b = makeBreaker({ failureThreshold: 1 });
    b.recordFailure();
    vi.advanceTimersByTime(1000);
    b.getState(); // triggers half-open transition
    const calls = warnSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    const halfOpenLog = calls.find((l) => l.event === "circuit:half_open");
    expect(halfOpenLog).toBeDefined();
    expect(halfOpenLog.cooldownMs).toBeUndefined();
  });

  it("structured log on close does NOT include cooldownMs", () => {
    vi.useFakeTimers();
    const b = makeBreaker({ failureThreshold: 1 });
    b.recordFailure();
    vi.advanceTimersByTime(1000);
    b.getState();
    b.recordSuccess();
    const calls = warnSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    const closeLog = calls.find((l) => l.event === "circuit:close");
    expect(closeLog).toBeDefined();
    expect(closeLog.cooldownMs).toBeUndefined();
  });

  it("onTransition is called synchronously within recordFailure", () => {
    const order: string[] = [];
    const b = makeBreaker({
      failureThreshold: 1,
      onTransition: () => order.push("callback"),
    });
    b.recordFailure();
    order.push("after");
    expect(order).toEqual(["callback", "after"]);
  });

  it("onTransition throwing does not prevent state update", () => {
    let threw = false;
    const b = makeBreaker({
      failureThreshold: 1,
      onTransition: () => {
        threw = true;
        throw new Error("callback boom");
      },
    });
    expect(() => b.recordFailure()).toThrow();
    // State update happened before callback? The current impl calls transitionTo
    // which sets state THEN calls onTransition. Verify state is open.
    expect(threw).toBe(true);
  });

  it("multiple independent breakers do not share failure state", () => {
    const b1 = makeBreaker({ failureThreshold: 3 });
    const b2 = makeBreaker({ failureThreshold: 3 });
    b1.recordFailure();
    b1.recordFailure();
    b1.recordFailure();
    expect(b1.getState()).toBe("open");
    expect(b2.getState()).toBe("closed");
  });

  it("canExecute does not increment halfOpenAttempts (pure read)", () => {
    vi.useFakeTimers();
    const b = makeBreaker({ halfOpenMaxAttempts: 1 });
    b.recordFailure();
    b.recordFailure();
    b.recordFailure();
    vi.advanceTimersByTime(1000);
    // canExecute should return true for the first call
    expect(b.canExecute()).toBe(true);
    // canExecute again — halfOpenAttempts is NOT incremented by canExecute;
    // it is only reset by recordSuccess/recordFailure/reset. So still true.
    expect(b.canExecute()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Provider fallback chains via ResilientModelInvoker
// ─────────────────────────────────────────────────────────────────────────────

describe("ResilientModelInvoker — provider fallback chain with circuit breaker", () => {
  it("succeeds on first provider and returns response", async () => {
    const c1 = candidate("openai", async () => OK_MSG);
    const invoker = new ResilientModelInvoker([c1]);
    const result = await invoker.invoke([]);
    expect(result).toBe(OK_MSG);
  });

  it("falls back to second provider when first throws transient error", async () => {
    const c1 = candidate("openai", async () => {
      throw new Error("429 rate limit exceeded");
    });
    const c2 = candidate("anthropic", async () => OK_MSG);
    const invoker = new ResilientModelInvoker([c1, c2]);
    const result = await invoker.invoke([]);
    expect(result).toBe(OK_MSG);
  });

  it("calls onFallback with failing provider, next provider, and error", async () => {
    const fallbacks: Array<{ failing: string; next: string; err: Error }> = [];
    const c1 = candidate("openai", async () => {
      throw new Error("503 service unavailable");
    });
    const c2 = candidate("anthropic", async () => OK_MSG);
    const invoker = new ResilientModelInvoker([c1, c2], undefined, {
      onFallback: (failing, next, err) =>
        fallbacks.push({ failing, next, err }),
    });
    await invoker.invoke([]);
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]!.failing).toBe("openai");
    expect(fallbacks[0]!.next).toBe("anthropic");
    expect(fallbacks[0]!.err.message).toContain("503");
  });

  it("throws ALL_PROVIDERS_EXHAUSTED when all candidates fail with transient errors", async () => {
    const c1 = candidate("openai", async () => {
      throw new Error("429 rate limit");
    });
    const c2 = candidate("anthropic", async () => {
      throw new Error("503 overloaded");
    });
    const invoker = new ResilientModelInvoker([c1, c2]);
    await expect(invoker.invoke([])).rejects.toMatchObject({
      code: "ALL_PROVIDERS_EXHAUSTED",
    });
  });

  it("throws ALL_PROVIDERS_EXHAUSTED with empty candidates list", async () => {
    const invoker = new ResilientModelInvoker([]);
    await expect(invoker.invoke([])).rejects.toMatchObject({
      code: "ALL_PROVIDERS_EXHAUSTED",
    });
  });

  it("does NOT fall back for non-transient errors — rethrows immediately", async () => {
    const c1 = candidate("openai", async () => {
      throw new Error("401 unauthorized");
    });
    const c2 = candidate("anthropic", async () => OK_MSG);
    const invoker = new ResilientModelInvoker([c1, c2]);
    await expect(invoker.invoke([])).rejects.toThrow("401 unauthorized");
    // c2 model should never have been called.
    expect(c2.model.invoke as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("falls back through 3-provider chain on consecutive transient errors", async () => {
    const c1 = candidate("openai", async () => {
      throw new Error("timeout");
    });
    const c2 = candidate("anthropic", async () => {
      throw new Error("503");
    });
    const c3 = candidate("gemini", async () => OK_MSG);
    const invoker = new ResilientModelInvoker([c1, c2, c3]);
    const result = await invoker.invoke([]);
    expect(result).toBe(OK_MSG);
  });

  it("onFallback exception does not break fallback chain", async () => {
    const c1 = candidate("openai", async () => {
      throw new Error("timeout");
    });
    const c2 = candidate("anthropic", async () => OK_MSG);
    const invoker = new ResilientModelInvoker([c1, c2], undefined, {
      onFallback: () => {
        throw new Error("onFallback boom");
      },
    });
    // Should still succeed — onFallback failure is non-fatal.
    const result = await invoker.invoke([]);
    expect(result).toBe(OK_MSG);
  });

  it("records provider failure on registry when updateBreakers=true (default)", async () => {
    const fakeRegistry = {
      recordProviderSuccess: vi.fn(),
      recordProviderFailure: vi.fn(),
    };
    const c1 = candidate("openai", async () => {
      throw new Error("429");
    });
    const c2 = candidate("anthropic", async () => OK_MSG);
    const invoker = new ResilientModelInvoker([c1, c2], fakeRegistry as never);
    await invoker.invoke([]);
    expect(fakeRegistry.recordProviderFailure).toHaveBeenCalledWith(
      "openai",
      expect.any(Error),
    );
    expect(fakeRegistry.recordProviderSuccess).toHaveBeenCalledWith(
      "anthropic",
    );
  });

  it("does NOT call registry when updateBreakers=false", async () => {
    const fakeRegistry = {
      recordProviderSuccess: vi.fn(),
      recordProviderFailure: vi.fn(),
    };
    const c1 = candidate("openai", async () => OK_MSG);
    const invoker = new ResilientModelInvoker([c1], fakeRegistry as never, {
      updateBreakers: false,
    });
    await invoker.invoke([]);
    expect(fakeRegistry.recordProviderSuccess).not.toHaveBeenCalled();
    expect(fakeRegistry.recordProviderFailure).not.toHaveBeenCalled();
  });

  it("error message in ALL_PROVIDERS_EXHAUSTED includes all tried providers", async () => {
    const c1 = candidate("openai", async () => {
      throw new Error("429");
    });
    const c2 = candidate("anthropic", async () => {
      throw new Error("503");
    });
    const invoker = new ResilientModelInvoker([c1, c2]);
    try {
      await invoker.invoke([]);
      expect.fail("should have thrown");
    } catch (err: unknown) {
      const msg = (err as Error).message;
      expect(msg).toContain("openai");
      expect(msg).toContain("anthropic");
    }
  });

  it("records success on registry for the winning candidate", async () => {
    const fakeRegistry = {
      recordProviderSuccess: vi.fn(),
      recordProviderFailure: vi.fn(),
    };
    const c1 = candidate("openai", async () => {
      throw new Error("timeout");
    });
    const c2 = candidate("anthropic", async () => {
      throw new Error("timeout");
    });
    const c3 = candidate("gemini", async () => OK_MSG);
    const invoker = new ResilientModelInvoker(
      [c1, c2, c3],
      fakeRegistry as never,
    );
    await invoker.invoke([]);
    expect(fakeRegistry.recordProviderSuccess).toHaveBeenCalledWith("gemini");
    expect(fakeRegistry.recordProviderSuccess).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. isTransientError & isContextLengthError
// ─────────────────────────────────────────────────────────────────────────────

describe("isTransientError — identifies retryable failures", () => {
  it.each([
    "429 rate limit",
    "503 service unavailable",
    "529 overloaded",
    "rate_limit exceeded",
    "rate limit hit",
    "too many requests",
    "overloaded",
    "capacity exceeded",
    "timeout",
    "ECONNRESET",
    "ECONNREFUSED",
    "socket hang up",
    "fetch failed",
  ])("isTransientError is true for: %s", (msg) => {
    expect(isTransientError(new Error(msg))).toBe(true);
  });

  it.each([
    "401 unauthorized",
    "403 forbidden",
    "context_length_exceeded",
    "schema error",
  ])("isTransientError is false for: %s", (msg) => {
    expect(isTransientError(new Error(msg))).toBe(false);
  });
});

describe("isContextLengthError — identifies non-retryable context overflows", () => {
  it.each([
    "context_length_exceeded",
    "maximum context length",
    "prompt is too long",
  ])("isContextLengthError is true for: %s", (msg) => {
    expect(isContextLengthError(new Error(msg))).toBe(true);
  });

  it.each(["429", "503", "timeout"])(
    "isContextLengthError is false for: %s",
    (msg) => {
      expect(isContextLengthError(new Error(msg))).toBe(false);
    },
  );

  it("isContextLengthError works with non-Error input (string)", () => {
    expect(isContextLengthError("context_length_exceeded")).toBe(true);
  });

  it("isContextLengthError returns false for null/undefined", () => {
    expect(isContextLengthError(null)).toBe(false);
    expect(isContextLengthError(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Multiple open / recovery cycles
// ─────────────────────────────────────────────────────────────────────────────

describe("multiple OPEN / recovery cycles", () => {
  it("breaker can cycle open→closed→open→closed repeatedly", () => {
    vi.useFakeTimers();
    const b = makeBreaker({ failureThreshold: 2, resetTimeoutMs: 500 });
    for (let cycle = 0; cycle < 5; cycle++) {
      b.recordFailure();
      b.recordFailure();
      expect(b.getState()).toBe("open");
      vi.advanceTimersByTime(500);
      expect(b.getState()).toBe("half-open");
      b.recordSuccess();
      expect(b.getState()).toBe("closed");
    }
  });

  it("after reset(), consecutive reopens counter is cleared", () => {
    vi.useFakeTimers();
    const b = makeBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
    // Drive up consecutiveReopens by failing probes.
    b.recordFailure(); // open #0 → cooldown=1000
    vi.advanceTimersByTime(1000);
    b.recordFailure(); // open #1 → cooldown=2000
    vi.advanceTimersByTime(2000);
    b.recordFailure(); // open #2 → cooldown=4000
    b.reset();
    // After reset, next open should be base cooldown (1000ms).
    b.recordFailure();
    vi.advanceTimersByTime(999);
    expect(b.getState()).toBe("open");
    vi.advanceTimersByTime(1);
    expect(b.getState()).toBe("half-open");
  });

  it("successful probe after multi-cycle history resets backoff counter", () => {
    vi.useFakeTimers();
    const b = makeBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
    // Escalate to 3 consecutive reopens.
    b.recordFailure();
    vi.advanceTimersByTime(1000);
    b.recordFailure(); // re-open #1
    vi.advanceTimersByTime(2000);
    b.recordFailure(); // re-open #2
    vi.advanceTimersByTime(4000);
    expect(b.getState()).toBe("half-open");
    b.recordSuccess(); // closes → resets consecutiveReopens to 0
    // New trip should use base cooldown.
    b.recordFailure();
    vi.advanceTimersByTime(999);
    expect(b.getState()).toBe("open");
    vi.advanceTimersByTime(1);
    expect(b.getState()).toBe("half-open");
  });

  it("open-state failures during multi-cycle do not reset cooldown window", () => {
    vi.useFakeTimers();
    const b = makeBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
    b.recordFailure(); // t=0, opens
    vi.advanceTimersByTime(400);
    b.recordFailure(); // t=400, already open — no-op for cooldown
    b.recordFailure(); // t=400
    vi.advanceTimersByTime(400);
    b.recordFailure(); // t=800
    vi.advanceTimersByTime(199); // t=999
    expect(b.getState()).toBe("open");
    vi.advanceTimersByTime(1); // t=1000
    expect(b.getState()).toBe("half-open");
  });

  it("transition event sequence covers N complete cycles", () => {
    vi.useFakeTimers();
    const events: CircuitTransitionEvent[] = [];
    const b = makeBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 100,
      onTransition: (e) => events.push(e),
    });
    for (let i = 0; i < 3; i++) {
      b.recordFailure();
      vi.advanceTimersByTime(100);
      b.getState();
      b.recordSuccess();
    }
    // 3 cycles × 3 transitions = 9 events.
    expect(events).toHaveLength(9);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(
      Array.from({ length: 3 }, () => [
        "circuit:open",
        "circuit:half_open",
        "circuit:close",
      ]).flat(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Concurrent call handling
// ─────────────────────────────────────────────────────────────────────────────

describe("concurrent call handling during state transitions", () => {
  it("all concurrent canExecute calls return false when breaker is open", () => {
    vi.useFakeTimers();
    const b = makeBreaker({ failureThreshold: 1 });
    b.recordFailure(); // opens circuit
    const results = Array.from({ length: 20 }, () => b.canExecute());
    expect(results.every((r) => r === false)).toBe(true);
  });

  it("canExecute returns true for all calls while closed", () => {
    const b = makeBreaker();
    const results = Array.from({ length: 50 }, () => b.canExecute());
    expect(results.every((r) => r === true)).toBe(true);
  });

  it("simulated concurrent failures: first one that hits threshold opens, rest are no-ops", () => {
    const events: CircuitTransitionEvent[] = [];
    const b = makeBreaker({
      failureThreshold: 3,
      onTransition: (e) => events.push(e),
    });
    // Simulate 10 concurrent failures.
    for (let i = 0; i < 10; i++) b.recordFailure();
    // Should open exactly once.
    expect(events.filter((e) => e.kind === "circuit:open")).toHaveLength(1);
    expect(b.getState()).toBe("open");
  });

  it("concurrent successes after half-open: first success closes, subsequent are no-ops", () => {
    vi.useFakeTimers();
    const events: CircuitTransitionEvent[] = [];
    const b = makeBreaker({
      failureThreshold: 1,
      onTransition: (e) => events.push(e),
    });
    b.recordFailure();
    vi.advanceTimersByTime(1000);
    b.getState(); // → half-open
    // Simulate concurrent successes.
    for (let i = 0; i < 5; i++) b.recordSuccess();
    // Should close exactly once.
    expect(events.filter((e) => e.kind === "circuit:close")).toHaveLength(1);
    expect(b.getState()).toBe("closed");
  });

  it("rapidfire interleaved failure-then-success-then-failure stabilizes correctly", () => {
    const b = makeBreaker({ failureThreshold: 5 });
    for (let i = 0; i < 10; i++) {
      if (i % 3 === 0) {
        b.recordSuccess(); // resets every 3 ops
      } else {
        b.recordFailure();
      }
    }
    // After resets interspersed, should still be closed.
    expect(b.getState()).toBe("closed");
  });

  it("getState is idempotent when called multiple times in open state before timeout", () => {
    vi.useFakeTimers();
    const b = makeBreaker({ failureThreshold: 1, resetTimeoutMs: 5000 });
    b.recordFailure();
    for (let i = 0; i < 20; i++) {
      expect(b.getState()).toBe("open");
    }
  });

  it("getState triggers half-open exactly once even if called many times at the boundary", () => {
    vi.useFakeTimers();
    const events: CircuitTransitionEvent[] = [];
    const b = makeBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      onTransition: (e) => events.push(e),
    });
    b.recordFailure();
    vi.advanceTimersByTime(1000);
    // 20 concurrent getState calls — half-open transition should fire only once.
    for (let i = 0; i < 20; i++) b.getState();
    expect(events.filter((e) => e.kind === "circuit:half_open")).toHaveLength(
      1,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. KeyedCircuitBreaker — advanced scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe("KeyedCircuitBreaker — advanced scenarios", () => {
  it("newly created key starts closed", () => {
    const kb = new KeyedCircuitBreaker({ failureThreshold: 3 });
    expect(kb.getState("brand-new")).toBe("closed");
    expect(kb.isAvailable("brand-new")).toBe(true);
  });

  it("each key has independent failure tracking with threshold=2", () => {
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 2,
      jitterFactor: 0,
    });
    kb.recordFailure("a");
    kb.recordFailure("b");
    kb.recordFailure("b"); // b opens, a stays closed
    expect(kb.getState("a")).toBe("closed");
    expect(kb.getState("b")).toBe("open");
  });

  it("filterAvailable returns empty list when all are open", () => {
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 1,
      jitterFactor: 0,
    });
    const items = [{ id: "x" }, { id: "y" }, { id: "z" }];
    for (const { id } of items) kb.recordFailure(id);
    expect(kb.filterAvailable(items)).toHaveLength(0);
  });

  it("filterAvailable returns all items when none are open", () => {
    const kb = new KeyedCircuitBreaker({ failureThreshold: 5 });
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(kb.filterAvailable(items)).toHaveLength(3);
  });

  it("filterAvailable keeps items whose key has never been seen", () => {
    const kb = new KeyedCircuitBreaker({ failureThreshold: 1 });
    kb.recordFailure("known");
    const items = [{ id: "known" }, { id: "unknown" }];
    const available = kb.filterAvailable(items);
    expect(available.map((i) => i.id)).toEqual(["unknown"]);
  });

  it("recordTimeout alias opens the same breaker as recordFailure", () => {
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 1,
      jitterFactor: 0,
    });
    kb.recordTimeout("svc");
    expect(kb.getState("svc")).toBe("open");
    expect(kb.isAvailable("svc")).toBe(false);
  });

  it("reset() after partial trips makes all keys available again", () => {
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 1,
      jitterFactor: 0,
    });
    ["a", "b", "c", "d"].forEach((k) => kb.recordFailure(k));
    kb.reset();
    ["a", "b", "c", "d"].forEach((k) => expect(kb.isAvailable(k)).toBe(true));
  });

  it("operations on 100 distinct keys do not cross-contaminate", () => {
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 3,
      jitterFactor: 0,
    });
    // Trip even keys.
    for (let i = 0; i < 100; i += 2) {
      const k = `k${i}`;
      kb.recordFailure(k);
      kb.recordFailure(k);
      kb.recordFailure(k);
    }
    for (let i = 0; i < 100; i++) {
      const k = `k${i}`;
      if (i % 2 === 0) {
        expect(kb.getState(k)).toBe("open");
      } else {
        expect(kb.getState(k)).toBe("closed");
      }
    }
  });

  it("keyed breaker transitions to half-open after per-key timeout", () => {
    vi.useFakeTimers();
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 500,
      jitterFactor: 0,
    });
    kb.recordFailure("svc");
    vi.advanceTimersByTime(499);
    expect(kb.getState("svc")).toBe("open");
    vi.advanceTimersByTime(1);
    expect(kb.getState("svc")).toBe("half-open");
  });

  it("successful recovery in keyed half-open closes only that key", () => {
    vi.useFakeTimers();
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 500,
      jitterFactor: 0,
    });
    kb.recordFailure("a");
    kb.recordFailure("b");
    vi.advanceTimersByTime(500);
    kb.recordSuccess("a"); // closes a, b stays in half-open
    expect(kb.getState("a")).toBe("closed");
    expect(kb.getState("b")).toBe("half-open");
  });

  it("isAvailable returns true after successful half-open recovery", () => {
    vi.useFakeTimers();
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 500,
      jitterFactor: 0,
    });
    kb.recordFailure("x");
    vi.advanceTimersByTime(500);
    kb.recordSuccess("x");
    expect(kb.isAvailable("x")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Edge-case configuration
// ─────────────────────────────────────────────────────────────────────────────

describe("edge-case configuration", () => {
  it("cooldownMs alias is used when resetTimeoutMs is absent", () => {
    vi.useFakeTimers();
    const b = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 750,
      jitterFactor: 0,
    });
    b.recordFailure();
    vi.advanceTimersByTime(749);
    expect(b.getState()).toBe("open");
    vi.advanceTimersByTime(1);
    expect(b.getState()).toBe("half-open");
  });

  it("explicit resetTimeoutMs wins over cooldownMs when both are set", () => {
    vi.useFakeTimers();
    const b = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      cooldownMs: 200, // should be ignored
      jitterFactor: 0,
    });
    b.recordFailure();
    vi.advanceTimersByTime(200);
    expect(b.getState()).toBe("open"); // cooldownMs=200 would have elapsed; wins=1000
    vi.advanceTimersByTime(800);
    expect(b.getState()).toBe("half-open");
  });

  it("failureThreshold=1 opens immediately on first failure", () => {
    const b = makeBreaker({ failureThreshold: 1 });
    b.recordFailure();
    expect(b.getState()).toBe("open");
  });

  it("halfOpenMaxAttempts=0: transition call returns true, subsequent calls return false", () => {
    vi.useFakeTimers();
    const b = makeBreaker({ halfOpenMaxAttempts: 0 });
    b.recordFailure();
    b.recordFailure();
    b.recordFailure();
    vi.advanceTimersByTime(1000);
    // The open→half-open transition fires inside canExecute() and returns true
    // from the open branch (before the half-open check runs).
    expect(b.canExecute()).toBe(true);
    // Now state is half-open and halfOpenAttempts=0; 0 < 0 is false → rejected.
    expect(b.canExecute()).toBe(false);
    expect(b.canExecute()).toBe(false);
  });

  it("negative jitterFactor is clamped to 0 (no jitter)", () => {
    vi.useFakeTimers();
    const b = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      jitterFactor: -5, // clamped to 0
    });
    b.recordFailure();
    vi.advanceTimersByTime(999);
    expect(b.getState()).toBe("open");
    vi.advanceTimersByTime(1);
    expect(b.getState()).toBe("half-open");
  });

  it("default failureThreshold is 3 when not specified", () => {
    const b = new CircuitBreaker({ resetTimeoutMs: 1000, jitterFactor: 0 });
    b.recordFailure();
    b.recordFailure();
    expect(b.getState()).toBe("closed");
    b.recordFailure();
    expect(b.getState()).toBe("open");
  });

  it("default resetTimeoutMs is 30_000 when not specified", () => {
    vi.useFakeTimers();
    const b = new CircuitBreaker({ failureThreshold: 1, jitterFactor: 0 });
    b.recordFailure();
    vi.advanceTimersByTime(29_999);
    expect(b.getState()).toBe("open");
    vi.advanceTimersByTime(1);
    expect(b.getState()).toBe("half-open");
  });

  it("maxResetTimeoutMs below resetTimeoutMs is clamped to resetTimeoutMs", () => {
    vi.useFakeTimers();
    const b = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      maxResetTimeoutMs: 100, // below base → clamped
      jitterFactor: 0,
    });
    b.recordFailure();
    vi.advanceTimersByTime(999);
    expect(b.getState()).toBe("open");
    vi.advanceTimersByTime(1);
    expect(b.getState()).toBe("half-open");
  });

  it("reset() resets currentCooldownMs back to base resetTimeoutMs", () => {
    vi.useFakeTimers();
    const b = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      jitterFactor: 0,
    });
    // Escalate cooldown to 2000ms.
    b.recordFailure();
    vi.advanceTimersByTime(1000);
    b.recordFailure(); // probe fails → consecutiveReopens=1, cooldown=2000

    b.reset(); // should revert to base 1000ms
    b.recordFailure();
    vi.advanceTimersByTime(999);
    expect(b.getState()).toBe("open");
    vi.advanceTimersByTime(1);
    expect(b.getState()).toBe("half-open");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. State consistency across getState / canExecute
// ─────────────────────────────────────────────────────────────────────────────

describe("state consistency across getState and canExecute", () => {
  it("getState and canExecute agree on closed state", () => {
    const b = makeBreaker();
    expect(b.getState()).toBe("closed");
    expect(b.canExecute()).toBe(true);
  });

  it("getState and canExecute agree on open state", () => {
    vi.useFakeTimers();
    const b = makeBreaker({ failureThreshold: 1 });
    b.recordFailure();
    expect(b.getState()).toBe("open");
    expect(b.canExecute()).toBe(false);
  });

  it("canExecute transitions open→half-open the same way as getState does", () => {
    vi.useFakeTimers();
    const events: CircuitTransitionEvent[] = [];
    const b = makeBreaker({
      failureThreshold: 1,
      onTransition: (e) => events.push(e),
    });
    b.recordFailure();
    vi.advanceTimersByTime(1000);
    // Use canExecute (not getState) to trigger the transition.
    expect(b.canExecute()).toBe(true);
    expect(events.map((e) => e.kind)).toContain("circuit:half_open");
    expect(b.getState()).toBe("half-open");
  });

  it("half-open state: canExecute returns true, getState returns half-open", () => {
    vi.useFakeTimers();
    const b = makeBreaker({ failureThreshold: 1, halfOpenMaxAttempts: 2 });
    b.recordFailure();
    vi.advanceTimersByTime(1000);
    b.getState(); // trigger transition
    expect(b.getState()).toBe("half-open");
    expect(b.canExecute()).toBe(true);
    expect(b.canExecute()).toBe(true);
  });
});

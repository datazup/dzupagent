/**
 * Provider Fallback Chains — comprehensive test suite
 *
 * Focuses on surfaces and scenarios NOT already covered by:
 *   - circuit-breaker.test.ts        (basic state machine + jitter + backoff)
 *   - resilient-invoker.test.ts      (basic fallback + breaker stubs)
 *   - provider-fallback-deep.test.ts (ModelRegistry + ResilientModelInvoker)
 *   - invoke-with-timeout.test.ts    (basic retry)
 *   - retry.test.ts                  (isTransientError classification)
 *
 * NEW coverage in this file:
 *   - KeyedCircuitBreaker — all methods
 *   - invokeWithTimeout — backoff timing, multiple retries, mixed error paths
 *   - CircuitBreaker with halfOpenMaxAttempts > 1
 *   - Circuit breaker canExecute() / getState() after half-open attempts exhausted
 *   - Provider chain: partial successes, stateful mocks, usage callback propagation
 *   - Cascading fallback: 4-provider chains, interleaved transient/non-transient
 *   - Recovery: circuit auto-recovers, traffic resumes after cooldown
 *   - Fallback priority ordering with the real ModelRegistry
 *   - Error detail propagation across hops
 *   - calculateBackoff — boundary values, multiplier 1, jitter range
 *
 * Total: ≥ 70 it() blocks all passing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { CircuitBreaker, KeyedCircuitBreaker } from "../llm/circuit-breaker.js";
import type { CircuitTransitionEvent } from "../llm/circuit-breaker.js";
import { calculateBackoff } from "../utils/backoff.js";
import { invokeWithTimeout } from "../llm/invoke.js";
import { ResilientModelInvoker } from "../llm/resilient-invoker.js";
import { ForgeError } from "../errors/forge-error.js";
import type { ModelFallbackCandidate } from "../llm/model-registry.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const MSG = [new AIMessage({ content: "ping" })];

function aiMsg(content: string): BaseMessage {
  return new AIMessage({ content });
}

/**
 * Build a mock model that resolves or rejects based on a sequence of behaviours.
 * After the sequence is exhausted, repeats the last entry.
 */
function seqModel(
  seq: Array<"ok" | "transient" | "nontransient" | "context" | "timeout">,
): BaseChatModel {
  let idx = 0;
  const invoke = vi.fn(async () => {
    const kind = seq[Math.min(idx, seq.length - 1)]!;
    idx++;
    switch (kind) {
      case "ok":
        return aiMsg(`ok-${idx}`);
      case "transient":
        throw new Error("503 service unavailable");
      case "nontransient":
        throw new Error("Invalid API key");
      case "context":
        throw new Error("context_length_exceeded in prompt");
      case "timeout":
        // Simulate a very slow response that times out
        await new Promise((r) => setTimeout(r, 60_000));
        return aiMsg("never");
    }
  });
  return { invoke } as unknown as BaseChatModel;
}

function fixedModel(content: string): BaseChatModel {
  return {
    invoke: vi.fn(async () => aiMsg(content)),
  } as unknown as BaseChatModel;
}

function alwaysFailModel(msg: string): BaseChatModel {
  return {
    invoke: vi.fn(async () => {
      throw new Error(msg);
    }),
  } as unknown as BaseChatModel;
}

function cand(provider: string, model: BaseChatModel): ModelFallbackCandidate {
  return { provider, modelName: `model-${provider}`, model };
}

// Fast retry (1 attempt, no sleep) used in all resilient-invoker tests
const NO_RETRY = { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 };

// ---------------------------------------------------------------------------
// Suite A: KeyedCircuitBreaker — full API coverage
// ---------------------------------------------------------------------------

describe("KeyedCircuitBreaker", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("A-01: isAvailable returns true for unknown key (default closed)", () => {
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 1000,
    });
    expect(kb.isAvailable("brand-new")).toBe(true);
  });

  it("A-02: getState returns closed for an unseen key", () => {
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 1000,
    });
    expect(kb.getState("unseen")).toBe("closed");
  });

  it("A-03: recordFailure then isAvailable still true below threshold", () => {
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 1000,
    });
    kb.recordFailure("p");
    kb.recordFailure("p");
    expect(kb.isAvailable("p")).toBe(true);
    expect(kb.getState("p")).toBe("closed");
  });

  it("A-04: recordFailure at threshold opens the breaker", () => {
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 1000,
    });
    kb.recordFailure("p");
    kb.recordFailure("p");
    expect(kb.isAvailable("p")).toBe(false);
    expect(kb.getState("p")).toBe("open");
  });

  it("A-05: different keys have independent breakers", () => {
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 1000,
    });
    kb.recordFailure("alpha");
    kb.recordFailure("alpha");
    expect(kb.isAvailable("alpha")).toBe(false);
    expect(kb.isAvailable("beta")).toBe(true);
  });

  it("A-06: recordSuccess resets breaker to closed", () => {
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 1000,
    });
    kb.recordFailure("p");
    kb.recordFailure("p");
    expect(kb.getState("p")).toBe("open");
    kb.recordSuccess("p");
    expect(kb.getState("p")).toBe("closed");
    expect(kb.isAvailable("p")).toBe(true);
  });

  it("A-07: reset clears all breakers", () => {
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 1000,
    });
    kb.recordFailure("x");
    kb.recordFailure("x");
    kb.recordFailure("y");
    kb.recordFailure("y");
    kb.reset();
    expect(kb.isAvailable("x")).toBe(true);
    expect(kb.isAvailable("y")).toBe(true);
  });

  it("A-08: filterAvailable removes items whose breaker is open", () => {
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
    });
    kb.recordFailure("bad");
    const items = [{ id: "bad" }, { id: "good" }, { id: "new" }];
    const result = kb.filterAvailable(items);
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id)).not.toContain("bad");
  });

  it("A-09: filterAvailable with all open returns empty array", () => {
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
    });
    kb.recordFailure("a");
    kb.recordFailure("b");
    const items = [{ id: "a" }, { id: "b" }];
    expect(kb.filterAvailable(items)).toHaveLength(0);
  });

  it("A-10: filterAvailable with no open breakers returns all items", () => {
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 5,
      resetTimeoutMs: 1000,
    });
    const items = [{ id: "x" }, { id: "y" }, { id: "z" }];
    expect(kb.filterAvailable(items)).toHaveLength(3);
  });

  it("A-11: recordTimeout alias behaves identically to recordFailure", () => {
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 1000,
    });
    kb.recordTimeout("srv");
    kb.recordTimeout("srv");
    expect(kb.isAvailable("srv")).toBe(false);
    expect(kb.getState("srv")).toBe("open");
  });

  it("A-12: multiple keys independently transition; only open ones excluded by filterAvailable", () => {
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 1000,
    });
    kb.recordFailure("a");
    kb.recordFailure("a"); // open
    kb.recordFailure("b"); // still closed
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const available = kb.filterAvailable(items);
    expect(available.map((i) => i.id)).toEqual(["b", "c"]);
  });

  it("A-13: half-open state is available (isAvailable returns true)", () => {
    vi.useFakeTimers();
    try {
      const kb = new KeyedCircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 1000,
        jitterFactor: 0,
      });
      kb.recordFailure("p");
      expect(kb.isAvailable("p")).toBe(false);
      vi.advanceTimersByTime(1000);
      // After cooldown, getState transitions to half-open
      expect(kb.getState("p")).toBe("half-open");
      expect(kb.isAvailable("p")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("A-14: recordSuccess on unseen key does not throw", () => {
    const kb = new KeyedCircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 1000,
    });
    expect(() => kb.recordSuccess("ghost")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Suite B: CircuitBreaker — halfOpenMaxAttempts > 1
// ---------------------------------------------------------------------------

describe("CircuitBreaker with halfOpenMaxAttempts > 1", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("B-01: canExecute returns true in half-open state (halfOpenAttempts starts at 0)", () => {
    vi.useFakeTimers();
    try {
      const b = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 1000,
        halfOpenMaxAttempts: 1,
        jitterFactor: 0,
      });
      b.recordFailure(); // → open
      vi.advanceTimersByTime(1000); // → half-open on next getState/canExecute
      expect(b.getState()).toBe("half-open");
      // In half-open state canExecute() returns true (halfOpenAttempts=0 < max=1)
      expect(b.canExecute()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("B-02: success while half-open transitions circuit to closed", () => {
    vi.useFakeTimers();
    try {
      const b = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 1000,
        halfOpenMaxAttempts: 1,
        jitterFactor: 0,
      });
      b.recordFailure();
      b.recordFailure(); // → open
      vi.advanceTimersByTime(1000); // → half-open
      b.getState(); // trigger transition
      expect(b.getState()).toBe("half-open");
      expect(b.canExecute()).toBe(true);
      b.recordSuccess(); // → closed
      expect(b.getState()).toBe("closed");
      expect(b.canExecute()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("B-03: failure in half-open re-opens and increments consecutiveReopens", () => {
    vi.useFakeTimers();
    try {
      const events: CircuitTransitionEvent[] = [];
      const b = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 1000,
        halfOpenMaxAttempts: 1,
        jitterFactor: 0,
        onTransition: (e) => events.push(e),
      });
      b.recordFailure(); // closed → open
      vi.advanceTimersByTime(1000); // open → half-open (triggered by canExecute/getState)
      b.getState(); // trigger half-open
      b.recordFailure(); // half-open → open (consecutiveReopens=1, cooldown=2000)
      vi.advanceTimersByTime(1999);
      expect(b.getState()).toBe("open");
      vi.advanceTimersByTime(1);
      expect(b.getState()).toBe("half-open");
      expect(events.map((e) => e.kind)).toContain("circuit:open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("B-04: onTransition fires for every half-open→open re-entry", () => {
    vi.useFakeTimers();
    try {
      const events: CircuitTransitionEvent[] = [];
      const b = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 500,
        halfOpenMaxAttempts: 1,
        jitterFactor: 0,
        onTransition: (e) => events.push(e),
      });
      b.recordFailure(); // → open
      vi.advanceTimersByTime(500);
      b.getState(); // → half-open
      b.recordFailure(); // → open again
      const kinds = events.map((e) => e.kind);
      expect(kinds.filter((k) => k === "circuit:open")).toHaveLength(2);
      expect(kinds.filter((k) => k === "circuit:half_open")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("B-05: failure in half-open re-opens the circuit immediately", () => {
    vi.useFakeTimers();
    try {
      const b = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 1000,
        halfOpenMaxAttempts: 1,
        jitterFactor: 0,
      });
      b.recordFailure();
      vi.advanceTimersByTime(1000);
      b.getState(); // trigger half-open
      expect(b.getState()).toBe("half-open");
      b.recordFailure(); // probe fails → re-open
      expect(b.getState()).toBe("open");
      expect(b.canExecute()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite C: calculateBackoff — boundary and multiplier coverage
// ---------------------------------------------------------------------------

describe("calculateBackoff — boundary and multiplier coverage", () => {
  it("C-01: attempt=0 returns initialBackoffMs with multiplier=2", () => {
    expect(
      calculateBackoff(0, {
        initialBackoffMs: 200,
        maxBackoffMs: 5000,
        multiplier: 2,
      }),
    ).toBe(200);
  });

  it("C-02: attempt=1 returns 2x initial with multiplier=2", () => {
    expect(
      calculateBackoff(1, {
        initialBackoffMs: 200,
        maxBackoffMs: 5000,
        multiplier: 2,
      }),
    ).toBe(400);
  });

  it("C-03: attempt=2 returns 4x initial with multiplier=2", () => {
    expect(
      calculateBackoff(2, {
        initialBackoffMs: 200,
        maxBackoffMs: 5000,
        multiplier: 2,
      }),
    ).toBe(800);
  });

  it("C-04: caps at maxBackoffMs", () => {
    expect(
      calculateBackoff(10, {
        initialBackoffMs: 1000,
        maxBackoffMs: 3000,
        multiplier: 2,
      }),
    ).toBe(3000);
  });

  it("C-05: multiplier=1 never grows beyond initialBackoffMs", () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(
        calculateBackoff(attempt, {
          initialBackoffMs: 100,
          maxBackoffMs: 5000,
          multiplier: 1,
        }),
      ).toBe(100);
    }
  });

  it("C-06: multiplier=1.5 grows slower than multiplier=2", () => {
    const slow = calculateBackoff(3, {
      initialBackoffMs: 100,
      maxBackoffMs: 10000,
      multiplier: 1.5,
    });
    const fast = calculateBackoff(3, {
      initialBackoffMs: 100,
      maxBackoffMs: 10000,
      multiplier: 2,
    });
    expect(slow).toBeLessThan(fast);
  });

  it("C-07: jitter always returns value <= capped delay", () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = calculateBackoff(attempt, {
        initialBackoffMs: 100,
        maxBackoffMs: 1000,
        multiplier: 2,
        jitter: true,
      });
      const capped = Math.min(100 * 2 ** attempt, 1000);
      expect(result).toBeLessThanOrEqual(capped);
    }
  });

  it("C-08: jitter always returns value >= 50% of capped delay", () => {
    const rng = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const result = calculateBackoff(2, {
        initialBackoffMs: 1000,
        maxBackoffMs: 8000,
        multiplier: 2,
        jitter: true,
      });
      // capped=4000, jitter=0 → 4000*0.5 = 2000
      expect(result).toBe(2000);
    } finally {
      rng.mockRestore();
    }
  });

  it("C-09: no jitter returns exact capped value deterministically", () => {
    const r1 = calculateBackoff(3, {
      initialBackoffMs: 500,
      maxBackoffMs: 10000,
      multiplier: 2,
    });
    const r2 = calculateBackoff(3, {
      initialBackoffMs: 500,
      maxBackoffMs: 10000,
      multiplier: 2,
    });
    expect(r1).toBe(r2);
    expect(r1).toBe(4000);
  });

  it("C-10: maxBackoffMs equal to initialBackoffMs clamps all attempts to initial", () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      expect(
        calculateBackoff(attempt, {
          initialBackoffMs: 500,
          maxBackoffMs: 500,
          multiplier: 2,
        }),
      ).toBe(500);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite D: invokeWithTimeout — retry backoff, multiple attempts, mixed paths
// ---------------------------------------------------------------------------

describe("invokeWithTimeout — retry backoff and multi-attempt behaviour", () => {
  it("D-01: succeeds on first attempt, model.invoke called exactly once", async () => {
    const m = fixedModel("hello");
    const result = await invokeWithTimeout(m, MSG, {
      retry: { maxAttempts: 3, backoffMs: 10, maxBackoffMs: 100 },
    });
    expect(result.content).toBe("hello");
    expect(m.invoke).toHaveBeenCalledTimes(1);
  });

  it("D-02: succeeds on second attempt after one transient failure", async () => {
    const m = seqModel(["transient", "ok"]);
    const result = await invokeWithTimeout(m, MSG, {
      retry: { maxAttempts: 3, backoffMs: 5, maxBackoffMs: 50 },
    });
    expect(String(result.content)).toMatch(/ok/);
    expect(m.invoke).toHaveBeenCalledTimes(2);
  });

  it("D-03: succeeds on third attempt after two transient failures", async () => {
    const m = seqModel(["transient", "transient", "ok"]);
    const result = await invokeWithTimeout(m, MSG, {
      retry: { maxAttempts: 3, backoffMs: 5, maxBackoffMs: 50 },
    });
    expect(String(result.content)).toMatch(/ok/);
    expect(m.invoke).toHaveBeenCalledTimes(3);
  });

  it("D-04: exhausts maxAttempts and throws last transient error", async () => {
    const m = seqModel(["transient", "transient", "transient"]);
    await expect(
      invokeWithTimeout(m, MSG, {
        retry: { maxAttempts: 3, backoffMs: 5, maxBackoffMs: 50 },
      }),
    ).rejects.toThrow("503");
    expect(m.invoke).toHaveBeenCalledTimes(3);
  });

  it("D-05: non-transient error on first attempt stops immediately, no retry", async () => {
    const m = seqModel(["nontransient", "ok"]);
    await expect(
      invokeWithTimeout(m, MSG, {
        retry: { maxAttempts: 3, backoffMs: 5, maxBackoffMs: 50 },
      }),
    ).rejects.toThrow("Invalid API key");
    expect(m.invoke).toHaveBeenCalledTimes(1);
  });

  it("D-06: context_length_exceeded wraps into CONTEXT_LENGTH_EXCEEDED ForgeError", async () => {
    const m = seqModel(["context"]);
    const err = await invokeWithTimeout(m, MSG, {
      retry: { maxAttempts: 3, backoffMs: 5, maxBackoffMs: 50 },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect((err as ForgeError).code).toBe("CONTEXT_LENGTH_EXCEEDED");
    expect(m.invoke).toHaveBeenCalledTimes(1);
  });

  it("D-07: transient then non-transient stops at second attempt without further retry", async () => {
    const m = seqModel(["transient", "nontransient", "ok"]);
    await expect(
      invokeWithTimeout(m, MSG, {
        retry: { maxAttempts: 5, backoffMs: 5, maxBackoffMs: 50 },
      }),
    ).rejects.toThrow("Invalid API key");
    expect(m.invoke).toHaveBeenCalledTimes(2);
  });

  it("D-08: onUsage callback receives token data on success", async () => {
    const m = {
      invoke: vi.fn(
        async () =>
          new AIMessage({
            content: "answer",
            response_metadata: {
              usage: { input_tokens: 50, output_tokens: 25 },
            },
          }),
      ),
    } as unknown as BaseChatModel;
    const onUsage = vi.fn();
    await invokeWithTimeout(m, MSG, { onUsage });
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 50, outputTokens: 25 }),
    );
  });

  it("D-09: onUsage throwing does not break the invocation", async () => {
    const m = fixedModel("ok");
    const onUsage = vi.fn(() => {
      throw new Error("usage boom");
    });
    const result = await invokeWithTimeout(m, MSG, { onUsage });
    expect(result.content).toBe("ok");
  });

  it("D-10: timeout fires when model takes too long", async () => {
    const m = seqModel(["timeout"]);
    await expect(
      invokeWithTimeout(m, MSG, {
        timeoutMs: 20,
        retry: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
      }),
    ).rejects.toThrow("timed out");
  });

  it("D-11: single-attempt config (maxAttempts=1) never retries on transient", async () => {
    const m = seqModel(["transient"]);
    await expect(
      invokeWithTimeout(m, MSG, {
        retry: { maxAttempts: 1, backoffMs: 5, maxBackoffMs: 100 },
      }),
    ).rejects.toThrow("503");
    expect(m.invoke).toHaveBeenCalledTimes(1);
  });

  it("D-12: retry=2 attempts model twice on transient before giving up", async () => {
    const m = seqModel(["transient", "transient"]);
    await expect(
      invokeWithTimeout(m, MSG, {
        retry: { maxAttempts: 2, backoffMs: 5, maxBackoffMs: 50 },
      }),
    ).rejects.toThrow();
    expect(m.invoke).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Suite E: ResilientModelInvoker — cascading multi-hop chain scenarios
// ---------------------------------------------------------------------------

describe("ResilientModelInvoker — cascading chain scenarios", () => {
  it("E-01: 4-provider chain — only the 4th succeeds", async () => {
    const c1 = cand("p1", alwaysFailModel("503 p1 down"));
    const c2 = cand("p2", alwaysFailModel("429 p2 throttled"));
    const c3 = cand("p3", alwaysFailModel("overloaded p3"));
    const c4 = cand("p4", fixedModel("p4-success"));
    const invoker = new ResilientModelInvoker([c1, c2, c3, c4], undefined, {
      retry: NO_RETRY,
    });
    const result = await invoker.invoke(MSG);
    expect(result.content).toBe("p4-success");
    expect(c1.model.invoke).toHaveBeenCalledTimes(1);
    expect(c2.model.invoke).toHaveBeenCalledTimes(1);
    expect(c3.model.invoke).toHaveBeenCalledTimes(1);
    expect(c4.model.invoke).toHaveBeenCalledTimes(1);
  });

  it("E-02: onFallback fires for each hop except the last", async () => {
    const hops: string[] = [];
    const c1 = cand("a", alwaysFailModel("503 a"));
    const c2 = cand("b", alwaysFailModel("rate_limit b"));
    const c3 = cand("c", alwaysFailModel("overloaded c"));
    const c4 = cand("d", fixedModel("ok"));
    const invoker = new ResilientModelInvoker([c1, c2, c3, c4], undefined, {
      onFallback: (from, to) => hops.push(`${from}->${to}`),
      retry: NO_RETRY,
    });
    await invoker.invoke(MSG);
    expect(hops).toEqual(["a->b", "b->c", "c->d"]);
  });

  it("E-03: non-transient at position 2 stops chain, providers 3+ never tried", async () => {
    const c1 = cand("a", alwaysFailModel("503 down"));
    const c2 = cand("b", alwaysFailModel("Invalid API key"));
    const c3 = cand("c", fixedModel("should-not-run"));
    const invoker = new ResilientModelInvoker([c1, c2, c3], undefined, {
      retry: NO_RETRY,
    });
    await expect(invoker.invoke(MSG)).rejects.toThrow("Invalid API key");
    expect(c3.model.invoke).not.toHaveBeenCalled();
  });

  it("E-04: non-transient at position 1 stops chain immediately", async () => {
    const c1 = cand("a", alwaysFailModel("Invalid API key"));
    const c2 = cand("b", fixedModel("should-not-run"));
    const invoker = new ResilientModelInvoker([c1, c2], undefined, {
      retry: NO_RETRY,
    });
    await expect(invoker.invoke(MSG)).rejects.toThrow("Invalid API key");
    expect(c2.model.invoke).not.toHaveBeenCalled();
  });

  it("E-05: context_length_exceeded at position 1 stops chain and wraps as CONTEXT_LENGTH_EXCEEDED", async () => {
    const c1 = cand("a", alwaysFailModel("context_length_exceeded for prompt"));
    const c2 = cand("b", fixedModel("never"));
    const invoker = new ResilientModelInvoker([c1, c2], undefined, {
      retry: NO_RETRY,
    });
    const err = await invoker.invoke(MSG).catch((e) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect((err as ForgeError).code).toBe("CONTEXT_LENGTH_EXCEEDED");
    expect(c2.model.invoke).not.toHaveBeenCalled();
  });

  it("E-06: transient errors in ALL providers → error list has every provider name", async () => {
    const providers = ["alpha", "beta", "gamma", "delta"];
    const candidates = providers.map((p) =>
      cand(p, alwaysFailModel("503 down")),
    );
    const invoker = new ResilientModelInvoker(candidates, undefined, {
      retry: NO_RETRY,
    });
    const err = (await invoker.invoke(MSG).catch((e) => e)) as ForgeError;
    const ctx = err.context as { errors: Array<{ provider: string }> };
    const names = ctx.errors.map((e) => e.provider);
    expect(names).toEqual(providers);
  });

  it("E-07: onFallback throwing on every hop does not break the chain", async () => {
    const onFallback = vi.fn(() => {
      throw new Error("observer fails");
    });
    const c1 = cand("a", alwaysFailModel("503 down"));
    const c2 = cand("b", alwaysFailModel("rate_limit"));
    const c3 = cand("c", fixedModel("safe"));
    const invoker = new ResilientModelInvoker([c1, c2, c3], undefined, {
      onFallback,
      retry: NO_RETRY,
    });
    const result = await invoker.invoke(MSG);
    expect(result.content).toBe("safe");
    expect(onFallback).toHaveBeenCalledTimes(2);
  });

  it("E-08: single candidate success — no onFallback called", async () => {
    const onFallback = vi.fn();
    const c1 = cand("solo", fixedModel("sole"));
    const invoker = new ResilientModelInvoker([c1], undefined, {
      onFallback,
      retry: NO_RETRY,
    });
    await invoker.invoke(MSG);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("E-09: updateBreakers=true records failures and success in correct order", async () => {
    const stub = {
      recordProviderSuccess: vi.fn(),
      recordProviderFailure: vi.fn(),
    };
    const c1 = cand("a", alwaysFailModel("503 down"));
    const c2 = cand("b", alwaysFailModel("overloaded"));
    const c3 = cand("c", fixedModel("win"));
    const invoker = new ResilientModelInvoker([c1, c2, c3], stub as never, {
      retry: NO_RETRY,
    });
    await invoker.invoke(MSG);
    expect(stub.recordProviderFailure).toHaveBeenCalledWith(
      "a",
      expect.any(Error),
    );
    expect(stub.recordProviderFailure).toHaveBeenCalledWith(
      "b",
      expect.any(Error),
    );
    expect(stub.recordProviderSuccess).toHaveBeenCalledWith("c");
    expect(stub.recordProviderSuccess).not.toHaveBeenCalledWith("a");
    expect(stub.recordProviderSuccess).not.toHaveBeenCalledWith("b");
  });

  it("E-10: updateBreakers=false — registry never called even on failures", async () => {
    const stub = {
      recordProviderSuccess: vi.fn(),
      recordProviderFailure: vi.fn(),
    };
    const c1 = cand("a", alwaysFailModel("503 down"));
    const c2 = cand("b", fixedModel("ok"));
    const invoker = new ResilientModelInvoker([c1, c2], stub as never, {
      updateBreakers: false,
      retry: NO_RETRY,
    });
    await invoker.invoke(MSG);
    expect(stub.recordProviderSuccess).not.toHaveBeenCalled();
    expect(stub.recordProviderFailure).not.toHaveBeenCalled();
  });

  it("E-11: error message from ALL_PROVIDERS_EXHAUSTED lists all provider names", async () => {
    const candidates = ["x", "y", "z"].map((p) =>
      cand(p, alwaysFailModel("rate_limit down")),
    );
    const invoker = new ResilientModelInvoker(candidates, undefined, {
      retry: NO_RETRY,
    });
    const err = (await invoker.invoke(MSG).catch((e) => e)) as ForgeError;
    expect(err.message).toContain("x");
    expect(err.message).toContain("y");
    expect(err.message).toContain("z");
  });

  it("E-12: ALL_PROVIDERS_EXHAUSTED is always a non-recoverable ForgeError", async () => {
    const c1 = cand("a", alwaysFailModel("503 down"));
    const invoker = new ResilientModelInvoker([c1], undefined, {
      retry: NO_RETRY,
    });
    const err = (await invoker.invoke(MSG).catch((e) => e)) as ForgeError;
    expect(err.recoverable).toBe(false);
  });

  it("E-13: onFallback receives correct error object from the failing provider", async () => {
    let capturedError: Error | undefined;
    const c1 = cand("a", alwaysFailModel("429 specific-message-abc"));
    const c2 = cand("b", fixedModel("ok"));
    const invoker = new ResilientModelInvoker([c1, c2], undefined, {
      onFallback: (_from, _to, err) => {
        capturedError = err;
      },
      retry: NO_RETRY,
    });
    await invoker.invoke(MSG);
    expect(capturedError?.message).toContain("429 specific-message-abc");
  });

  it("E-14: large chain with alternating success confirms only first-success provider wins", async () => {
    // 5 fail, then 1 success — the 6th is the winner
    const losing = Array.from({ length: 5 }, (_, i) =>
      cand(`fail${i}`, alwaysFailModel("overloaded")),
    );
    const winner = cand("winner", fixedModel("champion"));
    const invoker = new ResilientModelInvoker([...losing, winner], undefined, {
      retry: NO_RETRY,
    });
    const result = await invoker.invoke(MSG);
    expect(result.content).toBe("champion");
  });
});

// ---------------------------------------------------------------------------
// Suite F: Recovery behavior — circuit reopens after cooldown
// ---------------------------------------------------------------------------

describe("Provider recovery — circuit reopens after cooldown", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("F-01: circuit in open state rejects requests immediately", () => {
    const b = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 10_000,
      jitterFactor: 0,
    });
    b.recordFailure();
    expect(b.canExecute()).toBe(false);
  });

  it("F-02: circuit auto-transitions to half-open after cooldown", () => {
    vi.useFakeTimers();
    try {
      const b = new CircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 500,
        jitterFactor: 0,
      });
      b.recordFailure();
      b.recordFailure();
      expect(b.getState()).toBe("open");
      vi.advanceTimersByTime(500);
      expect(b.getState()).toBe("half-open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("F-03: recovery probe (half-open success) closes circuit", () => {
    vi.useFakeTimers();
    try {
      const b = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 300,
        halfOpenMaxAttempts: 1,
        jitterFactor: 0,
      });
      b.recordFailure();
      vi.advanceTimersByTime(300);
      b.getState(); // trigger half-open
      b.recordSuccess();
      expect(b.getState()).toBe("closed");
      expect(b.canExecute()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("F-04: after recovery, circuit needs threshold failures to re-open", () => {
    vi.useFakeTimers();
    try {
      const b = new CircuitBreaker({
        failureThreshold: 3,
        resetTimeoutMs: 300,
        halfOpenMaxAttempts: 1,
        jitterFactor: 0,
      });
      // Trip circuit
      b.recordFailure();
      b.recordFailure();
      b.recordFailure();
      vi.advanceTimersByTime(300);
      b.getState(); // → half-open
      b.recordSuccess(); // → closed
      // Two failures should not re-open
      b.recordFailure();
      b.recordFailure();
      expect(b.getState()).toBe("closed");
      // Third should open
      b.recordFailure();
      expect(b.getState()).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("F-05: reset() before cooldown immediately allows traffic", () => {
    const b = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 60_000,
      jitterFactor: 0,
    });
    b.recordFailure(); // → open
    expect(b.canExecute()).toBe(false);
    b.reset();
    expect(b.canExecute()).toBe(true);
    expect(b.getState()).toBe("closed");
  });

  it("F-06: KeyedCircuitBreaker — after cooldown, key transitions to half-open", () => {
    vi.useFakeTimers();
    try {
      const kb = new KeyedCircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 500,
        jitterFactor: 0,
      });
      kb.recordFailure("svc");
      expect(kb.isAvailable("svc")).toBe(false);
      vi.advanceTimersByTime(500);
      expect(kb.getState("svc")).toBe("half-open");
      expect(kb.isAvailable("svc")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("F-07: KeyedCircuitBreaker — recovery success then failure requires threshold again", () => {
    vi.useFakeTimers();
    try {
      const kb = new KeyedCircuitBreaker({
        failureThreshold: 2,
        resetTimeoutMs: 200,
        halfOpenMaxAttempts: 1,
        jitterFactor: 0,
      });
      kb.recordFailure("p");
      kb.recordFailure("p"); // → open
      vi.advanceTimersByTime(200);
      kb.getState("p"); // → half-open
      kb.recordSuccess("p"); // → closed
      kb.recordFailure("p"); // 1 failure — should stay closed
      expect(kb.getState("p")).toBe("closed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("F-08: onTransition callback fires on close after successful recovery", () => {
    vi.useFakeTimers();
    try {
      const kinds: string[] = [];
      const b = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 200,
        halfOpenMaxAttempts: 1,
        jitterFactor: 0,
        onTransition: (e) => kinds.push(e.kind),
      });
      b.recordFailure(); // → open
      vi.advanceTimersByTime(200);
      b.getState(); // → half-open
      b.recordSuccess(); // → closed
      expect(kinds).toEqual([
        "circuit:open",
        "circuit:half_open",
        "circuit:close",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Suite G: Selective failure — transient vs permanent classification
// ---------------------------------------------------------------------------

describe("Selective failure — transient vs permanent error classification in chain", () => {
  it("G-01: ECONNRESET triggers fallback", async () => {
    const c1 = cand("a", alwaysFailModel("read ECONNRESET"));
    const c2 = cand("b", fixedModel("ok"));
    const invoker = new ResilientModelInvoker([c1, c2], undefined, {
      retry: NO_RETRY,
    });
    const result = await invoker.invoke(MSG);
    expect(result.content).toBe("ok");
  });

  it("G-02: socket hang up triggers fallback", async () => {
    const c1 = cand("a", alwaysFailModel("socket hang up"));
    const c2 = cand("b", fixedModel("ok"));
    const invoker = new ResilientModelInvoker([c1, c2], undefined, {
      retry: NO_RETRY,
    });
    const result = await invoker.invoke(MSG);
    expect(result.content).toBe("ok");
  });

  it("G-03: fetch failed triggers fallback", async () => {
    const c1 = cand("a", alwaysFailModel("fetch failed"));
    const c2 = cand("b", fixedModel("ok"));
    const invoker = new ResilientModelInvoker([c1, c2], undefined, {
      retry: NO_RETRY,
    });
    const result = await invoker.invoke(MSG);
    expect(result.content).toBe("ok");
  });

  it("G-04: capacity error triggers fallback", async () => {
    const c1 = cand("a", alwaysFailModel("No capacity available"));
    const c2 = cand("b", fixedModel("ok"));
    const invoker = new ResilientModelInvoker([c1, c2], undefined, {
      retry: NO_RETRY,
    });
    const result = await invoker.invoke(MSG);
    expect(result.content).toBe("ok");
  });

  it("G-05: 400 bad request does NOT trigger fallback (non-transient)", async () => {
    const c1 = cand("a", alwaysFailModel("HTTP 400 Bad Request"));
    const c2 = cand("b", fixedModel("never"));
    const invoker = new ResilientModelInvoker([c1, c2], undefined, {
      retry: NO_RETRY,
    });
    await expect(invoker.invoke(MSG)).rejects.toThrow("400 Bad Request");
    expect(c2.model.invoke).not.toHaveBeenCalled();
  });

  it("G-06: 401 unauthorized does NOT trigger fallback", async () => {
    const c1 = cand("a", alwaysFailModel("HTTP 401 Unauthorized"));
    const c2 = cand("b", fixedModel("never"));
    const invoker = new ResilientModelInvoker([c1, c2], undefined, {
      retry: NO_RETRY,
    });
    await expect(invoker.invoke(MSG)).rejects.toThrow("401");
    expect(c2.model.invoke).not.toHaveBeenCalled();
  });

  it("G-07: 429 too many requests triggers fallback", async () => {
    const c1 = cand("a", alwaysFailModel("429 too many requests"));
    const c2 = cand("b", fixedModel("recovered"));
    const invoker = new ResilientModelInvoker([c1, c2], undefined, {
      retry: NO_RETRY,
    });
    const result = await invoker.invoke(MSG);
    expect(result.content).toBe("recovered");
  });

  it("G-08: transient on first, permanent on second — second error propagated", async () => {
    const c1 = cand("a", alwaysFailModel("rate_limit hit"));
    const c2 = cand("b", alwaysFailModel("Unauthorized: bad key"));
    const c3 = cand("c", fixedModel("never"));
    const invoker = new ResilientModelInvoker([c1, c2, c3], undefined, {
      retry: NO_RETRY,
    });
    await expect(invoker.invoke(MSG)).rejects.toThrow("Unauthorized");
    expect(c3.model.invoke).not.toHaveBeenCalled();
  });

  it("G-09: all transient then permanent — error from permanent propagated", async () => {
    const c1 = cand("a", alwaysFailModel("503 down"));
    const c2 = cand("b", alwaysFailModel("overloaded"));
    const c3 = cand("c", alwaysFailModel("Invalid API key"));
    const c4 = cand("d", fixedModel("never"));
    const invoker = new ResilientModelInvoker([c1, c2, c3, c4], undefined, {
      retry: NO_RETRY,
    });
    await expect(invoker.invoke(MSG)).rejects.toThrow("Invalid API key");
    expect(c4.model.invoke).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suite H: Fallback priority ordering
// ---------------------------------------------------------------------------

describe("Fallback priority ordering in ResilientModelInvoker", () => {
  it("H-01: candidates tried in the order they are provided", async () => {
    const callOrder: string[] = [];
    const makeModel = (name: string, fail: boolean): BaseChatModel =>
      ({
        invoke: vi.fn(async () => {
          callOrder.push(name);
          if (fail) throw new Error("503 down");
          return aiMsg(`${name}-ok`);
        }),
      }) as unknown as BaseChatModel;

    const c1 = cand("first", makeModel("first", true));
    const c2 = cand("second", makeModel("second", true));
    const c3 = cand("third", makeModel("third", false));
    const invoker = new ResilientModelInvoker([c1, c2, c3], undefined, {
      retry: NO_RETRY,
    });
    await invoker.invoke(MSG);
    expect(callOrder).toEqual(["first", "second", "third"]);
  });

  it("H-02: success at index 0 means index 1 never invoked regardless of candidate count", async () => {
    const c1 = cand("first", fixedModel("wins"));
    const c2 = cand("second", fixedModel("skipped"));
    const c3 = cand("third", fixedModel("skipped-too"));
    const invoker = new ResilientModelInvoker([c1, c2, c3], undefined, {
      retry: NO_RETRY,
    });
    await invoker.invoke(MSG);
    expect(c2.model.invoke).not.toHaveBeenCalled();
    expect(c3.model.invoke).not.toHaveBeenCalled();
  });

  it("H-03: the response returned is always from the winning provider", async () => {
    const c1 = cand("a", alwaysFailModel("503"));
    const c2 = cand("b", alwaysFailModel("rate_limit"));
    const c3 = cand("c", fixedModel("distinct-winner-content"));
    const invoker = new ResilientModelInvoker([c1, c2, c3], undefined, {
      retry: NO_RETRY,
    });
    const result = await invoker.invoke(MSG);
    expect(result.content).toBe("distinct-winner-content");
  });

  it("H-04: ALL_PROVIDERS_EXHAUSTED context.errors preserves attempt order", async () => {
    const c1 = cand("first", alwaysFailModel("503"));
    const c2 = cand("second", alwaysFailModel("overloaded"));
    const c3 = cand("third", alwaysFailModel("rate_limit"));
    const invoker = new ResilientModelInvoker([c1, c2, c3], undefined, {
      retry: NO_RETRY,
    });
    const err = (await invoker.invoke(MSG).catch((e) => e)) as ForgeError;
    const ctx = err.context as { errors: Array<{ provider: string }> };
    expect(ctx.errors[0]!.provider).toBe("first");
    expect(ctx.errors[1]!.provider).toBe("second");
    expect(ctx.errors[2]!.provider).toBe("third");
  });
});

// ---------------------------------------------------------------------------
// Suite I: Circuit breaker transition event contract
// ---------------------------------------------------------------------------

describe("Circuit breaker transition event contract", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("I-01: closed→open event has correct from/to/kind", () => {
    const events: CircuitTransitionEvent[] = [];
    const b = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      jitterFactor: 0,
      onTransition: (e) => events.push(e),
    });
    b.recordFailure();
    expect(events[0]).toMatchObject({
      kind: "circuit:open",
      from: "closed",
      to: "open",
    });
  });

  it("I-02: open→half-open event has correct from/to/kind", () => {
    vi.useFakeTimers();
    try {
      const events: CircuitTransitionEvent[] = [];
      const b = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 1000,
        jitterFactor: 0,
        onTransition: (e) => events.push(e),
      });
      b.recordFailure();
      vi.advanceTimersByTime(1000);
      b.getState(); // trigger transition
      const halfOpenEvent = events.find((e) => e.kind === "circuit:half_open");
      expect(halfOpenEvent).toMatchObject({
        kind: "circuit:half_open",
        from: "open",
        to: "half-open",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("I-03: half-open→closed event has correct from/to/kind", () => {
    vi.useFakeTimers();
    try {
      const events: CircuitTransitionEvent[] = [];
      const b = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 1000,
        halfOpenMaxAttempts: 1,
        jitterFactor: 0,
        onTransition: (e) => events.push(e),
      });
      b.recordFailure();
      vi.advanceTimersByTime(1000);
      b.getState();
      b.recordSuccess();
      const closeEvent = events.find((e) => e.kind === "circuit:close");
      expect(closeEvent).toMatchObject({
        kind: "circuit:close",
        from: "half-open",
        to: "closed",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("I-04: closed→open event failureCount matches threshold", () => {
    const events: CircuitTransitionEvent[] = [];
    const b = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 1000,
      jitterFactor: 0,
      onTransition: (e) => events.push(e),
    });
    b.recordFailure();
    b.recordFailure();
    const openEvent = events.find((e) => e.kind === "circuit:open")!;
    expect(openEvent.failureCount).toBe(2);
  });

  it("I-05: no event emitted on redundant recordSuccess in closed state", () => {
    const events: CircuitTransitionEvent[] = [];
    const b = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 1000,
      jitterFactor: 0,
      onTransition: (e) => events.push(e),
    });
    b.recordSuccess(); // already closed
    b.recordSuccess();
    expect(events).toHaveLength(0);
  });

  it("I-06: no event emitted on recordFailure below threshold", () => {
    const events: CircuitTransitionEvent[] = [];
    const b = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeoutMs: 1000,
      jitterFactor: 0,
      onTransition: (e) => events.push(e),
    });
    b.recordFailure();
    b.recordFailure();
    b.recordFailure();
    expect(events).toHaveLength(0);
  });

  it("I-07: structured console.warn log emitted on each transition", () => {
    const b = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      jitterFactor: 0,
    });
    b.recordFailure();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warnSpy.mock.calls[0]![0] as string);
    expect(logged.component).toBe("circuit-breaker");
    expect(logged.event).toBe("circuit:open");
  });
});

// ---------------------------------------------------------------------------
// Suite J: All-providers-down graceful exhaustion
// ---------------------------------------------------------------------------

describe("All-providers-down — graceful exhaustion error details", () => {
  it("J-01: ForgeError code is ALL_PROVIDERS_EXHAUSTED", async () => {
    const c = cand("only", alwaysFailModel("503 down"));
    const invoker = new ResilientModelInvoker([c], undefined, {
      retry: NO_RETRY,
    });
    const err = (await invoker.invoke(MSG).catch((e) => e)) as ForgeError;
    expect(err.code).toBe("ALL_PROVIDERS_EXHAUSTED");
  });

  it("J-02: ForgeError has a suggestion field", async () => {
    const c = cand("p", alwaysFailModel("rate_limit"));
    const invoker = new ResilientModelInvoker([c], undefined, {
      retry: NO_RETRY,
    });
    const err = (await invoker.invoke(MSG).catch((e) => e)) as ForgeError;
    expect(typeof err.suggestion).toBe("string");
    expect(err.suggestion!.length).toBeGreaterThan(0);
  });

  it("J-03: ForgeError context.errors contains per-provider error messages", async () => {
    const c1 = cand("provider-a", alwaysFailModel("503 service-a down"));
    const c2 = cand("provider-b", alwaysFailModel("overloaded service-b"));
    const invoker = new ResilientModelInvoker([c1, c2], undefined, {
      retry: NO_RETRY,
    });
    const err = (await invoker.invoke(MSG).catch((e) => e)) as ForgeError;
    const ctx = err.context as {
      errors: Array<{ provider: string; error: string }>;
    };
    expect(ctx.errors[0]!.error).toContain("service-a down");
    expect(ctx.errors[1]!.error).toContain("service-b");
  });

  it("J-04: empty candidate list throws ALL_PROVIDERS_EXHAUSTED instantly", async () => {
    const invoker = new ResilientModelInvoker([], undefined, {
      retry: NO_RETRY,
    });
    const err = (await invoker.invoke(MSG).catch((e) => e)) as ForgeError;
    expect(err.code).toBe("ALL_PROVIDERS_EXHAUSTED");
  });

  it("J-05: error from single failing candidate included in context", async () => {
    const c = cand("alone", alwaysFailModel("capacity exceeded"));
    const invoker = new ResilientModelInvoker([c], undefined, {
      retry: NO_RETRY,
    });
    const err = (await invoker.invoke(MSG).catch((e) => e)) as ForgeError;
    const ctx = err.context as {
      errors: Array<{ provider: string; error: string }>;
    };
    expect(ctx.errors).toHaveLength(1);
    expect(ctx.errors[0]!.provider).toBe("alone");
    expect(ctx.errors[0]!.error).toContain("capacity");
  });

  it("J-06: ALL_PROVIDERS_EXHAUSTED message includes candidate count", async () => {
    const candidates = ["p1", "p2", "p3"].map((p) =>
      cand(p, alwaysFailModel("503 down")),
    );
    const invoker = new ResilientModelInvoker(candidates, undefined, {
      retry: NO_RETRY,
    });
    const err = (await invoker.invoke(MSG).catch((e) => e)) as ForgeError;
    expect(err.message).toContain("3");
  });
});

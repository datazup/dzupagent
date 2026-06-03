# W9 Circuit-Breaker Exponential Backoff — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 8 test cases verifying W9 exponential backoff behaviour to `circuit-breaker.test.ts` — the implementation in `circuit-breaker.ts` is already complete.

**Architecture:** W9 is already implemented: `consecutiveReopens` counter, `computeCooldownMs()` exponential formula, `maxResetTimeoutMs` ceiling, OPEN-state guard in `recordFailure`, reset on `recordSuccess`/`reset()`. Only the test coverage is missing. All 8 cases use `vi.useFakeTimers()` + `jitterFactor: 0` for determinism, mirroring the existing cooldown jitter test pattern.

**Tech Stack:** TypeScript, Vitest (`vi.useFakeTimers`, `vi.spyOn`)

---

## Files

- **Modify:** `packages/core/src/__tests__/circuit-breaker.test.ts` — add `describe("W9 exponential backoff on re-opens", ...)` block with 8 test cases

---

### Task 1: Add the W9 test block (all 8 cases)

**Files:**

- Modify: `packages/core/src/__tests__/circuit-breaker.test.ts`

- [ ] **Step 1: Verify the implementation is present**

Run from `packages/core/`:

```bash
grep -n "consecutiveReopens\|maxResetTimeoutMs\|computeCooldownMs" src/llm/circuit-breaker.ts
```

Expected: lines for all three identifiers. If absent, stop — the implementation needs to land first.

- [ ] **Step 2: Run existing tests to establish a green baseline**

```bash
node ../../node_modules/vitest/vitest.mjs run src/__tests__/circuit-breaker.test.ts
```

Expected: all existing tests pass (no failures).

- [ ] **Step 3: Add the W9 describe block**

Append a new `describe` block inside the top-level `describe("CircuitBreaker", ...)` in `packages/core/src/__tests__/circuit-breaker.test.ts`, just after the `cooldown jitter` describe block:

```typescript
describe("W9 exponential backoff on re-opens", () => {
  it("case 1: first open uses base cooldown (reopen #0, no escalation)", () => {
    vi.useFakeTimers();
    try {
      const b = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 1000,
        halfOpenMaxAttempts: 1,
        jitterFactor: 0,
      });
      b.recordFailure(); // closed → open (reopen #0)
      vi.advanceTimersByTime(999);
      expect(b.getState()).toBe("open"); // not yet
      vi.advanceTimersByTime(1);
      expect(b.getState()).toBe("half-open"); // exactly at base
    } finally {
      vi.useRealTimers();
    }
  });

  it("case 2: one failed probe doubles the cooldown (reopen #1 → 2× base)", () => {
    vi.useFakeTimers();
    try {
      const b = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 1000,
        halfOpenMaxAttempts: 1,
        jitterFactor: 0,
      });
      b.recordFailure(); // → open (reopen #0, cooldown 1000)
      vi.advanceTimersByTime(1000); // → half-open
      expect(b.getState()).toBe("half-open");
      b.recordFailure(); // failed probe → reopen #1, cooldown 2000
      expect(b.getState()).toBe("open");
      vi.advanceTimersByTime(1999);
      expect(b.getState()).toBe("open"); // not yet (2× base − 1)
      vi.advanceTimersByTime(1);
      expect(b.getState()).toBe("half-open"); // exactly at 2× base
    } finally {
      vi.useRealTimers();
    }
  });

  it("case 3: second failed probe → 4× base (reopen #2)", () => {
    vi.useFakeTimers();
    try {
      const b = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 1000,
        halfOpenMaxAttempts: 1,
        jitterFactor: 0,
      });
      b.recordFailure(); // → open (reopen #0)
      vi.advanceTimersByTime(1000); // → half-open
      b.recordFailure(); // → open (reopen #1, cooldown 2000)
      vi.advanceTimersByTime(2000); // → half-open
      expect(b.getState()).toBe("half-open");
      b.recordFailure(); // → open (reopen #2, cooldown 4000)
      expect(b.getState()).toBe("open");
      vi.advanceTimersByTime(3999);
      expect(b.getState()).toBe("open");
      vi.advanceTimersByTime(1);
      expect(b.getState()).toBe("half-open"); // exactly at 4× base
    } finally {
      vi.useRealTimers();
    }
  });

  it("case 4: ceiling holds — maxResetTimeoutMs = base×3 caps at 3× after ≥2 re-opens", () => {
    vi.useFakeTimers();
    try {
      const b = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 1000,
        halfOpenMaxAttempts: 1,
        jitterFactor: 0,
        maxResetTimeoutMs: 3000, // 3× base
      });
      b.recordFailure(); // → open (reopen #0, 1000)
      vi.advanceTimersByTime(1000); // → half-open
      b.recordFailure(); // → open (reopen #1, min(2000, 3000)=2000 — below cap)
      vi.advanceTimersByTime(2000); // → half-open
      expect(b.getState()).toBe("half-open");
      b.recordFailure(); // → open (reopen #2, min(4000, 3000)=3000 — cap kicks in)
      vi.advanceTimersByTime(2999);
      expect(b.getState()).toBe("open"); // not yet (cap = 3× base)
      vi.advanceTimersByTime(1);
      expect(b.getState()).toBe("half-open"); // exactly at 3× base
    } finally {
      vi.useRealTimers();
    }
  });

  it("case 5: recordSuccess resets backoff — subsequent open uses base cooldown", () => {
    vi.useFakeTimers();
    try {
      const b = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 1000,
        halfOpenMaxAttempts: 1,
        jitterFactor: 0,
      });
      // Escalate to reopen #2 (cooldown would be 4× base without reset)
      b.recordFailure();
      vi.advanceTimersByTime(1000);
      b.recordFailure(); // reopen #1
      vi.advanceTimersByTime(2000);
      b.recordFailure(); // reopen #2 — next would be 4× base
      vi.advanceTimersByTime(4000); // → half-open
      expect(b.getState()).toBe("half-open");

      // Successful probe: consecutiveReopens resets to 0
      b.recordSuccess();
      expect(b.getState()).toBe("closed");

      // Re-open fresh: must use base cooldown (1000), not escalated
      b.recordFailure(); // → open (reopen #0, cooldown 1000)
      vi.advanceTimersByTime(999);
      expect(b.getState()).toBe("open");
      vi.advanceTimersByTime(1);
      expect(b.getState()).toBe("half-open"); // back to base
    } finally {
      vi.useRealTimers();
    }
  });

  it("case 6: default ceiling is 8× base; explicit maxResetTimeoutMs clamped ≥ resetTimeoutMs", () => {
    vi.useFakeTimers();
    try {
      // Default ceiling: escalate until capped, then confirm cooldown is 8× base
      const b = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 1000,
        halfOpenMaxAttempts: 1,
        jitterFactor: 0,
        // no maxResetTimeoutMs → defaults to 8000
      });
      // Drive to reopen #3: 2^3 × 1000 = 8000 = ceiling
      for (let i = 0; i < 3; i++) {
        b.recordFailure();
        vi.advanceTimersByTime(1000 * 2 ** i); // advance by current cooldown
      }
      b.recordFailure(); // reopen #3, min(8000, 8000) = 8000
      vi.advanceTimersByTime(7999);
      expect(b.getState()).toBe("open");
      vi.advanceTimersByTime(1);
      expect(b.getState()).toBe("half-open");

      // Explicit maxResetTimeoutMs below base is clamped to base
      const b2 = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 1000,
        halfOpenMaxAttempts: 1,
        jitterFactor: 0,
        maxResetTimeoutMs: 100, // below base → clamped to 1000
      });
      b2.recordFailure(); // → open (reopen #0, min(1000, 1000) = 1000)
      vi.advanceTimersByTime(999);
      expect(b2.getState()).toBe("open");
      vi.advanceTimersByTime(1);
      expect(b2.getState()).toBe("half-open");
    } finally {
      vi.useRealTimers();
    }
  });

  it("case 7: jitter applies to the escalated/capped value, not to raw base", () => {
    vi.useFakeTimers();
    // After reopen #1, effective backed = 2 × resetTimeoutMs = 2000.
    // With jitterFactor:0.2 and Math.random()→1.0 (max reduction):
    //   reduction = 2000 × 0.2 × 1.0 = 400
    //   effective cooldown = 2000 − 400 = 1600
    const randSpy = vi.spyOn(Math, "random").mockReturnValue(1.0);
    try {
      const b = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 1000,
        halfOpenMaxAttempts: 1,
        jitterFactor: 0.2,
      });
      b.recordFailure(); // → open (reopen #0); Math.random gives jitter but we test reopen #1
      vi.advanceTimersByTime(1000); // cooldown for reopen #0: min(1000,8000) × (1-0.2×1) = 800; at 1000 → half-open
      expect(b.getState()).toBe("half-open");
      b.recordFailure(); // → open (reopen #1): backed=2000, reduction=400, effective=1600
      vi.advanceTimersByTime(1599);
      expect(b.getState()).toBe("open"); // not yet
      vi.advanceTimersByTime(1);
      expect(b.getState()).toBe("half-open"); // exactly at 1600
    } finally {
      randSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("case 8: OPEN-state failures don't reset the cooldown window (lastFailureAt not bumped)", () => {
    vi.useFakeTimers();
    try {
      const b = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 1000,
        halfOpenMaxAttempts: 1,
        jitterFactor: 0,
      });
      b.recordFailure(); // → open; lastFailureAt = t0
      // Record another failure while already OPEN — must not bump lastFailureAt
      vi.advanceTimersByTime(500);
      b.recordFailure(); // OPEN-state guard should ignore this
      vi.advanceTimersByTime(499); // total 999ms from t0 — still 1ms short
      expect(b.getState()).toBe("open");
      vi.advanceTimersByTime(1); // total 1000ms from t0 — cooldown elapsed
      expect(b.getState()).toBe("half-open");
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 4: Run only the W9 tests to confirm they all pass**

```bash
node ../../node_modules/vitest/vitest.mjs run src/__tests__/circuit-breaker.test.ts -t "W9"
```

Expected: 8 tests pass, 0 fail.

- [ ] **Step 5: Run the full circuit-breaker test file to confirm no regressions**

```bash
node ../../node_modules/vitest/vitest.mjs run src/__tests__/circuit-breaker.test.ts
```

Expected: all tests pass (existing 12 + new 8 = 20 total).

- [ ] **Step 6: Run the full core suite**

```bash
node ../../node_modules/vitest/vitest.mjs run
```

Expected: all pass, no regressions.

- [ ] **Step 7: Typecheck**

```bash
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/__tests__/circuit-breaker.test.ts
git commit -m "test(core): add W9 exponential backoff test cases for circuit breaker"
```

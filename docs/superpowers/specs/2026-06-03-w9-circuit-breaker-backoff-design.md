# W9 — Exponential Backoff on Circuit Re-Opens (Design)

**Date:** 2026-06-03
**Status:** Approved design — ready for implementation plan
**Track:** Orchestration runtime hardening (Tier 2)
**Roadmap:** `out/orchestration-reeval-and-improvement-roadmap-2026-06-02.md` §2.2 W9, §3 Tier 2
**Target file:** `packages/core/src/llm/circuit-breaker.ts` (281 lines)
**Test file:** `packages/core/src/__tests__/circuit-breaker.test.ts`

---

## 1. Problem

`CircuitBreaker` uses a fixed `resetTimeoutMs` for **every** OPEN window
(`circuit-breaker.ts:104` sets `currentCooldownMs = resetTimeoutMs`; `:127`
re-derives it via `computeCooldownMs()`, which only ever applies downward
jitter). A provider that stays unhealthy is therefore probed on a fixed
cadence forever: `open → half-open → probe fails → open` in lock-step every
~30 s. This thrashes the recovering provider and wastes calls. (Roadmap W9:
"circuit breaker doesn't back off on repeated opens → thrash.")

## 2. Goal & non-goals

**Goal:** When the circuit **re-opens repeatedly** (a failed HALF_OPEN probe),
grow the OPEN cooldown exponentially, capped by an absolute ceiling. A
successful recovery resets the escalation.

**Non-goals:**

- Persisting backoff state across process restarts. The breaker's existing
  `failureCount` / `lastFailureAt` / state are all in-memory; W9's counter is
  too. Durable breaker state is out of scope (not in the roadmap).
- Changing the failure-threshold, half-open-attempts, jitter, transition-event,
  or `KeyedCircuitBreaker` behaviour. W9 is additive.

## 3. Approach — per-consecutive-reopen escalation, reset on recovery

A consecutive-reopen counter drives an exponential multiplier on the base
cooldown, capped by a new absolute `maxResetTimeoutMs`. The initial
`closed → open` is reopen #0 (base cooldown); each failed probe escalates;
recovery resets to 0.

### 3.1 Config — one new optional field

Add to `CircuitBreakerConfig`:

```ts
  /**
   * Absolute ceiling (ms) for the exponential re-open backoff
   * (default: 8 × resetTimeoutMs). Each consecutive HALF_OPEN→OPEN re-open
   * doubles the effective cooldown; this caps the growth so a persistently
   * unhealthy provider is not probed unboundedly often. Always clamped to be
   * ≥ resetTimeoutMs. Jitter (if any) applies to the capped value.
   */
  maxResetTimeoutMs?: number;
```

Resolved in the constructor **after** the `cooldownMs`-alias handling, so the
ceiling tracks the effective base:

```ts
merged.maxResetTimeoutMs = Math.max(
  merged.maxResetTimeoutMs ?? merged.resetTimeoutMs * 8,
  merged.resetTimeoutMs
);
```

`DEFAULT_CONFIG` does **not** need the field (it is derived from
`resetTimeoutMs` in the constructor), but adding `maxResetTimeoutMs: 240_000`
to `DEFAULT_CONFIG` is acceptable as documentation of the default; the
constructor's `?? resetTimeoutMs * 8` is the authoritative default so behaviour
stays correct if a caller overrides `resetTimeoutMs` without
`maxResetTimeoutMs`. **Decision: keep the default in the constructor only**
(derive from the effective base) so it scales with a custom `resetTimeoutMs`.

### 3.2 State — one new field

```ts
  /** Consecutive HALF_OPEN→OPEN re-opens; drives exponential cooldown (W9). */
  private consecutiveReopens = 0;
```

### 3.3 `computeCooldownMs()` — backoff before jitter

```ts
  private computeCooldownMs(): number {
    const { resetTimeoutMs, jitterFactor = 0, maxResetTimeoutMs } = this.config;
    // Exponential backoff: each consecutive re-open doubles the base, capped.
    const ceiling = maxResetTimeoutMs ?? resetTimeoutMs;
    const backed = Math.min(
      resetTimeoutMs * 2 ** this.consecutiveReopens,
      ceiling,
    );
    if (jitterFactor <= 0) return backed;
    const reduction = backed * jitterFactor * Math.random();
    return Math.max(0, backed - reduction);
  }
```

`maxResetTimeoutMs` is always set by the constructor; the `?? resetTimeoutMs`
fallback is defensive only. Note `2 ** consecutiveReopens` is bounded in
practice because `Math.min` caps it; even a large exponent is harmless (it just
clamps to the ceiling). The existing jitter contract (downward-only, within
`[value*(1-jitterFactor), value]`) is preserved against the capped value.

### 3.4 Counter transitions

Four touch points, all in existing methods:

1. **Failed probe → escalate** (`recordFailure`, the `state === "half-open"`
   branch at `:189-192`): increment **before** `transitionTo("open")` so the
   cooldown computed inside the transition reflects the new count.

   ```ts
   if (this.state === "half-open") {
     // Failed probe — escalate the next OPEN cooldown (W9), then re-open.
     this.consecutiveReopens++;
     this.transitionTo("open");
     return;
   }
   ```

2. **Initial open does NOT escalate** (`recordFailure`, the threshold branch at
   `:195-197`): leave unchanged. `consecutiveReopens` stays 0, so a fresh
   `closed → open` uses the base cooldown (reopen #0).

3. **Recovery resets** (`recordSuccess` at `:178-182` and `reset()` at
   `:214-220`): set `this.consecutiveReopens = 0` in both.

4. **Guard OPEN-state failures** (`recordFailure`, at the top of the method,
   before any other branch): when the circuit is already OPEN, return early
   without bumping `lastFailureAt` or `failureCount`. This prevents
   post-open failures (e.g. MCP heartbeat on an unconditional `setInterval`,
   or in-flight concurrent calls) from perpetually resetting the cooldown
   clock and starving the half-open probe — which would freeze
   `consecutiveReopens` at its current value and defeat W9's escalation.

   ```ts
   if (this.state === "open") {
     return; // already open — don't reset the cooldown window
   }
   ```

   Add this guard as the **first branch** in `recordFailure`, before the
   `half-open` and threshold branches. This is a pre-existing design gap that
   W9 is the first feature to depend on (escalation can only happen in the
   half-open branch, so if the half-open transition is starved, the multiplier
   never increments). Option A (early return) is preferred over tracking a
   separate open-transition timestamp because it also stops `failureCount`
   from accumulating meaninglessly while OPEN.

### 3.5 Semantics

Base `resetTimeoutMs = 30s`, default ceiling `maxResetTimeoutMs = 240s`:

| Event                          | consecutiveReopens | effective cooldown |
| ------------------------------ | ------------------ | ------------------ |
| closed → open (fresh failures) | 0                  | 30s                |
| probe fails → re-open          | 1                  | 60s                |
| probe fails → re-open          | 2                  | 120s               |
| probe fails → re-open          | 3                  | 240s (capped)      |
| probe fails → re-open          | 4+                 | 240s (cap holds)   |
| recordSuccess → closed         | 0 (reset)          | back to 30s        |

Jitter, if configured, shortens each value by up to `jitterFactor`.

### 3.6 `KeyedCircuitBreaker`

No change. Backoff state lives per `CircuitBreaker` instance, so each key
escalates and recovers independently automatically.

## 4. Testing

Extend `circuit-breaker.test.ts`, mirroring its `vi.useFakeTimers()` cooldown
tests and `jitterFactor: 0` determinism. New cases:

1. **First open uses base cooldown** — open via threshold, advance `< base` →
   still open; advance to `base` → `getState()` is `half-open` (reopen #0,
   unchanged from today; guards against regression).
2. **One failed probe doubles the cooldown** — open, advance to `base`
   (half-open), `recordFailure()` (re-open), advance to `base + ε` → still
   `open`; advance to `2 × base` → `half-open`.
3. **Second failed probe → 4× base** — repeat the probe-fail once more; assert
   the window is `4 × base`.
4. **Ceiling holds** — with `maxResetTimeoutMs = base * 3`, after ≥2 re-opens
   the cooldown is capped at `3 × base` (not `4 × base`). Use `base * 3` not
   `base * 2`: after one re-open, `2^1 × base = 2 × base`, which equals the
   `base * 2` ceiling by coincidence — a broken `Math.min` would still pass.
   With `base * 3`: reopen#1 = `min(2×, 3×) = 2×` (below cap; verifies
   uncapped path); reopen#2 = `min(4×, 3×) = 3×` (cap kicks in; advance to
   `3 × base` → half-open; advance to `base + ε` → still open).
5. **recordSuccess resets backoff** — escalate via a couple of re-opens, then
   drive `closed` via a successful probe (`canExecute()` in half-open →
   `recordSuccess()`), re-open fresh, and assert the cooldown is back to
   `base` (not the escalated value).
6. **Default ceiling = 8× base when unset**; an explicit `maxResetTimeoutMs`
   is honored and clamped to ≥ `resetTimeoutMs` (passing a value below base
   yields an effective ceiling of base).
7. **Jitter applies to the escalated/capped value** — configure
   `jitterFactor: 0.2` and mock `Math.random` to return `1.0` (maximum
   reduction). After one failed probe (`consecutiveReopens = 1`, effective
   base = `2 × resetTimeoutMs`), assert the effective cooldown equals
   `2 × resetTimeoutMs × (1 − 0.2) = 1.6 × resetTimeoutMs`. This catches a
   regression where jitter is applied to the raw `resetTimeoutMs` before
   the backoff multiplier instead of to the capped value.
8. **OPEN-state failures don't reset the cooldown window** — open the breaker,
   immediately call `recordFailure()` once more while state is OPEN, then
   advance time by `base − 1 ms` and assert state is still `open` (the extra
   failure must not have bumped `lastFailureAt`). Then advance to `base` and
   assert state is `half-open`.

## 5. Quality gates

```bash
# from packages/core (no .bin/turbo; use node entrypoints):
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node ../../node_modules/vitest/vitest.mjs run src/__tests__/circuit-breaker.test.ts
# then the core suite
node ../../node_modules/vitest/vitest.mjs run
```

All must pass with no regressions in the existing breaker tests.

## 6. Scope honesty

- **Delivers:** in-memory exponential backoff on consecutive re-opens with an
  absolute ceiling and recovery reset; one new optional config field; ~3
  additive touch points in existing methods.
- **Does not deliver:** persistence of backoff state across restarts; any
  change to threshold/jitter/half-open/event semantics.
- **Files touched:** `circuit-breaker.ts` (config field + 1 state field +
  `computeCooldownMs` + 4 touch points: the 3 counter transitions above plus
  the new OPEN-state early-return guard in `recordFailure`) and its test file.
  No public-API break — the new field is optional and defaulted.
- **Pre-existing gap addressed:** `recordFailure` previously bumped
  `lastFailureAt` unconditionally even while OPEN, which would have starved the
  half-open probe and frozen W9's escalation counter. The Option A guard (§3.4
  touch point 4) closes this. Test case 8 verifies it.

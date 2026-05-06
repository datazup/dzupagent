# Agent Audit — Quick Fixes (≤4h each, mechanical)

These tasks are deterministic and low-risk. Each is fully scoped — execute as atomic commits.

---

## QF-AGT-01 — Clear LLM invoke timeout timer on success path
**ID:** QF-AGT-01
**Target agent:** dzupagent-core-dev
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/llm/invoke.ts` (function `invokeWithTimeout`, line 157+)

**Current state:** `Promise.race([model.invoke(messages), new Promise((_, reject) => setTimeout(...)])`. On success, the setTimeout closure remains pending, holding `reject` and string references until the timer fires. Long-lived workers leak one timer per LLM call.

**Target state:** Capture the timer handle; clear it in a `finally` block on the resolved branch.

```ts
let timer: ReturnType<typeof setTimeout> | undefined
try {
  const response = await Promise.race([
    model.invoke(messages),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`LLM call timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
    }),
  ])
  // ...
  return response
} finally {
  if (timer) clearTimeout(timer)
}
```

Apply within the per-attempt try/catch so it works for both success and retry paths.

**Validation:**
- `yarn workspace @dzupagent/core test --filter invoke`
- New test: 100 successful invocations leave 0 active timers (use vitest fake timers + `vi.getTimerCount()`).

---

## QF-AGT-02 — Add jitter to circuit-breaker open→half-open cooldown
**ID:** QF-AGT-02
**Target agent:** dzupagent-core-dev
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/llm/circuit-breaker.ts` (line 65, `canExecute()` and line 105 `getState()`)

**Current state:** Cooldown comparison is `Date.now() - this.lastFailureAt >= this.config.resetTimeoutMs`. No jitter. Multi-process deployments thundering-herd on transition.

**Target state:** Apply equal-jitter via a per-instance random multiplier in [0.85, 1.15]. Cache the jittered deadline at the time the circuit opens, do not recompute.

```ts
private jitteredResetMs = 0
recordFailure(): void {
  // ...
  if (this.state === 'open' || (... reaches threshold)) {
    const jitter = 0.85 + Math.random() * 0.30  // [0.85, 1.15]
    this.jitteredResetMs = Math.round(this.config.resetTimeoutMs * jitter)
    this.state = 'open'
  }
}
// in canExecute() open case:
if (elapsed >= this.jitteredResetMs) { ... }
```

**Validation:**
- `yarn workspace @dzupagent/core test --filter circuit-breaker`
- New test: 100 breakers tripping at the same Date.now() show stddev > 1500ms in their half-open transition timestamps.

---

## QF-AGT-03 — Document IterationBudget.fork() lifecycle expectation
**ID:** QF-AGT-03
**Target agent:** dzupagent-agent-dev
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/guardrails/iteration-budget.ts:73`

**Current state:** `fork()` shares Sets with parent without comment about lifecycle.

**Target state:** Add JSDoc explaining: shared state by design; expected to be disposed with the parent run; fork is NOT meant for indefinite reuse across many child runs. If a user explicitly requests cleanup semantics, add a `dispose()` method that clears child-only entries.

**Validation:**
- `yarn lint`
- TypeDoc rebuild succeeds.

---

## QF-AGT-04 — Cancel approval gate timer on settled
**ID:** QF-AGT-04
**Target agent:** dzupagent-agent-dev
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/approval/approval-gate.ts` (around line 110-160)

**Current state:** Approval-gate `Promise` cleanup function clears `timeoutHandle` but only inside the resolve closure path. Cross-check that all four resolve paths (granted / rejected / cancelled / timeout) call `cleanup()`, and that the timer handle is `.unref()`'d so it does not prevent process exit when the run is abandoned.

**Target state:** Add `.unref()` to `setTimeout` return on the timeout handle. Confirm all four resolve paths invoke `cleanup()` (audit walk through `unsubGrant` / `unsubReject` / `onAbort` / timeout callback).

**Validation:**
- `yarn workspace @dzupagent/agent test --filter approval`
- Manual: spawn an agent with approval-required tool, abandon the process; verify Node exits within 200ms (no hanging timer).

---

## QF-AGT-05 — Fix tiktoken counter to use anthropic tokenizer for Claude
**ID:** QF-AGT-05
**Target agent:** dzupagent-core-dev
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/context/src/tiktoken-counter.ts:46`

**Current state:** `model && model.startsWith('gpt')` — for Claude, falls through to `cl100k_base`.

**Target state:**
1. Detect `model.startsWith('claude')`.
2. Try `createRequire('@anthropic-ai/tokenizer')` (already an optional peer of core).
3. Fallback to `cl100k_base` only as last resort.

Or: replace this counter with a call into the existing `defaultTokenizerRegistry` from `@dzupagent/core` (preferred — single source of truth).

**Validation:**
- `yarn workspace @dzupagent/context test`
- New vitest: `count(text, 'claude-sonnet-4-6')` for 5 prompts is within 2% of `@anthropic-ai/tokenizer` ground truth.

---

## QF-AGT-06 — Emit approval:timed_out event distinct from approval:cancelled
**ID:** QF-AGT-06
**Target agent:** dzupagent-agent-dev
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/approval/approval-gate.ts:110`
- Event union in `@dzupagent/core/events/event-types.ts` (locate)

**Current state:** Timeout resolves to `'cancelled'` and emits `approval:cancelled`. Same event for caller-aborted and timeout-reached.

**Target state:**
1. Add `approval:timed_out` to the event union: `{type, runId, contactId, timeoutMs}`.
2. Emit it on timeout path; keep `approval:cancelled` for `signal.aborted`.
3. Add tests.

**Validation:**
- `yarn workspace @dzupagent/agent test`
- Event union typecheck: `yarn typecheck` clean.

---

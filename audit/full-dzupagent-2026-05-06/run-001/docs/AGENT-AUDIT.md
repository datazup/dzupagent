# Agent Pattern Audit — dzupagent

**Audit date:** 2026-05-06
**Scope:** AI agent implementation patterns only (tool loops, memory, context, guardrails, orchestration, LLM integration, codegen agent patterns).
**Reviewer:** principal architect, framework specialty.
**Comparators:** LangGraph (StateGraph + Checkpointer), CrewAI (role-based crews), AutoGen (multi-agent group chat), Claude Agent SDK (`query()` + tool use), Codex SDK (Threads + Sandbox), Hermes Agent (prompt caching pattern).

---

## Executive Summary

DzupAgent is an unusually mature, opinionated agent framework. The tool loop, stuck detector, model registry circuit breaker, durable approval gate, audit log, prompt-cache injection, content scanners, and parallel-tool-governance parity are at or above the level of the best-known OSS frameworks. The code shows the marks of multiple disciplined audit/refactor passes (RF-08..RF-13, MC-01..MC-10, AGENT-108/AGENT-112).

The remaining issues are largely at the seams between subsystems rather than inside any one of them:

1. **Cross-tenant learning leak (Critical)** — `AdapterLearningLoop` aggregates execution data globally by `providerId`. No `tenantId` or scope on `ExecutionRecord` / `ProviderProfile` / `LearningStore`. Tenant A's failure patterns directly bias routing for tenant B. Confirms SEC-02 from the 2026-05-05 audit memory note as still open.
2. **Approval webhook unsigned (High)** — `notifyWebhook` POSTs the run plan to a third-party URL with no HMAC, no timestamp, no replay protection. Anyone who learns the webhook URL can forge approval requests at the consumer side. The receiver cannot authenticate the request as coming from the agent.
3. **Two parallel security stacks (High)** — `@dzupagent/security` (`ContentScanner` + `PiiDetector` + `PromptInjectionDetector`) and `core/security/monitor` (`SafetyMonitor` + `built-in-rules.ts`) duplicate patterns. The tool loop scans tool *results* via `SafetyMonitor`, but the run engine sanitizes user *prompts* and writes via `ContentScanner`. The two registries drift; e.g. `built-in-rules.ts` regex set is broader (includes `bypass safety filters`, `override programming`) than `prompt-injection/patterns.ts`. PII regex coverage also differs (built-in-rules adds email + phone but lacks JWT). Operators cannot reason about a single source of truth.
4. **LLM invoke timer leak (Medium)** — `invokeWithTimeout` uses `Promise.race` against `setTimeout` without `clearTimeout` on the success path. Long-lived processes accumulate timers (one per call) until the timeout fires. With 100k turns this is a real GC pressure source.
5. **Token counter mis-routes Claude (Medium)** — `TiktokenCounter` always returns `cl100k_base` for non-`gpt*` models, including Claude. Token counts on Claude are off by ~10–15%, which corrupts compression triggers, budget warnings, and prompt-cache `minTokensForCache` gating.
6. **Stuck detector idle counter only resets via `recordIteration`** — `recordIteration` increments idleCount when `toolCallsThisIteration === 0`, but the loop ALSO calls `recordToolCall` per tool, which independently sets `idleCount = 0`. This is correct *only* when the tool-loop's order matches: tools first, then iteration tick. Looking at `tool-loop.ts:794`, the iteration tick runs AFTER per-tool execution — so the counter works. However, a parallel-mode early-break (approval pending) bypasses the iteration tick, leaving stale state. Edge bug for resumed runs.
7. **Approval gate timeout default behaviour** — when `timeoutMs` elapses with no decision, `waitForApproval` resolves to `'cancelled'` *without* emitting `approval:rejected` or persisting a rejection record in the durable store. The next listener wake-up sees no decision history. Consumers cannot reliably distinguish "timed out, abandon run" from "no event yet".
8. **Working memory growth in `IterationBudget.fork()`** — the parent shares `state`, `emittedThresholds`, and `dynamicallyBlockedTools` Sets with all children. Long-running supervisor → sub-agent fan-out keeps strings in the threshold set forever. Minor leak, but unbounded.

The framework's biggest strength is the **policy-enabled tool executor** (570 LOC, 11 distinct concerns layered cleanly: permission → budget block → governance → schema validation → telemetry → invoke → safety scan → output validation → stuck detection → tracing). This is the gold standard for tool-call lifecycle in TS-land.

---

## Domain Scores

| Area | Score (1-5) | Rationale |
|------|-------------|-----------|
| Tool Loop | **5** | Best-in-class. Per-tool retry with backoff classification (`isToolCancellationError` / `isToolTimeoutError` / `ForgeError` excluded from retry; `isTransientError` default predicate); per-tool timeouts with `AbortSignal` plumbing; parallel mode with policy parity; OTel tracing per call; structured stuck escalation (3 stages + checkpoint recovery); approval hard-gate; fail-open/fail-closed scanner mode; output schema validation soft-fail. Exceeds LangGraph's tool node, exceeds Claude Agent SDK's loop. |
| Memory | **3** | Strong primitives (Ebbinghaus decay with spaced repetition, MCP projection, vector clocks, frozen snapshots, dual-stream writer). `TenantScopedStore` correctly namespaces. **BUT** `AdapterLearningLoop` (the actual learning surface across tenants) is NOT tenant-scoped, leaking failure-pattern signal cross-tenant. Memory sanitizer covers prompt injection + exfiltration + zero-width Unicode but is only wired by sanitizer-aware writers, not at every `MemoryStore.put` boundary. Score reflects the gap between architecture quality and enforcement coverage. |
| Context | **4** | `injectPromptCacheMarkers` correctly model-gates (Claude only) and threshold-gates (≥1024 tokens). Content-addressed cache strategy avoids invalidation churn from short tool messages. 4-phase auto-compress integrates with the tool loop via `maybeCompress` callback with consecutive-failure terminal error. Token counter falls back gracefully. Drops a star for Claude tokenization mismatch (`cl100k_base` is wrong for Anthropic models — they ship `@anthropic-ai/tokenizer`). |
| Guardrails | **3** | Iteration/token/cost budgets work, with threshold warnings at configurable ratios. Rate limit (token-bucket) wired locally + distributed (Redis). PII + prompt-injection scanners exist. **BUT** two parallel security stacks; PII coverage in tool-result scanning depends on `SafetyMonitor` (built-in-rules) NOT the canonical `PiiDetector`. Webhook unsigned. Audit log lacks tenantId, prompt, response — compliance-light. |
| Orchestration | **4** | Topology graph executor, contract-net bidding, planning agent, recovery copilot (172 LOC), failure analyzer + strategy ranker, delegating supervisor, parallel/branch/sequential primitives. Durable approvals via `checkpointStore`. Stronger than CrewAI orchestration; closer to LangGraph state graphs. Drops a star because failure recovery (`recoverFromCheckpoint`) is opt-in per call site rather than a first-class run mode, and there's no built-in saga/compensation pattern for partial commits. |
| LLM Integration | **4** | Per-provider circuit breaker with closed/open/half-open transitions and configurable threshold; selection-time fallback chain (`getModelFallbackCandidates`); `isTransientError` heuristic for retry; `isContextLengthError` raises typed `CONTEXT_LENGTH_EXCEEDED`. 5 token-usage extraction paths covering LangChain 0.3, Anthropic, OpenAI, older formats. Cache-token split (read/write) implemented. Drops a star for: timer leak; jitter not on cooldown timer (only on `calculateBackoff`); reasoning-effort routing is OpenAI-only. |
| Codegen Patterns | **4** | Tree-sitter AST extraction across 6 languages with regex fallback; multiple sandbox tiers (Docker, e2b, Fly, k8s, mock, WASM); permission-tiers + security-profile abstractions; symbol extractor + import-graph for repo map; pre-commit lint validation. Drops a star because `permission-tiers.ts` is a pure types module — actual enforcement happens at the sandbox layer, not at write/edit tool invocation, so a `read-only` tier could still let a tool emit a write call that fails downstream rather than being blocked at issuance. |

**Overall score: 3.9 / 5** — top quartile of OSS frameworks. The remaining gaps are bounded and addressable.

---

## Findings

### AGT-001: Adapter learning loop is not tenant-scoped (cross-tenant leak)
**Severity:** Critical
**Area:** memory, guardrails
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent-adapters/src/learning/adapter-learning-loop.ts:17` — `ExecutionRecord` has no `tenantId`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent-adapters/src/learning/adapter-learning-loop.ts:31` — `ProviderProfile` aggregates across all tenants
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent-adapters/src/learning/learning-store.ts:31` — `LearningStore.saveRecord(providerId, record)` keys only by provider
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent-adapters/src/learning/in-memory-learning-store.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent-adapters/src/learning/file-learning-store.ts`

**Current state:** Every adapter execution writes one `ExecutionRecord` with `providerId, taskType, tags, success, durationMs, ...` into a global ring buffer. `ProviderProfile.specialties` and `weaknesses` are computed from the global record set. Routing decisions and recovery suggestions then bias all subsequent runs across all tenants based on shared signal. A misconfigured tenant whose runs constantly fail will degrade routing for every other tenant on the same process.

**Industry pattern:** LangGraph's `BaseStore` requires a namespace tuple. CrewAI's persistence is per-crew. Production multi-tenant LLM platforms (Vellum, LangSmith) tag every record with `tenant_id` and aggregate per-tenant unless explicitly aggregated for a benchmark dashboard.

**Gap:** SEC-02 from the 2026-05-05 audit was marked "verify" — verification confirms it is NOT closed. Memory note "Auto-Repair / Self-Learning Sprint 2026-05-05" claims `LearningCandidate` has tenant scope, but that's a separate path; the adapter-level `AdapterLearningLoop` is still global.

**Fix:**
1. Add required `tenantId: string` to `ExecutionRecord`.
2. Re-key `LearningStore` by `(tenantId, providerId)` tuple.
3. Add `getProfile(tenantId, providerId)` and global aggregation method `getGlobalProfile(providerId)` for ops dashboards (read-only, never feeds routing).
4. Update `AdapterLearningLoop.recordExecution` to require `tenantId` (via `ExecutionContext` or call signature).
5. Add a vitest that records 50 tenant-A failures + 50 tenant-B successes for the same providerId and asserts tenant-A's ProviderProfile.successRate is 0 and tenant-B's is 1.

**Acceptance:**
- Records cannot be written without tenantId (TypeScript enforces at compile time).
- `getProfile('tenant-a', 'claude')` returns disjoint stats from `getProfile('tenant-b', 'claude')`.
- Routing decisions consult tenant-scoped profile only.

**Effort:** 8h (interface + 3 stores + tests).

---

### AGT-002: Approval webhook is unsigned
**Severity:** High
**Area:** guardrails
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/approval/approval-gate.ts:275` — `notifyWebhook` impl
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/approval/approval-types.ts` — `ApprovalConfig.webhookUrl`

**Current state:** `notifyWebhook` POSTs `{type: 'approval_requested', runId, plan, contactId, channel}` to `webhookUrl` over plain HTTPS. No `X-Signature` / `X-Timestamp` headers. The receiver cannot verify the payload originated from the agent. An attacker who reads the URL from logs, env vars, or a leaked config file can forge approval-request notifications, triggering downstream alerts/SMS/Slack as if the agent issued them.

**Industry pattern:** Stripe webhooks (HMAC-SHA256 over `timestamp.payload`), GitHub webhooks (HMAC-SHA256), Slack webhooks (signing secret + replay-protection timestamp). All major HITL platforms (Outerbounds, LangSmith, Pulse) sign their callbacks.

**Gap:** No webhook secret abstraction; no signature emission; no documented contract for receivers.

**Fix:**
1. Extend `ApprovalConfig` with `webhookSecret?: string` (env-driven).
2. Compute `X-DzupAgent-Signature: sha256=<hex(hmac(secret, ts + '.' + body))>` header.
3. Emit `X-DzupAgent-Timestamp: <unix-ms>` for replay protection.
4. Add a `verifyApprovalWebhookSignature(headers, body, secret)` helper exported from the approval module.
5. Document tolerance window (5 min) for receivers.

**Acceptance:**
- A webhook fires with `X-DzupAgent-Signature` and `X-DzupAgent-Timestamp` when `webhookSecret` is set.
- Verifier helper returns `true` for matching, `false` for tampered.
- Test that unsigned webhooks emit a startup warning.

**Effort:** 4h.

---

### AGT-003: Two parallel security stacks duplicate PII / injection coverage
**Severity:** High
**Area:** guardrails
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/security/src/prompt-injection/patterns.ts` — 13 patterns
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/security/src/pii/detector.ts` — 5 PII regexes
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/security/monitor/built-in-rules.ts:42` — 12 different injection patterns
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/security/monitor/built-in-rules.ts:85` — 3 PII patterns (email + phone + SSN)
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:303` — uses `safetyMonitor.scanContent` (built-in-rules)
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/agent-finalizers.ts:121` — uses `ContentScanner` (security package)

**Current state:** Two distinct registries scan content for the same threat classes with different patterns and different coverage. Tool *result* PII scanning (in the tool loop) detects email and phone but NOT JWT or API keys. Memory write-back PII scanning (in finalizers) detects JWT and API keys but NOT email or phone. Operators cannot answer "what does dzupagent block by default?" without reading both code paths.

**Industry pattern:** OWASP LLM AI Security guidance is one detector library used everywhere. Lakera Guard, Microsoft PromptShield, and AWS Guardrails all expose a single unified rule set with a single registry.

**Gap:** Two separate scanner implementations, no shared rule registry, no defined precedence.

**Fix:**
1. Designate `@dzupagent/security` as the canonical scanner.
2. Refactor `core/security/monitor/safety-monitor.ts` to delegate `prompt_injection` and `pii_leak` rule checks to `PromptInjectionDetector` and `PiiDetector` from `@dzupagent/security`.
3. Keep `tool_abuse` + `escalation` rules in `built-in-rules.ts` (orthogonal concerns).
4. Update tool-loop to scan tool results via the canonical detectors (or via `SafetyMonitor` once that delegates).
5. Add a single `SecurityPolicyConfig` interface that drives both surfaces.

**Acceptance:**
- One PII pattern table; one injection pattern table.
- Existing tests in both packages pass against the consolidated set.
- New test asserting tool-result scan + memory write-back use the same detection.

**Effort:** 12h.

---

### AGT-004: LLM invoke timer leak under sustained load
**Severity:** Medium
**Area:** llm
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/llm/invoke.ts:172` — `Promise.race([model.invoke, setTimeout])`

**Current state:** `Promise.race` resolves on the first promise to settle. When `model.invoke` resolves first (the success path), the `setTimeout` timer is NEVER cleared. Each call leaks one timer until `timeoutMs` elapses. A long-running daemon doing 100k LLM calls accumulates 100k pending timers, each holding a closure with `reject` + `lastError` references.

**Industry pattern:** `AbortController` + `signal` (LangChain's recommended pattern). `setTimeout(...).unref()` plus explicit `clearTimeout` on success.

**Fix:**
```ts
const timer = setTimeout(() => abortController.abort(...), timeoutMs)
try {
  return await model.invoke(messages, { signal: abortController.signal })
} finally {
  clearTimeout(timer)
}
```
Or, retain `Promise.race` but capture the timer handle and `clearTimeout` in a `finally` block.

**Acceptance:**
- Vitest with fake timers: 1000 successful invocations leave 0 pending timers.
- No behavioral change on timeout path.

**Effort:** 1h.

---

### AGT-005: Token counter mis-routes Claude models to cl100k_base
**Severity:** Medium
**Area:** context
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/context/src/tiktoken-counter.ts:46`

**Current state:** `count(text, model)` checks `model.startsWith('gpt')` — for Claude models the path falls to `cl100k_base`, which under-counts Claude tokens by ~10-15% on average and over-counts on certain Unicode/code-heavy prompts. This corrupts: budget warnings, compression triggers, prompt-cache `minTokensForCache` gating, and per-call cost attribution.

**Industry pattern:** Anthropic ships `@anthropic-ai/tokenizer` (BPE). `core/src/llm/tokenizer-registry.ts` already routes to it for Anthropic models — but `context/src/tiktoken-counter.ts` is a separate path that doesn't.

**Fix:**
1. Replace the `claude*` path with a delegated lookup to the core `tokenizerRegistry.resolve(model)`.
2. OR: extend `TiktokenCounter` to detect `model.startsWith('claude')` and lazy-load `@anthropic-ai/tokenizer`.
3. Document that callers should pass the model id, and update `auto-compress.ts` consumers.

**Acceptance:**
- `count('hello world', 'claude-sonnet-4-6')` returns the same value as `core/src/llm/tokenizer.ts`'s tokenizer for Claude.
- Vitest covering 5 Claude prompts shows <2% delta vs. ground-truth tokenizer.

**Effort:** 3h.

---

### AGT-006: Stuck detector idle counter can be stale after parallel-mode approval pause
**Severity:** Medium
**Area:** orchestration, tool-loop
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/tool-loop.ts:783` — `if (approvalPending) break` exits before line 794 iteration tick
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/guardrails/stuck-detector.ts:160`

**Current state:** When `approvalPending` is set in parallel mode, the loop breaks BEFORE `stuckDetector.recordIteration(toolCalls.length)` runs. On resume (next process / next call), the detector's `idleCount` is whatever it was before the pause — usually correct, but if the pause spans many wall-clock minutes, error-window timestamps in `recentErrors` are now unreliable for the post-resume context.

**Industry pattern:** LangGraph's checkpointer treats stuck detection as part of node-state, persisted with the run. On resume, the detector is rehydrated to the snapshot at suspend time, then ticks normally.

**Gap:** Stuck detector state is in-memory only; no snapshot/restore methods. Cross-process resume restarts the detector from zero.

**Fix:**
1. Add `StuckDetector.snapshot(): StuckDetectorSnapshot` and `StuckDetector.restore(snapshot)`.
2. Persist snapshot in the run journal alongside `approval-pending` state.
3. Run engine rehydrates the detector on resume.

**Acceptance:**
- Suspend at iteration 5 with idleCount=2, resume after 1h, idleCount still 2.
- Error-window timestamps survive serialization (epoch ms).

**Effort:** 4h.

---

### AGT-007: Approval timeout silently cancels without persisting decision
**Severity:** Medium
**Area:** guardrails, orchestration
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/approval/approval-gate.ts:110` — Promise resolution

**Current state:** When an approval times out, `waitForApproval` resolves to `'cancelled'` and emits an `approval:cancelled` event. The durable `checkpointStore` entry is left in place — the persisted state still says "pending". A new process picking up the run sees `approvalPending = true` and may re-fire the approval flow.

**Industry pattern:** Temporal-style durable workflows: timeouts are first-class, persisted as a terminal decision, never re-attempted.

**Fix:**
1. On timeout, write a terminal `{decision: 'timed_out', at: <ms>}` to the checkpoint store before resolving.
2. `loadApprovalPendingState` returns null for timed-out entries (or returns the terminal record so callers can distinguish).
3. Add `approval:timed_out` event distinct from `approval:cancelled` (cancelled = caller aborted; timed_out = no decision arrived in window).

**Acceptance:**
- After timeout, `checkpointStore.load(runId, APPROVAL_PENDING_KEY)` returns either null or a terminal `{decision: 'timed_out'}` marker.
- Resume flow does not re-emit `approval:requested`.

**Effort:** 3h.

---

### AGT-008: IterationBudget.fork() leaks Set entries across child runs
**Severity:** Low
**Area:** guardrails
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/guardrails/iteration-budget.ts:73`

**Current state:** `fork()` shares `emittedThresholds` and `dynamicallyBlockedTools` Sets between parent and all children. Long-lived parents that spawn many sub-agents accumulate entries forever (entries never expire, blocked tools never unblock). For a supervisor that runs 1000 sub-agents per day, the Sets grow without bound.

**Industry pattern:** Either copy-on-fork (each child gets its own Set seeded from parent) or weak references / TTL-bounded LRU.

**Fix:**
- Document: `fork()` is intentionally process-lifetime — operators are expected to dispose the budget at run end.
- Or: clone Sets on fork; merge child decisions back into parent on `child.end()`.

**Acceptance:** Either documented behavior or test asserting cleanup.

**Effort:** 2h.

---

### AGT-009: LLM audit log lacks tenantId, prompt, response — compliance light
**Severity:** Medium
**Area:** guardrails
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/observability/llm-call-audit.ts:18`

**Current state:** `LlmCallAuditEntry` has `agentId, runId, model, inputTokens, outputTokens, durationMs, timestamp, success, error`. No `tenantId`. No prompt or response content. No tool calls. SOC 2 / ISO 42001 traceability requires reconstructing what the model was asked and what it produced. The audit memo claims this was implemented; verification confirms the implementation is metadata-only.

**Industry pattern:** LangSmith captures full prompt + response + tools + tenant. Vellum / Helicone same. Hashed prompts are an acceptable middle ground for cost/storage reasons.

**Fix:**
1. Add optional `tenantId, promptHash, responseHash, toolCalls` fields to `LlmCallAuditEntry`.
2. Hashing function (sha256, hex) wrapped at the boundary so consumers don't accidentally store raw prompts.
3. Allow opt-in raw capture (`auditCapture: 'metadata' | 'hashed' | 'full'`).

**Acceptance:**
- Backwards compatible: existing fields preserved.
- New fields populated when configured.

**Effort:** 5h.

---

### AGT-010: Tool result safety scan uses SafetyMonitor (different PII set than ContentScanner)
**Severity:** Medium
**Area:** guardrails, tool-loop
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:303`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/security/monitor/built-in-rules.ts:85`

**Current state:** Tool results are scanned via `SafetyMonitor.scanContent`, which uses `built-in-rules.ts`'s 3 PII patterns (SSN, email, phone). The newer `@dzupagent/security/PiiDetector` (5 patterns: SSN, CC, IBAN, JWT, API_KEY_GENERIC) is NOT consulted. So a tool returning a leaked JWT or API key passes through silently, while a tool returning a phone number is blocked. Coverage is asymmetric and surprising.

**Industry pattern:** Single PII rule set used at every boundary.

**Gap:** Subset of AGT-003. Listed separately because it's the worst-impact instance of the duplicate-stack problem — silent JWT leak through tool results is a real exfiltration risk.

**Fix:** Resolve as part of AGT-003 or independently by injecting `ContentScanner` into the tool loop's `safetyMonitor` slot.

**Acceptance:** Tool returning a JWT triggers `safety:violation` with `category: 'pii_leak'` and (in `block` mode) replaces the result.

**Effort:** Bundled with AGT-003 (or 3h standalone).

---

### AGT-011: Circuit breaker cooldown timer has no jitter
**Severity:** Low
**Area:** llm
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/llm/circuit-breaker.ts:65`

**Current state:** When `state === 'open'`, recovery is gated on `Date.now() - lastFailureAt >= resetTimeoutMs` exactly. If 100 worker processes share an upstream Anthropic outage, they ALL transition to half-open at the same instant and slam the API simultaneously, causing a thundering herd that re-trips every breaker.

**Industry pattern:** Netflix Hystrix, Polly (.NET), `cockroachdb/pebble` — all add jitter to circuit-breaker cooldown.

**Fix:** Add equal-jitter (50%-150%) to the resetTimeoutMs comparison.

**Acceptance:** 100 simulated breakers transitioning to half-open across a 30s window show <30% same-second collisions.

**Effort:** 1h.

---

### AGT-012: Permission tier enforcement happens at sandbox layer, not write-tool issuance
**Severity:** Medium
**Area:** codegen
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/codegen/src/sandbox/permission-tiers.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/codegen/src/tools/` (write_file, edit_file, etc.)

**Current state:** `permission-tiers.ts` declares the tier types, but no upstream gate prevents an agent on `tier: 'read-only'` from CALLING `write_file`. The call flows down to the sandbox layer, which rejects it. This wastes LLM tokens (the model spent thought on a write call that could never execute) and produces error messages the model has to recover from.

**Industry pattern:** Claude Agent SDK — `allowedTools` filter at registration time. Codex SDK — `permissionMode` is enforced at the SDK boundary, not the sandbox.

**Fix:**
1. At tool registration, filter writeable tools out of the model's binding when `tier === 'read-only'`.
2. Document that sandbox-layer enforcement is defense-in-depth, not the primary gate.

**Acceptance:**
- Agent on `read-only` tier sees `available_tools` without `write_file` / `edit_file`.
- Generation tests confirm the model never emits write calls.

**Effort:** 4h.

---

### AGT-013: ModelRegistry fallback does NOT retry on invocation error (only on model-creation error)
**Severity:** Low
**Area:** llm
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/llm/model-registry.ts:338`

**Current state:** `getModelWithFallback` is documented as "selection-time" — open circuits skip; factory errors skip; the first successfully constructed model is returned. After that, if `model.invoke()` throws a transient error, the run engine has to manually call `getModelFallbackCandidates`. Most callers don't.

**Industry pattern:** OpenRouter and Helicone proxy fallback transparently: the SDK retries the next provider on a 5xx without surfacing the error to the agent.

**Gap:** Fallback chain exists (`getModelFallbackCandidates`) but is opt-in per call site, not run-engine default.

**Fix:**
1. Wrap `model.invoke` in `dzip-agent.ts` with a fallback-aware iterator that uses `getModelFallbackCandidates` and walks the chain on transient errors.
2. Add `RegistryConfig.fallbackOnInvocationError: boolean` (default true).

**Acceptance:** Run with provider A failing 100% transient + provider B healthy succeeds via provider B without caller intervention.

**Effort:** 6h.

---

### AGT-014: Memory sanitizer not enforced at every MemoryStore.put boundary
**Severity:** Medium
**Area:** memory, guardrails
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/memory/src/memory-sanitizer.ts:58`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/memory/src/memory-service.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/memory/src/dual-stream-writer.ts`

**Current state:** `sanitizeMemoryContent` is called by some writers (dual-stream, memory-defense, skill-manager) but NOT at the `BaseStore.put` interface itself. A direct write via `tenantScopedStore.put(['lessons'], 'k', {content: '<malicious>'})` bypasses the sanitizer. Memory poisoning attacks land.

**Industry pattern:** Sanitization at the chokepoint (write hook on the store), not opt-in by writer.

**Fix:**
1. Wrap the canonical store factory with a sanitizing decorator.
2. Document that `BaseStore` directly is unsafe for untrusted content.
3. Or: enforce via `MemoryService.write` chokepoint, restricting raw `BaseStore.put` to test/internal use.

**Acceptance:** Vitest writing `'ignore previous instructions'` via `MemoryService.write` results in either rejection or threats array on the result.

**Effort:** 5h.

---

### AGT-015: Auto-compress consecutive-failure terminal error count is per-loop, not per-run
**Severity:** Low
**Area:** context, orchestration
**Files:**
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/tool-loop.ts:504,640`

**Current state:** `consecutiveCompressionFailures` is local to one tool-loop invocation. After a `runToolLoop` returns and a new one starts (via supervisor or sub-agent), the counter resets. Two transient compression failures across the seam are not detected. In practice this is fine for intra-loop runs, but hides repeat failures across multi-agent orchestration.

**Industry pattern:** Cross-call rolling counter on the agent instance, not the loop call.

**Fix:** Move the counter to the agent or run-engine state and pass through. Or: emit `context:compress_failed` and let the orchestrator aggregate.

**Acceptance:** Two consecutive failures across loop boundaries trigger `ContextCompressionFailedError`.

**Effort:** 3h.

---

## Verification of prior audit findings

Memory note "Phase 1+2 Security + DzupAgent Quick Wins 2026-05-05" claimed several fixes. This audit verifies:

| Prior finding | Claimed status | Verified status |
|--|--|--|
| C-01 prompt caching unimplemented | done | **Confirmed done** (`injectPromptCacheMarkers` wired in `run-engine.ts:260`). |
| H-01 workspace-write → bypassPermissions | done | **Confirmed done** (`claude-adapter.ts:137-141` returns `'default'` for `workspace-write`). |
| Durable approvals | done | **Confirmed done** (`approval-gate.ts:170+` `requestApproval` with `checkpointStore` persistence). |
| OrchestratorFacade 909 LOC split | done | **Confirmed done** (orchestrator.ts is 568 LOC, recovery-copilot is 172 LOC). |
| 15 `as never` casts in event listeners | claimed remaining | **Closed**: zero `as never` casts in non-test code grep. |
| MC-01 cache token split | done | **Confirmed done** (`TokenUsage` includes `cacheReadTokens` + `cacheWriteTokens`). |
| RF-12 LLM audit log | done | **Partially done**: implemented but compliance-light (see AGT-009). |
| SEC-02 cross-tenant learning | claimed done | **Re-opened — see AGT-001**. |
| PII scan misses tool results | flagged | **Partially closed — see AGT-010**. Tool results ARE scanned, but with the wrong (smaller) PII set. |

---

## Comparator notes

**vs. LangGraph:** dzupagent's tool loop is more featureful (per-tool retry policy, per-tool timeout, output schema soft-validation, scanner fail-mode). LangGraph wins on durable orchestration (the StateGraph + Checkpointer model is more uniform than dzupagent's split between run-journal, approval-gate-checkpoint-store, and tool-loop in-memory state). Recommend studying LangGraph's `interrupt()` / `resume()` API for the next pass on approval/checkpoint unification.

**vs. CrewAI:** dzupagent has a richer guardrail / safety layer; CrewAI has cleaner role/agent abstractions out of the box. dzupagent's `delegating-supervisor.ts` + `contract-net` cover the same ground but require more wiring.

**vs. AutoGen:** Multi-agent group-chat patterns are less first-class in dzupagent. Topology executor exists but lacks the conversation-history sharing that AutoGen does well.

**vs. Claude Agent SDK:** dzupagent's tool-loop is more transparent and policy-rich. Claude Agent SDK wins on simplicity for small use cases. The permission-tier filtering at registration (AGT-012) would close the gap.

**vs. Codex SDK:** Codex's SandboxMode → permissionMode mapping is similar to dzupagent's. dzupagent has more sandbox tiers (Docker, e2b, Fly, k8s, mock, WASM); Codex has a tighter, more opinionated default. dzupagent's `codex-streamed-thread.ts` adapter shows good understanding of the Codex protocol.

**vs. Hermes Agent:** dzupagent's `prompt-cache.ts` is directly inspired by Hermes' approach and adds a content-addressed strategy. Tokenization fix (AGT-005) would bring it to parity.

---

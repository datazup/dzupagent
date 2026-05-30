# Agent Pattern Audit — DzupAgent (whole stack)

**Date:** 2026-05-05
**Scope:** `packages/agent`, `packages/agent-adapters`, `packages/memory*`, `packages/context`, `packages/security`, `packages/hitl-kit`, `packages/evals`, `packages/rag`, `packages/core` (registry/llm/audit), `packages/flow-*`.
**Prior runs:** full-agent-agent-adapters-2026-05-03, full-agent-agent-adapters-2026-05-05 (97 findings). Many P1 / Critical items have since been addressed; this audit re-verifies and extends scope across the full pattern stack.

---

## Subsystem Scorecard (1=brittle, 5=production-grade)

| # | Subsystem | Score | Trend vs 05-05 | One-line state |
|---|-----------|-------|----------------|----------------|
| 1 | Tool Loop (`packages/agent`) | **4.0** | + | ReAct loop modular; retry/timeout/stuck/scan all wired; minor concerns remain |
| 2 | Memory (`packages/memory*`) | **3.5** | + | Pruner + decay + consolidation now wired; multi-modal, CRDT, encryption present |
| 3 | Context (`packages/context`) | **4.0** | ++ | Prompt caching landed (C-01 closed); tiktoken counter; phase-window mgmt |
| 4 | Guardrails (`packages/security` + agent guardrails) | **3.5** | + | PII + prompt-injection scanners now scan tool results; distributed RL added |
| 5 | Orchestration (`packages/agent` orch + `flow-*`) | **4.0** | + | Durable approval store, recovery copilot, pipeline runtime; pipeline-runtime still 1044 LOC |
| 6 | LLM Integration (`packages/agent-adapters` + core) | **4.0** | ++ | Adapter-registry refactored 750→195 LOC; circuit breaker; cost tracking with cacheRead/Write |
| 7 | Evals (`packages/evals`) | **4.0** | = | Coverage strong: 31 test files, LLM-judge enhanced, prompt-experiment, regression suite |
| 8 | HITL (`packages/hitl-kit`) | **4.0** | ++ | Stateless gate, durable Postgres + in-memory stores, idempotent, polling |
| 9 | RAG (`packages/rag`) | **3.0** | = | Solid pipeline; reranker is `'none'` default + only `'cross-encoder'` placeholder option |
| 10 | Adapter Stack (Claude / Codex / Gemini / Qwen / Crush / Goose / OpenAI / OpenRouter) | **3.5** | + | Most adapters healthy; OpenAI tool-calls still false; OpenAI test gap persists |

**Weighted average:** ~3.75 / 5 (was ~3.45). Material improvement driven by C-01 prompt cache, MC sprint (durable approvals, registry split, pruner wiring, audit logger), and Sprint B fixes.

---

## What changed since 2026-05-05 (verified, not re-listed)

| Prior ID | Status | Evidence |
|----------|--------|----------|
| AGENT-020 / AGENT-050 (no prompt caching) | **CLOSED** | `claude-adapter.ts:698-700` — `cache_control` markers; `cacheReadTokens` + `cacheWriteTokens` tracked end-to-end (`cost-tracking.ts:99-282`); `claude-adapter-deep.test.ts:524` |
| AGENT-054 (workspace-write→bypassPermissions) | **CLOSED** | `claude-adapter.ts:133-143` now maps `workspace-write` to `'workspace-write'` permission mode, not `'bypassPermissions'` |
| AGENT-011 (no periodic memory pruning) | **CLOSED** | `agent-finalizers.ts:175,271-302` runs `MemoryPruner` post-run; package exports `MemoryPruner`, `findWeakMemories` |
| AGENT-032 (tool results not scanned) | **CLOSED** | `policy-enabled-tool-executor.ts:309-314` invokes `safetyMonitor.scanContent(resultStr, { source: 'tool:result', toolName })` |
| AGENT-030 (no LLM audit log) | **PARTIAL** | `ComplianceAuditLogger` + `ComplianceAuditStore` exist in `core/security/audit/`; only `InMemoryAuditStore` ships; no caller in `agent-adapters` invokes it (no Postgres/Redis store, no wiring at run-engine) |
| AGENT-051 (`as never` in registry emit) | **CLOSED** | `as never` count in `agent-adapters/src` source = **0**; in `agent/src` source = **0** (only in __tests__) |
| AGENT-040 (registry monolith 750 LOC) | **CLOSED** | Split into `adapter-registry.ts` 195 LOC + `health-monitor.ts` 201 + `registry-router.ts` 242 + `task-router.ts` 382 + `capability-router.ts` 452 |
| AGENT-070 (no openai-adapter test) | **OPEN** | `packages/agent-adapters/src/__tests__/` still has no `openai-adapter.test.ts` |
| AGENT-053 (`supportsToolCalls: false`) | **OPEN** | `openai-adapter.ts:84` still hardcoded `false`; Qwen/Crush correctly declare `true` |
| AGENT-005 (Promise.allSettled drops results) | **PARTIAL** | `tool-scheduler-kernel.ts:128-158` now collects every settled outcome including errors before re-throwing; **only the first error wins** but other tool outputs ARE preserved in messages |
| AGENT-003 (abort listener leak in retry sleep) | **OPEN** | `policy-enabled-tool-executor.ts:288-298` still adds `addEventListener('abort', onAbort, { once: true })` without an explicit `removeEventListener` on resolve (relies on `{ once: true }` only firing on abort, not on natural resolution; listener accumulates if signal never fires) |

---

## 1. TOOL LOOP — Score 4.0/5

**State.** Decomposed into `tool-loop.ts` (825 LOC orchestrator) + `tool-loop/` kernels (`policy-enabled-tool-executor` 576, `tool-scheduler-kernel` 173, `model-turn-kernel` 29, `output-validator` 92, `loop-stages` 242). Per-tool retry with exponential+jitter, timeout, OTel, stuck-detector 5-mode escalation, output schema validation, safety-monitor scanning of args+results, tool-stats tracker, iteration budget.

**Gaps vs LangGraph/CrewAI.** Top-of-loop file `tool-loop.ts` still 825 LOC; `policy-enabled-tool-executor.ts` is 576 LOC and owns governance + retry + scan + telemetry. No formal tool-call-graph view (LangGraph has explicit DAG); stuck detection drift between agent (5 modes) and adapter-guardrails (3 modes) persists.

**Top 3 fixes.** (a) Continue extraction: pull retry/backoff into `retry-policy.ts`, scanning into `tool-result-scanner.ts`. (b) Unify stuck detection through a single `StuckDetectorPort` consumed by both layers. (c) Replace `setTimeout`+`addEventListener` retry-sleep pattern with `AbortablePromise.delay` that guarantees listener removal.

## 2. MEMORY — Score 3.5/5

**State.** Rich surface: `memory-pruner`, `staleness-pruner`, `decay-engine`, `consolidation-engine`, `lesson-pipeline`, `lesson-dedup`, CRDT, vector-clock, encryption, multi-modal, sharing/space-manager. Pruner is fire-and-forget after each run via `agent-finalizers`. Memory write-back PII redact/block honored. 64 test files in `memory/src/__tests__/`.

**Gaps vs Mem0/Letta.** No declarative TTL/eviction policy at the store interface level (every store reimplements its own). No memory-namespace quota enforcement. Frozen-snapshot prompt-cache lifecycle (capture, version, invalidate) still lacks an explicit manager. No causal-consistency tests for the CRDT path (graph + crdt directories present but coverage thin in __tests__).

**Top 3 fixes.** (a) Lift `MemoryEvictionPolicy` to `store-capabilities.ts` so `MemoryServiceLike.prune({ ttl, maxItems, byStrength })` is a contract, not per-implementation. (b) Wire `MemoryHealer` to a scheduler; today `runMemoryPruner` runs only post-run, leaving long-lived agents un-pruned mid-run. (c) Add quota check in `staged-writer.ts` so a single high-volume tool cannot OOM working memory before the post-run pruner fires.

## 3. CONTEXT — Score 4.0/5

**State.** `prompt-cache.ts` + `prompt-cache-injector.ts` + `auto-compress.ts` + `progressive-compress.ts` + `phase-window.ts` + `tiktoken-counter.ts` + `char-estimate-counter.ts`. Adapters now stamp `cache_control` (Claude) and surface `cacheReadTokens`/`cacheWriteTokens` (Claude+Codex). Token-lifecycle compression hook fires inside the tool loop.

**Gaps.** Default token counter still char/4 unless `js-tiktoken` is explicitly installed (peer dep). Compression failure inside tool-loop still silently swallowed (`tool-loop.ts` ~608) — should emit `context:compression_failed`. Frozen-snapshot capture/version/invalidate API absent; today the frozen snapshot is a passive flag only.

**Top 3 fixes.** (a) Promote `TiktokenCounter` to default for Claude/OpenAI/Gemini adapters when their tokenizer is bundled; emit a startup warning when falling back to char-estimate. (b) Emit `context:compression_failed` event and fail-loud on second consecutive failure. (c) Provide `FrozenSnapshotManager` (capture-on-init, invalidate-on-skill-update, surfaced in metrics).

## 4. GUARDRAILS — Score 3.5/5

**State.** `packages/security` ships `ContentScanner`, `pii/detector`, `prompt-injection/detector` + `patterns` (54 LOC). `agent/guardrails` has iteration-budget, cascading-timeout, stuck-detector, distributed-budget, distributed-rate-limiter. Tool-result scanning is now mandatory unless `scanToolResults: false` is set explicitly. Adapter-guardrails event-stream wrapper layered on top.

**Gaps.** **No structured LLM-call audit log is wired** despite `ComplianceAuditLogger` existing (only `InMemoryAuditStore` ships; nothing instantiates it inside agent or adapter). Two parallel stuck-detector implementations (agent vs adapter) still drift in mode count. `prompt-injection/patterns.ts` is only 54 LOC — narrow signature set vs Lakera/Rebuff. PII detector is regex-only; no NER fallback.

**Top 3 fixes.** (a) Wire `ComplianceAuditLogger` to a Postgres-backed store and emit one entry per LLM call (run-engine has the `// listener in ComplianceAuditLogger picks this up automatically` comment but no producer). (b) Expand prompt-injection corpus (load from `dzupagent/audit/...` fixtures, add multilingual). (c) Add NER fallback in `pii/detector.ts` (e.g. compromise.js or compact NER model) for entity types regex misses.

## 5. ORCHESTRATION — Score 4.0/5

**State.** `orchestrator.ts` 568 LOC (sequential / parallel / supervisor / debate / contract-net), `delegating-supervisor.ts` 847 LOC, `pipeline-runtime.ts` 1044 LOC, `team-runtime.ts` (memory consolidate now non-throwing), `flow-ast` 1410 LOC validate, `flow-dsl` 1018 LOC normalize. `RecoveryCopilot` 679 LOC + `failure-analyzer` 260 + `strategy-ranker` 140. Approval gate is durable via `hitl-kit/postgres-approval-store.ts`.

**Gaps.** `delegating-supervisor.ts` (847) and `pipeline-runtime.ts` (1044) are still monoliths. `RecoveryCopilot` 679 LOC echoes the structural anti-pattern that `OrchestratorFacade` was just refactored away from. No DurableStore abstraction for pipeline state — checkpoint store is wired but verification-on-startup absent (`pipeline-runtime.ts:99`).

**Top 3 fixes.** (a) Extract pipeline-runtime branch-merge / edge-resolution / retry / classify into already-present `pipeline-runtime/` helper modules (split 1044→<400 main). (b) Verify checkpoint store wiring at startup (one round-trip ping) — fail-fast on misconfig. (c) Split `recovery-copilot.ts` into `copilot.ts` + `attempt-handler.ts` + `escalator.ts`.

## 6. LLM INTEGRATION — Score 4.0/5

**State.** Adapter-registry split: `adapter-registry.ts` 195 LOC, `health-monitor.ts` 201 (per-adapter `CircuitBreaker` from `@dzupagent/core/advanced`), `registry-core.ts` 184, `registry-router.ts` 242, `task-router.ts` 382, `capability-router.ts` 452, `event-bus-bridge.ts` 236. `OrchestratorFacade` 468 + supporting helpers. Cost tracking includes `cacheReadTokens`, `cacheWriteTokens`, `cacheHitRatio`, `costCents` per provider.

**Gaps.** `recovery-attempt-handler.ts` still 658 LOC; recovery directory now has 13 files totaling 2251 LOC — dense for the role. `capability-router.ts` 452 LOC — large for a router. SSE parser duplication between OpenAI and OpenRouter persists. `executeWithFallback` in agent-adapters now lives in the registry split but the cross-provider handoff path (`cross-provider-handoff.ts` 193) duplicates logic with `recovery-loop-runner.ts` 151.

**Top 3 fixes.** (a) Decompose `recovery-attempt-handler.ts` (658) into `attempt-tracker.ts`, `escalation-policy.ts`, `attempt-result-classifier.ts`. (b) Extract a shared `parseSSE(stream)` helper to `agent-adapters/src/utils/` and use from openai + openrouter. (c) Consolidate `cross-provider-handoff` and `recovery-loop-runner` — both decide "should we hand off?" with overlapping rules.

## 7. EVALS — Score 4.0/5

**State.** 31 test files, 30+ source files. `composite-scorer`, `deterministic`, `deterministic-enhanced`, `llm-judge-scorer`, `llm-judge-enhanced`, `evidence-quality-scorer`, `domain-scorer/`, `scorer-registry`, `prompt-experiment`, `prompt-optimizer`, `prompt-version-store`, `learning-curve-benchmark`, `self-correction-benchmark`. `eval-orchestrator` + `benchmark-orchestrator`.

**Gaps.** No regression-detection wiring discoverable from `index.ts` (benchmarks compute trend per `benchmark-trend.test.ts` but no automatic CI gate that fails when regression exceeds threshold). LLM-judge prompts are not version-pinned to a model snapshot. No cost ceiling on judge invocations.

**Top 3 fixes.** (a) Add `regressionGate({ baselineRun, threshold })` that exits non-zero when `score - baseline < threshold`. (b) Pin judge prompt+model snapshot in `prompt-version-store.ts` and emit a warning on judge model upgrade. (c) Add per-suite cost cap fed by `cost-tracking.ts` to abort runaway eval loops.

## 8. HITL — Score 4.0/5

**State.** `hitl-kit` is now stateless: `approval-gate.ts` 90 LOC delegates to `ApprovalStateStore`; `InMemoryApprovalStateStore` (idempotent, timeout, multi-waiter) + `PostgresApprovalStateStore` (polling, schema documented). Errors typed (`ApprovalTimeoutError`, `DuplicateApprovalError`, `UnknownApprovalError`).

**Gaps.** Polling-only Postgres store (`pollIntervalMs: 500`) — no LISTEN/NOTIFY path. Webhook notification still lives in legacy `packages/agent/src/approval/approval-gate.ts:104` (340 LOC kept for back-compat) and is fire-and-forget with no DLQ. Only one test file (`hitl-kit/__tests__/approval-gate.test.ts`).

**Top 3 fixes.** (a) Add `PostgresListenApprovalStateStore` using `LISTEN approval_resolved` for sub-100ms latency. (b) Move webhook delivery into a `WebhookDispatcher` with retry+DLQ (or remove from agent-side approval-gate now that hitl-kit owns durability). (c) Add cross-process integration test: process A `createPending`, process B `grant`, A's `poll()` resolves.

## 9. RAG — Score 3.0/5

**State.** Pipeline (`pipeline.ts` 364), retriever (`retriever.ts` 397), chunker (`chunker.ts` 290), corpus-manager (`corpus-manager.ts` 328), folder-context-generator (`folder-context-generator.ts` 360), citation-tracker, quality-retriever, qdrant provider+factory. 22 test files.

**Gaps vs LlamaIndex/Haystack.** Reranker is `'none'` default; the only declared option is `'cross-encoder'` and there's no implementation file for it (`grep reranker` reveals only configuration). No BM25/hybrid retrieval. Vector-store abstraction exists (`@dzupagent/core` `VectorStore`) but only one provider (Qdrant) is shipped. No retrieval-quality scorer wired into evals.

**Top 3 fixes.** (a) Implement at least one cross-encoder reranker (e.g. cohere or local cross-encoder via fetch); fail-loud when `reranker !== 'none'` but no implementation registered. (b) Add hybrid retrieval (BM25 + vector + RRF fusion). (c) Add `retrieval-quality-scorer.ts` to evals and gate corpus changes on recall@k.

## 10. ADAPTER STACK — Score 3.5/5

**State.** Eight adapters: Claude (716+ LOC), Codex (1125), OpenAI (~387 single file), OpenRouter, Gemini SDK + CLI, Qwen, Crush, Goose. Capability map `getCapabilities()` per adapter; circuit breaker per provider; cost report per provider. Recovery policies (`recovery-policies.ts` 103) drive cross-provider handoff.

**Gaps.** OpenAI adapter still declares `supportsToolCalls: false` (silent feature gap) and **has no test file**. `codex-adapter.ts` 1125 LOC is the largest adapter. No "task routing" decision matrix that maps task class → adapter — `task-router.ts` 382 exists but capability scoring is opaque. SSE parser duplicated across openai + openrouter. Crush adapter has only thin tests.

**Top 3 fixes.** (a) Implement OpenAI tool-calling (function-calling spec) and add `openai-adapter.test.ts` with SSE + tool-calls + structured-output scenarios. (b) Decompose `codex-adapter.ts` (1125) — pull SSE thread + writeback + capability map into siblings under `codex/`. (c) Document task-routing weights in `task-router.ts` and expose a `dryRun(task) → ranked adapters` debug method.

---

## Top 10 Repo-Wide Gaps (priority order)

1. **LLM-call audit not actually wired** — `ComplianceAuditLogger` exists, no producer in agent/adapter; only `InMemoryAuditStore` shipped. Compliance gap.
2. **OpenAI adapter `supportsToolCalls: false` + zero tests** — silent feature gap on a primary provider.
3. **Pipeline + delegating-supervisor monoliths** (1044 + 847 LOC) — readability, testability.
4. **`recovery-attempt-handler.ts` 658 LOC** — same anti-pattern that was just refactored elsewhere.
5. **No regression gate in evals** — benchmarks compute trends but don't fail CI on drift.
6. **RAG reranker option declared but unimplemented** — `'cross-encoder'` has no concrete impl.
7. **Memory eviction policy is per-store** — no declarative contract on `MemoryServiceLike`.
8. **Tool-loop top file still 825 LOC** — extraction of retry/scan/telemetry will land it under 400.
9. **Stuck-detector drift** between agent (5-mode) and adapter-guardrails (3-mode) layers.
10. **Postgres approval store is polling-only** — no LISTEN/NOTIFY path; latency floor 500ms.

---

## Findings (`AGENT-NN`)

| ID | Sev | Subsystem | File:Line | Fix sketch | Phase |
|----|-----|-----------|-----------|------------|-------|
| AGENT-101 | High | Guardrails | `core/security/audit/index.ts` + `agent/run-engine.ts:517` | Wire `ComplianceAuditLogger` producer at LLM call boundary; ship Postgres audit store | Refactor |
| AGENT-102 | High | Adapters | `agent-adapters/src/openai/openai-adapter.ts:84` | Implement function-calling; flip `supportsToolCalls: true`; add `openai-adapter.test.ts` | Major |
| AGENT-103 | High | Orchestration | `agent/src/pipeline/pipeline-runtime.ts` (1044 LOC) | Split into branch-merge / edge-resolve / retry / classify modules in `pipeline-runtime/` | Major |
| AGENT-104 | High | Orchestration | `agent/src/orchestration/delegating-supervisor.ts` (847 LOC) | Decompose by responsibility (delegation policy / specialist selection / merge) | Major |
| AGENT-105 | High | LLM | `agent-adapters/src/recovery/recovery-attempt-handler.ts` (658 LOC) | Split into `attempt-tracker` + `escalation-policy` + `result-classifier` | Refactor |
| AGENT-106 | High | Adapters | `agent-adapters/src/codex/codex-adapter.ts` (1125 LOC) | Pull SSE thread / writeback / capability into siblings under `codex/` | Refactor |
| AGENT-107 | High | Evals | `evals/src/orchestrator/benchmark-orchestrator.ts` | Add `regressionGate({ baselineRun, threshold })` wired into `verify` | Refactor |
| AGENT-108 | Medium | Tool Loop | `agent/src/agent/tool-loop/policy-enabled-tool-executor.ts:288-298` | Replace `setTimeout`+`addEventListener` retry-sleep with `AbortablePromise.delay` | Quick |
| AGENT-109 | Medium | Tool Loop | `agent/src/agent/tool-loop/tool-scheduler-kernel.ts:156-159` | First-error-wins still hides remaining errors; aggregate via `AggregateError` | Quick |
| AGENT-110 | Medium | Memory | `memory/src/store-capabilities.ts` | Lift `MemoryEvictionPolicy` to interface; require `prune({ttl, maxItems, byStrength})` | Refactor |
| AGENT-111 | Medium | Memory | `memory/src/staged-writer.ts` | Quota check before write; reject above limit instead of pruning post-run | Refactor |
| AGENT-112 | Medium | Context | `agent/src/agent/tool-loop.ts` (~608) | Emit `context:compression_failed`; fail-loud on second consecutive failure | Quick |
| AGENT-113 | Medium | Context | `context/src/index.ts` | Use `TiktokenCounter` by default for Claude/OpenAI/Gemini; warn on char/4 fallback | Refactor |
| AGENT-114 | Medium | Guardrails | `security/src/prompt-injection/patterns.ts` (54 LOC) | Expand corpus; load fixtures; add multilingual signatures | Refactor |
| AGENT-115 | Medium | Guardrails | `security/src/pii/detector.ts` (79 LOC) | Add NER fallback for entities regex misses | Refactor |
| AGENT-116 | Medium | Guardrails | `agent-adapters/src/guardrails/adapter-guardrails.ts` vs `agent/src/guardrails/stuck-detector.ts` | Unify behind `StuckDetectorPort`; remove drift | Refactor |
| AGENT-117 | Medium | Orchestration | `agent/src/pipeline/pipeline-runtime.ts:99-110` | Verify checkpoint store on startup (round-trip ping) — fail-fast | Quick |
| AGENT-118 | Medium | Orchestration | `agent/src/recovery/recovery-copilot.ts` (679 LOC) | Split `copilot` / `attempt-handler` / `escalator` | Refactor |
| AGENT-119 | Medium | LLM | `agent-adapters/src/openai/openai-adapter.ts` + `openrouter/openrouter-adapter.ts` | Extract shared `parseSSE` to `agent-adapters/src/utils/sse.ts` | Quick |
| AGENT-120 | Medium | LLM | `agent-adapters/src/recovery/cross-provider-handoff.ts` + `recovery-loop-runner.ts` | Consolidate handoff decision logic | Refactor |
| AGENT-121 | Medium | HITL | `hitl-kit/src/postgres-approval-store.ts` | Add `PostgresListenApprovalStateStore` with `LISTEN/NOTIFY` for sub-100ms decisions | Refactor |
| AGENT-122 | Medium | HITL | `agent/src/approval/approval-gate.ts:104` (340 LOC legacy) | Move webhook delivery to `WebhookDispatcher` with retry+DLQ; or deprecate now hitl-kit owns | Refactor |
| AGENT-123 | Medium | RAG | `rag/src/types.ts:75` + `retriever.ts:63` | Implement `'cross-encoder'` reranker; throw on unconfigured selection | Refactor |
| AGENT-124 | Medium | RAG | `rag/src/retriever.ts` | Add hybrid retrieval (BM25 + vector + RRF) | Major |
| AGENT-125 | Medium | RAG | `rag/src/quality-retriever.ts` + evals | Add `retrieval-quality-scorer`; gate corpus changes on recall@k | Refactor |
| AGENT-126 | Medium | Adapters | `agent-adapters/src/registry/task-router.ts` (382 LOC) | Document weights; expose `dryRun(task) → ranked adapters` | Quick |
| AGENT-127 | Medium | Adapters | `agent-adapters/src/registry/capability-router.ts` (452 LOC) | Decompose by capability axis; lift score formula to a strategy | Refactor |
| AGENT-128 | Low | Tool Loop | `agent/src/agent/tool-loop.ts` (825 LOC) | Continue extraction of retry / scan / telemetry helpers | Refactor |
| AGENT-129 | Low | Memory | `memory/src/memory-healer.ts` | Wire to scheduler; today only post-run pruner runs | Quick |
| AGENT-130 | Low | Context | `context/src/prompt-cache.ts` | Provide `FrozenSnapshotManager` with capture/version/invalidate | Refactor |
| AGENT-131 | Low | Evals | `evals/src/scorers/llm-judge-enhanced.ts` | Pin judge prompt+model snapshot via `prompt-version-store` | Quick |
| AGENT-132 | Low | Evals | `evals/src/orchestrator/eval-orchestrator.ts` | Add per-suite cost cap fed by `cost-tracking.ts` | Quick |
| AGENT-133 | Low | HITL | `hitl-kit/src/__tests__/approval-gate.test.ts` | Add cross-process integration test (in-process Postgres) | Quick |
| AGENT-134 | Low | RAG | `rag/src/__tests__/` | Add reranker tests once impl exists | Quick |
| AGENT-135 | Low | Adapters | `agent-adapters/src/__tests__/qwen-adapter.test.ts`, `crush-adapter.test.ts` | Thicken; cover error paths and capability map | Quick |

**Severity totals:** 0 Critical · 7 High · 20 Medium · 8 Low · **35 findings**.

---

## Buckets

### Quick wins (<1 day each, 12 items)

`AGENT-108` retry-sleep AbortablePromise · `AGENT-109` AggregateError in scheduler · `AGENT-112` compression_failed event · `AGENT-117` checkpoint store ping · `AGENT-119` shared parseSSE · `AGENT-126` task-router dryRun · `AGENT-129` MemoryHealer scheduler · `AGENT-131` pin judge prompt · `AGENT-132` eval cost cap · `AGENT-133` HITL cross-process test · `AGENT-134` reranker tests · `AGENT-135` thicken qwen/crush tests.

### Refactors (1–3 days each, 17 items)

`AGENT-101` audit logger producer · `AGENT-105` recovery-attempt-handler split · `AGENT-106` codex-adapter split · `AGENT-107` regression gate · `AGENT-110` MemoryEvictionPolicy contract · `AGENT-111` staged-writer quota · `AGENT-113` Tiktoken default · `AGENT-114` injection corpus · `AGENT-115` PII NER fallback · `AGENT-116` unify stuck detector · `AGENT-118` recovery-copilot split · `AGENT-120` consolidate handoff · `AGENT-121` Postgres LISTEN store · `AGENT-122` WebhookDispatcher · `AGENT-123` cross-encoder reranker · `AGENT-125` retrieval-quality-scorer · `AGENT-127` capability-router split · `AGENT-128` tool-loop top split · `AGENT-130` FrozenSnapshotManager.

### Major (3+ days each, 4 items)

`AGENT-102` OpenAI tool-calling + tests · `AGENT-103` pipeline-runtime split · `AGENT-104` delegating-supervisor split · `AGENT-124` hybrid retrieval (BM25+vector+RRF).

---

## Closing Note

The 2026-05-04 MC sprint and 2026-05-05 Phase 1+2 + Sprint B fixes materially improved the stack (registry split, prompt caching, durable approvals, tool-result scanning, pruner wiring, cache-token cost split). Remaining work is concentrated in: **(1) wiring the audit logger that already exists**, **(2) decomposing two remaining monoliths** (pipeline-runtime, delegating-supervisor), and **(3) closing the OpenAI adapter feature gap**. None of the open items are Critical; the 7 High items are all addressable inside a single 2-week sprint by 2 engineers.

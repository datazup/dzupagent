# Refactors (P2 / 4–8h each) — DzupAgent run-001

Self-contained prompts. Verify with `yarn typecheck` + the per-package `yarn test` (Turbo filtered) after each.

---

## RF-01 (CODE-01) Adopt `AppEnv` across server routes/middleware
**Domain:** code · **Severity:** High (P1) · **Agent:** dzupagent-server-dev · **Effort:** 6h
**Files:** `packages/server/src/middleware/{identity,auth,rbac,tenant-scope,rate-limiter}.ts`, `routes/{runs,run-guard,api-keys,memory-tenant-scope,a2a/helpers,openai-compat/auth-middleware}.ts`, `runtime/consolidation-scheduler.ts`
**Why:** `server/src/types.ts` defines `AppEnv` precisely so callers do not need `as never`. 33 stale casts remain.
**Change:** Replace `new Hono()` with `new Hono<AppEnv>()`; import `AppEnv` from `'../types.js'`; strip both the `as never` and the secondary `as Record<string, unknown>` re-casts. Add `apiKey: ApiKeyContext` field to `AppVariables`.
**Acceptance:** `rg "as never" packages/server/src/{routes,middleware,runtime}/` returns 0; `yarn workspace @dzupagent/server typecheck` clean; existing tests green.

---

## RF-02 (SEC-04) Express adapter hardening
**Agent:** dzupagent-server-dev · **Effort:** 4h
**File:** `packages/express/src/agent-router.ts:65-172`
**Change:** Add `express.json({ limit: '256kb' })`; per-handler Zod schema for body; cap `message` length to 32 KB; mount `express-rate-limit` on `/chat*`; sanitise 500 errors (`{ error: 'Internal error', code }`); allowlist `agentName`.
**Acceptance:** Tests — body >256kb returns 413; missing fields return 400; 500 returns generic message; rate-limit kicks in at configured threshold.

---

## RF-03 (SEC-07) Workspace command default-deny + tier registry
**Agent:** dzupagent-codegen-dev · **Effort:** 4h
**File:** `packages/codegen/src/workspace/local-workspace.ts:210-218`
**Change:** When `allowedCommands === undefined`, default to `['git','node','npm','yarn','pnpm','tsc','eslint','prettier','jest','vitest','rg','grep','find']`. Document opt-out (`allowedCommands: '*'` literal sentinel for tests only).
**Acceptance:** Test — `runCommand('curl', …)` rejects with `WorkspaceCommandDeniedError`; opt-in `['curl']` allows.

---

## RF-04 (SEC-08) Default cost ceiling
**Agent:** dzupagent-agent-dev · **Effort:** 4h
**File:** `packages/agent/src/agent/run-engine.ts:186-193`
**Change:** When `config.guardrails === undefined`, install default `IterationBudget(50_000 input, 50_000 output)`; lower default `maxIterations` to 5; document override.
**Acceptance:** Test — bare agent w/ no guardrails cannot spend >100k tokens; budget exhaustion aborts cleanly.

---

## RF-05 (SEC-11/12) Git ref validation + `--end-of-options`
**Agent:** dzupagent-codegen-dev · **Effort:** 3h
**Files:** `packages/codegen/src/git/{git-executor.ts:285-336,git-worktree.ts:52-66,110-115}`
**Change:** Add `validateRefName(name): asserts name is GitRefName` accepting `/^[A-Za-z0-9._\\/][A-Za-z0-9._\\/-]*$/`; insert `--end-of-options` (Git ≥2.24) or `--` before user-supplied positional arguments in `commit`, `createBranch`, `switchBranch`, `worktree add`, `merge`.
**Acceptance:** Tests — `--upload-pack=…`, `-c …`, leading `-` rejected.

---

## RF-06 (SEC-14) Migrate `learning.ts` POSTs to Zod
**Agent:** dzupagent-server-dev · **Effort:** 4h
**File:** `packages/server/src/routes/learning.ts:355-380,440,548`
**Change:** Define Zod schemas; safeParse; cap individual string lengths (e.g. `feedback.runId` to 128 chars).
**Note:** Subsumed by SEC-05 (the full sweep) but standalone if SEC-05 is deferred.

---

## RF-07 (SEC-16) MCP stdio SIGKILL escalation
**Agent:** dzupagent-core-dev · **Effort:** 2h
**File:** `packages/core/src/mcp/mcp-client.ts:432-479`
**Change:** Add SIGTERM→SIGKILL escalation pattern from `process-helpers.ts:88-101`. After first SIGTERM, schedule SIGKILL after 5s.
**Acceptance:** Test — child that ignores SIGTERM is killed within 5s.

---

## RF-08 (ARCH-03) Migrate cross-deps to `workspace:^`
**Agent:** dzupagent-architect · **Effort:** 8h
**Files:** every `packages/*/package.json` (32) — 70 cross-deps total
**Change:** Convert exact-pin `0.2.0` to `workspace:^`. Verify `yarn install` clean; verify publish-time rewrite works (smoke pack one package).
**Acceptance:** No `"@dzupagent/...": "0.\\d+\\.\\d+"` in any `dependencies` or `peerDependencies` field.

---

## RF-09 (ARCH-04) Trim god public surface for `core` and `agent`
**Agent:** dzupagent-architect · **Effort:** 8h
**Files:** `packages/core/src/index.ts` (874 LOC, 223 exports), `packages/agent/src/index.ts` (821 LOC, 210 exports)
**Change:** Move advanced-only exports to `./advanced` subpath; keep `index.ts` to ≤100 stable exports each. Add CI gate (test) that fails when `index.ts` exceeds 100 exports.
**Acceptance:** Both `index.ts` ≤100 named exports; downstream consumers still build (codev-app, server, agent-adapters).

---

## RF-10 (ARCH-05) Unify PII detection on `@dzupagent/security`
**Agent:** dzupagent-architect · **Effort:** 6h
**Files:** `packages/core/src/security/pii-detector.ts` (97 LOC) + `packages/security/src/pii/detector.ts` (79 LOC)
**Change:** Make `@dzupagent/security` canonical. Merge pattern set so neither loses coverage (IBAN, JWT, etc.). Re-export from `@dzupagent/core/security` with deprecation banner. Update existing callers to import from `@dzupagent/security`.
**Acceptance:** Tests — every former `core` PII type detected by `security` detector. `rg "from '@dzupagent/core/security/pii-detector'" packages/` returns 0 (or only deprecated re-exports).

---

## RF-11 (ARCH-06) Collapse 5 rate-limiters into 1 canonical
**Agent:** dzupagent-architect · **Effort:** 8h
**Files:** `core/src/rate-limit/token-bucket.ts`, `agent/src/guardrails/distributed-rate-limiter.ts`, `agent/src/mailbox/rate-limiter.ts`, `agent-adapters/src/http/rate-limiter.ts`, `server/src/middleware/rate-limiter.ts`, `server/src/notifications/mail-rate-limiter.ts`
**Change:** Designate `core/src/rate-limit/token-bucket.ts` (or new `shared-app-kit/rate-limit`) as canonical. Convert the others to thin wrappers. Keep external API of each unchanged.
**Acceptance:** All 5 callers compile against the canonical impl; bug fix to canonical propagates to all.

---

## RF-12 (ARCH-07) Collapse 2 circuit-breakers
**Agent:** dzupagent-architect · **Effort:** 4h
**Files:** `core/src/llm/circuit-breaker.ts` (canonical) + `agent/src/orchestration/circuit-breaker.ts`
**Change:** Make orchestration variant compose core's (state-machine wrapper).
**Acceptance:** Single source of state-transition logic.

---

## RF-13 (ARCH-08) Tier-driven boundary enforcement
**Agent:** dzupagent-test-dev · **Effort:** 8h
**File:** `packages/testing/src/__tests__/boundary-enforcement.test.ts`
**Change:** Drive rules from `dzupagent/config/package-tiers.json`. For every declared dep across packages, assert `pkg.tier <= dep.tier`. Add full-graph circular-detection (DFS) instead of the hand-written 1-pair list. Add a static `from '@dzupagent/'` regex sweep alongside package.json checks.
**Acceptance:** New test fails when `cache → memory` (or any other regression) is introduced.

---

## RF-14 (ARCH-12/13/17) Move imports from peer to dep
**Agent:** dzupagent-architect · **Effort:** 2h
**Files:** `packages/{app-tools,code-edit-kit}/package.json`
**Change:** `@dzupagent/core` (and any other directly-imported package) move to `dependencies`. Keep contract-only as peer.
**Acceptance:** Strict-peer resolver install clean.

---

## RF-15 (ARCH-14) Publish extension contracts
**Agent:** dzupagent-architect · **Effort:** 8h
**File:** new `packages/runtime-contracts/extension/{memory-store,tool-registry,model-provider}.ts`
**Change:** Extract abstract interfaces a third party can implement. Memory: `MemoryStore` (read/write/prune/search). Tools: `ToolRegistry`. Models: `ModelProvider`. Re-export from `@dzupagent/core/contracts`.
**Acceptance:** Existing in-tree implementations satisfy the new interfaces.

---

## RF-16 (ARCH-19) Make `apache-arrow` a peer in `memory-ipc`
**Agent:** dzupagent-architect · **Effort:** 4h
**File:** `packages/memory-ipc/package.json`
**Change:** Move `apache-arrow` from `dependencies` to `peerDependencies` with `optional: true` in `peerDependenciesMeta`. Match the existing `@duckdb/duckdb-wasm` pattern.
**Acceptance:** Consumers that don't import arrow APIs install without it.

---

## RF-17 (ARCH-20) Converge parallel-executors on shared concurrency primitive
**Agent:** dzupagent-agent-dev · **Effort:** 6h
**Files:** `agent/src/agent/parallel-executor.ts` + `agent-adapters/src/orchestration/parallel-executor.ts` (748 LOC) + `core/src/orchestration/Semaphore`
**Change:** Both executors compose `Semaphore` / `WorkerPool` from `@dzupagent/core/orchestration`. Remove duplicated concurrency math.
**Acceptance:** Both executors ≤300 LOC; tests green.

---

## RF-18 (CONSUMER-02 + CONSUMER-03) Fix consumer-facing API drift
**Agent:** dzupagent-core-dev · **Effort:** 6h
**Files:** `packages/memory/src/consolidation/*` + `packages/core/src/events/*`
**Change (memory):** Decide intent — restore `pruned`/`merged` as optional fields with deprecation, OR bump minor and document in `MIGRATION.md`. Either way, codev-app must typecheck against the published surface.
**Change (events):** Make `DzupEventBus` assignable to `DzupEventBusAdapter` from a consumer's perspective (or document that consumers must adapt).
**Acceptance:** `cd apps/codev-app && yarn typecheck` succeeds without local patches.

---

## RF-19 (CODE-02) Split `executeStreamingToolCall`
**Agent:** dzupagent-agent-dev · **Effort:** 8h
**File:** `packages/agent/src/agent/run-engine.ts:700` (397 LOC)
**Change:** Extract `applyBudgetGate`, `runToolStreamingPhase`, `recordToolLatencyOutcome`. Keep orchestrator <100 LOC.
**Acceptance:** Function ≤100 LOC; helpers each ≤120 LOC; tests still green.

---

## RF-20 (CODE-03) Strategy refactor of `planSync`
**Agent:** dzupagent-connectors-dev · **Effort:** 8h
**File:** `packages/agent-adapters/src/dzupagent/syncer.ts:261` (324 LOC)
**Change:** Define `SyncStrategy` interface; create `codex-sync-strategy.ts`, `claude-sync-strategy.ts`, `dzupagent-sync-strategy.ts`. `planSync` becomes lookup+delegation (~30 LOC).
**Acceptance:** Adding a hypothetical 4th target is a new file (open/closed).

---

## RF-21 (CODE-09) Slim DzipAgent constructor
**Agent:** dzupagent-agent-dev · **Effort:** 4h
**File:** `packages/agent/src/agent/dzip-agent.ts:170`
**Change:** Extract `validateConfig` and `installEventBus` helpers; constructor body <40 LOC.

---

## RF-22 (CODE-11) Split `routes/runs.ts`
**Agent:** dzupagent-server-dev · **Effort:** 8h
**File:** `packages/server/src/routes/runs.ts` (968 LOC)
**Change:** Split into `runs/list-handler.ts`, `runs/create-handler.ts`, `runs/stream-handler.ts`, `runs/control-handler.ts`. Keep `runs.ts` as router-only (≤100 LOC).
**Acceptance:** All routes still mounted; tests green; no behaviour change.

---

## RF-23 (CODE-12) Split `routes/compile.ts`
**Agent:** dzupagent-server-dev · **Effort:** 6h
**File:** `packages/server/src/routes/compile.ts` (782 LOC)
**Change:** Same shape as RF-22.

---

## RF-24 (CODE-14) Split `cli/doctor.ts`
**Agent:** dzupagent-server-dev · **Effort:** 6h
**File:** `packages/server/src/cli/doctor.ts` (715 LOC)
**Change:** One module per check under `cli/doctor/checks/*.ts`; `doctor.ts` aggregates.

---

## RF-25 (CODE-17) Slim `executeGenerateRunInner`
**Agent:** dzupagent-agent-dev · **Effort:** 6h
**File:** `packages/agent/src/agent/run-engine.ts:373` (270 LOC)
**Change:** Extract guard prelude, model-call setup, post-processing into helpers.

---

## RF-26 (CODE-18) `tool-loop.ts` runToolLoop helpers
**Agent:** dzupagent-agent-dev · **Effort:** 8h
**File:** `packages/agent/src/agent/tool-loop.ts` (825 LOC)
**Change:** Continue extraction begun in Sprint B — pull retry/backoff into `retry-policy.ts`, scanning into `tool-result-scanner.ts`. Target file <400 LOC.

---

## RF-27 (CODE-19) Extract from `delegating-supervisor.ts`
**Agent:** dzupagent-agent-dev · **Effort:** 8h
**File:** `packages/agent/src/orchestration/delegating-supervisor.ts:384,533`
**Change:** Extract `markCircuitBreakerRecorded` (149 LOC) → `circuit-breaker-recorder.ts`; `guardDuplicateSpecialistAssignmentIds` (117 LOC) → `assignment-validator.ts`.

---

## RF-28 (CODE-20) Extract codex event mapper + abort handling
**Agent:** dzupagent-connectors-dev · **Effort:** 8h
**File:** `packages/agent-adapters/src/codex/codex-adapter.ts` (1125 LOC)
**Change:** Pull event-mapping (currently inline) to `codex-event-mapper.ts`; abort/timeout into `codex-abort-controller.ts`.

---

## RF-29 (CODE-21) `mapRawEvent` dispatch table
**Agent:** dzupagent-connectors-dev · **Effort:** 4h
**File:** `packages/agent-adapters/src/claude/claude-adapter.ts:320`
**Change:** Replace 143-LOC switch with `RAW_EVENT_HANDLERS: Record<RawType, Handler>` dispatch table.
**Acceptance:** Same outputs; handler registry testable per type.

---

## RF-30 (CODE-22) Split `memory-space-manager.ts`
**Agent:** dzupagent-core-dev · **Effort:** 8h
**File:** `packages/memory/src/sharing/memory-space-manager.ts` (950 LOC)
**Change:** Split lifecycle (create/seal/compact) from membership (grant/revoke/list).

---

## RF-31 (CODE-23) Split `convention-extractor.ts`
**Agent:** dzupagent-core-dev · **Effort:** 8h
**File:** `packages/memory/src/convention/convention-extractor.ts` (748 LOC)
**Change:** Per-extractor strategy.

---

## RF-32 (CODE-25) Split `flow-dsl/normalize.ts`
**Agent:** dzupagent-architect · **Effort:** 8h
**File:** `packages/flow-dsl/src/normalize.ts` (1018 LOC)
**Change:** Per-construct normalizer modules.

---

## RF-33 (CODE-26) `flow-compiler/semantic.ts` visitor registry
**Agent:** dzupagent-architect · **Effort:** 8h
**File:** `packages/flow-compiler/src/stages/semantic.ts:160` (807 LOC, `visit` 117)
**Change:** Per-node-kind visitors in a registry; `visit` becomes dispatch.

---

## RF-34 (CODE-27) Slim `eval-orchestrator`
**Agent:** dzupagent-test-dev · **Effort:** 6h
**File:** `packages/evals/src/orchestrator/eval-orchestrator.ts:412,257`
**Change:** Slim `executeRun` (95 LOC) and `reconcilePersistedRuns` (84 LOC).

---

## RF-35 (CODE-31) Document `no-new-func` trust boundary
**Agent:** dzupagent-architect · **Effort:** 4h
**File:** `packages/flow-compiler/src/stages/semantic.ts:324`
**Change:** Add comment explaining the trust boundary; runtime guard that input has been validated by `flow-ast` first; throw if not.
**Acceptance:** Calling with raw user input throws `UnvalidatedFlowError` before reaching `Function()`.

---

## RF-36 (AGENT-101) Wire `ComplianceAuditLogger` producer
**Agent:** dzupagent-core-dev · **Effort:** 6h
**Files:** `packages/core/src/security/audit/index.ts` + new `postgres-audit-store.ts` + `agent/src/agent/run-engine.ts:517`
**Change:** Emit one structured audit entry per LLM call (model, tokens, costCents, runId, tenantId, prompt+response hashes). Ship `PostgresAuditStore`. Wire producer at run-engine call site.
**Acceptance:** Test agent run produces ≥1 audit row in mock store; PII redacted before write.

---

## RF-37 (AGENT-105) Decompose `recovery-attempt-handler.ts`
**Agent:** dzupagent-connectors-dev · **Effort:** 6h
**File:** `packages/agent-adapters/src/recovery/recovery-attempt-handler.ts` (658 LOC)
**Change:** Split into `attempt-tracker.ts`, `escalation-policy.ts`, `attempt-result-classifier.ts`. Handler ≤250 LOC.

---

## RF-38 (AGENT-107) Eval regression gate
**Agent:** dzupagent-test-dev · **Effort:** 4h
**File:** `packages/evals/src/orchestrator/benchmark-orchestrator.ts`
**Change:** Add `regressionGate({ baselineRun, threshold })` that exits non-zero on regression. Wire into `yarn verify` via a new `evals:regression-gate` script.

---

## RF-39 (AGENT-110) Lift `MemoryEvictionPolicy` to contract
**Agent:** dzupagent-core-dev · **Effort:** 6h
**File:** `packages/memory/src/store-capabilities.ts` (+ `runtime-contracts/extension`)
**Change:** Add `prune({ ttl?, maxItems?, byStrength? })` to `MemoryServiceLike` contract. Implement default eviction policy. Existing stores inherit.

---

## RF-40 (AGENT-111) Quota check in staged-writer
**Agent:** dzupagent-core-dev · **Effort:** 4h
**File:** `packages/memory/src/staged-writer.ts`
**Change:** Reject `write()` when namespace quota exceeded; emit `memory:quota_exceeded` event.

---

## RF-41 (AGENT-113) Default TiktokenCounter for major adapters
**Agent:** dzupagent-core-dev · **Effort:** 4h
**File:** `packages/context/src/index.ts`
**Change:** Use `TiktokenCounter` by default for Claude/OpenAI/Gemini when their tokenizer is bundled; emit startup warning when falling back to char/4.

---

## RF-42 (AGENT-114) Expand prompt-injection corpus
**Agent:** dzupagent-core-dev · **Effort:** 4h
**File:** `packages/security/src/prompt-injection/patterns.ts` (54 LOC)
**Change:** Load patterns from `fixtures/`; add multilingual signatures; add categories (jailbreak / instruction-override / system-prompt-leak).

---

## RF-43 (AGENT-115) PII detector NER fallback
**Agent:** dzupagent-core-dev · **Effort:** 4h
**File:** `packages/security/src/pii/detector.ts`
**Change:** Add NER fallback (e.g. compromise.js) for entity types regex misses (PERSON, ORG, LOC). Wrap as optional plugin to avoid hard dep.

---

## RF-44 (AGENT-116) Unify stuck detector
**Agent:** dzupagent-agent-dev · **Effort:** 4h
**Files:** `packages/agent-adapters/src/guardrails/adapter-guardrails.ts` + `packages/agent/src/guardrails/stuck-detector.ts`
**Change:** Define `StuckDetectorPort`; both layers consume the canonical 5-mode implementation.

---

## RF-45 (AGENT-118) Split `recovery-copilot.ts`
**Agent:** dzupagent-agent-dev · **Effort:** 8h
**File:** `packages/agent/src/recovery/recovery-copilot.ts` (679 LOC)
**Change:** Split into `copilot.ts` + `attempt-handler.ts` + `escalator.ts`.

---

## RF-46 (AGENT-120) Consolidate handoff decision logic
**Agent:** dzupagent-connectors-dev · **Effort:** 6h
**Files:** `packages/agent-adapters/src/recovery/{cross-provider-handoff.ts,recovery-loop-runner.ts}`
**Change:** Single decision function consumed by both call paths.

---

## RF-47 (AGENT-121) Postgres LISTEN approval store
**Agent:** dzupagent-agent-dev · **Effort:** 6h
**File:** `packages/hitl-kit/src/postgres-approval-store.ts` (+ new `postgres-listen-approval-store.ts`)
**Change:** Implement `PostgresListenApprovalStateStore` using `LISTEN approval_resolved` for sub-100ms latency. Polling impl remains as fallback.

---

## RF-48 (AGENT-122) WebhookDispatcher with retry + DLQ
**Agent:** dzupagent-agent-dev · **Effort:** 6h
**File:** `packages/agent/src/approval/approval-gate.ts:104` (340 LOC legacy)
**Change:** Extract webhook delivery into a `WebhookDispatcher` with retry (exponential backoff, max 5 attempts) + DLQ. Or deprecate legacy approval-gate now that hitl-kit owns durability.

---

## RF-49 (AGENT-123) Cross-encoder reranker
**Agent:** dzupagent-connectors-dev · **Effort:** 8h
**File:** `packages/rag/src/types.ts:75` + `retriever.ts:63`
**Change:** Implement `'cross-encoder'` reranker (Cohere Rerank API or local ONNX cross-encoder via `@xenova/transformers`). Throw on unconfigured selection.

---

## RF-50 (AGENT-125) Retrieval-quality scorer
**Agent:** dzupagent-test-dev · **Effort:** 6h
**Files:** `packages/rag/src/quality-retriever.ts` + `packages/evals/src/scorers/retrieval-quality-scorer.ts`
**Change:** Score recall@k and MRR over a labelled fixture set. Gate corpus changes via eval CI.

---

## RF-51 (AGENT-127) Decompose capability-router
**Agent:** dzupagent-connectors-dev · **Effort:** 8h
**File:** `packages/agent-adapters/src/registry/capability-router.ts` (452 LOC)
**Change:** Split by capability axis (model class, latency tier, region, cost). Lift score formula to a strategy.

---

## RF-52 (AGENT-128) Tool-loop top split (continuation)
**Agent:** dzupagent-agent-dev · **Effort:** 6h
(See RF-26 — same file, different scope.)

---

## RF-53 (AGENT-130) `FrozenSnapshotManager`
**Agent:** dzupagent-core-dev · **Effort:** 6h
**File:** `packages/context/src/prompt-cache.ts`
**Change:** Provide `FrozenSnapshotManager` with `capture(skillId)`, `version(snapshot)`, `invalidate(skillId)`. Surface metrics.

---

## RF-54 (CODE-08) Slim `mergeBranchExecutionResult`
**Agent:** dzupagent-agent-dev · **Effort:** 4h
**File:** `packages/agent/src/pipeline/pipeline-runtime.ts`
**Change:** Extract nested branch/result merge into `mergeBranchExecutionResult/{aggregate,reconcile,emit}.ts`.

---

(End of refactors — 49 items including subsumed entries, ~280 hours total.)

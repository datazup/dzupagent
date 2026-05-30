# Unified Recommendations — DzupAgent Audit (run-001, 2026-05-05)

Sorted: Critical → High → Medium → Low; within tier, quick wins first.
Each item is self-contained and ready to drop into `/analyze-implement`.

---

## Critical (resolve this week)

### SEC-01: Approval bypass — wire ownership check into `routes/approvals.ts`
- **Domain:** Security · OWASP A01 Broken Access Control
- **Phase:** quick (~30 min)
- **Expert Agent:** dzupagent-server-dev
- **Files:** `packages/server/src/routes/approvals.ts:36-78`
- **Why:** Endpoint resolves any approval id with no ownership/tenant guard — entire HITL gate bypassable across tenants.
- **Fix:** Re-use `requireOwnedRun` (already used in `routes/approval.ts`); resolve via `runStore.get(runId)` and 403 when `run.tenantId !== c.get('apiKey').tenantId`.
- **Acceptance:** New test — Tenant A's API key gets 403 on `POST /api/approvals/<TenantB-runId>/<approvalId>/grant`.

### SEC-02: Cross-tenant learning data — replace `getTenantId` with `defaultResolveAuthScope`
- **Domain:** Security · OWASP A01
- **Phase:** quick (~45 min)
- **Expert Agent:** dzupagent-server-dev
- **Files:** `packages/server/src/routes/learning.ts:120-126,217-220,274-275,355-365`
- **Why:** `c.get('tenantId')` is never set in production; every tenant collapses to `defaultTenantId`. All lessons/rules/skills/feedback shared across tenants.
- **Fix:** Replace `getTenantId(c)` body with `defaultResolveAuthScope(c).tenantId` (mirror `routes/memory-tenant-scope.ts` pattern).
- **Acceptance:** Regression test — two distinct API keys hit `GET /dashboard`, results MUST be disjoint.

---

## High

### ARCH-01: Add `@dzupagent/memory` to `server` deps (phantom dep)
- **Domain:** Architecture · Phase: quick
- **Expert:** dzupagent-architect
- **Files:** `packages/server/package.json` + `packages/server/src/routes/memory-sync.ts:13-20`
- **Why:** Builds work today only via workspace hoisting; isolated install breaks.
- **Fix:** Add `"@dzupagent/memory": "workspace:^"` to `dependencies`.
- **Acceptance:** `yarn workspaces focus @dzupagent/server` then `yarn typecheck` from server alone passes.

### CODE-01: Adopt `AppEnv` across server routes/middleware; strip `as never`
- **Domain:** Code · Phase: refactor (~4–8h)
- **Expert:** dzupagent-server-dev
- **Files:** `server/src/middleware/{identity,auth,rbac,tenant-scope,rate-limiter}.ts`, `routes/{runs,run-guard,api-keys,memory-tenant-scope,a2a/helpers,openai-compat/auth-middleware}.ts`, `runtime/consolidation-scheduler.ts`
- **Why:** `server/src/types.ts` defines `AppEnv` precisely to remove these casts. 33 stale `as never` remain across ~14 files.
- **Fix:** `new Hono<AppEnv>()`; import `AppEnv` from `../types.js`; strip both `as never` and the secondary `as Record<string, unknown>` re-cast. Add `apiKey` field to `AppVariables` as a typed `ApiKeyContext`.
- **Acceptance:** `rg "as never" packages/server/src/{routes,middleware,runtime}/` returns 0 hits; tsc clean.

### SEC-09: Drop raw `err.message` from server global error handler
- **Phase:** quick (~15 min) · **Expert:** dzupagent-server-dev
- **Files:** `packages/server/src/composition/middleware.ts:386-396`
- **Fix:** Log via structured logger w/ existing `redact*` helpers; emit error code + stack trace to log only; `c.json({ error: 'Internal error', code })` to client.
- **Acceptance:** Test — `pg: password authentication failed for user "X" with hash …` style errors must NOT appear in client response.

### SEC-13: Replace high-cardinality / PII-bearing metric label with route template
- **Phase:** quick (~30 min) · **Expert:** dzupagent-server-dev
- **Files:** `packages/server/src/composition/middleware.ts:369-383`
- **Fix:** Use `c.req.routePath` instead of `c.req.path`.
- **Acceptance:** Metric cardinality stable as input ids vary.

### SEC-17: Re-validate MCP executable URL on PATCH
- **Phase:** quick (~20 min) · **Expert:** dzupagent-server-dev
- **Files:** `packages/server/src/routes/mcp.ts:196-222`
- **Fix:** Call `validateMcpExecutablePath(patch.url)` when `url` changes.
- **Acceptance:** PATCH with invalid url returns 400 before persistence.

### SEC-04: Express adapter hardening
- **Phase:** refactor (~4h) · **Expert:** dzupagent-server-dev
- **Files:** `packages/express/src/agent-router.ts:65-115,119-172`
- **Fix:** `express.json({ limit: '256kb' })`; Zod schema for body; cap `message` to 32 KB; `express-rate-limit` on `/chat*`; sanitised 500 message; agent-name allowlist.
- **Acceptance:** Tests — body >256kb returns 413; missing fields return 400; 500 returns generic body.

### SEC-07: Default-deny for `LocalWorkspace.runCommand`
- **Phase:** refactor (~4h) · **Expert:** dzupagent-codegen-dev
- **Files:** `packages/codegen/src/workspace/local-workspace.ts:210-218`
- **Fix:** When `allowedCommands === undefined`, default to `['git','node','npm','yarn','pnpm','tsc','eslint','prettier','jest','vitest','rg','grep','find']`.
- **Acceptance:** Tests — `runCommand('curl', …)` rejects when allowedCommands not set; opt-out path documented.

### SEC-08: Default cost ceiling for un-guardrailed runs
- **Phase:** refactor (~4h) · **Expert:** dzupagent-agent-dev
- **Files:** `packages/agent/src/agent/run-engine.ts:186-193`
- **Fix:** When `config.guardrails` undefined, install a default `IterationBudget(50_000 input, 50_000 output)`; lower default `maxIterations` to 5.
- **Acceptance:** Tests — bare `new Agent({...})` followed by 100k-token loop is aborted at the budget threshold.

### SEC-11/12: Git ref validator + `--end-of-options`
- **Phase:** refactor (~3h) · **Expert:** dzupagent-codegen-dev
- **Files:** `packages/codegen/src/git/{git-executor.ts:285-336,git-worktree.ts:52-66,110-115}`
- **Fix:** Add `validateRefName(name)` that accepts `/^[A-Za-z0-9._\/][A-Za-z0-9._\/-]*$/`; insert `--end-of-options` (Git ≥2.24) before user-supplied positionals; reject leading `-`.
- **Acceptance:** Tests — `--upload-pack=…` and `-c core.fsmonitor=…` rejected.

### ARCH-05: Unify PII detection on `@dzupagent/security`
- **Phase:** refactor (~4–8h) · **Expert:** dzupagent-architect
- **Files:** `core/src/security/pii-detector.ts` (deprecate) + `security/src/pii/detector.ts` (canonical)
- **Fix:** Move `core` consumers to import from `@dzupagent/security`; re-export from `core/security` for back-compat with deprecation banner; merge pattern sets so neither loses coverage.
- **Acceptance:** Tests — every former `core` PII type is detected by `security` detector.

### AGENT-101: Wire `ComplianceAuditLogger` producer at LLM-call boundary
- **Phase:** refactor (~6h) · **Expert:** dzupagent-core-dev
- **Files:** `core/src/security/audit/index.ts` + `agent/src/agent/run-engine.ts:517` + new `core/src/security/audit/postgres-audit-store.ts`
- **Fix:** Emit one audit entry per LLM call (model, tokens, costCents, runId, tenantId, prompt/response hashes). Ship Postgres store. Wire at run-engine call site.
- **Acceptance:** Test — every test agent run produces ≥1 audit row in mock store.

### AGENT-105: Decompose `recovery-attempt-handler.ts`
- **Phase:** refactor (~6h) · **Expert:** dzupagent-connectors-dev
- **Files:** `agent-adapters/src/recovery/recovery-attempt-handler.ts` (658 LOC)
- **Fix:** Split into `attempt-tracker.ts`, `escalation-policy.ts`, `attempt-result-classifier.ts`. Keep `handler.ts` <250 LOC orchestrator.
- **Acceptance:** All existing recovery tests pass; new per-module unit tests cover state transitions.

### AGENT-106: Decompose `codex-adapter.ts`
- **Phase:** refactor (~8h) · **Expert:** dzupagent-connectors-dev
- **Files:** `agent-adapters/src/codex/codex-adapter.ts` (1125 LOC)
- **Fix:** Pull SSE-thread runner, writeback, capability map, abort/timeout into siblings under `codex/`. Adapter file <400 LOC.
- **Acceptance:** No new test failures; line count target met.

### AGENT-107: Add eval regression gate
- **Phase:** refactor (~4h) · **Expert:** dzupagent-test-dev
- **Files:** `evals/src/orchestrator/benchmark-orchestrator.ts`
- **Fix:** Add `regressionGate({ baselineRun, threshold })` that exits non-zero when `score - baseline < threshold`. Wire into `yarn verify`.
- **Acceptance:** Synthetic regression test fails CI; non-regressing run passes.

### CONSUMER-01: Ship `.d.ts` for `@dzupagent/flow-compiler`
- **Phase:** quick (~1h) · **Expert:** dzupagent-architect
- **Files:** `packages/flow-compiler/tsup.config.ts` (add `dts: true` if missing) + `packages/flow-compiler/package.json` (verify `types` entry)
- **Why:** Consumers (codev-app) see `Could not find a declaration file for module '@dzupagent/flow-compiler'`.
- **Acceptance:** `yarn build --filter=@dzupagent/flow-compiler` produces `dist/index.d.ts`; consumer typecheck clean.

### SEC-03: Scraper SSRF guard
- **Phase:** major (~16h) · **Expert:** dzupagent-connectors-dev
- **Files:** `packages/scraper/src/{http-fetcher.ts:55-85,scraper.ts:180-190}`
- **Fix:** Port `connectors/src/http/http-connector.ts` SSRF pattern: reject loopback / link-local / RFC1918 / IPv6 ULA / DNS-rebinding; require allowlist when `NODE_ENV==='production'`.
- **Acceptance:** Tests — `scrape("http://169.254.169.254/...")` rejected; `scrape("http://localhost:8080/...")` rejected unless allowlisted.

### SEC-05: Zod everywhere across server routes
- **Phase:** major (~24h) · **Expert:** dzupagent-server-dev
- **Files:** 19 route files in `packages/server/src/routes/*.ts`
- **Fix:** Per-handler Zod schema; `safeParse`; 400 on failure. Mirror `RunCreateSchema` pattern.
- **Acceptance:** Contract tests for each handler; `(await c.req.json()) as` count drops to 0.

### AGENT-102: Implement OpenAI tool-calling + tests
- **Phase:** major (~16h) · **Expert:** dzupagent-connectors-dev
- **Files:** `agent-adapters/src/openai/openai-adapter.ts:84` + new `__tests__/openai-adapter.test.ts`
- **Fix:** Implement OpenAI function-calling spec; flip `supportsToolCalls: true`; SSE+tool-calls+structured-output test scenarios.
- **Acceptance:** Tests cover happy path + tool error + structured output + abort.

### AGENT-103: Split `pipeline-runtime.ts`
- **Phase:** major (~16h) · **Expert:** dzupagent-agent-dev
- **Files:** `agent/src/pipeline/pipeline-runtime.ts` (1044 LOC)
- **Fix:** Use existing `pipeline-runtime/` helper modules; extract branch-merge / edge-resolution / retry / classify. Main file <400 LOC.
- **Acceptance:** All pipeline tests green; per-helper unit tests added.

### AGENT-104: Split `delegating-supervisor.ts`
- **Phase:** major (~16h) · **Expert:** dzupagent-agent-dev
- **Files:** `agent/src/orchestration/delegating-supervisor.ts` (847 LOC)
- **Fix:** Decompose by responsibility: delegation policy / specialist selection / merge + extract `markCircuitBreakerRecorded` (149) and `guardDuplicateSpecialistAssignmentIds` (117).
- **Acceptance:** All supervisor tests green; per-module tests added.

### CONSUMER-02 / CONSUMER-03: API drift in `memory.ConsolidationResult` and `core.DzupEventBus`
- **Phase:** refactor (~6h) · **Expert:** dzupagent-core-dev
- **Why:** Codev-app fails typecheck because `ConsolidationResult` lost `pruned/merged` and gained `summarized/summaries/provenance/durationMs`; `DzupEventBus` no longer assignable to `DzupEventBusAdapter`.
- **Fix:** Either keep additive shape (re-add `pruned/merged` as optional w/ deprecation), bump minor and document in `MIGRATION.md`, and fix EventBus contract drift.
- **Acceptance:** Codev-app typecheck passes against current dzupagent dist.

---

## Medium (selected — full list in CROSS-DOMAIN-MATRIX)

### Architecture sweep

- **ARCH-02** Bump `adapter-rules` to `0.2.0` (1h, dzupagent-architect)
- **ARCH-03** Migrate cross-deps to `workspace:^` (8h, dzupagent-architect)
- **ARCH-04** Trim `core/index.ts` (223 exports) and `agent/index.ts` (210) to stable surface only; CI gate <100 (8h)
- **ARCH-06** Collapse 5 rate-limiter implementations to 1 canonical (8h)
- **ARCH-07** Collapse 2 circuit-breakers; orchestration version composes core's (4h)
- **ARCH-08** Tier-driven boundary enforcement: drive `boundary-enforcement.test.ts` from `config/package-tiers.json`; full-graph DFS for circulars (8h, dzupagent-test-dev)
- **ARCH-12/13/17** Move `code-edit-kit`/`app-tools` deps from peer to dep where appropriate (2h)
- **ARCH-14** Publish `MemoryStore`/`ToolRegistry`/`ModelProvider` interfaces from `runtime-contracts/extension` (8h)

### Agent / LLM-loop sweep (Medium-band)

- **AGENT-108/109** Replace setTimeout+addEventListener retry-sleep with `AbortablePromise.delay`; aggregate tool-batch errors via `AggregateError` (1h each)
- **AGENT-110** Lift `MemoryEvictionPolicy` to `MemoryServiceLike.prune({ttl, maxItems, byStrength})` contract (6h)
- **AGENT-111** Quota check in `staged-writer.ts` (4h)
- **AGENT-112** Emit `context:compression_failed`; fail-loud on second consecutive failure (1h)
- **AGENT-113** Default `TiktokenCounter` for Claude/OpenAI/Gemini; warn on char/4 fallback (4h)
- **AGENT-114/115** Expand prompt-injection corpus + add NER fallback to PII detector (8h combined)
- **AGENT-116** Unify stuck-detector behind `StuckDetectorPort` (4h)
- **AGENT-117** Verify checkpoint store on startup (1h)
- **AGENT-118** Split `recovery-copilot.ts` (679) (8h)
- **AGENT-119** Extract shared `parseSSE` to `agent-adapters/src/utils/sse.ts` (1h)
- **AGENT-120** Consolidate `cross-provider-handoff` and `recovery-loop-runner` (6h)
- **AGENT-121/122** Add `PostgresListenApprovalStateStore` (LISTEN/NOTIFY); `WebhookDispatcher` w/ retry+DLQ (8h combined)
- **AGENT-123/124/125** Implement cross-encoder reranker; hybrid retrieval (BM25+vector+RRF); retrieval-quality scorer (16h+ combined)
- **AGENT-126/127** Document task-router weights + decompose capability-router (6h)

### Code/server sweep

- **CODE-04/05/06/16/24** Test coverage uplift:
  - `memory/retrieval/*` per-file tests (16h+)
  - Restore `security/src/prompt-injection/fixtures/`; per-file tests (8h)
  - `agent/src/orchestration/team/*` per-file tests (16h+)
  - Server runtime test gap (16h+)
- **CODE-02/17/18** Split `executeStreamingToolCall`, slim `executeGenerateRunInner`, extract `runToolLoop` helpers (24h combined)
- **CODE-03** Strategy-pattern refactor of `planSync` (8h)
- **CODE-09** Slim DzipAgent constructor (4h)
- **CODE-11/12/13/14** Split server routes/runs (968), routes/compile (782), runtime/run-worker-stages (798), cli/doctor (715) (24h combined)
- **CODE-19/20/21** Extract from `delegating-supervisor`, `codex-adapter`, `claude-adapter mapRawEvent` (20h combined)
- **CODE-22/23** Split `memory-space-manager` (950) and `convention-extractor` (748) (16h combined)
- **CODE-26/25/7** Visitor registry for `flow-compiler/semantic`; split `flow-dsl/normalize`; finish `flow-ast/{validate,parse}` migration (40h combined)
- **CODE-31** Document `no-new-func` trust boundary in `flow-compiler/semantic.ts:324` + add runtime guard that input has been schema-validated (4h)

### Security low-band

- **SEC-10** Constant-time API-key compare (3h)
- **SEC-14** Migrate `learning.ts` to Zod (4h, subsumed by SEC-05 once that lands)
- **SEC-15** Default-encrypted memory + key-rotation runbook (16h)
- **SEC-16** SIGTERM→SIGKILL escalation in `mcp-client.spawnWithStdin` (2h)

---

## Low (do during nearby sprints)

- **AGENT-128/129/130** Tool-loop top split / MemoryHealer scheduler / FrozenSnapshotManager
- **AGENT-131..135** Eval / HITL / RAG / adapter test thickening
- **CODE-10/15/29/30** `console.*` → logger; `as never` DOM probe → `as Record<string, unknown>`; CLI doctor split
- **SEC-18..22** body-limit consts; `as never` typed Variables; `execSync` → `execFile`; `which` portability; run npm audit manually
- **ARCH-09/11/15/16/18/19/20** OrchestratorFacade reconcile; optional-peer for create-dzupagent; dead `playground/` shell deletion; `connectors` per-driver split or peer-optional; `apache-arrow` peer in `memory-ipc`; parallel-executor convergence

---

## Suggested Sprint Sequencing (~7 dev-weeks for High-band closure)

| Week | Focus | Items |
|------|-------|------|
| 1 | Critical + High security quick wins | SEC-01, SEC-02, SEC-09, SEC-13, SEC-17, ARCH-01, CONSUMER-01 |
| 2 | High-impact code clean-up | CODE-01 `AppEnv`, CODE-21 dispatch-table, AGENT-108/109/112/117/119/126 quick wins |
| 3 | Hardening | SEC-04 Express, SEC-07 workspace allow-list, SEC-08 budget defaults, SEC-11/12 git refs |
| 4 | Architecture consolidation | ARCH-05 PII unify, ARCH-06 rate-limiter unify, ARCH-07 circuit-breaker unify, ARCH-08 tier-driven boundary |
| 5 | Agent compliance + tests | AGENT-101 audit log producer, AGENT-107 regression gate, CODE-04 retrieval tests, CODE-05/24 security fixtures |
| 6–7 | Major refactors | AGENT-103 pipeline-runtime split, AGENT-104 supervisor split, AGENT-106 codex split, CODE-11/12 server route splits, SEC-05 Zod sweep |
| 8+ | Major net-new | SEC-03 SSRF, AGENT-102 OpenAI tool-calls, AGENT-124 hybrid retrieval, ARCH-18 connectors split |

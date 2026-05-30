# Major Changes (P3 / 16h+ each) — DzupAgent run-001

Multi-day or multi-week initiatives. Each is self-contained and ready for a focused sprint.

---

## MC-01 (SEC-03) Scraper SSRF guard
**Agent:** dzupagent-connectors-dev · **Effort:** 16h
**Files:** `packages/scraper/src/{http-fetcher.ts,scraper.ts}`
**Why:** No private-IP / loopback / metadata-IP guard. Prompt-injected agent could exfiltrate AWS credentials via `169.254.169.254` or hit internal services on `localhost`.
**Change:**
1. Port the SSRF pattern from `connectors/src/http/http-connector.ts`.
2. Reject loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`), RFC1918 (`10/8`, `172.16/12`, `192.168/16`), IPv6 ULA (`fc00::/7`).
3. Resolve DNS once and re-check the resolved IP (DNS rebinding mitigation).
4. Require an explicit allowlist when `process.env.NODE_ENV === 'production'`; warn (don't block) in dev.
5. Add integration tests with mock DNS resolver.
**Acceptance:** Tests — `scrape("http://169.254.169.254/...")` rejected; `scrape("http://localhost:8080/...")` rejected unless allowlisted; rebinding test (DNS returns public IP first then private) is rejected.

---

## MC-02 (SEC-05) Zod everywhere across server routes
**Agent:** dzupagent-server-dev · **Effort:** 24h
**Files:** 19+ files in `packages/server/src/routes/*.ts`: `agents.ts`, `benchmarks.ts`, `clusters.ts`, `deploy.ts`, `human-contact.ts`, `learning.ts` (3 handlers), `mailbox.ts`, `mcp.ts` (2), `personas.ts`, `presets.ts`, `prompts.ts`, `registry.ts`, `schedules.ts`, etc.
**Change:** For each handler: define Zod schema, replace `(await c.req.json()) as Type` with `safeParse`, return 400 on failure. Mirror `RunCreateSchema` pattern from `routes/runs.ts`. Add contract tests.
**Acceptance:** `rg "(await c\\.req\\.json\\(\\)) as" packages/server/src/routes/` returns 0; per-route Zod schema; 400 tests for each handler.

---

## MC-03 (SEC-15) Default-encrypt memory + key rotation runbook
**Agent:** dzupagent-core-dev · **Effort:** 16h
**Files:** `packages/memory/src/encryption/*` + `MemoryServiceFactory`
**Change:**
1. Make `EncryptedMemoryService` the default wrapper in `MemoryServiceFactory` when `NODE_ENV === 'production'`.
2. Emit `FRAMEWORK_MEMORY_ENCRYPTION_DISABLED` warning at startup if the wrap is opted-out.
3. Add a key-rotation runbook in `dzupagent/docs/security/memory-key-rotation.md` covering: dual-write window, re-encrypt batch job, key version metadata.
4. Add round-trip test that store contents are unreadable without the key.
**Acceptance:** New default produces encrypted-at-rest stores; key-rotation script + tests; runbook present.

---

## MC-04 (CODE-04) Memory retrieval per-file tests
**Agent:** dzupagent-test-dev · **Effort:** 16h
**Files:** `packages/memory/src/retrieval/{cross-encoder-rerank,fts-search,graph-search,rrf-fusion,vector-search,vector-store-search}.ts`
**Why:** Six recall-hot files have **zero** matching `.test.ts`. Aggregate tests don't isolate behaviour.
**Change:** Per-file unit tests with deterministic fixtures (mock vector store, mock graph index). Reranker: golden cases for top-k stability under tied scores. Fusion: synthetic ranked lists with known fusion result.
**Acceptance:** Each of the 6 files has a sibling `*.test.ts` with ≥5 cases; coverage on those files >80%.

---

## MC-05 (CODE-06) `agent/src/orchestration/team/*` per-file tests
**Agent:** dzupagent-test-dev · **Effort:** 20h
**Files:** All `team/team-runtime-*.ts` split modules, `team/patterns/*.ts`, `topology/*.ts`, `routing/*.ts`, `merge/*.ts`, `contract-net/*.ts`, `provider-adapter/*.ts` (25+ files)
**Change:** Per-file `<file>.test.ts` for leaf primitives — bid strategies, routing strategies (`hash-routing`, `llm-routing`, `round-robin-routing`, `rule-based-routing`), merge strategies (`all-required`, `first-wins`, `use-partial`).
**Acceptance:** ≥20 new test files; each leaf primitive covered.

---

## MC-06 (CODE-07) Finish `flow-ast/{validate,parse}` migration
**Agent:** dzupagent-architect · **Effort:** 24h
**Files:** `packages/flow-ast/src/{validate.ts,parse.ts}` (1410 + 1077 LOC)
**Change:** Helpers already exist (`validation-descriptors.ts`, `validation-helpers.ts`, `validation-traversal.ts`); finish per-node-kind migration. Same for parse. Both files target ≤300 LOC each.
**Acceptance:** Files reduced ≥50%; existing tests green; new per-helper tests added.

---

## MC-07 (CODE-13) Split `run-worker-stages.ts`
**Agent:** dzupagent-server-dev · **Effort:** 16h
**File:** `packages/server/src/runtime/run-worker-stages.ts` (798 LOC)
**Change:** Extract per-stage modules (one file per stage), plus `stages/index.ts` barrel. Worker becomes a sequencer.

---

## MC-08 (CODE-16) Server runtime test coverage uplift
**Agent:** dzupagent-test-dev · **Effort:** 24h
**Files:** 126 of 202 `server/src/` files lack tests
**Change:** Prioritise `runtime/*` and `lifecycle/*` (durability paths). Add fixtures for `run-worker-stages`. Goal: ≥70% file coverage in `runtime/` and `lifecycle/`.

---

## MC-09 (CODE-28) Reduce `as unknown` density via discriminated unions
**Agent:** dzupagent-architect · **Effort:** 24h
**Files:** distributed across 32 packages (143 cases total)
**Change:** Per-package audit. Many cases collapse once CODE-01 lands. For the remainder, introduce discriminated unions (e.g. `type ToolResult = { kind: 'success'; value: …} | { kind: 'error'; message: string }`).
**Acceptance:** Density reduced from 143 → ≤50.

---

## MC-10 (ARCH-10) Split top god-objects
**Agent:** dzupagent-architect · **Effort:** 40h
**Files:** `flow-ast/validate.ts` (1410), `agent-adapters/codex/codex-adapter.ts` (1125), `agent/run-engine.ts` (1096), `flow-ast/parse.ts` (1077), `agent/pipeline/pipeline-runtime.ts` (1044), `flow-dsl/normalize.ts` (1018)
**Change:** Per-node-type submodules for AST trio; phase split (preflight/execute/finalize) for `run-engine`; provider-specific submodules for `codex-adapter`. Each file ≤500 LOC.
**Note:** Subsumes MC-06, AGENT-103, AGENT-106 — execute as a coordinated track if they all run.

---

## MC-11 (ARCH-18) Split `connectors` per driver (or peer-optional)
**Agent:** dzupagent-architect · **Effort:** 24h
**File:** `packages/connectors/package.json` (9 DB drivers as direct deps)
**Change:** Either split into `connectors-postgres`, `connectors-mysql`, `connectors-mssql`, `connectors-snowflake`, `connectors-duckdb`, `connectors-sqlite`, `connectors-bigquery`, `connectors-clickhouse` — OR move all 9 drivers to `peerDependencies` with `optional: true`. Add `loadDriver(name)` lazy import.
**Acceptance:** Consumers that use only one driver install only that driver.

---

## MC-12 (AGENT-102) OpenAI tool-calling + tests
**Agent:** dzupagent-connectors-dev · **Effort:** 16h
**File:** `packages/agent-adapters/src/openai/openai-adapter.ts:84` + new `__tests__/openai-adapter.test.ts`
**Change:**
1. Implement OpenAI function-calling spec (request: `tools` + `tool_choice`; response: `tool_calls` array).
2. Map to internal `ToolCall` event shape.
3. Flip `supportsToolCalls: true`.
4. Add tests covering: SSE stream, tool-call event, tool error, structured output (JSON mode), abort signal.
**Acceptance:** Test file ≥15 cases; all pass; cost-tracking populates correctly.

---

## MC-13 (AGENT-103) Split `pipeline-runtime.ts`
**Agent:** dzupagent-agent-dev · **Effort:** 16h
**File:** `packages/agent/src/pipeline/pipeline-runtime.ts` (1044 LOC)
**Change:** Use existing `pipeline-runtime/` helper modules; extract branch-merge / edge-resolution / retry / classify. Main file ≤400 LOC.
**Acceptance:** Pipeline tests green; per-helper unit tests added; LOC target met.

---

## MC-14 (AGENT-104) Split `delegating-supervisor.ts`
**Agent:** dzupagent-agent-dev · **Effort:** 16h
**File:** `packages/agent/src/orchestration/delegating-supervisor.ts` (847 LOC)
**Change:** Decompose by responsibility — delegation policy / specialist selection / merge. Plus extract `markCircuitBreakerRecorded` (149) and `guardDuplicateSpecialistAssignmentIds` (117) helpers.
**Acceptance:** Supervisor tests green; per-module unit tests; LOC target ≤350.

---

## MC-15 (AGENT-124) Hybrid retrieval (BM25 + vector + RRF)
**Agent:** dzupagent-connectors-dev · **Effort:** 24h
**File:** `packages/rag/src/retriever.ts` + new `bm25-retriever.ts` + `hybrid-retriever.ts`
**Change:**
1. Implement BM25 retriever over the corpus (e.g. via `@elastic/elasticsearch` or local in-memory `okapi-bm25`).
2. Wire RRF fusion (already exists in `memory/src/retrieval/rrf-fusion.ts` — extract to a shared util) over BM25 + vector hits.
3. Expose `HybridRetriever` as a config option.
4. Tests: synthetic corpus where BM25 and vector each score differently, fusion picks both top hits.
**Acceptance:** New retriever produces ≥10pp recall@k uplift over vector-only on the test corpus.

---

(End of major changes — 15 items, ~360 hours total.)

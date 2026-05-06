# DzupAgent Monorepo — Architecture Audit (run-001, 2026-05-05)

Scope: `dzupagent/packages/*` (32 packages). Sibling shared-kit (`shared-kit/dzupagent-kit`, `shared-kit/shared-app-kit`) consulted for extraction candidates.

Sprint B / MC sprint claims independently verified below (some discrepancies).

---

## 1. Layer Dependency Graph (textual, verified)

Each row lists production runtime imports (excluding `__tests__/__benches__`) actually present in source, NOT just declared dependencies.

| Layer | Package | dzupagent-scope deps (real, prod) |
| --- | --- | --- |
| L0 Foundation (types-only) | `adapter-types` | (none) |
| L0 | `agent-types` | (none) |
| L0 | `eval-contracts` | (none) |
| L0 | `runtime-contracts` | (none) |
| L1 Core | `cache` | (none) |
| L1 Core | `security` | (none) |
| L1 Core | `core` | `agent-types`, `runtime-contracts` |
| L1 Core | `memory-ipc` | (none) |
| L1 Core | `context` | `memory-ipc` |
| L1 Core | `otel` | `core` |
| L2 Mid | `memory` | `agent-types`, `cache` (+`memory-ipc` peer) |
| L2 Mid | `rag` | `core`, `memory` |
| L2 Mid | `scraper` | `core` |
| L2 Mid | `hitl-kit` | (none) |
| L2 Mid | `flow-ast` | (none) |
| L2 Mid | `flow-dsl` | `flow-ast` |
| L2 Mid | `flow-compiler` | `flow-dsl` (+`core`,`flow-ast` peer) |
| L3 High | `agent` | `adapter-types`, `agent-types`, `context`, `core`, `memory`, `memory-ipc`, `security` |
| L3 High | `codegen` | `adapter-types`, `core` |
| L3 High | `connectors` | `core`, `flow-ast` |
| L3 High | `connectors-browser` | `core` |
| L3 High | `connectors-documents` | `core` |
| L3 High | `code-edit-kit` | (peer: `codegen`, `core`) |
| L3 High | `app-tools` | (peer: `code-edit-kit`, `core`, `hitl-kit`) |
| L4 Adapters | `adapter-rules` | `adapter-types` |
| L4 Adapters | `agent-adapters` | `adapter-rules`, `adapter-types`, `agent`, `agent-types`, `core`, `runtime-contracts` |
| L5 Top | `evals` | `core`, `eval-contracts` |
| L5 Top | `express` | `agent`, `core` |
| L5 Top | `server` | `agent`, `agent-adapters`, `app-tools`, `context`, `core`, `eval-contracts`, `flow-ast`, `flow-compiler`, `hitl-kit`, `memory-ipc`, `otel`, `memory` (phantom — see ARCH-04) |
| L5 Top | `testing` | `agent`, `core` |
| L5 Top | `test-utils` | `core` |
| L5 Top | `create-dzupagent` | (none real; dynamic-import strings only) |

The graph is acyclic on the L0→L5 axis. No package below L3 imports anything from L4/L5 in production sources.

---

## 2. Layer Violations Table

| ID | Severity | Importer | Imports | File(s) | Status |
| --- | --- | --- | --- | --- | --- |
| (none) | – | – | – | – | No production layer violations observed. |

A previously suspected `codegen → @dzupagent/agent` and `codegen → @dzupagent/server` import was investigated and confirmed to be **string fixtures inside guardrail tests** (`codegen/src/__tests__/guardrails.test.ts`, `guardrail-rules.test.ts`) — these are intentionally written-as-violations to assert the guardrail rejects them. Not real edges.

The `playground` package described in legacy docs / Sprint B narrative no longer has a `package.json` or `src/`; only `packages/playground/docs/` remains. Code now lives under `agent/src/orchestration/playground/*`. Verified.

---

## 3. Circular Dependency List

| Pair | Status |
| --- | --- |
| `core ↔ agent-adapters` | **None.** `core` declares zero `@dzupagent/*` deps in package.json. |
| `agent ↔ memory` | **None.** `memory` does not import `agent`. |
| `agent ↔ context` | **None.** `context` only imports `memory-ipc`. |
| `flow-compiler ↔ flow-dsl ↔ flow-ast` | **None.** Linear chain `flow-compiler → flow-dsl → flow-ast`. |
| Any other pair | **None observed** by greppping `from '@dzupagent/...'` per package and cross-checking. |

`madge` was not executed to keep runtime under 3 minutes; manual import-graph inspection of all 32 packages found no cycles. Existing `boundary-enforcement.test.ts` covers the most likely circular pair (`core ↔ agent-adapters`) at the package.json level. **Recommendation:** extend the static check (ARCH-08).

---

## 4. shared-kit Extraction Candidates (top 10)

Existing shared-kit already provides `logger`, `crypto-utils`, `auth-*`, `express-utils`, `webhook-delivery-kit`, `dzupagent-trace`, `memory-kit`, `event-bridge`, `orchestration-kit`. Gaps below.

| # | Candidate | Where today | Why extract | Target package |
| --- | --- | --- | --- | --- |
| 1 | **PII detection / redaction** | `core/src/security/pii-detector.ts` (97 LOC) **AND** `security/src/pii/detector.ts` (79 LOC) — duplicated | Two regex tables, two sanitize functions, two test sets | `shared-app-kit/pii-detector` (new) |
| 2 | **Secrets scanner** | `core/src/security/secrets-scanner.ts` (153 LOC) plus partial regex set in `security/src/prompt-injection/detector.ts` | Same patterns repeated | merge into `shared-app-kit/pii-detector` |
| 3 | **Token-bucket / rate limiter** | 5 implementations: `core/src/rate-limit/token-bucket.ts`, `agent/src/guardrails/distributed-rate-limiter.ts`, `agent/src/mailbox/rate-limiter.ts`, `agent-adapters/src/http/rate-limiter.ts`, `server/src/middleware/rate-limiter.ts`, `server/src/notifications/mail-rate-limiter.ts` | Cross-cutting infra; clear duplication | `shared-app-kit/rate-limit` (new) |
| 4 | **Circuit breaker** | `core/src/llm/circuit-breaker.ts`, `agent/src/orchestration/circuit-breaker.ts` | Two parallel impls | `shared-app-kit/resilience` (new) — combine with retry/backoff |
| 5 | **Retry / exponential backoff** | Repeated inline in `pipeline-runtime.ts`, `tool-loop.ts`, `recovery-loop-runner.ts`, `replay-controller.ts`, `skill-chain-executor.ts` (≥5 sites) | Pure utility, zero dzupagent semantics | `shared-app-kit/resilience` |
| 6 | **Cost / token-pricing tables** | `core/src/...` (cost calc surfaces in `@dzupagent/core/orchestration`) consumed by adapters, evals, server | Pricing data is generic across products | `shared-app-kit/llm-pricing` (new) |
| 7 | **Tool-format adapter (OpenAI ↔ Anthropic ↔ MCP shape)** | `core/src/formats/tool-format-adapters.ts` | Mostly schema mapping; useful for any LLM consumer | `shared-app-kit/llm-tool-formats` (new) |
| 8 | **Hash utilities** | `agent-adapters/src/dzupagent/hash-utils.ts`, `cache/src/key-generator.ts`, `agent/src/snapshot/agent-snapshot.ts`, `codegen/src/vfs/checkpoint-manager.ts` | Same SHA-256 / canonical-stringify pattern | extend `shared-kit/crypto-utils` |
| 9 | **OpenTelemetry bootstrap helper** | `dzupagent/packages/otel` is already 15K LOC and largely a wrapper over OTel SDK | A `shared-kit/otel-setup` already exists; consolidate non-agent-specific portions | `shared-kit/otel-setup` |
| 10 | **Audit logger** | `core/src/security/audit/audit-logger.ts` plus ad-hoc loggers in evals | Generic append-only structured log | extend `shared-kit/logger` (add audit channel) |

---

## 5. God-Objects (top 10 by LOC, src only — tests excluded)

| Rank | File | LOC | Notes |
| --- | --- | --- | --- |
| 1 | `flow-ast/src/validate.ts` | 1410 | Single mega-validator; split per node type |
| 2 | `agent-adapters/src/codex/codex-adapter.ts` | 1125 | Concrete adapter; needs feature-folder split |
| 3 | `agent/src/agent/run-engine.ts` | 1096 | Core run loop; extract phases (preflight / execute / finalize) |
| 4 | `flow-ast/src/parse.ts` | 1077 | Token/tree producer; split per construct |
| 5 | `agent/src/pipeline/pipeline-runtime.ts` | 1044 | Pipeline orchestrator; already partially split — finish |
| 6 | `flow-dsl/src/normalize.ts` | 1018 | DSL→AST normalizer; split per node |
| 7 | `server/src/routes/runs.ts` | 968 | HTTP route monolith; should be ~200 LOC after extracting handlers |
| 8 | `agent/src/workflow/workflow-builder.ts` | 966 | Builder god-object; consider step-class plug-in registry |
| 9 | `memory/src/sharing/memory-space-manager.ts` | 950 | Shared memory orchestrator |
| 10 | `agent/src/agent/dzip-agent.ts` | 942 | The DzupAgent class itself |

Public API surface (export count from `index.ts`):

| Package | `index.ts` LOC | top-level exports |
| --- | --- | --- |
| `core` | 874 | **223** |
| `agent` | 821 | **210** |
| `agent-adapters` | 587 | **161** |
| `memory` | 423 | **137** |

Both `core/index.ts` and `agent/index.ts` are themselves bigger than the largest typical "god class" file would be.

`OrchestratorFacade` was claimed at 279 LOC in MEMORY but the file at `agent-adapters/src/facade/orchestrator-facade.ts` is **468 LOC** today. Either the split regressed or the memory note was off-by-one. Flagged as ARCH-09.

---

## 6. Findings (`ARCH-NN`)

### ARCH-01 — Phantom dependency: `server → @dzupagent/memory` (P1)
- File: `dzupagent/packages/server/src/routes/memory-sync.ts:13–20`
- `server` does `import type { SharedMemoryNamespace, SyncSession, … } from '@dzupagent/memory'` but `server/package.json` does not list `@dzupagent/memory` in `dependencies` or `peerDependencies`.
- Why: builds work today only because the workspace hoists `memory`. Outside the workspace (npm/yarn install of `@dzupagent/server` alone), TS resolution will fail.
- Fix: add `"@dzupagent/memory": "0.2.0"` to `server`'s `dependencies` (or move the route into `memory` and re-export).
- Phase: **quick**.

### ARCH-02 — Internal version pin drift: `adapter-rules` is `0.1.0` (P2)
- `packages/adapter-rules/package.json` is `"version": "0.1.0"`; every other dzupagent package is `0.2.0`. `agent-adapters` declares `"@dzupagent/adapter-rules": "0.1.0"`.
- Why: future consumer pulling `@dzupagent/agent-adapters@0.2.x` may end up with mismatched adapter contracts.
- Fix: bump `adapter-rules` to `0.2.0` and update the dep in `agent-adapters`.
- Phase: **quick**.

### ARCH-03 — Pinned exact versions instead of `workspace:^` (P2)
- 70 cross-package deps are `"0.2.0"` (exact). None use `workspace:^` or `workspace:*`.
- Why: every minor bump requires touching 70 lines across 32 package.jsons, increasing drift risk and CI churn. `workspace:^` lets Yarn rewrite at publish time and prevents accidental version-mismatch.
- Fix: convert dzupagent-scope cross-deps to `workspace:^`. Yarn 4 supports it; the sibling `shared-kit` already follows this pattern.
- Phase: **refactor**.

### ARCH-04 — God public surface in `core` and `agent` (P2)
- `core/src/index.ts` 874 LOC / 223 exports; `agent/src/index.ts` 821 LOC / 210 exports.
- Subpath exports already exist (`./advanced`, `./orchestration`, `./security`, `./facades` for core; `./agent`, `./orchestration`, `./pipeline`, `./workflow`, `./tools`, `./compat` for agent), so the consumer story is fixable without breakage.
- Fix: shrink `index.ts` to the **stable** surface only (move advanced exports to `./advanced` only) and add a CI check that fails when `index.ts` exceeds 100 exports.
- Phase: **refactor**.

### ARCH-05 — Duplicated PII / secrets logic (P1)
- `core/src/security/pii-detector.ts` (97 LOC) and `security/src/pii/detector.ts` (79 LOC) both emit different `[REDACTED-…]` markers, different type sets (one has `IBAN`/`JWT`, the other does not), different return types.
- Risk: caller-dependent leak coverage. Auditors who switch from one to the other lose detections silently.
- Fix: keep `@dzupagent/security` as the single source, deprecate `core/src/security/pii-detector.ts`, re-export from `core` for back-compat.
- Phase: **refactor**.

### ARCH-06 — Five rate-limiter implementations (P2)
- `core/src/rate-limit/token-bucket.ts`, `agent/src/guardrails/distributed-rate-limiter.ts`, `agent/src/mailbox/rate-limiter.ts`, `agent-adapters/src/http/rate-limiter.ts`, `server/src/middleware/rate-limiter.ts`, `server/src/notifications/mail-rate-limiter.ts`.
- Risk: bug-fixes have to be applied 5 times; behaviour drifts; tests do not converge.
- Fix: one canonical token-bucket + leaky-bucket pair in `@dzupagent/core/rate-limit` (or new `shared-app-kit/rate-limit`); make all others adapt over it.
- Phase: **refactor**.

### ARCH-07 — Two circuit-breaker implementations (P2)
- `core/src/llm/circuit-breaker.ts` is consumed by adapters; `agent/src/orchestration/circuit-breaker.ts` is the orchestration variant.
- Fix: consolidate on the `core` version; the orchestration one should compose it (state-machine wrapper).
- Phase: **refactor**.

### ARCH-08 — Boundary tests do not enumerate all package pairs (P2)
- `testing/src/__tests__/boundary-enforcement.test.ts` only enforces 4 explicit `FORBIDDEN_DEP_RULES` (core→{agent,server,codegen,connectors}; agent-adapters→server; testing→server) and 1 circular pair (core↔agent-adapters).
- The architecture intends a strict L0→L5 layering. The test does not catch e.g. `cache → memory`, `flow-ast → flow-dsl`, or any other future regression.
- Fix: drive the rules from `config/package-tiers.json` (already present!): assert `pkg.tier <= dep.tier` for every declared dep. Replace the static rule list with a tier comparator. Add a circular-detection pass over the full graph (DFS, not the hand-written 1-pair list).
- Phase: **refactor**.

### ARCH-09 — `OrchestratorFacade` is 468 LOC, not 279 LOC (P3)
- `agent-adapters/src/facade/orchestrator-facade.ts` is currently 468 LOC. MEMORY note from MC sprint claims 279 LOC.
- Either Sprint B target slipped or memory note is stale. Verify and either continue the split or update the project record.
- Phase: **quick** (decide intent), then **refactor** if split is still wanted.

### ARCH-10 — Top god-objects exceed 1000 LOC (P2)
- `flow-ast/validate.ts` 1410, `codex-adapter.ts` 1125, `run-engine.ts` 1096, `parse.ts` 1077, `pipeline-runtime.ts` 1044, `normalize.ts` 1018.
- Each is a hand-rolled state machine or visitor.
- Fix: per-node-type submodules for the AST trio; phase split (preflight/execute/finalize) for `run-engine`; provider-specific submodules for `codex-adapter`.
- Phase: **major**.

### ARCH-11 — Dynamic-import phantom edges in `create-dzupagent` (P3)
- `create-dzupagent/src/bridge.ts:137` and `sync.ts:147` do `await import('@dzupagent/agent-adapters')`. Comment claims it is intentionally optional.
- Risk: tools that resolve the import graph statically (madge, depcheck) will flag this; but at runtime users get a confusing error.
- Fix: declare `@dzupagent/agent-adapters` as **optionalPeerDependency** (npm) or add a `peerDependenciesMeta.optional = true`.
- Phase: **quick**.

### ARCH-12 — `app-tools` declares all deps as peer, none as deps (P2)
- `app-tools/package.json` has `peerDependencies: { code-edit-kit, core, hitl-kit }` and zero `dependencies`.
- Risk: `import { … } from '@dzupagent/core'` in app-tools will fail in strict-peer-resolver environments (yarn pnp, pnpm strict). For runtime code that *uses* a package (vs. wraps a public contract), it should be a `dependency`.
- Fix: review which of the three are public-contract (peer) vs private-impl (dep). At minimum `core` should likely be a dep.
- Phase: **quick**.

### ARCH-13 — `code-edit-kit` peer-only with no deps (P2)
- Same shape as ARCH-12. Imports `@dzupagent/codegen` types; `codegen` is in peer.
- Fix: same as ARCH-12.
- Phase: **quick**.

### ARCH-14 — Extension surfaces lack a published abstract base (P2)
- Memory store: `memory/src/store-capabilities.ts` is implementation-flavoured (capabilities map) rather than a thin `MemoryStore` interface a 3rd party can implement.
- Tool registry / model provider: scattered across `core/src/llm/model-config.ts` and `core/src/tools/*` without one canonical `interface` exported from `@dzupagent/core/contracts`.
- Adapters DO have proper bases (`BaseSdkAdapter`, `BaseCliAdapter` in `agent-adapters/src/base/`) — so the pattern exists; just not consistently across extension points.
- Fix: introduce `@dzupagent/runtime-contracts/extension` with `MemoryStore`, `ToolRegistry`, `ModelProvider` abstract types.
- Phase: **refactor**.

### ARCH-15 — Per-package version 0.2.0 hand-pinned in 70 places (P3)
- See ARCH-03 — same root cause; the symptom is also that bumping is a 70-place edit. Tooling (`yarn version apply`) is unused.
- Fix: subsumed by ARCH-03.
- Phase: combined with ARCH-03.

### ARCH-16 — `playground` package directory is dead-code shell (P3)
- `packages/playground/` contains only `docs/`. No `package.json`, no `src/`. Workspace globs may still match it.
- Fix: delete the directory, or move its `docs/` to `dzupagent/docs/playground/`.
- Phase: **quick**.

### ARCH-17 — `app-tools` and `code-edit-kit` produce zero `@dzupagent/*` deps in package.json but import several (P2)
- ARCH-12/13 consequence: `npm publish` would ship a package whose declared graph is empty-but-broken.
- Phase: **quick** (ties into ARCH-12).

### ARCH-18 — `connectors` package mixes 9 third-party DB drivers as direct deps (P3)
- `connectors/package.json` declares `pg`, `mysql2`, `mssql`, `snowflake-sdk`, `duckdb`, `better-sqlite3`, `@google-cloud/bigquery`, `@clickhouse/client`, `node-sql-parser` as deps. 22K LOC package.
- Risk: every consumer of `@dzupagent/connectors` installs all 9 drivers (≈ hundreds of MB).
- Fix: split into `connectors-postgres`, `connectors-mysql`, etc., or move all drivers to `peerDependencies` with `optional: true`. Already done correctly for `puppeteer` in `scraper`.
- Phase: **major**.

### ARCH-19 — `memory-ipc` declares `apache-arrow` as a hard dep but is a "core" foundation (P3)
- 18K LOC for an IPC/Arrow adapter; the typescript-only `@duckdb/duckdb-wasm` is a peer (good) but `apache-arrow` is a dep. Consumers that don't need arrow pay the install cost.
- Fix: peer + optional.
- Phase: **refactor**.

### ARCH-20 — Two parallel-executor implementations (P3)
- `agent/src/agent/parallel-executor.ts` and `agent-adapters/src/orchestration/parallel-executor.ts` (748 LOC).
- Likely justified (different domains) but interfaces should converge — both should consume one `Semaphore`/`WorkerPool` primitive.
- Fix: factor a `concurrency` primitive into `core/src/orchestration` (already exports `Semaphore`); make both executors thin wrappers.
- Phase: **refactor**.

---

## 7. Quick / Refactor / Major Buckets

### Quick (< 1 day each)
- ARCH-01 add `@dzupagent/memory` to `server` deps
- ARCH-02 bump `adapter-rules` to `0.2.0`
- ARCH-09 reconcile OrchestratorFacade LOC vs memory note
- ARCH-11 mark optional peer for `agent-adapters` in `create-dzupagent`
- ARCH-12/13/17 fix peer-vs-dep for `app-tools`, `code-edit-kit`
- ARCH-16 delete dead `packages/playground/` shell

### Refactor (1–5 days each)
- ARCH-03/15 migrate to `workspace:^`
- ARCH-04 trim `index.ts` of `core` and `agent` to stable surface only
- ARCH-05 unify PII detection on `@dzupagent/security`
- ARCH-06 collapse 5 rate limiters into 1 canonical
- ARCH-07 collapse 2 circuit-breakers
- ARCH-08 tier-driven boundary enforcement + full circular-DFS
- ARCH-14 publish extension contracts
- ARCH-19 make `apache-arrow` peer/optional in `memory-ipc`
- ARCH-20 fold parallel-executors over a shared concurrency primitive

### Major (> 5 days each)
- ARCH-10 split god-objects (`flow-ast/validate`, `codex-adapter`, `run-engine`, `pipeline-runtime`, `flow-dsl/normalize`, `flow-ast/parse`)
- ARCH-18 split `connectors` per driver (or peer+optional all 9)

---

## 8. What Sprint B / MC Sprint Did Land (verified)

- Subpath exports landed for `agent` (12 entries) and `core` (7 entries) — verified in `package.json`.
- `playground` package code moved into `agent/src/orchestration/playground/*` — directory exists; old shell `packages/playground/` is empty (see ARCH-16).
- Boundary enforcement test exists at `testing/src/__tests__/boundary-enforcement.test.ts` (400 LOC) and `testing/src/__tests__/boundary/architecture.test.ts` (545 LOC, config-driven from `config/architecture-boundaries.json` + `config/package-tiers.json`).
- Base adapter contracts (`BaseSdkAdapter`, `BaseCliAdapter`) present — good extension story for adapters.
- `OrchestratorFacade` LOC claim **NOT verified** — file is 468 LOC, not 279 (ARCH-09).

---

## 9. Coverage Snapshot (Boundary Tests)

| Coverage axis | Current | Gap |
| --- | --- | --- |
| Forbidden-dep rules (declared) | 4 explicit rules over 6 packages | does not cover the L0→L5 generic rule (ARCH-08) |
| Circular detection (declared) | 1 hard-coded pair (`core ↔ agent-adapters`) | no full-graph DFS |
| Static import scan (real `from '@dzupagent/...'`) | 545 LOC `architecture.test.ts`; config-driven | covers the same 6-rule policy; needs tier-driven generalisation |
| Apps boundary | yes — apps must not import each other | OK |

---

## 10. Top-line Risks

1. **Phantom `server → memory` dep** breaks isolated install (ARCH-01).
2. **Five rate limiters** (ARCH-06) are an active bug-multiplier.
3. **Two PII detectors** (ARCH-05) leak coverage silently.
4. **Boundary test coverage is rule-listed, not tier-derived** (ARCH-08).
5. **`connectors` ships 9 DB drivers to every consumer** (ARCH-18).

---

End of audit.

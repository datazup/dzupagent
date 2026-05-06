# Major Changes (P3, 16h+ each) — full-dzupagent 2026-05-06

This file is the consolidated handoff for `/analyze-implement`. It pulls together
the major-change prompts from all four domain audits. Per-domain files with fuller
context still live alongside this one (`{code,security,architecture,agent}-major-changes.md`).

Each entry is self-contained: ID, finding ref, files, change description, validation, target agent, effort.
Items are ordered by dependency: security/cross-cutting first, then architecture extractions, then code quality.

Total: ~22 major changes, ~400-500h aggregate effort. Plan as sustained quarterly work.

---

## Sequencing

1. **Security MCs first** (MC-SEC-01 through MC-SEC-03) — close tenant-isolation and logging gaps; these are load-bearing for any architectural refactor above them.
2. **Package extractions next** (MC-ARCH-001 through MC-ARCH-006) — reduce core surface area before splitting god files.
3. **Cycle/layering gate** (MC-ARCH-010) — enforce in CI so subsequent work can't regress.
4. **Agent MCs** (MC-AGT-01 through MC-AGT-05) — interface-level changes that touch learning loops, security stacks, run state, and permission tiers.
5. **Code quality last** (MC-001 through MC-007) — file splits and test uplift; safest to defer until architecture is stable.

---

## MC-SEC-01 — Cross-cutting tenant-isolation framework

**Domain:** Security · **Findings:** SEC-001, SEC-009, SEC-013, SEC-022 · **Effort:** 24h
**Files:** `packages/server/src/` (all routes), `packages/agent/src/self-correction/`, `packages/memory/src/tenant-scoped-store.ts`

**Change:**
1. Introduce a typed `RequestScope` Hono variable (`tenantId`, `ownerId`, `role`, `apiKeyId`) populated by auth middleware; routes read `c.get('scope')` — never raw `c.get('apiKey' as never)`.
2. Make every store a `Scoped<T>` wrapper: expose `withScope(scope: RequestScope): ScopedStore<T>`; unscoped reads/writes throw at runtime and fail compile. Migrate all 7 CRUD stores (agents, personas, triggers, schedules, prompts, marketplace, clusters) plus `runStore`, `mailboxStore`, `clusterStore`, `catalogStore`.
3. Emit a `ComplianceAuditEntry` via `ComplianceAuditLogger` for every state-mutating handler.
4. Update RBAC defaults: `viewer` = GET only; `user` = GET + POST own resources; `operator` = + admin tooling; `admin` = full. New key issuance defaults to `'user'`.
5. Add `packages/server/src/__tests__/tenant-isolation.spec.ts` covering every route family: create as tenant A, request as tenant B, assert 404, assert audit entry.

**Validation:**
```bash
yarn workspace @dzupagent/server test --filter=tenant-isolation
yarn verify
```
**Target agent:** `dzupagent-server-dev` (implementation) + `dzupagent-architect` (ADR first)

---

## MC-SEC-02 — Centralised secrets-redaction logger

**Domain:** Security · **Findings:** SEC-019, SEC-020 · **Effort:** 12h
**Files:** New `packages/core/src/logging/secure-logger.ts`; refactor ~60 `console.error/warn/log` call sites across `packages/server`, `packages/agent`, `packages/agent-adapters`

**Change:**
1. Create `secureLogger` in `@dzupagent/core` wrapping `console.{error,warn,info}`, always piping through `redactSecrets` + configurable PII detector, supporting structured logging (`{ event, err, context }`), and allowing test capture.
2. Add OTel correlation: tag every log line with `traceId`/`spanId` from `@dzupagent/otel`.
3. Replace all `console.error` in server/agent/agent-adapters with `secureLogger.error`.
4. Add ESLint rule (`no-restricted-syntax`) disallowing `console.error` outside of `secure-logger.ts`.

**Validation:**
```bash
grep -rn "console\.\(error\|warn\|log\)" packages/server/src packages/agent/src packages/agent-adapters/src \
  | grep -v "__tests__\|secure-logger\.ts" | wc -l
# expect 0
yarn lint
yarn workspace @dzupagent/core test --filter=secure-logger
```
**Target agent:** `dzupagent-core-dev`

---

## MC-SEC-03 — Default outbound URL policy on every fetch

**Domain:** Security · **Findings:** SEC-003, SEC-021 · **Effort:** 8h
**Files:** Every `fetch(` in `packages/` outside the URL-policy module and test files

**Change:**
1. Add ESLint `no-restricted-globals: ['fetch']` + `no-restricted-imports` on `node:http`/`https`; allowlist only `packages/core/src/security/outbound-url-policy.ts`, test files, and redirect-handling internals.
2. Replace remaining raw `fetch(` call sites with `fetchWithOutboundUrlPolicy`.
3. Add CI check that fails on any new raw `fetch(` outside the allowlist.
4. Document override path: callers that genuinely need unpolicied fetch import `__internalUnpolicedFetch` with an inline `eslint-disable-next-line` comment that is reviewed in PR.

**Validation:**
```bash
grep -rn "\\bfetch(" packages/ --include='*.ts' \
  | grep -v "__tests__\|outbound-url-policy\|fetchWithOutboundUrlPolicy" \
  | wc -l
# expect 0
yarn lint
```
**Target agent:** `dzupagent-core-dev`

---

## MC-ARCH-001: Extract vector-DB implementations to `@dzupagent/rag`

**Domain:** Architecture · **Finding:** ARCH-010 · **Effort:** 12-20h
**Files moved (3,631 LOC):**
- `packages/core/src/vectordb/adapters/` → `packages/rag/src/providers/`
- `packages/core/src/vectordb/embeddings/` → `packages/rag/src/embeddings/`
- `packages/core/src/vectordb/{semantic-store,filter-utils,auto-detect}.ts` → `packages/rag/src/providers/`

**Retained in core (interfaces + in-memory impl only):**
- `packages/core/src/vectordb/types.ts`
- `packages/core/src/vectordb/in-memory-vector-store.ts`

**Change:** Move files, update imports, remove Qdrant/LanceDB optional peer deps from `core/package.json`, add them to `rag/package.json`. Update all consumers (`grep -rn "from '@dzupagent/core/vectordb'\|from '@dzupagent/core/advanced'" packages apps --include="*.ts"`).

**Validation:**
```bash
find packages/core/src/vectordb -name '*.ts' -not -name '*.test.ts' | xargs wc -l | tail -1  # ≤ 800 LOC
yarn verify
```
**Target agent:** `dzupagent-core-dev`

---

## MC-ARCH-002: Extract `core/security` implementation to `@dzupagent/security`

**Domain:** Architecture · **Finding:** ARCH-003 · **Effort:** 16-24h
**Files moved (~2,500 of 3,094 LOC):**
- `core/src/security/audit/`, `classification/`, `memory/`, `monitor/`, `output/`, `policy/`, `output-pipeline.ts`, `risk-classifier.ts`, `content-sanitizer.ts`, `outbound-url-policy.ts` → `packages/security/src/`

**Retained in core:**
- `secrets-scanner.ts`, `pii-detector.ts`, `tool-permission-tiers.ts` (hot-path, no external SDK deps)

**Change:** Move files; add interface re-exports in core for contract types still referenced from core code; add `@dzupagent/security` as a runtime dep of `agent`, `agent-adapters`, `server`, `evals`.

**Validation:**
```bash
find packages/core/src/security -name '*.ts' -not -name '*.test.ts' | xargs wc -l | tail -1  # ≤ 800 LOC
find packages/security/src -name '*.ts' -not -name '*.test.ts' | xargs wc -l | tail -1        # ≥ 2,500 LOC
yarn verify
```
**Target agent:** `dzupagent-core-dev`

---

## MC-ARCH-003: Extract `core/protocol` (A2A) into `@dzupagent/a2a`

**Domain:** Architecture · **Finding:** ARCH-004 · **Effort:** 12-20h
**Files moved (2,826 LOC):** `packages/core/src/protocol/` → `packages/a2a/src/`

**New package:** `@dzupagent/a2a` with subpath exports `./adapter`, `./client`, `./push`, `./sse`. Layer: tier 3.

**Change:** Create package skeleton, move files + ARCHITECTURE.md, update consumers (`grep -rn "from '@dzupagent/core/protocol"` + root-barrel A2A imports), remove A2A exports from `packages/core/src/index.ts`.

**Validation:**
```bash
find packages/core/src/protocol -name '*.ts' | wc -l  # expect 0
yarn verify
```
**Target agent:** `dzupagent-core-dev`

---

## MC-ARCH-004: Extract `core/mcp` into `@dzupagent/mcp`

**Domain:** Architecture · **Finding:** ARCH-005 · **Effort:** 12-20h
**Files moved (3,010 LOC):** `packages/core/src/mcp/` → `packages/mcp/src/`

**New package:** `@dzupagent/mcp` with subpath exports `./client`, `./manager`, `./registry`, `./resources`, `./reliability`. Peer-dep: `@modelcontextprotocol/sdk` (moves from `core/package.json`).

**Change:** Create package, move files, update consumers (search `@dzupagent/core/mcp` and root-barrel MCP imports), remove MCP exports from `packages/core/src/index.ts`.

**Validation:**
```bash
find packages/core/src/mcp -name '*.ts' | wc -l  # expect 0
yarn verify
```
**Target agent:** `dzupagent-core-dev`

---

## MC-ARCH-005: Extract `core/identity` into `@dzupagent/identity`

**Domain:** Architecture · **Finding:** ARCH-006 · **Effort:** 10-16h
**Files moved (2,196 LOC):** `packages/core/src/identity/` → `packages/identity/src/`

**New package:** `@dzupagent/identity` with subpaths `./api-key`, `./delegation`, `./trust`, `./signing`. Layer: tier 3 (separate from security: identity is auth-entry, security is output-sanitization).

**Change:** Create package, move 17 files, update consumers (`server`, `agent`, `agent-adapters`), remove identity exports from core root barrel.

**Validation:**
```bash
find packages/core/src/identity -name '*.ts' | wc -l  # expect 0
yarn verify
```
**Target agent:** `dzupagent-core-dev`

---

## MC-ARCH-006: Extract `core/skills` implementation into `@dzupagent/skills`

**Domain:** Architecture · **Finding:** ARCH-007 · **Effort:** 10-16h
**Files moved (~2,000 of 2,334 LOC):** `core/src/skills/loader.ts`, `injector.ts`, `manager.ts`, `skill-chain.ts`, `skill-model-v2.ts`, etc. → `packages/skills/src/`. Contract types stay in core.

**Change:** Create `packages/skills/`, move implementation files, update consumers (`agent`, `codegen`, `agent-adapters`), remove implementation exports from `packages/core/src/index.ts`.

**Validation:**
```bash
find packages/core/src/skills -name '*.ts' -not -name '*.test.ts' | xargs wc -l | tail -1  # ≤ 500 LOC (contracts)
yarn verify
```
**Target agent:** `dzupagent-core-dev`

---

## MC-ARCH-007: Consolidate `flow-ast` / `flow-dsl` / `flow-compiler`

**Domain:** Architecture · **Finding:** ARCH-008 · **Effort:** 0-4h (Option A) or 16-24h (Option B)

**Decision required:**
- **Option A (recommended):** Keep three packages; add `docs/dzupagent/adr/ADR-0006-flow-package-split.md` explaining the rationale (independent versioning, leaf-runtime size).
- **Option B:** Merge into `@dzupagent/flow` with subpath exports `./ast`, `./dsl`, `./compiler`. Migrate 31 source files (8,718 LOC); update `agent`, `server`, `evals`, `app-tools`.

**Validation (Option B):**
```bash
find packages/flow-ast packages/flow-dsl packages/flow-compiler -name '*.ts' | wc -l  # expect 0
yarn verify
```
**Target agent:** `dzupagent-codegen-dev`

---

## MC-ARCH-008: Consolidate contract packages

**Domain:** Architecture · **Finding:** ARCH-009 · **Effort:** 4h (Option A) or 12-20h (Option B)

**Decision required:**
- **Option A:** Keep five packages; add a glossary ADR (covered by QF-ARCH-012).
- **Option B:** Merge `runtime-contracts`, `agent-types`, `adapter-types`, `eval-contracts` into `@dzupagent/contracts` with subpath exports. Keep `adapter-rules` separate (has runtime code). Migrate ~150 files / ~250 import lines.

**Target agent:** `dzupagent-core-dev`

---

## MC-ARCH-009: Split top-20 god files (>600 LOC)

**Domain:** Architecture · **Finding:** ARCH-007 · **Effort:** 60-100h (sustained sprint)

**Priority targets (by LOC):**
- `packages/agent/src/agent/dzip-agent.ts` (942)
- `packages/agent/src/workflow/workflow-builder.ts` (966)
- `packages/memory/src/sharing/memory-space-manager.ts` (950)
- `packages/agent/src/orchestration/delegating-supervisor.ts` (847)
- `packages/agent-adapters/src/codex/codex-adapter.ts` (1,125)
- `packages/agent-adapters/src/claude/claude-adapter.ts` (783)
- `packages/server/src/runtime/run-worker-stages.ts` (798)
- `packages/server/src/routes/compile.ts` (782)
- (see `architecture-major-changes.md` for full 35-file list)

**Patterns:** per-concern split → barrel re-export; adapter → `{transport,normalization,capability,error-mapping}` modules; each result ≤ 400 LOC.

**Validation:**
```bash
find packages -name '*.ts' -not -name '*.test.ts' -exec wc -l {} + | sort -rn | head -10
# top entry below 700 LOC (excluding barrels)
yarn verify
```
**Target agent:** distribute — `dzupagent-agent-dev` for agent/agent-adapters, `dzupagent-core-dev` for core/server/memory, `dzupagent-codegen-dev` for codegen/evals.

---

## MC-ARCH-010: Architecture enforcement — cycles + dependency completeness

**Domain:** Architecture · **Finding:** ARCH-022 · **Effort:** 16-24h + ongoing

Already covered by R-ARCH-008 in `refactors.md`. Listed here because once the gate is enforced in CI, all other architectural MCs become required to pass it. Sequence: implement gate → fix existing violations (covered by other prompts) → enable gate in CI (1h).

---

## MC-AGT-01 — Tenant-scoped adapter learning loop

**Domain:** Agent · **Finding:** AGT-001 (Critical) · **Effort:** 16h
**Files:**
- `packages/agent-adapters/src/learning/{adapter-learning-loop,learning-store,in-memory-learning-store,file-learning-store}.ts`
- All callers of `recordExecution`/`getProfile`/`getFailurePatterns`
- `packages/agent-adapters/src/types.ts`

**Change:**
1. Add required `tenantId: string` to `ExecutionRecord`.
2. Re-key all `LearningStore` operations to `(tenantId, providerId, ...)`.
3. Add `getGlobalProfile(providerId)` for ops dashboards only — never consulted by routing.
4. Bump `LearningSnapshot` to version 2 with v1→v2 migration helper (operator specifies tenantId for legacy data).
5. Update all routing/orchestration callers to thread tenantId.
6. Deprecate 1-arg `recordExecution` signature.

**Validation:**
```bash
# Vitest: 50 tenant-A failures + 50 tenant-B successes for same providerId
# Assert getProfile('A', 'claude').successRate === 0 and getProfile('B', 'claude').successRate === 1
# Assert routing for tenant B does NOT consult tenant A's failure patterns
yarn verify --filter @dzupagent/agent-adapters
```
**Target agent:** `dzupagent-agent-dev`

---

## MC-AGT-02 — Unify the two security stacks under `@dzupagent/security`

**Domain:** Agent · **Findings:** AGT-003, AGT-010 · **Effort:** 16h
**Files:**
- `packages/security/src/` (canonical scanner)
- `packages/core/src/security/monitor/{built-in-rules,safety-monitor}.ts`

**Change:**
1. Designate `@dzupagent/security` as canonical for `prompt_injection` and `pii_leak` categories.
2. Refactor `SafetyMonitor`: keep rule-based arch for `tool_abuse`/`escalation`; delegate injection/PII rules to `@dzupagent/security` classes.
3. Single `SecurityPolicyConfig` with `{ promptInjection, pii, toolAbuse, escalation }`.
4. Tool-loop scans tool results through the consolidated path (closes AGT-010).
5. Add ADR to `docs/adr/`.

**Validation:**
```bash
# New test: tool returning JWT blocked with category 'pii_leak'
# New test: memory write-back of injection phrase detected with same rule set
yarn verify
```
**Target agent:** `dzupagent-core-dev` + `dzupagent-agent-dev`

---

## MC-AGT-03 — Run-engine-managed provider fallback on transient errors

**Domain:** Agent · **Finding:** AGT-013 · **Effort:** 12h
**Files:**
- `packages/core/src/llm/model-registry.ts` (`getModelFallbackCandidates`)
- `packages/core/src/llm/invoke.ts`
- `packages/agent/src/agent/{dzip-agent,provider-failover}.ts`

**Change:**
1. Introduce `ResilientModelInvoker` holding a candidate chain from `getModelFallbackCandidates(tier)`; walks chain on `isTransientError`; records breaker state; emits `model:fallback` event.
2. Integrate into `dzip-agent.ts` as the default invocation path.
3. Add `RegistryConfig.fallbackOnInvocationError: boolean` (default `true`).

**Validation:**
```bash
# Vitest: provider A throws 503 → invocation transparently retries on B → succeeds
# Vitest: all providers down → throws ALL_PROVIDERS_EXHAUSTED
# Telemetry: model:fallback emitted exactly once per hop
yarn verify --filter @dzupagent/agent
```
**Target agent:** `dzupagent-core-dev` + `dzupagent-agent-dev`

---

## MC-AGT-04 — Unified durable run state (approval + stuck + checkpoint)

**Domain:** Agent · **Findings:** AGT-006, AGT-007 · **Effort:** 32h
**Files:**
- `packages/agent/src/approval/approval-types.ts`
- `packages/core/src/persistence/{run-journal,checkpointer}.ts`
- `packages/core/src/guardrails/stuck-detector.ts`

**Change:**
1. Introduce `DzupRunState` snapshot interface: `{ runId, tenantId, agentId, messages, budget, stuckDetector, approval, iteration, cumulativeUsage, version }`.
2. Implement `DzupRunStateStore` backed by existing `BaseStore` adapters.
3. Run engine writes snapshots at every iteration boundary and on suspend/terminal.
4. Resume rebuilds full agent state from snapshot (stuck detector + budget preserved).
5. Approval gate's `checkpointStore` becomes a keyed view on `DzupRunStateStore`.

**Validation:**
```bash
# Integration test: pause at iteration 7, kill process, resume in new process, complete normally
# Assert stuck-detector and budget state preserved
yarn verify
```
**Target agent:** `dzupagent-agent-dev`

---

## MC-AGT-05 — Permission tier as first-class agent capability

**Domain:** Agent · **Finding:** AGT-012 · **Effort:** 16h
**Files:**
- `packages/codegen/src/sandbox/permission-tiers.ts` (move type to core)
- `packages/agent/src/agent/agent-types.ts` (add `permissionTier`)
- `packages/agent/src/tools/` (tag required tiers)

**Change:**
1. Move `PermissionTier` type to `@dzupagent/core`.
2. Add `requiredTier?: PermissionTier` to `StructuredTool` metadata.
3. Tag all codegen write/edit tools with `'workspace-write'`; shell/network tools with `'full-access'`.
4. At agent construction, filter bound tool list to `requiredTier <= effectiveTier` — model never sees tools above its tier.
5. Emit `agent:tools-filtered` event with filter decision.

**Validation:**
```bash
# Vitest: agent on read-only with write_file registered → agent.boundTools excludes write_file
# Vitest: model invocation transcript shows zero write-tool calls
yarn verify
```
**Target agent:** `dzupagent-agent-dev` + `dzupagent-codegen-dev`

---

## MC-001: Split top-5 oversized files (>1,000 LOC)

**Domain:** Code Quality · **Finding:** CODE-001 · **Effort:** 16-24h per file
**Files:**
- `packages/flow-ast/src/validate.ts` (1,410 LOC)
- `packages/agent/src/agent/run-engine.ts` (1,186 LOC)
- `packages/agent-adapters/src/codex/codex-adapter.ts` (1,126 LOC)
- `packages/flow-ast/src/parse.ts` (1,077 LOC)
- `packages/agent/src/pipeline/pipeline-runtime.ts` (1,071 LOC)
- `packages/flow-dsl/src/normalize.ts` (1,018 LOC)

**Change:** For each file, identify natural split axes, move chunks into `<file-stem>/<axis>.ts`, keep original as a barrel. Each result ≤ 400 LOC.

**Validation:**
```bash
yarn verify
# All tests green; downstream apps typecheck passes.
```
**Target agent:** `dzupagent-agent-dev` (run-engine, pipeline); `dzupagent-codegen-dev` (flow-ast, flow-dsl); `dzupagent-connectors-dev` (codex-adapter)

---

## MC-002: Build `test-utils` factories and migrate `as never` test mocks

**Domain:** Code Quality · **Findings:** CODE-014, CODE-021 · **Effort:** 24h
**Files (new):** `packages/test-utils/src/factories/{mock-event-bus,mock-memory-client,mock-agent,mock-tool,mock-llm,mock-dom,mock-codegen-context}.ts`
**Files (migrated):** agent/__tests__ (72 casts), codegen/__tests__ (32 casts), connectors-browser/__tests__ (38 casts)

**Change:** Build typed factories (`DeepPartial<T>` + explicit defaults); replace `someValue as never` with `factories.createMockX({ ...override })`.

**Validation:**
```bash
yarn test
grep -rcE "\bas never\b" packages/agent/src/__tests__ packages/codegen/src/__tests__ packages/connectors-browser/src/__tests__ \
  --include="*.test.ts" | awk -F: '{s+=$NF} END{print s}'
# Expect total ≤ 30 (down from ~140)
```
**Target agent:** `dzupagent-test-dev`

---

## MC-003: Resize barrel files

**Domain:** Code Quality · **Findings:** CODE-013, CODE-012 · **Effort:** 16h
**Files:**
- `packages/core/src/index.ts` (875 LOC)
- `packages/agent-adapters/src/index.ts` (587 LOC)
- `packages/agent/src/index.ts` (821 LOC, 40 deprecated re-exports)

**Change:** Curate public surfaces; move detailed re-exports into sub-barrel files; remove the 40 deprecated re-exports from `agent/index.ts` (coordinate with codev-app for a single migration commit or enforce via `no-restricted-imports` ESLint rule).

**Validation:**
```bash
yarn verify
wc -l packages/core/src/index.ts packages/agent-adapters/src/index.ts packages/agent/src/index.ts
# Expect each ≤ 250 LOC.
```
**Target agent:** `dzupagent-core-dev` + codev-app maintainer coordination

---

## MC-004: Move event-types to family-split structure

**Domain:** Code Quality · **Finding:** CODE-024 · **Effort:** 16h
**Files:** `packages/core/src/events/event-types.ts` (717 LOC) → split into `events/types/{lifecycle,tool,memory,governance,orchestration,observability}.ts`

**Change:** Group events by family, move each group, keep `event-types.ts` as a re-exporting barrel.

**Validation:**
```bash
yarn typecheck && yarn test
wc -l packages/core/src/events/event-types.ts   # expect ≤ 200
```
**Target agent:** `dzupagent-core-dev`

---

## MC-005: Centralise timeout and retry constants

**Domain:** Code Quality · **Finding:** CODE-019 · **Effort:** 16h
**Files (new):** `packages/core/src/config/timeouts.ts`
**Files (replace):** adapter utils, route handlers, pipeline types — ~10 hardcoded literal sites

**Change:** Create `TIMEOUTS` const object with named constants; replace literal sites; document each tuning rationale.

**Validation:**
```bash
yarn typecheck && yarn test
grep -rE "(setTimeout|setInterval)\s*\(\s*[^,]+,\s*[0-9]{4,}" packages/*/src --include="*.ts" \
  | grep -v "__tests__\|fixtures\|TIMEOUTS\." | wc -l
# Expect significant drop from baseline
```
**Target agent:** `dzupagent-core-dev`

---

## MC-006: Coverage uplift for top-10 zero-test source files (≥ 250 LOC)

**Domain:** Code Quality · **Findings:** CODE-005, CODE-006, CODE-007 · **Effort:** 32h
**Files (priority):**
1. `packages/agent/src/agent/run-engine-streaming-helpers.ts` (717 LOC)
2. `packages/agent/src/agent/run-engine-generate-helpers.ts` (426 LOC)
3. `packages/agent/src/self-correction/root-cause-analyzer.ts` (407 LOC)
4. `packages/server/src/deploy/confidence-calculator.ts` (348 LOC)
5. `packages/agent/src/agent/structured-generate.ts` (327 LOC)
6. (see `code-major-changes.md` for full list)

**Change:** For each, add focused unit test file with ≥ 12 cases targeting ≥ 70% branch coverage.

**Validation:**
```bash
yarn test --coverage
# Each module ≥ 70% branch coverage; aggregate test count +100
```
**Target agent:** `dzupagent-test-dev`

---

## MC-007: Per-node test fixtures for `flow-ast/parse.ts` (16 nodes)

**Domain:** Code Quality · **Finding:** CODE-007 · **Effort:** 24h
**Files (new):** `packages/flow-ast/test/parsers/{action,approval,branch,classify,clarification,emit,foreach,memory,parallel,persona,route,sequence,spawn,checkpoint,restore,complete}.test.ts`

**Change:** For each per-node parser drive ≥ 5 inputs: valid, missing-required, wrong-type, invalid-optional, multiple-issues. Use shared fixture loader.

**Validation:**
```bash
yarn workspace @dzupagent/flow-ast test --coverage
# parse.ts and validate.ts branch coverage ≥ 80%
```
**Target agent:** `dzupagent-test-dev`

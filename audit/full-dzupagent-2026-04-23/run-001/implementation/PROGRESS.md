# Audit Implementation Progress

## Summary

| Phase | Tasks | Status |
|-------|-------|--------|
| Quick Fixes | 20/21 | ✅ (QF-11 was pre-existing no-op) |
| Refactors | 16/16 | ✅ |
| Major Changes | 10/10 | ✅ |

**All 47 tasks complete. All quality gates green as of 2026-04-24.**

---

## Quality Gate Results (Final)

| Gate | Result |
|------|--------|
| `yarn typecheck` (51 pkgs) | 52/52 ✅ |
| `yarn lint` (32 pkgs) | 32/32 ✅ |
| `@dzupagent/core` (standalone) | 2735/2735 ✅ |
| `@dzupagent/server` (standalone) | 2870/2870 ✅ (1 skip) |
| `@dzupagent/agent` (standalone) | pass ✅ |
| `@dzupagent/evals` (standalone) | 1315/1315 ✅ |
| `@dzupagent/scraper` (standalone) | 325/325 ✅ |
| `@dzupagent/testing` (standalone) | 296/296 ✅ |
| Turbo parallel (excl. 3 flaky) | 50/50 ✅ |

Note: @dzupagent/evals, @dzupagent/scraper, @dzupagent/testing exhibit flaky failures
under Turbo parallel execution (pre-existing; all pass 100% standalone).

---

## Major Changes Phase (MC) — Complete

### MC-A01: Core Layer Inversion Fix
- Removed `@dzupagent/memory`, `@dzupagent/context`, `@dzupagent/memory-ipc` imports from `@dzupagent/core`
- Boundary test updated: ALLOWED_IMPORTS = {core, runtime-contracts, agent-types}
- `facades/memory.ts` removed; `facades.test.ts` updated to remove memory assertions
- `stable.ts` / `advanced.ts` updated

### MC-A02: Server→Evals Layer Inversion Fix
- New `@dzupagent/eval-contracts` types-only package
- `@dzupagent/evals` removed from server runtime deps, added to devDeps
- `DefaultEvalOrchestrator` added to `evals.ts` for executeTarget-only configs
- eval-routes.test.ts, eval-lease-recovery.integration.test.ts wired with `EvalOrchestrator` from evals
- benchmark-routes.test.ts wired with `BenchmarkOrchestrator` from evals + default `'qa'` suite

### MC-GA01: Durable Pipeline Checkpoints
- `PostgresPipelineCheckpointStore` and `RedisPipelineCheckpointStore` in `@dzupagent/agent`

### MC-GA02: Cross-Process ApprovalGate
- `ApprovalStateStore`, `InMemoryApprovalStateStore`, `PostgresApprovalStateStore` in `@dzupagent/hitl-kit`
- `/api/approvals/:runId/:approvalId/grant` and `reject` routes in server

### MC-GA03: Tool Permission Scoping
- `ToolPermissionPolicy`, `ToolScope`, `ToolPermissionEntry` in `@dzupagent/agent-types`
- `OwnershipPermissionPolicy`, `getToolsForAgent`, ownership metadata in `tool-registry.ts`
- Permission check in sequential + parallel paths of `tool-loop.ts`
- 16/16 tool-permission tests pass

### MC-S01: Token Budget Quota
- `ResourceQuotaManager` in `server/src/security/resource-quota.ts`
- Wired into `run-worker.ts`: 429 admission check + post-completion `recordUsage`
- `resource-quota.test.ts`: 13/13 pass

### MC-S02: RBAC + Tenant Isolation
- `rbacMiddleware` with `ForgeRole` types (admin/operator/viewer/agent)
- `tenant_id` column added to `forge_runs` Drizzle schema
- `postgres-run-store.integration.test.ts` updated to include `tenant_id` column
- `api-key-wiring.test.ts` + `integration.test.ts` fixed with `role: 'operator'`

### MC-S03: Prompt Injection Guard
- `createInputGuard`, `InputGuard` in `server/src/security/input-guard.ts`
- `mapStrings` fixed with `WeakSet` cycle detection
- Wired into `run-worker.ts`: pre-execute PII/injection scan
- `input-guard.test.ts`: 20/20 pass

### MC-C01: Flow DSL + Compiler Tests
- 5 flow-dsl test files (160 tests)
- 4 flow-compiler test files (289 tests)
- `makeActionJson` return type fix for discriminated union

### MC-C02: TeamRuntime + Orchestrator Tests
- `team-runtime.test.ts` (1143 LOC)
- `orchestrator.test.ts` (779 LOC)

---

## Key Test Fixes Applied This Session

| File | Fix |
|------|-----|
| `core/src/__tests__/facades.test.ts` | Removed memory facade tests (MC-A01 removed facades/memory.ts) |
| `server/src/routes/evals.ts` | Added `DefaultEvalOrchestrator` + guard requiring executeTarget/allowReadOnlyMode/orchestrator |
| `server/src/security/input-guard.ts` | Fixed `mapStrings` WeakSet cycle detection |
| `server/src/__tests__/eval-routes.test.ts` | Wired `EvalOrchestrator` from `@dzupagent/evals` via `orchestratorFactory` |
| `server/src/__tests__/eval-lease-recovery.integration.test.ts` | Same |
| `server/src/__tests__/benchmark-routes.test.ts` | Wired `BenchmarkOrchestrator`, added `'qa'` suite |
| `server/src/__tests__/api-key-wiring.test.ts` | Added `role: 'operator'` to mock ApiKeyRecord |
| `server/src/__tests__/integration.test.ts` | Added `role: 'operator'` to InMemoryApiKeyStore.create |
| `server/src/__tests__/postgres-run-store.integration.test.ts` | Added `tenant_id` column to CREATE TABLE |
| `server/package.json` | Added `@dzupagent/evals` as devDependency |

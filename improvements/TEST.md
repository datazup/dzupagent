# IMR: Test and Integration Coverage Improvement Plan

Date: 2026-03-29  
Scope: `packages/*` in this monorepo

## 1) Current Baseline (Test Inventory)

Method used in this pass:
- Counted non-test TypeScript files in `packages/<name>/src/**/*.ts` (excluding `*.test.ts`).
- Counted test files in `packages/<name>/src/**/*.test.ts`.
- Classified integration-style tests by filename matching: `integration|e2e|contract|end-to-end`.

| Package | Src Files | Test Files | Integration-style Tests | Test/Src Ratio | Notes |
|---|---:|---:|---:|---:|---|
| agent | 114 | 67 | 2 | 0.59 | Strong unit depth, some integration coverage |
| agent-adapters | 38 | 27 | 1 | 0.71 | Good unit depth, limited integration |
| cache | 6 | 0 | 0 | 0.00 | No tests |
| codegen | 118 | 20 | 0 | 0.17 | Low test density, no integration |
| connectors | 27 | 4 | 0 | 0.15 | Low test density |
| connectors-browser | 12 | 1 | 0 | 0.08 | Very low test density |
| connectors-documents | 12 | 2 | 0 | 0.17 | Low test density |
| context | 11 | 8 | 0 | 0.73 | Good unit depth |
| core | 178 | 57 | 0 | 0.32 | Moderate unit depth, no integration |
| create-dzipagent | 24 | 5 | 0 | 0.21 | Low test density |
| domain-nl2sql | 23 | 0 | 0 | 0.00 | No tests |
| evals | 46 | 14 | 3 | 0.30 | Some contract/integration tests |
| express | 4 | 0 | 0 | 0.00 | No tests |
| memory | 88 | 44 | 1 | 0.50 | Good unit depth, limited integration |
| memory-ipc | 31 | 21 | 0 | 0.68 | Good unit depth, no integration |
| otel | 13 | 14 | 0 | 1.08 | High test density |
| playground | 21 | 21 | 0 | 1.00 | High test density |
| rag | 9 | 0 | 0 | 0.00 | No tests |
| scraper | 6 | 0 | 0 | 0.00 | No tests |
| server | 96 | 43 | 4 | 0.45 | Best current integration footprint |
| test-utils | 4 | 1 | 0 | 0.25 | Low test density |
| testing | 8 | 1 | 0 | 0.12 | Low test density |

Integration-style test files currently detected:
- `packages/agent-adapters/src/__tests__/contract-net.test.ts`
- `packages/agent/src/__tests__/contract-net.test.ts`
- `packages/agent/src/__tests__/self-learning-integration.test.ts`
- `packages/evals/src/__tests__/contracts.test.ts`
- `packages/evals/src/__tests__/sandbox-contracts.test.ts`
- `packages/evals/src/__tests__/vectorstore-contracts.test.ts`
- `packages/memory/src/__tests__/vector-integration.test.ts`
- `packages/server/src/__tests__/bullmq-e2e.test.ts`
- `packages/server/src/__tests__/e2e-run-pipeline.test.ts`
- `packages/server/src/__tests__/integration-scorecard.test.ts`
- `packages/server/src/__tests__/mcp-integration.test.ts`

## 2) Review Findings (Severity-Ranked)

### High
1. Five production packages have zero tests: `cache`, `domain-nl2sql`, `express`, `rag`, `scraper`.
2. Integration coverage is concentrated in a small subset (`server`, `agent`, `evals`, `memory`), leaving most package boundaries unvalidated.
3. Several packages appear without local `vitest.config.ts` (`cache`, `domain-nl2sql`, `express`, `rag`, `scraper`, `connectors-browser`, `connectors-documents`), increasing inconsistency risk.

### Medium
1. Critical high-surface packages with low test density:
   - `codegen` (0.17), `connectors` (0.15), `create-dzipagent` (0.21), `testing` (0.12), `test-utils` (0.25).
2. `core` has broad functionality but no explicit integration-style test files.
3. Current baseline is file-count based; no enforced statement/branch thresholds are visible at workspace level.

### Low
1. Test naming conventions for integration/contract/e2e are not fully standardized, making CI filtering and reporting less reliable.

## 3) Target State

By end of the next improvement cycle:
- 100% of runtime packages have at least smoke-level tests.
- Every package has at least one integration or contract test at a package boundary.
- Workspace enforces minimum line/branch coverage gates in CI.

Proposed measurable thresholds:
- Global minimum: `line >= 70%`, `branch >= 55%`.
- Critical packages (`core`, `server`, `agent`, `memory`, `codegen`): `line >= 80%`, `branch >= 65%`.
- New/low-complexity packages: start at `line >= 60%`, raise quarterly.

## 4) Execution Plan

### Phase 1 (Week 1): Remove Zero-Coverage Risk
Deliverables:
1. Add `vitest.config.ts` and baseline tests for:
   - `cache`, `domain-nl2sql`, `express`, `rag`, `scraper`.
2. For each package above, create:
   - 1 smoke test (module load + basic path).
   - 1 error-path test (input validation or failure mode).
   - 1 contract/integration test (boundary interaction).
3. Add CI check to fail if any package has `0` tests.

Exit criteria:
- All five packages have `>=3` tests and at least one integration-style test.

### Phase 2 (Week 2): Lift Critical Package Confidence
Deliverables:
1. Increase `codegen`, `connectors`, `connectors-browser`, `connectors-documents`, `create-dzipagent`, `testing`, `test-utils`.
2. Add integration tests for `core` and `memory-ipc` package boundaries.
3. Introduce common integration fixture helpers in `packages/test-utils` for reuse.

Exit criteria:
- `codegen` ratio >= 0.30.
- `connectors*` packages each have >= 1 integration/contract test.
- `core` and `memory-ipc` each have >= 1 integration test.

### Phase 3 (Week 3): Enforce and Stabilize Coverage
Deliverables:
1. Enable/standardize `test:coverage` reporting across all packages.
2. Add CI coverage gates:
   - Global thresholds and stricter thresholds for critical packages.
3. Add package coverage trend report (JSON/markdown artifact per CI run).

Exit criteria:
- Coverage gates active on CI.
- No package below agreed threshold without approved waiver.

## 5) CI and Process Improvements

1. Add a workspace script that reports per-package:
   - src files, test files, integration files, line coverage, branch coverage.
2. Standardize naming:
   - Unit: `*.test.ts`
   - Integration: `*.integration.test.ts`
   - E2E: `*.e2e.test.ts`
   - Contract: `*.contract.test.ts`
3. Require new feature PRs to include:
   - Unit tests for logic.
   - At least one integration/contract test for boundary changes.
4. Add failure triage labels in CI:
   - `unit-failure`, `integration-failure`, `coverage-regression`.

## 6) Immediate Backlog (Prioritized)

1. `packages/domain-nl2sql`: first test suite (parser + workflow boundary).
2. `packages/express`: router and SSE handler integration tests.
3. `packages/scraper`: fetcher/extractor tests with mocked network and one integration flow.
4. `packages/rag`: retrieval pipeline contract tests.
5. `packages/cache`: cache hit/miss/eviction behavior tests.
6. `packages/codegen`: broaden test matrix for generation + validation + failure recovery.

## 7) Risks and Assumptions

- This baseline is derived from test-file inventory and naming conventions, not runtime coverage percentages.
- Some tests with integration semantics may not include integration keywords in filenames.
- Next step should include running `test:coverage` per package and replacing ratio proxies with real line/branch coverage.

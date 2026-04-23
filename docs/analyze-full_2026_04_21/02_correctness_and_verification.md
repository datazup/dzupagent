# Correctness and Verification - dzupagent (2026-04-21)

## Repository Overview
- Repository: `dzupagent` monorepo (`yarn@1.22.22`) with `packages/*` workspaces and Turbo orchestration (`package.json:4-9`, `package.json:11-42`, `turbo.json:1-57`).
- Package surface observed: 29 package manifests under `packages/*` in this checkout, with one extra directory lacking a package manifest (`packages/create-dzupagent/node`).
- Test surface observed: `1047` `*.test.ts|*.spec.ts` files in `packages/` from local scan.
- Verification model is mixed:
  - Static/build gates via Turbo (`build`, `typecheck`, `lint`, `test`, `verify`, `verify:strict`).
  - Custom correctness scripts (`check-runtime-test-inventory`, `check-workspace-coverage`, `check-domain-boundaries`, `check-terminal-tool-event-guards`, `check-improvements-drift`).
  - CI workflows split across strict verify, coverage matrix, security, connectors verification, orchestration-focused tests, publish, and compatibility matrix (`.github/workflows/*.yml`).
- Secondary artifact context: static repo-doc artifact in `out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md` reports `healthScore: 100` (generated `2026-04-19`), which currently overstates live verification trust compared with local strict-gate behavior.

## Verification Surface

| Area | Primary command(s) | Where defined | Sandbox-safe vs env-dependent | Notes |
|---|---|---|---|---|
| Build | `yarn build` | `package.json:11` | Mostly sandbox-safe | Turbo build across workspaces (`turbo run build`). |
| Typecheck | `yarn typecheck` | `package.json:14` | Sandbox-safe | Turbo typecheck graph (`turbo.json:15-21`). |
| Lint | `yarn lint` | `package.json:16` | Sandbox-safe | Only packages with `lint` scripts participate. |
| Unit/package tests | `yarn test` | `package.json:17`, `turbo.json:26-30` | Mostly sandbox-safe, but some suites skip based on env/runtime | Runs each package `test` script, not `test:e2e`. |
| Baseline verification bundle | `yarn verify` | `package.json:30` | Mostly sandbox-safe | Includes runtime inventory + drift + boundary/tool-event checks + Turbo build/typecheck/lint/test. |
| Strict verification bundle | `yarn verify:strict` | `package.json:29` | Mixed; currently artifact-sensitive | Adds strict runtime inventory, workspace coverage gate, waiver/docs checks before Turbo tasks. |
| Runtime inventory gate | `yarn test:inventory:runtime`, `yarn test:inventory:runtime:strict` | `package.json:18-19`, `scripts/check-runtime-test-inventory.mjs:34-160` | Sandbox-safe | File-system based inventory; strict mode enforces integration-style test naming for runtime-critical packages. |
| Coverage gate (workspace) | `yarn test:coverage:workspace` / `yarn check:workspace:coverage` | `package.json:20,28`, `scripts/check-workspace-coverage.mjs:204-287` | Artifact-dependent locally | Fails when `coverage-summary.json` missing (`scripts/check-workspace-coverage.mjs:241-247`). |
| Coverage CI matrix | Workflow `coverage-gate.yml` | `.github/workflows/coverage-gate.yml:31-131` | CI env-dependent | Dynamically discovers packages with `test:coverage`, runs each, then enforces workspace gate. |
| Focused orchestration checks | `yarn test:orchestration:race|cancel|contracts` | `package.json:23-25`, `packages/agent-adapters/package.json` | Sandbox-safe | Targeted regression suite for orchestration behavior. |
| Connectors verified build | `yarn build:connectors:verified` | `package.json:33`, `packages/connectors/package.json:20-21` | Mostly sandbox-safe | Adds ESM smoke test after build. |
| Integration tests | Package-level integration suites | e.g. `packages/rag/src/__tests__/qdrant-factory.test.ts:162-213`, `packages/server/src/__tests__/postgres-run-store.integration.test.ts:1-142` | Env-dependent | Gated by `describe.skipIf(...)` and runtime prerequisites. |
| E2E tests | `yarn workspace @dzupagent/playground test:e2e` | `packages/playground/package.json:13` | Env-dependent | Playwright/browser runtime required; not part of root `test`/`verify`. |
| Migration commands | `yarn workspace @dzupagent/server db:generate`, `db:push` | `packages/server/package.json:22-23` | Env-dependent | Require DB setup/connection (`DATABASE_URL` or local DB config). |
| Docs freshness gate in strict path | `yarn check:capability-matrix` | `package.json:35`, `scripts/check-capability-matrix-freshness.mjs:16-21` | Sandbox-safe but non-product | Fails if `docs/CAPABILITY_MATRIX.md` absent. |

Observed local command evidence (2026-04-21):
- `yarn -s test:inventory:runtime` passed.
- `yarn -s test:inventory:runtime:strict` passed.
- `yarn -s check:domain-boundaries` passed.
- `yarn -s check:terminal-tool-event-guards` passed.
- `yarn -s check:waiver-expiry` passed with 6 active waivers, 0 expired.
- `yarn -s check:workspace:coverage` failed with `1 missing` coverage summary (`agent-adapters`).
- `yarn -s check:capability-matrix` failed because `docs/CAPABILITY_MATRIX.md` is absent.
- `yarn -s verify:strict` failed early at workspace coverage gate before Turbo build/typecheck/lint/test execution.

## Confidence Signals
- Strong: runtime package inventory is explicit and machine-enforced, including strict integration-style checks for runtime-critical packages (`scripts/check-runtime-test-inventory.mjs:18-32`, `148-160`), and both runtime inventory commands passed locally.
- Strong: architecture-specific static guards exist and are executable (`check-domain-boundaries`, `check-terminal-tool-event-guards`), and both passed locally.
- Strong: dedicated CI workflows exist for targeted risk lanes:
  - Coverage matrix + workspace threshold gate (`coverage-gate.yml:41-131`).
  - Orchestration race/cancel/contracts workflows.
  - Connectors verified build workflow.
- Strong: coverage policy includes threshold configuration and waiver expiry controls (`coverage-thresholds.json`, `scripts/check-waiver-expiry.mjs`).

- Weak: strict verification is not currently a trustworthy single-command truth source in this environment because it fails on missing generated artifacts before core build/test stages.
- Weak: integration/e2e behavior is not exercised by default root verification path; multiple real-infra suites are skip-gated on runtime availability.
- Weak: coverage gating is only enforceable for packages with `test:coverage` plus tracked packages; runtime code without `test:coverage` is outside the threshold gate.
- Weak: static secondary artifacts in `out/` can overstate health compared with current runnable gates (example: `healthScore: 100` in `out/.../DZUPAGENT.md:7` while local `verify:strict` is red).

## Findings

### 1) High: `verify:strict` is non-hermetic and fails on artifact preconditions
- Impact: The top-level “strict” command can fail for missing generated files instead of code regressions, reducing trust in day-to-day correctness feedback.
- Evidence:
  - `verify:strict` executes `check:workspace:coverage` before Turbo build/typecheck/lint/test (`package.json:29`).
  - Coverage gate hard-fails on missing `coverage-summary.json` (`scripts/check-workspace-coverage.mjs:241-247`, exit logic `283-285`).
  - Coverage outputs are not committed (`.gitignore:37` ignores `coverage/`).
  - Local run failed exactly on missing `packages/agent-adapters/coverage/coverage-summary.json`.
- Why current verification catches/misses:
  - It catches missing artifacts.
  - It does not guarantee that strict failure corresponds to product correctness failure.

### 2) High: strict CI job calls `verify:strict` without generating coverage artifacts first
- Impact: On clean CI runners, strict workflow reliability depends on incidental artifact state and can fail before meaningful code validation.
- Evidence:
  - `verify-strict.yml` runs `yarn -s verify:strict` directly (`.github/workflows/verify-strict.yml:65-66`).
  - Coverage generation is in a separate workflow (`coverage-gate.yml:95-131`), not wired into strict workflow execution.
  - `check-workspace-coverage` expects package coverage summaries to already exist (`scripts/check-workspace-coverage.mjs:215-247`).
- Why current verification catches/misses:
  - It catches coverage artifact absence.
  - It misses/defers actual compile/test regressions when it exits early.

### 3) Medium: integration and e2e correctness is underrepresented in default feedback loop
- Impact: Regressions in real Redis/Postgres/Qdrant/browser flows can bypass normal `yarn verify`/`yarn verify:strict`.
- Evidence:
  - Root verify flows run Turbo `test`, not explicit e2e commands (`package.json:29-30`).
  - Playground e2e is separate (`packages/playground/package.json:13`).
  - RAG and server integration suites are conditionally skipped by runtime checks (`qdrant-factory.test.ts:165-168`, `bullmq-e2e.test.ts:63-67,102`, `postgres-run-store.integration.test.ts:62-63,142`).
- Why current verification catches/misses:
  - It catches unit/mocked behavior.
  - It misses infra-backed behavior unless environment is provisioned and those suites are explicitly run.

### 4) Medium: runtime-critical coverage enforcement is incomplete
- Impact: Some runtime-critical packages can regress in branch/edge logic without coverage-threshold enforcement.
- Evidence:
  - Runtime-critical set includes `scraper` (`scripts/check-runtime-test-inventory.mjs:18-31`).
  - `@dzupagent/scraper` has no `test:coverage` script (`packages/scraper/package.json:13-19`).
  - Coverage matrix discovers only packages with `test:coverage` (`coverage-gate.yml:54-61`).
- Why current verification catches/misses:
  - It catches zero-test regressions via inventory gate.
  - It does not enforce coverage floors where `test:coverage` is absent.

### 5) Medium: publish path is build-only, not full correctness-gated
- Impact: Release pipeline can publish from a state that builds but has unresolved test/lint/type issues.
- Evidence:
  - `publish.yml` runs install + `yarn build`, then Changesets publish/version (`.github/workflows/publish.yml:36-47`).
  - No explicit `yarn verify`, `yarn verify:strict`, `yarn test`, `yarn lint`, or `yarn typecheck` in publish job.
- Why current verification catches/misses:
  - It catches build breakage.
  - It misses non-build correctness regressions at release time.

### 6) Medium: compatibility matrix workflow appears cross-repo coupled and can mask publish failures
- Impact: Compatibility CI may provide noisy or misleading confidence in this repo context.
- Evidence:
  - Workflow uses working dirs outside this repo shape (`monorepo/packages/dzupagent-kit`, `monorepo/apps/testman-app`, `monorepo/apps/nl2sql`) (`compat-matrix.yml:128`, `184`, `242`).
  - Verdaccio config path assumes nested `monorepo/dzupagent/.github/...` (`compat-matrix.yml:124`, `238`).
  - Snapshot publish loop swallows `npm publish` failures (`compat-matrix.yml:88` with `|| true`).
- Why current verification catches/misses:
  - It may catch ecosystem breakage when full external layout exists.
  - It can miss packaging failures and can fail for harness-layout reasons unrelated to product correctness.

## Verification Path Risks

Product-risk distortions:
- Integration correctness risk: infra-backed server/rag and browser flows are not in the default verification command path.
- Coverage risk: runtime-critical package coverage gating is partial (not all runtime-critical packages carry `test:coverage`).

Harness/env/CI/portability distortions:
- Strict gate currently depends on pre-existing generated coverage artifacts and docs artifacts.
- Strict gate can fail before build/typecheck/lint/test, giving early red signals not directly tied to runtime behavior.
- Compatibility workflow is coupled to external workspace layout and suppresses some publish errors.
- Secondary static artifacts (under `out/`) can look “green” while live strict command is currently red, causing confidence drift.

How this distorts engineering confidence:
- False negatives: clean runners fail due missing artifacts even when code changes are correct.
- False positives: previously generated local artifacts can allow coverage gates to appear healthier than current diff reality.
- Mixed signal quality: CI lanes vary in determinism and scope, making it difficult to infer end-to-end correctness from one status.

## Recommended Verification Restructure

1. Make strict verification hermetic and product-focused.
- Introduce `test:coverage:all` that runs coverage generation for all coverage-enabled workspaces (for example via Turbo).
- Reorder strict pipeline to:
  - `yarn test:inventory:runtime:strict`
  - `yarn check:domain-boundaries`
  - `yarn check:terminal-tool-event-guards`
  - `turbo run build typecheck lint test`
  - `yarn test:coverage:all`
  - `yarn test:coverage:workspace`
  - `yarn check:waiver-expiry`
- Keep docs freshness checks out of the core correctness bundle.

2. Split docs/metadata freshness into separate required CI.
- Move `check:capability-matrix` from `verify:strict` to a dedicated docs workflow.
- Keep it required for docs-sensitive changes, but not as a blocker for core correctness signal.

3. Add an explicit integration lane.
- Add `verify:integration` for env-backed tests:
  - `@dzupagent/server` integration suites.
  - `@dzupagent/rag` live-Qdrant integration suite.
  - `@dzupagent/playground` Playwright e2e.
- Run this lane nightly and on labeled PRs (`needs-integration`) with required status for high-risk changes.

4. Close runtime-critical coverage gaps.
- Add `test:coverage` to runtime-critical packages currently excluded (starting with `@dzupagent/scraper`).
- Extend `coverage-thresholds.json` to include newly covered runtime packages with thresholds or explicit short-lived waivers.

5. Harden release gates.
- Update publish workflow to require at least `yarn verify` before publish.
- Promote to `yarn verify:strict` once hermetic strict path is fixed.

6. Repair or relocate compatibility matrix workflow.
- Remove `|| true` from snapshot publish loop, or explicitly aggregate/validate publish failures.
- If cross-repo layout is required, move this workflow to the workspace-level orchestration repo; otherwise rewrite paths to current repo topology.

## Net Assessment
- Core package correctness (`agent`, `agent-adapters`, `core`, `memory*`): **Moderate-High confidence** from large test volume plus targeted static guards.
- Integration correctness (`server` infra paths, `rag` live vector store, browser/e2e): **Moderate-Low confidence** in default loop because these paths are environment-gated and not first-class in root verification.
- Coverage signal quality: **Moderate confidence** with strong thresholds where artifacts exist, but weakened by waivers and missing coverage scripts in some runtime-critical areas.
- CI/release harness trustworthiness: **Moderate-Low confidence** until strict gate is hermetic and release workflow enforces broader verification.
- Overall: The codebase has meaningful correctness scaffolding, but the default engineering feedback loop is not yet fully trustworthy end-to-end because strict verification currently mixes product checks with artifact-dependent and non-runtime preconditions.
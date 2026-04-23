# Verification And Release Stabilization (2026-04-23)

## Goal

Make verification and release gates authoritative so the repo can use green status as real engineering and release signal.

Current shared status:
- `not done`

Primary control references:
- [`../STABILIZATION_REBASELINE_2026-04-23.md`](../STABILIZATION_REBASELINE_2026-04-23.md)
- [`STABILIZATION_MATRIX_2026-04-23.md`](./STABILIZATION_MATRIX_2026-04-23.md)

Detailed analysis references:
- [`../analyze-full_2026_04_21/02_correctness_and_verification.md`](../analyze-full_2026_04_21/02_correctness_and_verification.md)
- [`../analyze-full_2026_04_21/07_operability_and_release_readiness.md`](../analyze-full_2026_04_21/07_operability_and_release_readiness.md)
- [`../analyze-full_2026_04_21/13_data_model_and_migrations.md`](../analyze-full_2026_04_21/13_data_model_and_migrations.md)

## Scope

Primary paths:
- `package.json`
- `.github/workflows/`
- `scripts/check-workspace-coverage.mjs`
- `scripts/check-runtime-test-inventory.mjs`
- `scripts/check-capability-matrix-freshness.mjs`
- `packages/server/package.json`
- `packages/server/drizzle/`
- `packages/server/drizzle.config.ts`

## Risks To Remove

1. `verify:strict` can fail for missing artifacts before proving code health.
2. Release automation is weaker than the repository's intended correctness standard.
3. Migration application and migration-check behavior are not first-class release gates.
4. Environment-backed integration behavior is outside the main verification story.

## Evidence Baseline

Root script ordering still shows the core problem:
- `verify:strict` currently runs drift, coverage, and capability-matrix checks before `turbo run build typecheck lint test`

Analysis-pack findings that remain the active baseline:
- strict gate is non-hermetic
- coverage gate depends on pre-existing summaries
- publish path is build-heavy but not full correctness-gated
- migration workflow is underdefined for production safety

## Required Work

### 1. Make `verify:strict` hermetic

Required outcome:
- strict verification generates the artifacts it needs or moves non-product freshness checks out of the core correctness lane

Minimum shape:
- runtime inventory strict
- boundary checks
- Turbo build/typecheck/lint/test
- coverage generation
- workspace coverage validation
- waiver expiry

Exit condition:
- a clean runner can execute `verify:strict` without pre-seeded local artifacts

### 2. Separate docs freshness from correctness signal

Required outcome:
- missing docs artifacts do not cause the core correctness lane to fail before code is evaluated

Exit condition:
- docs freshness remains required where appropriate, but it is not masquerading as runtime correctness

### 3. Add an explicit integration lane

Required outcome:
- env-backed server, RAG, and playground checks have a named place in the control model

Suggested direction:
- `verify:integration`
- nightly or labeled PR execution
- required status for high-risk changes

Exit condition:
- teams can point to one explicit lane for infra-backed truth instead of informal ad-hoc reruns

### 4. Promote migration controls to release gates

Required outcome:
- migration apply/check commands exist and are part of release expectations

Minimum shape:
- `db:migrate`
- `db:migrate:check`
- publish workflow references verification and migration readiness

Exit condition:
- release claims are not made from build-only success

### 5. Align publish workflow with actual trust bar

Required outcome:
- publish automation enforces at least the baseline verify path, and eventually the strict path once it is hermetic

Exit condition:
- release workflow no longer undercuts the tracked stabilization bar

## Verification Requirements

Minimum proof before closing this area:

1. `yarn verify`
2. `yarn verify:strict`
3. explicit record of any integration lane and migration gate behavior
4. exact failing package/check recorded if any gate is still red

Recommended additional proof:

1. clean-runner CI evidence for strict gate determinism
2. release workflow evidence showing pre-publish verification and migration checks
3. runtime-critical coverage expansion where the current matrix has gaps

## Completion Rule

Do not mark this area `done` unless:

1. strict verification is hermetic enough to serve as a trust signal
2. publish path no longer relies on weaker proof than the tracked stabilization model
3. migration readiness is part of release truth rather than operator convention

## Explicit Non-Goals During This Tranche

1. Expanding every possible CI workflow at once
2. Perf-oriented pipeline tuning before correctness signal is fixed
3. Broad documentation churn unrelated to verification or release truth

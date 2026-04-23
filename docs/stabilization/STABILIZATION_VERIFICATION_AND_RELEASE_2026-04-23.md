# Verification And Release Stabilization (2026-04-23)

## Goal

Make verification and release gates authoritative so the repo can use green status as real engineering and release signal.

Current shared status:
- `in progress`

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

Active live baseline after the current stabilization wave:
- strict preflights are green in-session
- `@dzupagent/agent-adapters` coverage summaries are generated again
- capability-matrix generation and freshness checks are now plain-Node and sandbox-safe
- `@dzupagent/server` package-local blockers were fixed and the full package test lane is green
- `yarn verify:strict` completed successfully in the current session

Remaining verification gap:
- `yarn verify` has not yet been re-run to completion after the current stabilization wave
- publish and integration controls are still weaker than the repo's now-proven strict baseline

## Required Work

### 1. Make `verify:strict` hermetic

Required outcome:
- strict verification generates the artifacts it needs or moves non-product freshness checks out of the core correctness lane

Current progress:
- capability-matrix generation no longer depends on `tsx` IPC or shell-spawn behavior
- workspace coverage summaries are available for the packages currently tracked by the strict lane
- the strict lane has been observed green end to end after the current package fixes

Minimum shape:
- runtime inventory strict
- boundary checks
- Turbo build/typecheck/lint/test
- coverage generation
- workspace coverage validation
- waiver expiry

Exit condition:
- a clean runner can execute `verify:strict` without pre-seeded local artifacts

### 2. Widen The Baseline Back To `verify`

Required outcome:
- the broader verification lane does not quietly diverge from the now-stable strict lane

Required verification:
- `yarn verify`
- record the exact first failing package/check if the broader lane still differs from strict

Exit condition:
- the repo can point to one broader baseline and one strict baseline without contradictory status

### 3. Separate docs freshness from correctness signal

Required outcome:
- missing docs artifacts do not cause the core correctness lane to fail before code is evaluated

Current progress:
- this risk is reduced for `CAPABILITY_MATRIX.md` because the checker can now generate and compare the artifact in-process

Exit condition:
- docs freshness remains required where appropriate, but it is not masquerading as runtime correctness

### 4. Add An Explicit Integration Lane

Required outcome:
- env-backed server, RAG, and playground checks have a named place in the control model

Suggested direction:
- `verify:integration`
- nightly or labeled PR execution
- required status for high-risk changes

Exit condition:
- teams can point to one explicit lane for infra-backed truth instead of informal ad-hoc reruns

### 5. Promote Migration Controls To Release Gates

Required outcome:
- migration apply/check commands exist and are part of release expectations

Minimum shape:
- `db:migrate`
- `db:migrate:check`
- publish workflow references verification and migration readiness

Exit condition:
- release claims are not made from build-only success

### 6. Align Publish Workflow With Actual Trust Bar

Required outcome:
- publish automation enforces at least the baseline verify path, and eventually the strict path once it is hermetic

Exit condition:
- release workflow no longer undercuts the tracked stabilization bar

## Verification Requirements

Minimum proof before closing this area:

1. `yarn verify:strict`
2. `yarn verify`
3. explicit record of any integration lane and migration gate behavior
4. exact failing package/check recorded if any gate is still red

Current next proof target:
1. run `yarn verify`
2. if it fails, record the first failing package/check
3. fix only that blocker
4. rerun the narrowest proving command
5. widen back to `yarn verify`

Recommended additional proof:

1. clean-runner CI evidence for strict gate determinism
2. release workflow evidence showing pre-publish verification and migration checks
3. runtime-critical coverage expansion where the current matrix has gaps

## Completion Rule

Do not mark this area `done` unless:

1. strict verification is hermetic enough to serve as a trust signal
2. the broader verification lane is also revalidated and its status does not contradict strict
3. publish path no longer relies on weaker proof than the tracked stabilization model
4. migration readiness is part of release truth rather than operator convention

## Explicit Non-Goals During This Tranche

1. Expanding every possible CI workflow at once
2. Perf-oriented pipeline tuning before correctness signal is fixed
3. Broad documentation churn unrelated to verification or release truth

# Stabilization Matrix (2026-04-23)

This matrix is the tracked coordination view for the current stabilization cycle. It is derived from:

- [`../STABILIZATION_REBASELINE_2026-04-23.md`](../STABILIZATION_REBASELINE_2026-04-23.md)
- [`../analyze-full_2026_04_21/00_master_summary.md`](../analyze-full_2026_04_21/00_master_summary.md)
- [`../analyze-full_2026_04_21/11_recommendations_and_roadmap.md`](../analyze-full_2026_04_21/11_recommendations_and_roadmap.md)

## Shared Goal

Remove process drift, narrow the live change surface, and restore trust in the codebase before resuming broad feature expansion.

## Area Matrix

| Area | Current status | Primary packages | Main risk being removed | Dependency order | Required proof | Companion doc | Detailed analysis refs |
|---|---|---|---|---|---|---|---|
| Runtime truth | partially done | `server`, `agent`, `core` | False terminal states, unsafe cancellation, queue/worker truth drift | first | Targeted lifecycle tests, persistence review, explicit cancel semantics | [`STABILIZATION_RUNTIME_TRUTH_2026-04-23.md`](./STABILIZATION_RUNTIME_TRUTH_2026-04-23.md) | [`07_operability_and_release_readiness.md`](../analyze-full_2026_04_21/07_operability_and_release_readiness.md), [`11_recommendations_and_roadmap.md`](../analyze-full_2026_04_21/11_recommendations_and_roadmap.md) |
| Security boundaries | partially done | `server`, `core`, `create-dzupagent` | Permissive control-plane behavior, secret exposure, weak authz boundaries | parallel with runtime truth, but must finish before release truth | Route-level denial coverage and secure-default behavior | [`STABILIZATION_SECURITY_BOUNDARIES_2026-04-23.md`](./STABILIZATION_SECURITY_BOUNDARIES_2026-04-23.md) | [`04_security_review.md`](../analyze-full_2026_04_21/04_security_review.md), [`11_recommendations_and_roadmap.md`](../analyze-full_2026_04_21/11_recommendations_and_roadmap.md) |
| Contract convergence | not done | `server`, `playground`, `core`, `create-dzupagent` | Active producer-consumer drift on A2A, marketplace, events, and envelopes | after runtime/security decisions are pinned | Live producer-consumer verification plus compatibility notes | [`STABILIZATION_CONTRACT_CONVERGENCE_2026-04-23.md`](./STABILIZATION_CONTRACT_CONVERGENCE_2026-04-23.md) | [`14_api_surface_and_contracts.md`](../analyze-full_2026_04_21/14_api_surface_and_contracts.md), [`09_feature_gap_matrix.md`](../analyze-full_2026_04_21/09_feature_gap_matrix.md) |
| Verification and release | not done | repo root, `server`, CI workflows | Non-hermetic strict gate, weak publish gating, migration drift | in parallel with runtime/security, must finish before release claims | `verify`, `verify:strict`, coverage generation flow, migration/release checks | [`STABILIZATION_VERIFICATION_AND_RELEASE_2026-04-23.md`](./STABILIZATION_VERIFICATION_AND_RELEASE_2026-04-23.md) | [`02_correctness_and_verification.md`](../analyze-full_2026_04_21/02_correctness_and_verification.md), [`07_operability_and_release_readiness.md`](../analyze-full_2026_04_21/07_operability_and_release_readiness.md), [`13_data_model_and_migrations.md`](../analyze-full_2026_04_21/13_data_model_and_migrations.md) |
| Docs and scaffolder truth | in progress | `docs`, `server`, `playground`, `create-dzupagent` | Status/documentation drift that reintroduces bad defaults | should track every other tranche, must finish before "stabilized" claim | Updated tracked docs, smoke checks, fixed version/doc truth | [`STABILIZATION_DOCS_AND_SCAFFOLDER_TRUTH_2026-04-23.md`](./STABILIZATION_DOCS_AND_SCAFFOLDER_TRUTH_2026-04-23.md) | [`08_product_and_docs_consistency.md`](../analyze-full_2026_04_21/08_product_and_docs_consistency.md), [`15_developer_experience_and_onboarding.md`](../analyze-full_2026_04_21/15_developer_experience_and_onboarding.md) |

## Recommended Order

1. Runtime truth
2. Security boundaries
3. Verification and release
4. Contract convergence
5. Docs and scaffolder truth

Notes:
- `verification and release` can run in parallel with `runtime truth` and `security boundaries`, but release-authoritative claims should stay blocked until those areas are green.
- `docs and scaffolder truth` should be updated continuously, but it should not replace the runtime/security/contract gates.

## Active Tranche Guardrails

1. Keep the active tranche narrow. Do not work broad `server` and broad `playground` changes in the same wave unless the wave is explicitly a contract-convergence tranche.
2. Every area must record:
   - exact commands run
   - exact failing command if still open
   - touched paths
   - consumer impact
   - compatibility note if behavior changed
3. "Partially done" is acceptable only while the missing proof is identified by exact commands or exact open tests.
4. No area may be marked `done` if it still depends on hidden local state or ignored docs to pass.

## Completion Standard

The stabilization cycle is not complete until:

1. runtime truth is green
2. security boundaries are green
3. contract convergence is green on active seams
4. verification and release gates are authoritative
5. tracked docs and scaffolder truth match the live workspace

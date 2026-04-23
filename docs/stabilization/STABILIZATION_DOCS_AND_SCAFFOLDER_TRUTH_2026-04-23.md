# Docs And Scaffolder Truth Stabilization (2026-04-23)

## Goal

Make tracked docs, version identity, and scaffolder defaults match the live workspace so status reporting and downstream setup stop reintroducing drift.

Current shared status:
- `in progress`

Primary control references:
- [`../STABILIZATION_REBASELINE_2026-04-23.md`](../STABILIZATION_REBASELINE_2026-04-23.md)
- [`STABILIZATION_MATRIX_2026-04-23.md`](./STABILIZATION_MATRIX_2026-04-23.md)

Detailed analysis references:
- [`../analyze-full_2026_04_21/08_product_and_docs_consistency.md`](../analyze-full_2026_04_21/08_product_and_docs_consistency.md)
- [`../analyze-full_2026_04_21/15_developer_experience_and_onboarding.md`](../analyze-full_2026_04_21/15_developer_experience_and_onboarding.md)
- [`../analyze-full_2026_04_21/11_recommendations_and_roadmap.md`](../analyze-full_2026_04_21/11_recommendations_and_roadmap.md)

## Scope

Primary paths:
- `docs/`
- `README.md`
- `MIGRATION.md`
- high-traffic package READMEs
- `packages/create-dzupagent/`
- version-reporting surfaces in `packages/core`, `packages/agent`, and `packages/server`

## Risks To Remove

1. Tracked docs can claim states or versions that no longer match code.
2. Strict/doc gates can depend on missing artifacts or broken entry points.
3. Scaffolder defaults can propagate stale auth/config assumptions.
4. Status reporting can look green while the actual workspace is still drifting.

## Evidence Baseline

Active drift examples from the analysis pack:
- missing `docs/README.md`
- missing `docs/CAPABILITY_MATRIX.md` while strict checks require it
- runtime/doc version mismatch (`0.1.0` vs `0.2.0`)
- server README examples no longer match current auth config types
- migration docs and wave trackers contain contradictory status claims

## Required Work

### 1. Establish the tracked docs entry points

Required outcome:
- `docs/` has a clear tracked hub and the stabilization doc set is discoverable

Exit condition:
- root and docs navigation no longer points to missing or misleading primary artifacts

### 2. Normalize version truth

Required outcome:
- package manifests, runtime constants, health endpoints, and README snippets report the same version lineage

Exit condition:
- operators and consumers do not get contradictory version identity from code vs docs

### 3. Fix high-traffic copy-paste paths

Required outcome:
- root README, server README, playground README, and migration guidance reflect current package names, config types, and route/auth expectations

Exit condition:
- common setup snippets are type-accurate and path-accurate

### 4. Align scaffolder defaults with stabilized contracts

Required outcome:
- generated projects do not encode stale auth or route assumptions

Exit condition:
- smoke tests cover current server contract expectations for generated apps/templates

### 5. Keep status truth synchronized

Required outcome:
- tracked docs say exactly what is proven, not what used to be true

Exit condition:
- wave/rebaseline status tables do not contradict current verification evidence

## Verification Requirements

Minimum proof before closing this area:

1. docs hub and stabilization docs are tracked and linked from the active control docs
2. high-traffic docs updated for any changed auth, route, version, or migration behavior
3. scaffolder or example paths updated alongside contract changes
4. doc-sensitive checks or smoke checks recorded if they are part of the updated process

Recommended additional proof:

1. dead-link checks
2. README example validation or type-checked examples where practical
3. scaffold smoke test coverage for current server contract

## Completion Rule

Do not mark this area `done` unless:

1. docs stop contradicting the current tracked stabilization state
2. version and capability claims are sourced from real workspace truth
3. scaffolder and docs no longer reintroduce stale defaults for current server behavior

## Explicit Non-Goals During This Tranche

1. Broad marketing or product-positioning rewrites
2. Reformatting legacy docs without fixing truth gaps
3. Treating docs-only green status as proof of codebase stabilization

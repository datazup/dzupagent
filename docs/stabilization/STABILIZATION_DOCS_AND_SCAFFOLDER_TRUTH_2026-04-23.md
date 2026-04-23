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

Current live progress from this session:
- `docs/CAPABILITY_MATRIX.md` now exists and can be generated/checked via plain Node tooling
- `yarn verify:strict` is now green, so docs can no longer describe execution truth as "not yet proven"
- `yarn verify` is now green, so the broader workspace baseline is also no longer an open-status unknown
- `create-dzupagent` CLI version, generated project version, and generated `@dzupagent/*` dependency pins were aligned to `0.2.0`
- `create-dzupagent` README now reflects the real nine-template, five-preset surface
- the remaining docs/scaffolder drift is now primarily about duplicated truth ownership, mixed public naming, and any remaining stale high-traffic README examples outside the scaffolder package rather than missing generation paths
- root lint participation is now workspace-complete and warning-clean, which removes the earlier policy and signal-quality drift from this area

## Required Work

### 1. Establish the tracked docs entry points

Required outcome:
- `docs/` has a clear tracked hub and the stabilization doc set is discoverable

Exit condition:
- root and docs navigation no longer points to missing or misleading primary artifacts

### 2. Normalize version truth

Required outcome:
- package manifests, runtime constants, health endpoints, and README snippets report the same version lineage

Current progress:
- scaffolder-emitted version identity is aligned to `0.2.0`

Remaining gap:
- version truth is still duplicated across multiple package READMEs and runtime-facing constants

Exit condition:
- operators and consumers do not get contradictory version identity from code vs docs

### 3. Fix high-traffic copy-paste paths

Required outcome:
- root README, server README, playground README, scaffolder README, and migration guidance reflect current package names, config types, template inventory, and route/auth expectations

Exit condition:
- common setup snippets are type-accurate and path-accurate

### 4. Align scaffolder defaults with stabilized contracts

Required outcome:
- generated projects do not encode stale auth or route assumptions

Current progress:
- generated package versions and dependency pins no longer start new projects on stale `0.1.0` contracts

Remaining gap:
- the package still has multiple generation paths and no single-source version helper, so this class of drift can recur
- template inventory and preset-oriented onboarding copy can still drift unless README truth is updated alongside registry changes

Exit condition:
- smoke tests cover current server contract expectations for generated apps/templates

### 5. Keep status truth synchronized

Required outcome:
- tracked docs say exactly what is proven, not what used to be true

Exit condition:
- wave/rebaseline status tables do not contradict current verification evidence

### 6. Reduce naming ambiguity in docs and scaffolder surfaces

Required outcome:
- docs and generated surfaces do not present `DzupAgent`, `Forge`, and `DZIP` as if they are interchangeable without a compatibility explanation

Exit condition:
- public docs and generated defaults have one canonical term set per surface, with aliases called out explicitly where compatibility requires them

## Verification Requirements

Minimum proof before closing this area:

1. docs hub and stabilization docs are tracked and linked from the active control docs
2. high-traffic docs updated for any changed auth, route, version, or migration behavior
3. scaffolder or example paths updated alongside contract changes
4. doc-sensitive checks or smoke checks recorded if they are part of the updated process
5. rebaseline/status docs reflect the actually observed strict verification state

Recommended additions for the next wave:

1. snapshot tests that assert scaffolder-emitted package versions track the intended repo version
2. README/example scans for stale template counts, naming aliases, and `0.1.0` references outside the scaffolder package
3. a rule that any export-surface change regenerates `docs/CAPABILITY_MATRIX.md` in the same change wave

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

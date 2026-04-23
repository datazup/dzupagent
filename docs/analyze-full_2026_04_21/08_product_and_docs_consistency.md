# Product and Docs Consistency Review (`08_product_and_docs_consistency`)

## Repository Overview
`dzupagent` is a Yarn 1 + Turbo TypeScript monorepo with a large platform surface (SDK packages, server runtime, adapters, memory/RAG, and a playground UI).  
This review compared documentation claims against live code for product behavior, release metadata, route exposure, and planning/status artifacts.

Observed implementation shape relevant to consistency:
- Server route surface is broad and configuration-gated in [`packages/server/src/app.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts#L557).
- Package version manifests are on `0.2.0` for core packages (for example [`packages/core/package.json:3`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/package.json:3)).
- Multiple package READMEs and exported runtime constants still advertise `0.1.0` (for example [`packages/core/src/index.ts:961`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/index.ts:961)).

## Documentation Sources Reviewed
- Root and migration docs:
- [`README.md`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/README.md)
- [`MIGRATION.md`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/MIGRATION.md)
- [`AGENTS.md`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/AGENTS.md)

- Planning, ADRs, and tracking:
- [`docs/WAVE22_TRACKING.md`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/docs/WAVE22_TRACKING.md)
- [`docs/WAVE23_TRACKING.md`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/docs/WAVE23_TRACKING.md)
- [`docs/tooling/DECISIONS_WAVE_11.md`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/docs/tooling/DECISIONS_WAVE_11.md)
- [`docs/ADR-001-qdrant-isolation-strategy.md`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/docs/ADR-001-qdrant-isolation-strategy.md)

- Package README surface:
- Root plus package READMEs under `packages/*/README.md` (21 files), including:
- [`packages/server/README.md`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/README.md)
- [`packages/agent/README.md`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/README.md)
- [`packages/core/README.md`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/README.md)
- [`packages/playground/README.md`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/playground/README.md)
- [`packages/connectors/README.md`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/connectors/README.md)

- Implementation files used for consistency checks:
- [`packages/server/src/app.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts)
- [`packages/server/src/middleware/auth.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/middleware/auth.ts)
- [`packages/server/src/routes/health.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/health.ts)
- [`packages/server/src/routes/runs.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/runs.ts)
- [`packages/server/src/routes/compile.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/compile.ts)
- [`packages/server/src/routes/spawn-compiler-bridge.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/spawn-compiler-bridge.ts)
- [`packages/agent/src/index.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/index.ts)
- [`packages/core/src/index.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/index.ts)
- [`packages/server/src/index.ts`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/index.ts)

- Docs/check scripts and hidden docs:
- [`package.json`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/package.json)
- [`scripts/check-capability-matrix-freshness.mjs`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/scripts/check-capability-matrix-freshness.mjs)
- [`scripts/check-improvements-drift.mjs`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/scripts/check-improvements-drift.mjs)
- `.docs/improvements/*` symlinks (hidden docs dependency outside repo tree)

- Workspace/project indexes and `out/` artifacts:
- [`PROJECT_INDEX.md`](/media/ninel/Second/code/datazup/ai-internal-dev/PROJECT_INDEX.md)
- [`PROJECT_INDEX.json`](/media/ninel/Second/code/datazup/ai-internal-dev/PROJECT_INDEX.json)
- [`out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md`](/media/ninel/Second/code/datazup/ai-internal-dev/out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md)
- [`out/workspace-repo-docs-static-portable-markdown/SUMMARY.md`](/media/ninel/Second/code/datazup/ai-internal-dev/out/workspace-repo-docs-static-portable-markdown/SUMMARY.md)
- [`out/workspace-commit-groups/dzupagent/plan.json`](/media/ninel/Second/code/datazup/ai-internal-dev/out/workspace-commit-groups/dzupagent/plan.json)
- [`out/knowledge-index/gap-analysis-requirements.dzupagent.md`](/media/ninel/Second/code/datazup/ai-internal-dev/out/knowledge-index/gap-analysis-requirements.dzupagent.md)

## Alignment Areas
- Root build/test guidance is aligned with implementation scripts and toolchain (`yarn@1.22.22`, Turbo pipeline): [`README.md:9`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/README.md:9), [`package.json:4`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/package.json:4), [`package.json:11`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/package.json:11).
- Core API tier guidance (`@dzupagent/core`, `/stable`, `/advanced`) matches package exports: [`README.md:83`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/README.md:83), [`packages/core/package.json:12`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/package.json:12).
- Wave 11 architecture decisions are materially implemented (async resolvers, always-async compile path, `RESOLVER_INFRA_ERROR`, `forwardInnerEvents` contract): [`docs/tooling/DECISIONS_WAVE_11.md`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/docs/tooling/DECISIONS_WAVE_11.md), [`packages/flow-ast/src/types.ts:82`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-ast/src/types.ts:82), [`packages/flow-compiler/src/index.ts:90`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-compiler/src/index.ts:90), [`packages/flow-compiler/src/stages/semantic.ts:291`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-compiler/src/stages/semantic.ts:291).
- Wave 22/23 completion notes are backed by actual deep-test files present in the repo (for example `evals-llm-benchmark-deep`, `plugin-mcp-deep`, `ws-event-bridge-deep`).

## Drift Findings
1. **Critical**: Migration guide states built-in presets were removed, but code still exports them.
Evidence: [`MIGRATION.md:127`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/MIGRATION.md:127), [`MIGRATION.md:185`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/MIGRATION.md:185), versus live exports in [`packages/agent/src/index.ts:627`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/index.ts:627).  
Impact: migration decisions and deprecation planning can be materially wrong.

2. **High**: Version identity is inconsistent between package manifests and runtime/doc-facing constants.
Evidence: manifests at `0.2.0` in [`packages/core/package.json:3`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/package.json:3), [`packages/agent/package.json:3`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/package.json:3), [`packages/server/package.json:3`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/package.json:3), but runtime constants/health still `0.1.0` in [`packages/core/src/index.ts:961`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/index.ts:961), [`packages/agent/src/index.ts:698`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/index.ts:698), [`packages/server/src/index.ts:504`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/index.ts:504), [`packages/server/src/routes/health.ts:20`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/health.ts:20).  
Impact: release observability and compatibility tracking are unreliable.

3. **High**: Root docs and strict-doc gate are broken by missing referenced artifacts.
Evidence: README links to missing docs hub [`README.md:115`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/README.md:115), strict verify includes capability matrix check [`package.json:29`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/package.json:29), checker hard-requires `docs/CAPABILITY_MATRIX.md` [`scripts/check-capability-matrix-freshness.mjs:16`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/scripts/check-capability-matrix-freshness.mjs:16), but file is absent.  
Impact: onboarding and CI expectations diverge from repository reality.

4. **High**: Server README usage examples are not type-accurate for current server config.
Evidence: README auth example uses `auth: { apiKeys: [...] }` [`packages/server/README.md:77`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/README.md:77), while `AuthConfig` requires `mode` plus optional `validateKey` [`packages/server/src/middleware/auth.ts:9`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/middleware/auth.ts:9), and `ForgeServerConfig` expects `auth?: AuthConfig` [`packages/server/src/app.ts:167`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts:167).  
Impact: copy-paste integration from docs fails or misconfigures auth.

5. **High**: Package README version/dependency references are stale (`0.1.0`) across multiple packages.
Evidence in package docs: [`packages/agent/README.md:159`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/README.md:159), [`packages/core/README.md:169`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/README.md:169), [`packages/connectors/README.md:117`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/connectors/README.md:117).  
Impact: dependency expectations and migration guidance are outdated for consumers.

6. **Medium**: Product API docs underrepresent the actual server surface.
Evidence: README “Default Routes” is narrow [`packages/server/README.md:111`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/README.md:111), while app wiring mounts many additional routes (`/api/prompts`, `/api/personas`, `/api/presets`, `/api/marketplace`, `/api/reflections`, `/api/mailbox`, `/api/clusters`, `/v1/*`, `/metrics`) in [`packages/server/src/app.ts:557`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts:557).  
Impact: product planning and client integration miss real capabilities.

7. **Medium**: Planning-status docs contain conflicting state in the same file.
Evidence: W22/W23 task summary still shows `pending` [`docs/WAVE22_TRACKING.md:37`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/docs/WAVE22_TRACKING.md:37), [`docs/WAVE23_TRACKING.md:37`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/docs/WAVE23_TRACKING.md:37), while progress section reports all tasks `✅ DONE` [`docs/WAVE22_TRACKING.md:188`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/docs/WAVE22_TRACKING.md:188), [`docs/WAVE23_TRACKING.md:189`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/docs/WAVE23_TRACKING.md:189).  
Impact: PM and release reporting can interpret opposite statuses from one artifact.

8. **Medium**: Workspace-level project index metadata drifts from current repo facts.
Evidence: index claims dzupagent is “Yarn 4, 28 packages” [`PROJECT_INDEX.md:9`](/media/ninel/Second/code/datazup/ai-internal-dev/PROJECT_INDEX.md:9) and root package manager `yarn@4` [`PROJECT_INDEX.json:6`](/media/ninel/Second/code/datazup/ai-internal-dev/PROJECT_INDEX.json:6), while dzupagent repo is `yarn@1.22.22` [`dzupagent/package.json:4`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/package.json:4) with 29 top-level package dirs containing manifests.  
Impact: cross-repo automation and new contributor setup may choose wrong commands/tooling.

9. **Low**: Internal route docs include path ambiguity around compile subprocess flow.
Evidence: comment says “Use with `POST /compile`” in [`packages/server/src/routes/spawn-compiler-bridge.ts:6`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/spawn-compiler-bridge.ts:6), while mounted path is `/api/workflows/compile` [`packages/server/src/app.ts:446`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts:446).  
Impact: low direct risk, but contributes to route confusion.

10. **Low**: Static `out/` repo doc overstates health confidence versus observed doc drift.
Evidence: “Health score 100/100” and “No obvious structural gaps” in [`out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md:54`](/media/ninel/Second/code/datazup/ai-internal-dev/out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md:54), [`out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md:191`](/media/ninel/Second/code/datazup/ai-internal-dev/out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md:191).  
Impact: low if treated as navigation; higher if treated as release-readiness truth.

## Product-Surface Consistency Review
- **Routed UI**: Documentation correctly states optional playground mount at `/playground` (README and app wiring align), but example paths are stale (`packages/dzupagent-playground`) in both playground and server docs ([`packages/playground/README.md:42`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/playground/README.md:42), [`packages/server/README.md:90`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/README.md:90)).
- **Exposed APIs**: Actual product surface includes API-key management, workflows/compile, prompts/personas/presets, marketplace/reflections, mailbox/clusters, OpenAI-compatible `/v1` routes, and `/metrics`; package docs still present a smaller default route list.
- **Feature flags and runtime toggles**: Behavior depends on distributed env/config switches (`USE_DRIZZLE_A2A`, `SSE_KEEPALIVE_INTERVAL_MS`, `RUN_TIMEOUT_MS`, notification webhooks, compile `?subprocess=true`) in code ([`packages/server/src/app.ts:622`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts:622), [`packages/server/src/routes/runs.ts:649`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/runs.ts:649), [`packages/server/src/routes/compile.ts:205`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/routes/compile.ts:205)); no canonical operator-facing flag matrix was found in root/package docs.
- **Capability claims vs implementation**: Decisions around Wave 11 and Qdrant strategy are mostly aligned to code, but migration/version/API surface docs are not consistently aligned with shipped behavior.

## Onboarding Risk Review
- New engineers are likely to encounter broken references quickly (`docs/README.md` missing, capability matrix required by strict checks but absent), causing early trust erosion in docs.
- Integrators using package READMEs may adopt invalid config (server auth example) or wrong package paths (`dzupagent-playground`), creating avoidable setup failures.
- PM/release stakeholders can misread status due to contradictory wave statuses (`pending` and `DONE` in the same trackers) and inconsistent version identity (`0.1.0` runtime constants vs `0.2.0` manifests).
- Cross-repo operators using workspace indexes may pick wrong package-manager assumptions for dzupagent due to stale `PROJECT_INDEX` metadata.
- Hidden symlinked docs under `.docs/improvements` add portability risk because critical drift checks depend on content outside the repository boundary.

## Recommended Doc Refresh Plan
1. Resolve migration contradiction first: either update [`MIGRATION.md`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/MIGRATION.md) to reflect current preset exports, or remove those exports and update tests accordingly.
2. Normalize version truth source: generate runtime version constants from package manifests and refresh all README/API version snippets to `0.2.x`.
3. Add missing documentation hub file [`docs/README.md`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/docs/README.md) or remove the dead link in root README if intentionally omitted.
4. Regenerate and commit [`docs/CAPABILITY_MATRIX.md`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/docs/CAPABILITY_MATRIX.md), then keep `check:capability-matrix` as a real freshness gate.
5. Rewrite [`packages/server/README.md`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/README.md) examples to match current types (`AuthConfig`) and current paths (`packages/playground/dist`).
6. Publish a canonical server surface matrix (routes, conditional mounts, auth scope, and `/v1` behavior) sourced from `createForgeApp` route wiring.
7. Publish a single runtime toggle reference (env var/config key, default, scope, and operational impact) for server deployment behavior.
8. Clean W22/W23 trackers by reconciling “Task Summary” statuses with “Progress” outcomes; keep one canonical status table.
9. Refresh workspace-level indexes [`PROJECT_INDEX.md`](/media/ninel/Second/code/datazup/ai-internal-dev/PROJECT_INDEX.md) and [`PROJECT_INDEX.json`](/media/ninel/Second/code/datazup/ai-internal-dev/PROJECT_INDEX.json) from live repo metadata (package manager, package counts, wave links).
10. Mark `out/` static repo docs as non-authoritative snapshots unless they include stronger staleness/validation markers.
11. Add doc-consistency CI checks: dead-link detection, README version drift checks, and route-example validation against mounted prefixes.

## Overall Assessment
Documentation reliability is **mixed**: architecture and some decision records are well aligned, but product-facing docs have several high-impact drifts (migration guidance, version identity, server usage examples, and API surface coverage).  
Current docs are usable for orientation, but not fully reliable for release decisions, onboarding accuracy, or integration correctness without direct code verification.
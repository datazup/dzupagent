# Developer Experience And Onboarding Review (`15_developer_experience_and_onboarding`)

## Repository Overview
`dzupagent` is a Yarn 1 + Turbo TypeScript monorepo with a broad package surface (29 package manifests under `packages/*` in this checkout). Core onboarding entry points are the root README, repo automation guidance, and package-level READMEs, with additional status artifacts in `docs/` and `out/`.

Primary sources reviewed:
- Root onboarding and workflow docs in [`README.md`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/README.md#L1) and [`AGENTS.md`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/AGENTS.md#L1).
- Build/verification definitions in [`package.json`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/package.json#L1), [`turbo.json`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/turbo.json#L1), and `scripts/*` checks.
- High-surface package docs and runtime files, especially server and playground docs.

Secondary artifacts reviewed:
- Static repo summary in [`out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md`](/media/ninel/Second/code/datazup/ai-internal-dev/out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md#L1).
- Existing analysis set under [`docs/analyze-full_2026_04_21/`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/docs/analyze-full_2026_04_21/).

## Onboarding Surface
Main onboarding surface is present but fragmented.

What a new contributor sees first:
- Requirements are clear and minimal: Node `>=20` + Yarn `1.22.22` in [`README.md:7`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/README.md:7).
- Quick start and common loops are explicit: `yarn install`, `yarn build`, `yarn dev`, and package-filtered Turbo checks in [`README.md:12`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/README.md:12).
- Repo contributor guidance is concrete and command-focused in [`AGENTS.md:8`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/AGENTS.md:8).

What is less clear during first setup:
- The README points to a docs hub file that does not exist (`docs/README.md`) in [`README.md:113`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/README.md:113), and `docs/` currently contains mostly wave tracking and analysis artifacts rather than newcomer-oriented setup docs ([`docs/`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/docs/)).
- No root `.env.example` exists; only template-level example env exists under scaffolding output ([`packages/create-dzupagent/node/.env.example`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/create-dzupagent/node/.env.example)).
- Strict verification prerequisites are not obvious from onboarding docs (`verify:strict` includes multiple non-obvious checks before Turbo tests).

## Strong Areas
- Root script ergonomics are strong and consistent (`build`, `typecheck`, `lint`, `test`, `verify`, `verify:strict`) in [`package.json:11`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/package.json:11).
- Package-scoped iteration is clearly encouraged with concrete commands in [`README.md:33`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/README.md:33) and [`AGENTS.md:22`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/AGENTS.md:22).
- Verification depth is better than average for a monorepo: runtime inventory, boundary checks, terminal event guard checks, and workspace coverage gating are codified in scripts and CI hooks.
- Package-level READMEs are widespread, and many include auto-generated package overview blocks with scope/quality metadata (for example [`packages/server/README.md:3`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/README.md:3)).
- Scaffolding flow is well documented and practical via `create-dzupagent` templates ([`packages/create-dzupagent/README.md:24`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/create-dzupagent/README.md:24)).

## Findings
Severity-ranked developer-experience and onboarding issues.

| Severity | Finding | Evidence | Contributor Impact |
|---|---|---|---|
| High | Broken primary docs entry point | Root README points to missing docs hub in [`README.md:113`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/README.md:113); file is absent in [`docs/`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/docs/). | New contributors hit dead navigation immediately, lowering trust in docs. |
| High | `verify:strict` fails on missing capability matrix artifact before core checks | `verify:strict` includes `check:capability-matrix` in [`package.json:29`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/package.json:29); checker hard-requires `docs/CAPABILITY_MATRIX.md` in [`scripts/check-capability-matrix-freshness.mjs:16`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/scripts/check-capability-matrix-freshness.mjs:16); local command `yarn -s check:capability-matrix` fails with `docs/CAPABILITY_MATRIX.md does not exist`. | The strict gate is not a reliable “one command” confidence signal for a fresh or partially-prepared clone. |
| Medium | Verification relies on hidden `.docs` improvement docs outside normal tracked surface | `verify` and `verify:strict` run `check:improvements:drift` in [`package.json:30`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/package.json:30); script reads `.docs/improvements/*` in [`scripts/check-improvements-drift.mjs:177`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/scripts/check-improvements-drift.mjs:177); `.docs/` is ignored in [`.gitignore:43`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/.gitignore:43); `git ls-files .docs` returns empty. | Portability is fragile: local setups with generated/symlinked `.docs` pass, while clean clones can diverge unless this prerequisite is documented or generated deterministically. |
| Medium | Package docs contain stale or copy-paste-breaking examples | Server auth example uses `auth: { apiKeys: [...] }` in [`packages/server/README.md:77`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/README.md:77), while `AuthConfig` expects `mode` + optional `validateKey` in [`packages/server/src/middleware/auth.ts:9`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/middleware/auth.ts:9). Playground path example uses `packages/dzupagent-playground` in [`packages/server/README.md:90`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/README.md:90) and [`packages/playground/README.md:42`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/playground/README.md:42), but actual package is `packages/playground`. Multiple package READMEs still mention `0.1.0` while manifests are `0.2.0` (for example [`packages/core/README.md:169`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/README.md:169) vs [`packages/core/package.json:3`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/package.json:3)). | New contributors lose time reconciling docs with types/code and may start from invalid config snippets. |
| Medium | Environment expectations are distributed in code, not centralized for onboarding | Root requirements mention only Node/Yarn in [`README.md:7`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/README.md:7). Runtime env expectations are mostly discoverable via doctor implementation (`DATABASE_URL`, provider keys, optional `REDIS_URL`) in [`packages/server/src/cli/doctor.ts:123`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/cli/doctor.ts:123). | First-time server setup requires code spelunking instead of a single trusted environment matrix. |
| Low | Useful CLI diagnostics exist but are under-documented and partially placeholdered | `dzup doctor` exists in [`packages/server/src/cli/dzup.ts:82`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/cli/dzup.ts:82), but server README does not make it a first-step troubleshooting path. Some subcommands are explicitly incomplete (for example config set in [`packages/server/src/cli/dzup.ts:187`](/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/cli/dzup.ts:187)). | Engineers miss a good diagnostics tool and may hit unfinished command paths unexpectedly. |
| Low | Secondary `out/` snapshot overstates onboarding health | Secondary artifact reports `healthScore: 100` and “No obvious structural gaps” in [`out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md:7`](/media/ninel/Second/code/datazup/ai-internal-dev/out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md:7) and [`out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md:191`](/media/ninel/Second/code/datazup/ai-internal-dev/out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md:191), despite current dead docs link and strict-gate artifact failure. | If treated as source of truth, teams may underestimate practical onboarding friction. |

## Day-To-Day Workflow Review
What works well in daily development:
- Fast loop is clear: run package-filtered Turbo checks for changed scope, then broader verification.
- Script naming is predictable and mostly composable.
- Refactor safety is improved by runtime inventory and boundary guard scripts in addition to tests.

Main friction points in real daily use:
- “Single-command safety” is currently weak because strict verification can fail for generated-doc prerequisites before validating code quality.
- Coverage gate is strict and useful, but requires pre-existing per-package coverage summaries; this is easy to miss without explicit local workflow guidance.
- Local command runs in constrained environments can emit Yarn cache/global-folder warnings, which adds setup noise for newcomers.

Refactor confidence profile:
- High confidence for isolated package changes when contributors use package filters and package-local tests.
- Medium confidence for cross-package changes when strict gate status depends on local artifact state not clearly documented in onboarding docs.

## Documentation And Discoverability Review
- Core command documentation is good in root docs, but information architecture is inconsistent.
- The most important navigation link in root docs is broken (`docs/README.md`), and current `docs/` content is skewed toward tracking history rather than onboarding.
- Package READMEs provide breadth but have trust gaps in key examples and version strings.
- Troubleshooting knowledge exists in implementation (`doctor` checks) more than in contributor-facing documentation.
- Secondary generated artifacts in `out/` are useful as map-like snapshots, but currently too optimistic to be relied on as onboarding truth.

## Recommended DX Improvements
1. Add and maintain a real `docs/README.md` as the canonical onboarding hub.
2. Publish a “first 30 minutes” guide with exact install, env setup, quick verification path, and common failures.
3. Make `verify:strict` hermetic by generating required artifacts inside the flow or moving docs-freshness checks out of strict correctness gates.
4. Add deterministic handling for `.docs/improvements` dependencies: either version them, generate them in-script, or remove them from default verification.
5. Add a root `.env.example` (or `docs/ENVIRONMENT.md`) with required and optional env vars by feature area.
6. Run a README accuracy pass on high-traffic packages (`server`, `core`, `agent`, `playground`, `connectors`) and enforce doc-example type checks where practical.
7. Document `dzup doctor` as the first troubleshooting command for server onboarding.
8. Add a verification-mode matrix (`quick`, `package-scoped`, `verify`, `verify:strict`) with expected prerequisites and runtime cost.
9. Add CI checks for dead links and doc drift (README examples, version constants, and referenced docs artifacts).
10. Mark `out/` repository docs explicitly as advisory snapshots unless they are tied to freshness guarantees.

## Overall Assessment
Developer experience is solid at the command and package-workflow level, but onboarding trust is reduced by documentation navigation breakage and non-hermetic strict-gate prerequisites. The repo is close to a strong onboarding experience; fixing docs entry points and strict verification determinism would materially improve contributor speed and confidence.
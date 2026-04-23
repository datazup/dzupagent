# Current State Inventory - dzupagent (2026-04-21)

## Scope Reviewed
- Repository governance and identity docs:
  - `AGENTS.md`
  - `README.md`
  - `docs/WAVE23_TRACKING.md`
- Root build, workspace, and quality config:
  - `package.json`
  - `turbo.json`
  - `tsconfig.json`
  - `eslint.config.js`
  - `coverage-thresholds.json`
- Core implementation areas sampled:
  - `packages/core/src/index.ts`
  - `packages/agent/src/index.ts`
  - `packages/agent-adapters/src/index.ts`
  - `packages/memory/src/index.ts`
  - `packages/server/src/app.ts`
  - `packages/server/src/runtime/run-worker.ts`
  - `packages/server/src/queue/run-queue.ts`
  - `packages/server/src/persistence/drizzle-schema.ts`
- Package boundaries and manifest surface:
  - Top-level `packages/*` directory enumeration
  - Top-level package manifests and selected package `package.json` files (`core`, `agent`, `server`, `agent-adapters`, `playground`, `create-dzupagent`)
- Test and guardrail scripts:
  - `scripts/check-runtime-test-inventory.mjs`
  - `scripts/check-workspace-coverage.mjs`
  - `scripts/check-capability-matrix-freshness.mjs`
  - `scripts/check-improvements-drift.mjs`
  - `scripts/check-domain-boundaries.mjs`
  - `scripts/check-terminal-tool-event-guards.mjs`
- CI/workflow coverage:
  - `.github/workflows/verify-strict.yml`
  - `.github/workflows/coverage-gate.yml`
  - `.github/workflows/security.yml`
  - `.github/workflows/connectors-verified.yml`
  - `.github/workflows/compat-matrix.yml`
- Secondary `out/` artifacts for drift comparison:
  - `out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md`
  - `out/workspace-repo-docs-static-portable-markdown/SUMMARY.md`
  - `out/knowledge-index/gap-analysis-requirements.dzupagent.md`
  - `out/workspace-commit-groups/dzupagent/plan.json`
- Live command-based checks run during inventory:
  - package/test/workflow counts
  - `yarn -s test:coverage:workspace:report`
  - `yarn -s verify:strict`
  - `yarn -s check:capability-matrix`

## Repository Overview
- `dzupagent` is a large TypeScript monorepo for the DzupAgent framework ecosystem, not a single app.
- It combines framework runtime packages, provider adapters, server runtime/API, memory/RAG infrastructure, scaffolding CLI, and an internal playground UI.
- Scale signals from the current tree:
  - 30 top-level directories under `packages/`
  - 29 top-level package directories with a `package.json` (one exception: `packages/agent-types`)
  - 1046 `*.test.ts` files and 63 `__tests__` directories
  - 9 GitHub workflow files
  - 67 route files under `packages/server/src/routes`
- Product orientation is platform-like: reusable SDK packages plus a deployable server and tooling, with strict CI and quality gates.

## Repository Identity
- Repository role: primary framework/platform repo for DzupAgent, serving internal and downstream consumers that integrate `@dzupagent/*` packages (`README.md:5`, `README.md:79`, `README.md:113`).
- Audience:
  - Framework/package developers inside the monorepo
  - Integrators consuming published packages such as `@dzupagent/core`, `@dzupagent/agent`, `@dzupagent/server`
- Language and runtime stack:
  - TypeScript + ESM across packages (`tsconfig.json:6`, package manifests)
  - Node.js `>=20` (`README.md:9`, `package.json:35`)
  - Hono server runtime (`packages/server/src/app.ts:21`, `packages/server/package.json:40`)
  - Drizzle ORM persistence (`packages/server/package.json:39`, `packages/server/src/persistence/drizzle-schema.ts:7`)
  - Optional BullMQ integration via peer dependency (`packages/server/package.json:43`)
  - Vue-based playground package (`packages/playground/README.md:24`)
- Package manager and workspace model:
  - Yarn 1 (`package.json:4`)
  - Yarn workspaces on `packages/*` (`package.json:7`)
  - Turbo task orchestration (`package.json:11`, `turbo.json:3`)
- API/package shape:
  - `@dzupagent/core` exposes tiered entrypoints (`./stable`, `./advanced`) plus facades (`packages/core/package.json:12`-`packages/core/package.json:43`)
  - Server package exports runtime and CLI entrypoint (`packages/server/package.json:5`-`packages/server/package.json:15`)

## Implementation Surface
- Major domains and responsibilities:
  - Core framework primitives in `packages/core/src/*` with broad domain spread (32 first-level directories under `core/src`).
  - Agent runtime/orchestration in `packages/agent/src/*`.
  - Multi-provider adapter system in `packages/agent-adapters/src/*` including provider-specific adapters and orchestration/recovery policy layers (38 first-level directories under `agent-adapters/src`).
  - Memory and retrieval systems in `packages/memory`, `packages/memory-ipc`, and `packages/rag`.
  - Full server runtime in `packages/server` with API routes, queue worker, persistence, streaming, auth/rate-limit middleware, and platform adapters.
  - Scaffolding CLI in `packages/create-dzupagent`.
  - Internal playground app in `packages/playground`.
- Server composition complexity is high and operationally rich:
  - `createForgeApp` config accepts many optional subsystems (learning, evals, deploy, workflows, A2A, triggers, schedules, mailbox, marketplace, OpenAI-compatible routes) (`packages/server/src/app.ts:162`-`packages/server/src/app.ts:301`).
  - Route mounting covers broad surface (`packages/server/src/app.ts:556` onward), including `/api/*`, `/v1/*`, and plugin-mounted routes.
  - Worker bootstrap and lifecycle wiring are first-class (`packages/server/src/app.ts:466`-`packages/server/src/app.ts:482`, `packages/server/src/runtime/run-worker.ts:201`).
- Persistence surface is beyond minimal CRUD:
  - Drizzle schema includes agents, runs, logs, artifacts, vectors, A2A tasks/messages, triggers/schedules, reflections, deployment history, mailbox/cluster/catalog-related entities (`packages/server/src/persistence/drizzle-schema.ts`).
  - SQL migrations exist under `packages/server/drizzle` (3 `.sql` migration files plus metadata).
- Scale signals from large modules:
  - `packages/core/src/index.ts` 961 LOC
  - `packages/agent/src/index.ts` 698 LOC
  - `packages/agent-adapters/src/index.ts` 536 LOC
  - `packages/server/src/app.ts` 823 LOC
  - `packages/server/src/index.ts` 504 LOC
  - `packages/memory/src/index.ts` 395 LOC
- Packaging caveat worth noting for implementation mapping:
  - `packages/agent-types` is present but has no top-level `package.json`, unlike peer package directories.

## Maturity Signals
- Strong production-grade signals:
  - Strict CI gate exists and chains domain boundaries, terminal tool-event guard checks, and `verify:strict` (`.github/workflows/verify-strict.yml:59`-`66`, `package.json:29`).
  - Coverage gate is structured as package-matrix + workspace enforcement (`.github/workflows/coverage-gate.yml:41`-`131`).
  - Security workflow includes dependency audit, gitleaks secret scanning, and grep-based SAST checks (`.github/workflows/security.yml:25`, `52`, `75`).
  - Connector-specific verified build gate exists (`.github/workflows/connectors-verified.yml:1`-`39`).
  - Runtime test inventory gate enforces no zero-test runtime packages and optional strict integration-style checks for critical packages (`scripts/check-runtime-test-inventory.mjs:18`-`37`, `148`-`160`).
  - TypeScript strict mode and project references are enabled (`tsconfig.json:6`, `tsconfig.json:16`).
- Quality governance is explicit and automated:
  - Coverage thresholds and package-specific waivers with expiry dates are versioned (`coverage-thresholds.json:2`-`134`).
  - Workspace coverage script fails on missing coverage summary artifacts (`scripts/check-workspace-coverage.mjs:241`-`247`).
  - Improvements-drift script cross-checks implementation markers against tracked docs (`scripts/check-improvements-drift.mjs:175`-`232`).
- Current evidence of transitional maturity:
  - `yarn -s verify:strict` fails in current local state due missing `agent-adapters` coverage summary artifact, despite many packages passing coverage.
  - Several packages rely on active temporary waivers (`coverage-thresholds.json` entries for `codegen`, `context`, `create-dzupagent`, `playground`, `test-utils`, `testing`).

## Current-State Caveats
- Documentation hub mismatch:
  - Root README points to `docs/README.md` (`README.md:113`-`115`), but that file does not exist in current tree.
- Capability matrix check is wired but missing source file:
  - `check-capability-matrix-freshness` requires `docs/CAPABILITY_MATRIX.md` and exits non-zero if absent (`scripts/check-capability-matrix-freshness.mjs:16`-`21`).
  - `yarn -s check:capability-matrix` currently fails with missing file.
- Strict verification can fail on artifact preconditions rather than code defects:
  - Current `verify:strict` run fails at workspace coverage because `packages/agent-adapters/coverage/coverage-summary.json` is missing (behavior defined at `scripts/check-workspace-coverage.mjs:241`-`247`).
- Cross-repo assumptions exist in at least one workflow:
  - `compat-matrix.yml` references `monorepo/packages/dzupagent-kit` and `monorepo/apps/testman-app`/`monorepo/apps/nl2sql` (`.github/workflows/compat-matrix.yml:128`, `184`, `205`), which are not paths inside this repo alone.
- Legacy naming residue remains in live code:
  - Export and file names still include `dzip`/`DZIP` forms (`packages/agent/src/index.ts:10`, `packages/server/src/index.ts:383`, `packages/server/src/persistence/drizzle-schema.ts:27`).
- Version constant drift in public source exports:
  - Multiple package index files export `*_VERSION = '0.1.0'` while package manifests are `0.2.0` (for example `packages/core/src/index.ts:961` vs `packages/core/package.json:3`).
- Hidden docs dependency portability caveat:
  - `.docs/improvements/*` files are symlinks to absolute workspace paths outside the repo (`.docs/improvements` symlink targets), and drift checks read those docs (`scripts/check-improvements-drift.mjs:177`-`180`).
- Package-level README drift examples:
  - Playground README instructs `cd packages/dzupagent-playground` while actual folder is `packages/playground` (`packages/playground/README.md:42`).
  - Server README auto-generated metrics and route summary can lag current route/config breadth (`packages/server/README.md` vs `packages/server/src/app.ts` live wiring).
- `out/` artifact drift:
  - `out/workspace-repo-docs-static-portable-markdown/DZUPAGENT.md` and `SUMMARY.md` present a highly healthy static snapshot; useful for orientation but partially stale against current strict-gate runnable state.

## Overall Assessment
`dzupagent` is currently a high-maturity, production-oriented framework monorepo with substantial runtime breadth, strong CI/quality governance, and deep test investment. The live implementation surface (agent orchestration, adapter ecosystem, server runtime, persistence/migrations, and tooling) is robust and clearly beyond early-stage architecture.

The highest risks are synchronization and operability caveats, not missing core engineering capability: strict-gate precondition failures (coverage artifact, missing capability matrix doc), cross-repo workflow assumptions, and naming/documentation drift. In practical terms, the platform core appears strong, while release/onboarding friction is elevated by documentation and verification alignment gaps.
# DzupAgent Baseline And Scope

Generated: 2026-04-26  
Audit command: `/audit:full dzupagent`  
Workspace root: `/media/ninel/Second/code/datazup/ai-internal-dev`  
Repository root: `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent`  
Audit run directory: `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-26/run-001`

This note is a baseline capture only. It records the current repository shape, measured file counts, command discovery, and live gate status before domain conclusions. It does not include remediation, implementation backlog, severity ranking, or audit findings.

## Scope Reviewed

### Current Repository Paths

- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent`
- `AGENTS.md`
- `README.md`
- `package.json`
- `turbo.json`
- `tsconfig.json`
- `tsconfig.docs.json`
- `typedoc.json`
- `eslint.config.js`
- `docs/`
- `docs/BASELINE.md` as prior audit context only
- `packages/*/package.json`
- `packages/*/src/**`
- `packages/*/tsconfig.json`
- `packages/*/vitest.config.ts` where present
- `packages/agent-adapters/ARCHITECTURE.md`

### Packages Inspected

The live workspace contains 32 package manifests under `packages/*`:

- `@dzupagent/adapter-rules` at `packages/adapter-rules`
- `@dzupagent/adapter-types` at `packages/adapter-types`
- `@dzupagent/agent` at `packages/agent`
- `@dzupagent/agent-adapters` at `packages/agent-adapters`
- `@dzupagent/agent-types` at `packages/agent-types`
- `@dzupagent/app-tools` at `packages/app-tools`
- `@dzupagent/cache` at `packages/cache`
- `@dzupagent/code-edit-kit` at `packages/code-edit-kit`
- `@dzupagent/codegen` at `packages/codegen`
- `@dzupagent/connectors` at `packages/connectors`
- `@dzupagent/connectors-browser` at `packages/connectors-browser`
- `@dzupagent/connectors-documents` at `packages/connectors-documents`
- `@dzupagent/context` at `packages/context`
- `@dzupagent/core` at `packages/core`
- `@dzupagent/eval-contracts` at `packages/eval-contracts`
- `@dzupagent/evals` at `packages/evals`
- `@dzupagent/express` at `packages/express`
- `@dzupagent/flow-ast` at `packages/flow-ast`
- `@dzupagent/flow-compiler` at `packages/flow-compiler`
- `@dzupagent/flow-dsl` at `packages/flow-dsl`
- `@dzupagent/hitl-kit` at `packages/hitl-kit`
- `@dzupagent/memory` at `packages/memory`
- `@dzupagent/memory-ipc` at `packages/memory-ipc`
- `@dzupagent/otel` at `packages/otel`
- `@dzupagent/playground` at `packages/playground`
- `@dzupagent/rag` at `packages/rag`
- `@dzupagent/runtime-contracts` at `packages/runtime-contracts`
- `@dzupagent/scraper` at `packages/scraper`
- `@dzupagent/server` at `packages/server`
- `@dzupagent/test-utils` at `packages/test-utils`
- `@dzupagent/testing` at `packages/testing`
- `create-dzupagent` at `packages/create-dzupagent`

### Documentation Inspected

- `README.md`
- `AGENTS.md`
- Root `docs/` file inventory, including current and prior audit documents such as `docs/AGENT-AUDIT.md`, `docs/ARCHITECTURE-AUDIT.md`, `docs/CODE-AUDIT.md`, `docs/DESIGN-AUDIT.md`, `docs/SECURITY-AUDIT.md`, `docs/BASELINE.md`, and `docs/analyze-full_2026_04_21/**`
- `docs/BASELINE.md` was opened only as comparison-only prior audit context.
- `packages/agent-adapters/ARCHITECTURE.md` was discovered as the only package-local `ARCHITECTURE.md` at `packages/*/ARCHITECTURE.md` depth.

The dated audit, planning, tracking, and analysis documents above were treated as repository documents or comparison-only context. They were not used as current implementation truth.

### Audit Prep Artifacts Inspected

The prepared prompt pack was inspected as workflow metadata only:

- `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-26/run-001/codex-prep/README.md`
- `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-26/run-001/codex-prep/manifest.json`
- `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-26/run-001/codex-prep/prompts/01-baseline-and-scope.md`

The full prompt pack inventory was listed under `codex-prep/prompts/**`. These artifacts define audit workflow shape only; they are not current code evidence.

### Commands Run

- `pwd`
- `git status --short`
- `rg --files -g 'package.json' -g 'turbo.json' -g 'tsconfig*.json' -g 'typedoc.json' -g 'vitest.config.*' -g 'eslint.config.*' -g '.eslintrc*' -g 'AGENTS.md'`
- `find /media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-26/run-001 -maxdepth 3 -type f`
- `sed -n '1,220p' package.json`
- `sed -n '1,220p' turbo.json`
- `sed -n '1,180p' README.md`
- `sed -n '1,220p' eslint.config.js`
- `sed -n '1,160p' tsconfig.json`
- `sed -n '1,160p' typedoc.json`
- `find docs -maxdepth 2 -type f | sort | head -200`
- `find packages -maxdepth 2 -type f -name 'ARCHITECTURE.md'`
- `node` package inventory script over `packages/*/package.json`
- `find packages ... -path 'packages/*/src/*' ...` source and test file counts
- `rg -n '"(build|typecheck|lint|test|verify|docs:generate|build:connectors:verified)"' package.json packages/*/package.json`
- `yarn typecheck`
- `yarn lint`

## Repo Identity

- Package manager: `yarn@1.22.22`
- Root package: `dzupagent`
- Repository type: private Yarn workspace monorepo
- Workspace pattern: `packages/*`
- Module system: ESM via root `"type": "module"`
- Runtime requirement: Node.js `>=20.0.0`
- License: MIT
- Build orchestrator: Turbo `2.9.0`
- Build output convention: package `dist/**` through `tsup`
- TypeScript checking: package-local `tsc --noEmit`; `@dzupagent/playground` uses `vue-tsc --noEmit`
- Test runner discovered: Vitest through package-local `test` scripts and `vitest.config.ts` files
- Linting: ESLint through root `eslint.config.js` and package-local lint scripts
- API docs: TypeDoc through `typedoc.json` and `tsconfig.docs.json`

### Workspace Shape

The repository is organized as a framework monorepo with these major runtime surfaces:

- Core API and contracts: `packages/core`, `packages/runtime-contracts`, `packages/agent-types`, `packages/adapter-types`
- Agent runtime and orchestration: `packages/agent`, `packages/agent-adapters`, `packages/adapter-rules`
- Context, memory, and retrieval: `packages/context`, `packages/memory`, `packages/memory-ipc`, `packages/cache`, `packages/rag`
- Connectors and ingestion: `packages/connectors`, `packages/connectors-browser`, `packages/connectors-documents`, `packages/scraper`
- Server and HTTP integration: `packages/server`, `packages/express`
- Code generation and editing: `packages/codegen`, `packages/code-edit-kit`, `packages/app-tools`
- Flow tooling: `packages/flow-ast`, `packages/flow-dsl`, `packages/flow-compiler`
- Evaluation and testing support: `packages/eval-contracts`, `packages/evals`, `packages/testing`, `packages/test-utils`
- Operational and support surfaces: `packages/otel`, `packages/hitl-kit`
- Compatibility, examples, and developer surfaces: `packages/playground`, `packages/create-dzupagent`

### Current Worktree State

Before this baseline file was written, `git status --short` in the repository root produced no output. The live `dzupagent` worktree was clean at that point.

## Baseline Metrics

### File Counts

Measured under `packages/*/src/**`, excluding `node_modules`, `dist`, `coverage`, `.turbo`, declaration files, and generated build output.

- Source file count: 1,318
- Test file count: 1,071
- Total counted non-declaration TypeScript source-tree files: 2,391

Counting rules:

- Source files include `*.ts`, `*.tsx`, `*.mts`, and `*.cts` under `packages/*/src/**`.
- Declaration files `*.d.ts` are excluded.
- Test files include `*.test.ts`, `*.test.tsx`, `*.spec.ts`, and `*.spec.tsx` under `packages/*/src/**`.
- Source file count excludes the test file count and excludes files under `__tests__` or `__test__`.

### Typecheck Status

- Command run: `yarn typecheck`
- Status: failed
- Scope reported by Turbo: 32 packages
- Failure surface: `@dzupagent/test-utils#build`, which is a dependency build invoked by the `typecheck` task graph.
- Error excerpt:
  - `packages/test-utils/src/test-helpers.ts(15,8): error TS2305: Module '"@dzupagent/core"' has no exported member 'AgentStore'.`
  - `packages/test-utils/src/test-helpers.ts(16,8): error TS2305: Module '"@dzupagent/core"' has no exported member 'AgentDefinition'.`
- Turbo summary: 35 successful tasks, 42 total tasks; failed task `@dzupagent/test-utils#build`.

### Lint Status

- Command run: `yarn lint`
- Status: failed
- Scope reported by Turbo: 32 packages
- Failure surface: `@dzupagent/agent#lint`
- Error excerpt:
  - `packages/agent/src/pipeline/pipeline-runtime-types.ts:186:17 error import() type annotations are forbidden @typescript-eslint/consistent-type-imports`
  - `packages/agent/src/pipeline/pipeline-runtime-types.ts:192:14 error import() type annotations are forbidden @typescript-eslint/consistent-type-imports`
- Turbo summary: 31 successful tasks, 32 total tasks; failed task `@dzupagent/agent#lint`.

### Build And Test Commands Discovered

Root commands from `package.json`:

- `yarn build` -> `turbo run build`
- `yarn dev` -> `turbo run dev --parallel`
- `yarn typecheck` -> `turbo run typecheck`
- `yarn lint` -> `turbo run lint`
- `yarn test` -> `turbo run test`
- `yarn verify` -> `yarn test:inventory:runtime && yarn check:improvements:drift && yarn check:domain-boundaries && yarn check:terminal-tool-event-guards && turbo run build typecheck lint test`
- `yarn verify:strict` -> `yarn test:inventory:runtime:strict && yarn check:improvements:drift && yarn check:workspace:coverage && yarn check:waiver-expiry && yarn check:capability-matrix && yarn check:domain-boundaries && yarn check:terminal-tool-event-guards && turbo run build typecheck lint test`
- `yarn docs:generate` -> `typedoc --options typedoc.json`
- `yarn build:connectors:verified` -> `yarn workspace @dzupagent/connectors build:verified`

Package command patterns discovered:

- Most framework packages expose `build`, `typecheck`, `lint`, and `test`.
- Most package builds use `tsup`.
- Most package typechecks use `tsc --noEmit`.
- Most package tests use `vitest run`; `@dzupagent/server` adds `--testTimeout=30000 --hookTimeout=30000`.
- `@dzupagent/rag` runs tests with `NODE_OPTIONS='--max-old-space-size=4096' vitest run`.
- `@dzupagent/playground` builds with `vue-tsc --noEmit && vite build`, typechecks with `vue-tsc --noEmit`, and lints with `eslint src/ --ext .vue,.ts`.

## Snapshot Boundaries

### What Reflects Current Code

- Package manager, workspace pattern, runtime requirement, scripts, package list, and toolchain identity are from the live root and package `package.json` files.
- Package count and package names are from live `packages/*/package.json` discovery.
- Source and test file counts are from live filesystem counts under `packages/*/src/**`.
- Typecheck and lint status are from commands executed during this baseline pass on 2026-04-26.
- Runtime surface grouping is based on current package names and repository structure, not on prior audit conclusions.

### What Reflects Prior Audit Artifacts Only

- `docs/BASELINE.md`, `docs/*-AUDIT.md`, `docs/analyze-full_2026_04_21/**`, and other dated docs under `docs/**` were treated as comparison-only context or repository documentation inventory.
- The prepared `codex-prep/**` prompt pack was treated as audit workflow metadata only.
- No prior audit bundle was used as evidence for current implementation status.

### What Has Not Been Verified

- `yarn build`, `yarn test`, `yarn verify`, `yarn verify:strict`, `yarn docs:generate`, and `yarn build:connectors:verified` were discovered but not run in this baseline step.
- Runtime behavior of agent loops, server routes, connectors, memory stores, RAG providers, codegen, and playground UI was not exercised.
- Database-backed, Redis-backed, network-backed, browser-backed, and external-service paths were not executed.
- Dependency vulnerability status was not audited in this step.
- Prior audit claims were not reconciled against source beyond inventorying and labeling the artifacts as comparison-only context.

## Consistency Failures

- `README.md` points to `docs/README.md` as the documentation hub, but `docs/README.md` is not present in this checkout.
- `yarn typecheck` currently fails before completing the full typecheck graph because `@dzupagent/test-utils#build` cannot emit declarations against the current `@dzupagent/core` export surface.
- `yarn lint` currently fails on two `@typescript-eslint/consistent-type-imports` errors in `packages/agent/src/pipeline/pipeline-runtime-types.ts`.

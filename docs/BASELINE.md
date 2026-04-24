# DzupAgent Baseline And Scope

Generated: 2026-04-24  
Audit command: `/audit:full dzupagent`  
Workspace root: `/media/ninel/Second/code/datazup/ai-internal-dev`  
Repository root: `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent`  
Audit run directory: `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-24/run-002`

This note is a baseline capture only. It records current repository shape, measured file counts, command discovery, and live gate status. It does not include remediation, implementation backlog, severity ranking, or domain conclusions.

## Scope Reviewed

### Current Repository Paths

- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent`
- `package.json`
- `yarn.lock`
- `turbo.json`
- `tsconfig.json`
- `tsconfig.docs.json`
- `typedoc.json`
- `typedoc.adapter-config.json`
- `eslint.config.js`
- `README.md`
- `AGENTS.md`
- `CLAUDE.md`
- `docs/`
- `packages/*/package.json`
- `packages/*/src/**`
- `packages/*/tsconfig.json`
- `packages/*/tsup.config.ts`
- `packages/*/vitest.config.ts` where present

### Packages Inspected

The workspace currently contains 32 package manifests under `packages/*`:

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
- `docs/README.md` was discovered through the documentation hub reference but not opened in this baseline pass.
- Top-level `docs/` file inventory was inspected:
  - `ADR-001-qdrant-isolation-strategy.md`
  - `ADR-002-agent-registry-primary-control-plane.md`
  - `AGENT_CONTROL_PLANE_ROADMAP_2026-04-23.md`
  - `AGENT_NAMING_RENAME_PLAN_2026-04-23.md`
  - `ARCHITECTURE_REFACTOR_ROADMAP_2026-04-23.md`
  - `ARCHITECTURE_STABILIZATION_MEMORY_2026-04-23.md`
  - `CAPABILITY_MATRIX.md`
  - `CONTRACT_SEGMENTATION_PLAN_2026-04-23.md`
  - `MCP_REBASELINE_2026-04-23.md`
  - `NEXT_SESSION_PROMPT_2026-04-23_contract-runtime-compat.md`
  - `NEXT_SESSION_PROMPT_2026-04-23_openai-compat-runtime-pilot.md`
  - `NEXT_SESSION_PROMPT_2026-04-23_server-root-allowlist.md`
  - `NEXT_SESSION_PROMPT_2026-04-23_server-runtime-control-plane-matrix.md`
  - `PACKAGE_SUPPORT_INDEX.md`
  - `SERVER_API_SURFACE_INDEX.md`
  - `SERVER_ROOT_ALLOWLIST_2026-04-23.md`
  - `STABILIZATION_REBASELINE_2026-04-23.md`
  - `SUPPORTED_KERNEL.md`
  - `WAVE17_TRACKING.md`
  - `WAVE18_TRACKING.md`
  - `WAVE19_TRACKING.md`
  - `WAVE20_TRACKING.md`
  - `WAVE21_TRACKING.md`
  - `WAVE22_TRACKING.md`
  - `WAVE23_TRACKING.md`

The dated planning and tracking documents above were treated as repository documents and not as proof of current implementation status.

### Audit Prep Artifacts Inspected

The prepared prompt pack was inspected as workflow metadata only:

- `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-24/run-002/codex-prep/README.md`
- `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-24/run-002/codex-prep/PLAN.md`
- `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-24/run-002/codex-prep/manifest.json`
- `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-24/run-002/codex-prep/prompts/00-master-prompt.md`
- `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-24/run-002/codex-prep/prompts/01-baseline-and-scope.md`
- `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-24/run-002/codex-prep/prompts/02-code-quality.md`
- `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-24/run-002/codex-prep/prompts/03-security.md`
- `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-24/run-002/codex-prep/prompts/04-architecture.md`
- `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-24/run-002/codex-prep/prompts/05-agent-patterns.md`
- `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-24/run-002/codex-prep/prompts/06-synthesis-and-consistency.md`
- `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-24/run-002/codex-prep/prompts/07-implementation-handoff.md`
- `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-24/run-002/codex-prep/prompts/08-design-system.md`

These artifacts are comparison-only and workflow-context evidence. They are not used as current code truth.

### Commands Run

- `pwd && git status --short`
- `sed -n '1,240p' package.json`
- `ls -la && find packages -maxdepth 2 -name package.json | sort`
- `find . -maxdepth 3 \( -name 'turbo.json' -o -name 'tsconfig*.json' -o -name 'typedoc.json' -o -name 'eslint.config.*' -o -name '.yarnrc.yml' -o -name 'vitest.config.*' -o -name 'tsup.config.*' \) | sort`
- `find /media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-24/run-002 -maxdepth 3 -type f | sort`
- `node` package inventory script over `packages/*/package.json`
- `node` source/test count script over `packages/**`, excluding `node_modules`, `.git`, `dist`, `.turbo`, and `coverage`
- `sed -n '1,240p' turbo.json`
- `sed -n '1,260p' README.md`
- `find docs -maxdepth 1 -type f | sort`
- `sed -n '1,220p' codex-prep/README.md`
- `sed -n '1,260p' codex-prep/PLAN.md`
- `sed -n '1,220p' codex-prep/manifest.json`
- `test -f codex-prep/implementation/implementation-task-manifest.json`
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
- TypeScript checking: package-local `tsc --noEmit` and `vue-tsc --noEmit` for `@dzupagent/playground`
- Test runner discovered: Vitest through package-local `vitest.config.ts` files and package `test` scripts
- Linting: ESLint through root `eslint.config.js` and package-local lint scripts
- API docs: TypeDoc through `typedoc.json`, `typedoc.adapter-config.json`, and `tsconfig.docs.json`

### Workspace Shape

The repository is organized as a framework monorepo with these major runtime surfaces:

- Core API and runtime contracts: `packages/core`, `packages/runtime-contracts`, `packages/agent-types`, `packages/adapter-types`
- Agent runtime and orchestration: `packages/agent`, `packages/agent-adapters`, `packages/adapter-rules`
- Context, memory, and retrieval: `packages/context`, `packages/memory`, `packages/memory-ipc`, `packages/cache`, `packages/rag`
- Connectors and document/browser ingestion: `packages/connectors`, `packages/connectors-browser`, `packages/connectors-documents`, `packages/scraper`
- Server and HTTP integration: `packages/server`, `packages/express`
- Code generation and editing: `packages/codegen`, `packages/code-edit-kit`, `packages/app-tools`
- Flow tooling: `packages/flow-ast`, `packages/flow-dsl`, `packages/flow-compiler`
- Evaluation and testing support: `packages/eval-contracts`, `packages/evals`, `packages/testing`, `packages/test-utils`
- Operational and support surfaces: `packages/otel`, `packages/hitl-kit`
- Consumer/developer surfaces: `packages/playground`, `packages/create-dzupagent`

### Current Worktree State

Before this baseline file was written, `git status --short` showed existing modifications in:

- `packages/server/package.json`
- `packages/server/src/__tests__/api-key-wiring.test.ts`
- `packages/server/src/__tests__/benchmark-routes.test.ts`
- `packages/server/src/__tests__/eval-lease-recovery.integration.test.ts`
- `packages/server/src/__tests__/eval-routes.test.ts`

Those modified files were not edited by this baseline step.

## Baseline Metrics

### File Counts

Measured under `packages/**`, excluding `node_modules`, `.git`, `dist`, `.turbo`, and `coverage`.

- Source file count: 1,316
- Test file count: 1,068
- Total TypeScript source-tree files counted: 2,384

Counting rules:

- Source files include `*.ts`, `*.tsx`, `*.mts`, and `*.cts` under `packages/*/src/**`.
- Declaration files `*.d.ts` are excluded.
- Test files include files under `__tests__` or `__test__`, plus `*.test.*` and `*.spec.*`.
- Source file count excludes the test file count.

### Typecheck Status

- Command: `yarn typecheck`
- Status: passed
- Turbo scope: 32 packages
- Task result: 52 successful, 52 total
- Cache result: 51 cached, 52 total
- Reported duration: 37.84 seconds
- Notes: Turbo typecheck includes dependency build tasks because `typecheck` depends on `^build` and `^typecheck` in `turbo.json`.

### Lint Status

- Command: `yarn lint`
- Status: passed
- Turbo scope: 32 packages
- Task result: 32 successful, 32 total
- Cache result: 31 cached, 32 total
- Reported duration: 104.91 seconds

### Build And Test Commands Discovered

Root commands:

- `yarn build` -> `turbo run build`
- `yarn dev` -> `turbo run dev --parallel`
- `yarn start` -> `yarn dev`
- `yarn typecheck` -> `turbo run typecheck`
- `yarn lint` -> `turbo run lint`
- `yarn test` -> `turbo run test`
- `yarn verify` -> inventory/drift/domain/terminal-tool checks plus `turbo run build typecheck lint test`
- `yarn verify:strict` -> strict inventory, drift, coverage, waiver, capability, domain, terminal-tool checks plus `turbo run build typecheck lint test`
- `yarn docs:generate` -> `typedoc --options typedoc.json`
- `yarn docs:adapters` -> `typedoc --options typedoc.adapter-config.json`
- `yarn build:connectors:verified` -> `yarn workspace @dzupagent/connectors build:verified`
- `yarn bench` -> `vitest bench --config scripts/bench/vitest.bench.config.ts`

Package-scoped command pattern discovered from README and package manifests:

- `yarn build --filter=@dzupagent/<package>`
- `yarn typecheck --filter=@dzupagent/<package>`
- `yarn lint --filter=@dzupagent/<package>`
- `yarn test --filter=@dzupagent/<package>`
- `yarn workspace @dzupagent/<package> test`

Most packages expose `build`, `typecheck`, `lint`, and `test`. Several packages also expose `dev`, `test:coverage`, `test:watch`, connector verification, orchestration race/cancel/contract checks, Prisma database commands in `@dzupagent/server`, and e2e testing in `@dzupagent/playground`.

## Snapshot Boundaries

### Reflects Current Code

The following items reflect the live repository state at baseline time:

- Root workspace metadata from `package.json`
- Workspace package list from current `packages/*/package.json`
- Configuration inventory from current root and package config files
- File counts from current `packages/*/src/**`
- Typecheck status from the executed `yarn typecheck`
- Lint status from the executed `yarn lint`
- Worktree status from executed `git status --short`
- Root README command and runtime statements

### Reflects Prior Or Comparison-Only Artifacts

The following items are not current-code evidence and were used only to understand audit workflow shape:

- `audit/full-dzupagent-2026-04-24/run-002/codex-prep/README.md`
- `audit/full-dzupagent-2026-04-24/run-002/codex-prep/PLAN.md`
- `audit/full-dzupagent-2026-04-24/run-002/codex-prep/manifest.json`
- `audit/full-dzupagent-2026-04-24/run-002/codex-prep/prompts/*.md`

The prepared pack itself states that current repository code is the evidence source and prior audit reports are comparison context only.

### Not Verified

This baseline step did not verify:

- Full `yarn build`
- Full `yarn test`
- Full `yarn verify`
- Full `yarn verify:strict`
- `yarn docs:generate`
- `yarn docs:adapters`
- `yarn build:connectors:verified`
- Runtime behavior of `yarn dev`, `@dzupagent/server`, `@dzupagent/playground`, or any long-running service
- External service integration such as databases, queues, browsers, vector stores, provider APIs, or networked connectors
- Security findings
- Code-quality findings
- Architecture findings
- Agent-pattern findings
- Design-system findings
- Accuracy of dated planning documents in `docs/` beyond their presence in the repository
- Accuracy of prior audit bundles outside the run-002 prompt pack

## Consistency Failures

- `codex-prep/manifest.json` lists `implementation/implementation-task-manifest.json` in its expected outputs, but `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-24/run-002/codex-prep/implementation/implementation-task-manifest.json` is absent.
- `codex-prep/manifest.json` has `generatedPath: null` and `sourceReport: null`; this baseline therefore does not treat the prompt pack as a completed audit report.

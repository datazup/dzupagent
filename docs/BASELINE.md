# Baseline And Scope

Audit scope: `dzupagent`  
Audit command: `/audit:full`  
Workspace root: `/media/ninel/Second/code/datazup/ai-internal-dev`  
Repository root: `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent`  
Audit run directory requested by wrapper: `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-27/run-001`  
Actual file path written: `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/docs/BASELINE.md`  
Budget: `standard`  
Domains: `code`, `security`, `architecture`, `agent`, `design`  
Depth: `deep`

## Consistency Failures

- Direct write to `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-27/run-001/docs/BASELINE.md` was rejected by the filesystem sandbox because the audit run directory is outside the writable roots for this session.
- The requested target name, `docs/BASELINE.md`, was therefore written relative to the repository root, which is writable.

## Scope Reviewed

Snapshot and prepared context inspected:

- `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-27/run-001/codex-prep/context/repo-snapshot.md`
- `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-27/run-001/codex-prep`

Repository policy and root config inspected:

- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/AGENTS.md`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/README.md`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/package.json`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/turbo.json`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/tsconfig.json`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/eslint.config.js`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/typedoc.json`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/yarn.lock`

Representative package manifests and entrypoints inspected:

- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/package.json`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/core/src/index.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/package.json`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/index.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/agent/src/agent/memory-context-loader.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/codegen/package.json`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/codegen/src/index.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/package.json`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/index.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/server/src/app.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/express/package.json`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/express/src/index.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/memory-ipc/package.json`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/memory-ipc/tsconfig.json`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/memory-ipc/tsup.config.ts`
- `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/playground/docs/ARCHITECTURE.md`

Discovery and verification commands run:

- `rg --files -g 'package.json' -g 'turbo.json' -g 'tsconfig*.json' -g 'vitest.config.*' -g 'typedoc*.json' -g 'AGENTS.md' -g 'README.md' -g 'yarn.lock' -g '.yarnrc.yml' | sort`
- `find packages -mindepth 2 -maxdepth 2 -name package.json | sort`
- `find packages -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort`
- `rg --files packages | rg '/src/.*\.(ts|tsx|js|jsx|mts|cts)$' | rg -v '(__tests__/|\.(test|spec)\.)' | wc -l`
- `rg --files packages scripts | rg '(__tests__/.*\.(ts|tsx|js|jsx|mts|cts)$|\.(test|spec)\.(ts|tsx|js|jsx|mts|cts)$)' | wc -l`
- `yarn typecheck`
- `yarn lint`
- `git status --short`

## Repo Identity

`dzupagent` is a private TypeScript ESM monorepo for the DzupAgent framework.

- Package manager: `yarn@1.22.22`
- Node runtime floor: `>=20.0.0`
- Workspace shape: root Yarn workspaces with `packages/*`
- Build orchestration: Turbo 2 via root scripts such as `turbo run build`, `turbo run typecheck`, `turbo run lint`, and `turbo run test`
- Package build tool: `tsup` in package-level build scripts, emitting `dist/**`
- Test framework: Vitest in package-level `test` scripts and `vitest.config.ts` files
- API docs: TypeDoc via `typedoc.json` and `tsconfig.docs.json`
- Lint stack: ESLint flat config with `@typescript-eslint` and `eslint-plugin-security`

Live workspace packages with `package.json`:

- `@dzupagent/adapter-rules`
- `@dzupagent/adapter-types`
- `@dzupagent/agent`
- `@dzupagent/agent-adapters`
- `@dzupagent/agent-types`
- `@dzupagent/app-tools`
- `@dzupagent/cache`
- `@dzupagent/code-edit-kit`
- `@dzupagent/codegen`
- `@dzupagent/connectors`
- `@dzupagent/connectors-browser`
- `@dzupagent/connectors-documents`
- `@dzupagent/context`
- `@dzupagent/core`
- `create-dzupagent`
- `@dzupagent/eval-contracts`
- `@dzupagent/evals`
- `@dzupagent/express`
- `@dzupagent/flow-ast`
- `@dzupagent/flow-compiler`
- `@dzupagent/flow-dsl`
- `@dzupagent/hitl-kit`
- `@dzupagent/memory`
- `@dzupagent/memory-ipc`
- `@dzupagent/otel`
- `@dzupagent/rag`
- `@dzupagent/runtime-contracts`
- `@dzupagent/scraper`
- `@dzupagent/server`
- `@dzupagent/test-utils`
- `@dzupagent/testing`

Major runtime surfaces verified from manifests and public entrypoints:

- `@dzupagent/core`: base framework infrastructure, including events, model registry, prompt/template primitives, plugin registry, middleware, persistence, run journal, stable/advanced/core export tiers, and facade subpaths.
- `@dzupagent/agent`: top-level agent abstraction, tool loop, guardrails, workflow builder, multi-agent orchestration, delegation, planning, topology, and routing surfaces.
- `@dzupagent/codegen`: code generation engine with virtual filesystem, generation services, sandbox adapters, patching, workspace execution, and quality/codegen support surfaces.
- `@dzupagent/memory` and `@dzupagent/memory-ipc`: memory and Arrow/IPC memory support surfaces used by agent runtime paths.
- `@dzupagent/context`: context and snapshot-related support used by the agent memory-context loader.
- `@dzupagent/server`: optional Hono HTTP/WS runtime, persistence, queue, routes, middleware, metrics, WebSocket control/event bridge, and `@dzupagent/server/ops` subpath.
- `@dzupagent/express`: Express adapter layer with SSE, agent router, and MCP request context/router helpers.
- `@dzupagent/connectors*`, `@dzupagent/rag`, `@dzupagent/scraper`, `@dzupagent/evals`, `@dzupagent/testing`, and `@dzupagent/test-utils`: integration, retrieval, scraping, evaluation, and testing support packages.

Product boundary from repository instructions:

- Framework capabilities belong in reusable framework packages.
- New product capabilities should not be added to `packages/server` or `packages/playground`.
- `packages/server` and `packages/playground` are retained for compatibility, tests, examples, and maintenance.
- Workspace/project/task/persona/prompt-template/workflow-DSL/memory-policy/multi-tenant filtering/adapter orchestration/Codev operator UX work should be routed to the consuming app, not expanded inside server/playground.

## Baseline Metrics

- Source file count: `1331`
  - Count basis: non-test `*.ts`, `*.tsx`, `*.js`, `*.jsx`, `*.mts`, and `*.cts` files under `packages/**/src/**`, excluding `__tests__`, `*.test.*`, and `*.spec.*`.
- Test file count: `1074`
  - Count basis: test/spec files under `packages/**` and `scripts/**`, including files in `__tests__` and files matching `*.test.*` or `*.spec.*`.
- Package file count: `2693`
  - Count basis: `rg --files packages`.
- Workspace package manifests: `31`
  - Count basis: `packages/*/package.json`.
- Typecheck status: `FAIL`
  - Command: `yarn typecheck`
  - Turbo scope: 31 packages.
  - Failing package: `@dzupagent/agent`.
  - Error: `packages/agent/src/agent/memory-context-loader.ts` cannot find declarations for module `@dzupagent/memory-ipc` at static and dynamic import sites.
  - Observed diagnostic: `TS7016: Could not find a declaration file for module '@dzupagent/memory-ipc'. '/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/memory-ipc/dist/index.js' implicitly has an 'any' type.`
- Lint status: `PASS`
  - Command: `yarn lint`
  - Turbo scope: 31 packages.
  - Result: 31 successful tasks, 0 failed.
- Git working tree status at baseline capture before writing this note: clean from `git status --short`.

Build/test/development commands discovered:

- `yarn build`
- `yarn dev`
- `yarn start`
- `yarn typecheck`
- `yarn lint`
- `yarn test`
- `yarn verify`
- `yarn verify:strict`
- `yarn docs:generate`
- `yarn docs:adapters`
- `yarn docs:package-support-index`
- `yarn docs:server-api-surface`
- `yarn docs:capability-matrix`
- `yarn build:connectors:verified`
- `yarn test:coverage:workspace`
- `yarn test:coverage:workspace:report`
- `yarn test:inventory:runtime`
- `yarn test:inventory:runtime:strict`
- `yarn check:domain-boundaries`
- `yarn check:package-tiers`
- `yarn check:server-api-surface`
- `yarn check:terminal-tool-event-guards`
- `yarn check:waiver-expiry`
- `yarn check:workspace:coverage`
- `yarn check:capability-matrix`
- `yarn check:improvements:drift`
- `yarn bench`

Focused package command pattern discovered:

- `yarn build --filter=@dzupagent/<package>`
- `yarn typecheck --filter=@dzupagent/<package>`
- `yarn lint --filter=@dzupagent/<package>`
- `yarn test --filter=@dzupagent/<package>`
- `yarn workspace @dzupagent/<package> <script>`

## Baseline Findings

1. `yarn typecheck` is currently red at the root gate.
   - Evidence: `@dzupagent/agent#typecheck` fails with `TS7016` in `packages/agent/src/agent/memory-context-loader.ts` for `@dzupagent/memory-ipc`.
   - Scope impact: this is a current-code baseline fact and should be treated as blocking for any later claim that the full workspace typecheck is green.

2. `yarn lint` is currently green at the root gate.
   - Evidence: `yarn lint` completed with 31 successful Turbo tasks and no failures.
   - Scope impact: later lint regressions can be compared against this baseline.

3. The prepared repo snapshot is bounded and smaller than the live package tree.
   - Evidence: snapshot reports `Files listed: 240`, while live `rg --files packages` reports `2693` files.
   - Scope impact: snapshot content is useful for orientation, but current repository code and live discovery commands are the source of truth for this baseline.

4. `packages/playground` exists as a docs-only directory in the live checkout.
   - Evidence: `packages/playground/docs/ARCHITECTURE.md` exists, but `packages/playground/package.json` was not present in the package-manifest discovery.
   - Scope impact: root `tsconfig.json` still contains a `packages/playground` reference, while Turbo package scope is driven by the 31 package manifests.

5. The server package remains a runtime compatibility surface, not the forward product-feature surface.
   - Evidence: repository instructions classify `packages/server` and `packages/playground` as compatibility/tests/examples/maintenance-only for new product capability work.
   - Scope impact: later audit steps should evaluate server issues as framework runtime/compatibility concerns unless a task explicitly names server work.

## Snapshot Boundaries

What reflects current code:

- Root package identity, package manager, workspace pattern, scripts, Node version, and Turbo task graph from live `package.json` and `turbo.json`.
- Live package list and package scripts from `packages/*/package.json`.
- Runtime surface descriptions verified from representative package public entrypoints and manifests.
- Source/test/package file counts from live repository file discovery.
- Typecheck and lint statuses from commands executed during this baseline step.
- Product feature boundary from the repository instructions provided for this repo.

What reflects prior audit artifacts only:

- Any previous audit bundle or analysis material under paths such as `docs/analyze-full_2026_04_21/**` was not treated as current truth in this step.
- The prepared `codex-prep/context/repo-snapshot.md` is comparison/orientation context only where it conflicts with live repository discovery.
- The prepared prompt pack under `codex-prep/prompts/**` was not used as evidence for current implementation behavior.

What has not been verified:

- Full `yarn build` status.
- Full `yarn test` status.
- Full `yarn verify` or `yarn verify:strict` status.
- Dependency vulnerability status from `yarn audit` or external advisories.
- Runtime behavior of HTTP routes, WebSocket flows, queues, persistence, connectors, sandbox execution, or adapters.
- Generated API docs freshness from `yarn docs:generate`.
- Connector verified gate status from `yarn build:connectors:verified`.
- Coverage thresholds and strict inventory gates.
- Prior audit findings outside the prepared snapshot and the minimal repo-local docs/config paths listed above.

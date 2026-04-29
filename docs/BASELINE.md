# Baseline And Scope

Audit scope: `dzupagent`

Audit command: `/audit:full dzupagent`

Workspace root: `/media/ninel/Second/code/datazup/ai-internal-dev`

Repository root: `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent`

Audit run directory: `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-29/run-001`

Prepared prompt pack: `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-29/run-001/codex-prep`

## Scope Reviewed

- Prepared audit context:
  - `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-29/run-001/codex-prep/context/repo-snapshot.md`
- Repository instructions and boundary documents:
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/AGENTS.md`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/README.md`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/docs/BASELINE.md` as a prior in-repo baseline artifact before replacement
- Root package/config files:
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/package.json`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/yarn.lock`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/turbo.json`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/tsconfig.json`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/tsconfig.docs.json`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/typedoc.json`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/eslint.config.js`
- Workspace package manifests inspected by inventory:
  - `packages/adapter-rules/package.json`
  - `packages/adapter-types/package.json`
  - `packages/agent/package.json`
  - `packages/agent-adapters/package.json`
  - `packages/agent-types/package.json`
  - `packages/app-tools/package.json`
  - `packages/cache/package.json`
  - `packages/code-edit-kit/package.json`
  - `packages/codegen/package.json`
  - `packages/connectors/package.json`
  - `packages/connectors-browser/package.json`
  - `packages/connectors-documents/package.json`
  - `packages/context/package.json`
  - `packages/core/package.json`
  - `packages/create-dzupagent/package.json`
  - `packages/eval-contracts/package.json`
  - `packages/evals/package.json`
  - `packages/express/package.json`
  - `packages/flow-ast/package.json`
  - `packages/flow-compiler/package.json`
  - `packages/flow-dsl/package.json`
  - `packages/hitl-kit/package.json`
  - `packages/memory/package.json`
  - `packages/memory-ipc/package.json`
  - `packages/otel/package.json`
  - `packages/rag/package.json`
  - `packages/runtime-contracts/package.json`
  - `packages/scraper/package.json`
  - `packages/server/package.json`
  - `packages/test-utils/package.json`
  - `packages/testing/package.json`
- Package directory boundary checked:
  - `packages/playground/` exists in the current checkout, but currently has no `package.json` or `src` tree; it contains `packages/playground/docs/`.
- Commands run or inspected:
  - `sed -n '1,260p' /media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-29/run-001/codex-prep/context/repo-snapshot.md`
  - `sed -n '261,620p' /media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-2026-04-29/run-001/codex-prep/context/repo-snapshot.md`
  - `sed -n '1,240p' package.json`
  - `sed -n '1,220p' README.md`
  - `sed -n '1,220p' AGENTS.md`
  - `sed -n '1,220p' turbo.json`
  - `sed -n '1,220p' tsconfig.json`
  - `sed -n '1,160p' tsconfig.docs.json`
  - `sed -n '1,220p' typedoc.json`
  - `sed -n '1,220p' eslint.config.js`
  - `sed -n '1,80p' yarn.lock`
  - `sed -n '1,200p' packages/create-dzupagent/package.json`
  - `find packages -mindepth 2 -maxdepth 2 -name package.json | sort`
  - `find packages -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort`
  - `node -e "..."` package manifest inventory for names, versions, scripts, exports, and bins
  - `rg --files packages scripts -g '!node_modules/**' -g '!dist/**' -g '!coverage/**' -g '!.turbo/**' | rg '\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$' | wc -l`
  - `rg --files packages scripts -g '!node_modules/**' -g '!dist/**' -g '!coverage/**' -g '!.turbo/**' | rg '\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$' | rg -v '\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$' | wc -l`
  - `rg --files packages scripts -g '!node_modules/**' -g '!dist/**' -g '!coverage/**' -g '!.turbo/**' | rg '\.(test|spec)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$' | wc -l`
  - `yarn typecheck`
  - `yarn lint`
  - `git status --short`

## Repo Identity

- Package manager: Yarn Classic, `yarn@1.22.22`, declared in root `package.json`.
- Runtime baseline: Node.js `>=20.0.0`, TypeScript ESM packages, root `"type": "module"`.
- Workspace shape: private monorepo named `dzupagent` with Yarn workspaces `["packages/*"]`.
- Current package shape:
  - 32 top-level directories under `packages/`.
  - 31 current workspace package manifests under `packages/*/package.json`.
  - `packages/playground/` is present as a docs-only directory in this checkout, not as a current workspace package.
- Build orchestration: Turbo through root scripts:
  - `build`: `turbo run build`
  - `dev`: `turbo run dev --parallel`
  - `typecheck`: `turbo run typecheck`
  - `lint`: `turbo run lint`
  - `test`: `turbo run test`
  - `verify`: `yarn test:inventory:runtime && yarn check:improvements:drift && yarn check:package-tiers && yarn check:domain-boundaries && yarn check:terminal-tool-event-guards && turbo run build typecheck lint test`
  - `verify:strict`: `yarn test:inventory:runtime:strict && yarn check:improvements:drift && yarn check:workspace:coverage && yarn check:waiver-expiry && yarn check:capability-matrix && yarn check:package-tiers && yarn check:domain-boundaries && yarn check:terminal-tool-event-guards && turbo run build typecheck lint test`
- Major package groups present in live manifests:
  - Core/runtime: `@dzupagent/core`, `@dzupagent/agent`, `@dzupagent/context`, `@dzupagent/memory`, `@dzupagent/memory-ipc`, `@dzupagent/runtime-contracts`
  - Adapter/control surfaces: `@dzupagent/agent-adapters`, `@dzupagent/adapter-types`, `@dzupagent/adapter-rules`, `@dzupagent/agent-types`, `@dzupagent/otel`
  - Flow stack: `@dzupagent/flow-ast`, `@dzupagent/flow-dsl`, `@dzupagent/flow-compiler`
  - Server, transport, and app/tooling surfaces: `@dzupagent/server`, `@dzupagent/express`, `@dzupagent/app-tools`, `@dzupagent/code-edit-kit`, `@dzupagent/hitl-kit`, `create-dzupagent`
  - Data, retrieval, evaluation, and test support: `@dzupagent/connectors`, `@dzupagent/connectors-browser`, `@dzupagent/connectors-documents`, `@dzupagent/rag`, `@dzupagent/scraper`, `@dzupagent/evals`, `@dzupagent/eval-contracts`, `@dzupagent/testing`, `@dzupagent/test-utils`, `@dzupagent/cache`
- Runtime/export surfaces visible from package manifests:
  - `@dzupagent/core`: root plus `./stable`, `./advanced`, `./quick-start`, `./orchestration`, `./security`, and `./facades`.
  - `@dzupagent/agent`: root plus `./runtime`, `./workflow`, `./tools`, `./compat`, and playground UI subpaths.
  - `@dzupagent/codegen`: root plus `./vfs`, `./tools`, `./runtime`, and `./compat`.
  - `@dzupagent/server`: root plus `./ops`, `./runtime`, and `./compat`; CLI bin `dzup`.
  - `@dzupagent/flow-compiler`: CLI bin `dzupagent-compile`.
  - `create-dzupagent`: root export plus package `bin` mapped to `./dist/cli.js`.
  - Most support packages expose a package root only.
- Framework/product boundary from `AGENTS.md`:
  - DzupAgent framework capabilities belong as reusable primitives in framework packages.
  - New product features are not to be added to `packages/server` or `packages/playground`.
  - `packages/server` and `packages/playground` are retained for compatibility, tests, examples, and maintenance unless explicitly requested by name.
- Documentation/API surface:
  - `typedoc.json` generates API docs into `docs/api` from `packages/core/src/index.ts`, `packages/agent/src/index.ts`, `packages/memory/src/index.ts`, `packages/rag/src/index.ts`, and `packages/scraper/src/index.ts`.
  - `README.md` identifies `yarn verify` as the complete pre-PR validation command and `yarn build:connectors:verified` as the connectors-specific gate.
- Lint/security baseline:
  - ESLint uses `@typescript-eslint` and `eslint-plugin-security`.
  - Generated/dependency artifacts ignored by lint include `dist`, `node_modules`, `.vite`, declaration files, source maps, coverage, `.turbo`, `.yarn`, and Vue files.
  - Baseline rules include `@typescript-eslint/no-explicit-any`, `@typescript-eslint/consistent-type-imports`, selected `eslint-plugin-security` checks, and type-aware async safety rules outside tests.

## Baseline Metrics

- Prepared snapshot metrics from `context/repo-snapshot.md`:
  - Files listed: 500
  - Source-like files: 467
  - Test-like files: 215
  - Config/docs marker files: 20
- Current live repository metrics, excluding generated/dependency artifacts by `rg --files` globs for `node_modules`, `dist`, `coverage`, and `.turbo`:
  - TS/JS-family code files under `packages/` and `scripts/`: 2,524
  - Non-test TS/JS-family source/config files under `packages/` and `scripts/`: 1,433
  - Test/spec files under `packages/` and `scripts/`: 1,091
- Typecheck status:
  - Command: `yarn typecheck`
  - Result: passed
  - Turbo result: 52 successful tasks, 52 total
  - Cache note: 52 cached tasks, 52 total
  - Environment note: Yarn warned that `/home/ninel/.cache/yarn` and the global folder candidates were not writable, then used `/tmp/.yarn-cache-1000`; this did not fail the command.
- Lint status:
  - Command: `yarn lint`
  - Result: passed
  - Turbo result: 31 successful tasks, 31 total
  - Cache note: 31 cached tasks, 31 total
  - Environment note: Yarn emitted the same writable-cache/global-folder warnings; this did not fail the command.
- Build/test commands discovered:
  - Root build: `yarn build`
  - Root development: `yarn dev`
  - Root typecheck: `yarn typecheck`
  - Root lint: `yarn lint`
  - Root test: `yarn test`
  - Root verify: `yarn verify`
  - Strict verify: `yarn verify:strict`
  - API docs: `yarn docs:generate`
  - Connectors verified build: `yarn build:connectors:verified`
  - Package-scoped Turbo pattern: `yarn build --filter=@dzupagent/<package>`, `yarn typecheck --filter=@dzupagent/<package>`, `yarn lint --filter=@dzupagent/<package>`, `yarn test --filter=@dzupagent/<package>`
  - Workspace-local package pattern: `yarn workspace @dzupagent/<package> build`, `typecheck`, `lint`, and `test`

## Snapshot Boundaries

- Reflects current code:
  - Live root files under `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent`: `AGENTS.md`, `README.md`, `package.json`, `turbo.json`, `tsconfig.json`, `typedoc.json`, and `eslint.config.js`.
  - Live package manifest inventory under `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/*/package.json`.
  - Live package directory fact that `packages/playground/` currently has docs only and no package manifest.
  - Live file counts from `rg --files` over `packages/` and `scripts/`, with generated/dependency artifacts excluded.
  - Current `yarn typecheck` and `yarn lint` outcomes from this checkout.
  - Current git status before the baseline edit was clean.
- Reflects prepared audit context, not independent live-code proof:
  - `context/repo-snapshot.md` under the prepared prompt pack.
  - Snapshot-level totals, bounded file list, and embedded README/AGENTS snippets in that snapshot.
  - The audit command, audit budget, and run directory values supplied by the automation wrapper.
- Reflects prior audit artifacts only:
  - The previous contents of `docs/BASELINE.md` described an earlier `packages/flow-dsl` sub-audit. That file was treated as comparison-only context and replaced for this full-repo baseline.
  - Older audit memories or prior run notes were not used as proof of current implementation, current package shape, or current verification status.
- Not verified in this step:
  - Full `yarn build`.
  - Full `yarn test`.
  - Full `yarn verify` or `yarn verify:strict`.
  - `yarn build:connectors:verified`.
  - Runtime behavior of package APIs, CLIs, HTTP routes, WebSocket routes, adapter orchestration, memory persistence, RAG flows, or generated TypeDoc output.
  - Security vulnerability status from dependency audit commands such as `yarn audit`.
  - Generated artifacts under `dist`, dependency directories such as `node_modules`, coverage output, Turbo cache contents, and `docs/api` generated documentation.

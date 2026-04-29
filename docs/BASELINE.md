# Baseline And Scope

Audit scope: `dzupagent/packages/flow-dsl`

Audit command:

`/audit:full dzupagent/packages/flow-dsl textual DSL parsing, normalization, canonicalization, formatting, document validation, graph conversion --domains code,architecture,agent --depth deep`

Workspace root: `/media/ninel/Second/code/datazup/ai-internal-dev`

Repository root: `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent`

Audit run directory: `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-packages-flow-dsl-textual-dsl-parsing-normalization-canonicalization-formatting-document-validation-graph-conversion-2026-04-29/run-001`

## Scope Reviewed

- Prepared snapshot and prompt context:
  - `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-packages-flow-dsl-textual-dsl-parsing-normalization-canonicalization-formatting-document-validation-graph-conversion-2026-04-29/run-001/codex-prep/context/repo-snapshot.md`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/audit/full-dzupagent-packages-flow-dsl-textual-dsl-parsing-normalization-canonicalization-formatting-document-validation-graph-conversion-2026-04-29/run-001/codex-prep/prompts/01-baseline-and-scope.md`
- Repository instructions and identity:
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/AGENTS.md` through the wrapper-provided instructions
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/package.json`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/README.md` excerpt through `repo-snapshot.md`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/turbo.json`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/tsconfig.json`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/eslint.config.js`
- Audited package:
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-dsl/package.json`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-dsl/tsconfig.json`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-dsl/tsup.config.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-dsl/vitest.config.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-dsl/src/index.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-dsl/src/types.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-dsl/src/errors.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-dsl/src/mini-yaml.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-dsl/src/parse-dsl.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-dsl/src/normalize.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-dsl/src/canonicalize-dsl.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-dsl/src/format-dsl.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-dsl/src/document-validate.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-dsl/src/document-to-graph.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-dsl/src/__tests__/*.test.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-dsl/test/*.test.ts`
- Contract dependency inspected because `flow-dsl` normalizes into and validates against it:
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-ast/package.json`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-ast/src/index.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-ast/src/types.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-ast/src/validate.ts`
  - `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-ast/test/*.test.ts` by test-name inventory only
- Commands run or inspected:
  - `rg --files packages/flow-dsl packages/flow-ast | sort`
  - `node -e ...` file-count inventory for `packages/flow-dsl`
  - `node -e ...` package-name inventory for `packages/*`
  - `rg -n "describe\\(|it\\(|test\\(" packages/flow-dsl/src/__tests__ packages/flow-dsl/test packages/flow-ast/test | sort`
  - `yarn typecheck --filter=@dzupagent/flow-dsl`
  - `yarn lint --filter=@dzupagent/flow-dsl`
  - `yarn test --filter=@dzupagent/flow-dsl`

## Repo Identity

- Package manager: Yarn Classic, `yarn@1.22.22`, declared in repository `packageManager`.
- Runtime baseline: Node.js `>=20.0.0`, TypeScript ESM packages, `type: "module"`.
- Workspace shape: private monorepo named `dzupagent` with Yarn workspaces `["packages/*"]`.
- Build orchestration: root scripts delegate package work through Turbo:
  - `build`: `turbo run build`
  - `typecheck`: `turbo run typecheck`
  - `lint`: `turbo run lint`
  - `test`: `turbo run test`
  - `verify`: `yarn test:inventory:runtime && yarn check:improvements:drift && yarn check:package-tiers && yarn check:domain-boundaries && yarn check:terminal-tool-event-guards && turbo run build typecheck lint test`
- Major package groups present in the current workspace:
  - Core/runtime: `@dzupagent/core`, `@dzupagent/agent`, `@dzupagent/context`, `@dzupagent/memory`, `@dzupagent/memory-ipc`, `@dzupagent/runtime-contracts`
  - Adapter/control surfaces: `@dzupagent/agent-adapters`, `@dzupagent/adapter-types`, `@dzupagent/adapter-rules`, `@dzupagent/agent-types`, `@dzupagent/otel`
  - Flow stack: `@dzupagent/flow-ast`, `@dzupagent/flow-dsl`, `@dzupagent/flow-compiler`
  - Server/transport/tooling: `@dzupagent/server`, `@dzupagent/express`, `@dzupagent/app-tools`, `@dzupagent/code-edit-kit`, `@dzupagent/hitl-kit`
  - Data/evaluation/support: `@dzupagent/connectors`, `@dzupagent/connectors-browser`, `@dzupagent/connectors-documents`, `@dzupagent/rag`, `@dzupagent/scraper`, `@dzupagent/evals`, `@dzupagent/eval-contracts`, `@dzupagent/testing`, `@dzupagent/test-utils`, `create-dzupagent`
- Product boundary from local repository instructions:
  - New reusable DzupAgent framework primitives belong in framework packages.
  - `packages/server` and `packages/playground` are retained for compatibility, examples, tests, and maintenance, not as the forward path for new agent product capabilities.
- Audited package identity:
  - Package: `@dzupagent/flow-dsl`
  - Version: `0.2.0`
  - Description: textual `dzupflow/v1` DSL parser, formatter, validator, and graph projection for DzupAgent.
  - Public export: package root only, mapped to `dist/index.js` and `dist/index.d.ts`.
  - Runtime dependency: `@dzupagent/flow-ast`.
  - Package scripts: `build` via `tsup`, `typecheck` via `tsc --noEmit`, `lint` via `eslint src/`, `test` via `vitest run`.
- Audited runtime surface:
  - `parseYamlSubset(source)` parses the intentionally small YAML subset used by the textual DSL.
  - `parseDslToDocument(source)` parses YAML subset input, normalizes it, validates it, and returns diagnostics.
  - `normalizeDslDocument(raw)` and `normalizeSteps(...)` convert authoring sugar into canonical `FlowDocumentV1`/`FlowNode` structures.
  - `canonicalizeDsl(source)` fails closed on parse/normalization/validation diagnostics, otherwise returns the canonical document, root flow input, and derived graph.
  - `formatDocumentToDsl(document)` emits a deterministic textual DSL representation from a canonical document.
  - `validateDocument(document)` delegates runtime document validation to `@dzupagent/flow-ast`'s `flowDocumentSchema`.
  - `documentToGraph(document)` projects the canonical tree document into derived graph nodes and edges.

## Baseline Metrics

- Snapshot-level metrics from `context/repo-snapshot.md`:
  - Files listed: 500
  - Source-like files: 467
  - Test-like files: 215
  - Config/docs marker files: 20
- Current audited package file inventory for `packages/flow-dsl`:
  - Total files under package, excluding generated/dependency artifacts by traversal: 25
  - Implementation source files under `packages/flow-dsl/src`, excluding `src/__tests__`: 10
  - Non-test TypeScript/config source-like files in the package, including `tsup.config.ts` and `vitest.config.ts`: 12
  - Test files: 11
    - `src/__tests__`: 5 files
    - `test`: 6 files
- Focused typecheck status:
  - Command: `yarn typecheck --filter=@dzupagent/flow-dsl`
  - Result: passed
  - Turbo tasks: 3 successful, 3 total
  - Notes: output replayed cached `@dzupagent/flow-ast` build/typecheck and `@dzupagent/flow-dsl` typecheck logs; Yarn warned that the preferred cache/global folders were not writable and used `/tmp/.yarn-cache-1000`.
- Focused lint status:
  - Command: `yarn lint --filter=@dzupagent/flow-dsl`
  - Result: passed
  - Turbo tasks: 1 successful, 1 total
  - Notes: output replayed cached `@dzupagent/flow-dsl` lint logs.
- Focused test status:
  - Command: `yarn test --filter=@dzupagent/flow-dsl`
  - Result: passed
  - Turbo tasks: 2 successful, 2 total
  - Vitest result: 11 test files passed, 171 tests passed.
  - Notes: test run included a cached dependency build for `@dzupagent/flow-ast`.
- Build/test commands discovered:
  - Root build: `yarn build`
  - Root typecheck: `yarn typecheck`
  - Root lint: `yarn lint`
  - Root test: `yarn test`
  - Root verify: `yarn verify`
  - Package-scoped build: `yarn build --filter=@dzupagent/flow-dsl`
  - Package-scoped typecheck: `yarn typecheck --filter=@dzupagent/flow-dsl`
  - Package-scoped lint: `yarn lint --filter=@dzupagent/flow-dsl`
  - Package-scoped test: `yarn test --filter=@dzupagent/flow-dsl`
  - Workspace-local equivalents from `packages/flow-dsl/package.json`: `yarn workspace @dzupagent/flow-dsl build`, `typecheck`, `lint`, and `test`.

## Snapshot Boundaries

- Reflects current code:
  - Live files under `/media/ninel/Second/code/datazup/ai-internal-dev/dzupagent/packages/flow-dsl`.
  - The directly inspected `@dzupagent/flow-ast` type and runtime schema files that define the canonical document/node contract used by `flow-dsl`.
  - Current root workspace/package metadata from `package.json`, `turbo.json`, `tsconfig.json`, and `eslint.config.js`.
  - Focused command outcomes for `yarn typecheck --filter=@dzupagent/flow-dsl`, `yarn lint --filter=@dzupagent/flow-dsl`, and `yarn test --filter=@dzupagent/flow-dsl`.
- Reflects prepared audit context, not independent live-code proof:
  - File totals and bounded file list in `codex-prep/context/repo-snapshot.md`.
  - README and AGENTS snippets embedded in `repo-snapshot.md`.
  - Prompt pack files under `codex-prep/prompts/*`.
- Reflects prior audit artifacts only:
  - No prior audit bundle was used as source-of-truth evidence for this baseline.
  - Any older audit/memory notes about `flow-dsl` are comparison-only context and are not counted as current implementation, current test coverage, or current verification status.
- Not verified in this step:
  - Full repository `yarn verify`.
  - Full repository `yarn build`, `yarn typecheck`, `yarn lint`, or `yarn test` without filters.
  - Focused `yarn build --filter=@dzupagent/flow-dsl`; only dependency build replay for `@dzupagent/flow-ast` appeared during the typecheck/test lanes.
  - Runtime integration through `@dzupagent/flow-compiler`, `@dzupagent/server`, `packages/playground`, or consuming applications.
  - Generated artifacts under `dist`, dependency directories such as `node_modules`, coverage output, Turbo cache contents, and audit output outside this baseline file.

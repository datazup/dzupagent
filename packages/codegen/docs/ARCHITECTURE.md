# @dzupagent/codegen Architecture

## Scope
`@dzupagent/codegen` is the DzupAgent package for code generation runtime primitives, execution isolation helpers, and code-quality/control utilities. The scope in `packages/codegen` includes:

- Generation services and orchestration (`src/generation/*`, `src/pipeline/*`, `src/correction/*`, `src/streaming/*`).
- Virtual file and workspace abstractions (`src/vfs/*`, `src/workspace/*`).
- Sandbox providers and governance/hardening layers (`src/sandbox/*`, including Docker, E2B, Fly, WASM, K8s, pool, volume, audit, and PTC governance).
- Guardrails, conventions, validation, and scoring (`src/guardrails/*`, `src/conventions/*`, `src/validation/*`, `src/quality/*`).
- Code intelligence utilities (`src/repomap/*`, `src/chunking/*`, `src/search/*`, `src/context/*`, `src/contract/*`).
- Workflow helpers (`src/git/*`, `src/ci/*`, `src/review/*`, `src/pr/*`, `src/migration/*`).
- Tool facades for agent/tooling integration (`src/tools/*`, plus `src/tools.ts` export facade).

Out of scope: app-owned product semantics (for example tenancy/workspace UX and product workflows), which should stay in consuming applications.

## Responsibilities
The package is responsible for:

- Publishing a broad TypeScript API via `src/index.ts` and subpath entrypoints (`/vfs`, `/tools`, `/runtime`, `/compat`).
- Generating code either directly through `CodeGenService` (ModelRegistry path) or through `CodegenRunEngine` adapter routing.
- Managing generated code state in memory/workspace abstractions, including snapshots, patching, and checkpointing.
- Executing phase-based generation flows with dependency ordering, retries, timeout handling, budget checks, and optional guardrail gates.
- Providing sandbox execution primitives and security configuration helpers used by tools and workspace runners.
- Exposing reusable review, CI, PR, git, migration, and search primitives for upstream orchestrators.

## Structure
Current package layout:

- `src/index.ts`: main export surface for package consumers.
- `src/runtime.ts`: runtime-focused facade (generation, sandbox, pipeline, guardrails, quality).
- `src/tools.ts`: tool and workspace/git facade.
- `src/vfs.ts`: VFS-specific facade.
- `src/compat.ts`: transitional facade marked deprecated for future removal.
- `src/generation`: `CodeGenService`, `CodegenRunEngine`, incremental generation, code-block parsing, test generation.
- `src/pipeline`: DAG-based pipeline builder/executor, phase conditions, budget gate, guardrail gate, escalation.
- `src/sandbox`: provider protocols/implementations, security tiers/profiles, hardening, pool, audit, volumes, WASM, K8s, governed PTC.
- `src/vfs`: `VirtualFS`, copy-on-write VFS, patch engine, snapshots, workspace FS adapters and runner.
- `src/workspace`: local/sandboxed workspace wrappers and factory.
- `src/quality`, `src/validation`, `src/guardrails`, `src/conventions`: quality dimensions, import/contract checks, rule engine/reporting, convention detection/enforcement.
- `src/repomap`, `src/chunking`, `src/search`, `src/context`, `src/contract`: symbol extraction, import graphs, AST chunking, semantic indexing/search, token budgeting, API extraction.
- `src/git`, `src/ci`, `src/review`, `src/pr`, `src/migration`: workflow assistance modules.
- `src/__tests__`: package test suite.

Build/export shape from `package.json` and `tsup.config.ts`:

- ESM build (`dist/*`) with declaration output.
- Public export map includes root plus `./vfs`, `./tools`, `./runtime`, and `./compat`.

## Runtime and Control Flow
Primary control flow paths in current code:

1. `CodeGenService.generateFile(params, systemPrompt)`
- Resolves model from `ModelRegistry` (`codegen` tier by default).
- Builds user prompt from target path, purpose, reference files, and context.
- Invokes model via LangChain messages and extracts the largest code block.
- Returns normalized output with token usage and detected language.

2. `CodegenRunEngine.generateFile(...)`
- Uses adapter route when `AgentCLIAdapter` is configured.
- Streams adapter events, tracks completion/failure, and normalizes generated content.
- Optionally forwards normalized events to `DzupEventBus`, including execution-run-id checks for tool events.
- Falls back to `CodeGenService` when adapter is absent and a registry is configured.

3. `PipelineExecutor.execute(phases, initialState)`
- Topologically sorts phases by `dependsOn`.
- Applies condition checks, optional budget gate, optional skill injection.
- Executes phase bodies with timeout/retry behavior.
- Optionally runs guardrail gate per phase when configured.
- Produces per-phase results and final pipeline status/state.

4. `WorkspaceFactory` + `WorkspaceRunner`
- `WorkspaceFactory` chooses local vs sandboxed execution based on options and available sandbox backend.
- `WorkspaceRunner` syncs VFS files into sandbox, runs command, and can sync changed files back.

5. `CodeSearchService`
- Chunks source using AST-aware chunking.
- Upserts chunks into a `SemanticStore` collection.
- Supports query search, symbol search, file removal, and collection reindex.

## Key APIs and Types
Representative public APIs (from current exports):

- Generation/runtime:
  - `CodeGenService`, `CodegenRunEngine`
  - `GenerateFileParams`, `GenerateFileResult`, `CodegenRunEngineConfig`
  - `PipelineExecutor`, `GenPipelineBuilder`, `PipelineExecutionResult`
  - `SelfCorrectionLoop`, `ReflectionNode`, `LessonExtractor`

- VFS/workspace:
  - `VirtualFS`, `CopyOnWriteVFS`, `CheckpointManager`
  - `parseUnifiedDiff`, `applyPatch`, `applyPatchSet`
  - `WorkspaceRunner`, `InMemoryWorkspaceFS`, `DiskWorkspaceFS`, `GitWorktreeWorkspaceFS`
  - `LocalWorkspace`, `SandboxedWorkspace`, `WorkspaceFactory`

- Sandbox/security:
  - `createSandbox`, `DockerSandbox`, `E2BSandbox`, `FlySandbox`, `MockSandbox`, `MockSandboxV2`
  - `SandboxPool` and reset strategies
  - `TIER_DEFAULTS`, `SECURITY_PROFILES`, hardening helpers
  - WASM and K8s sandbox exports
  - PTC governance/tool exports (`createPtcTool`, `checkPtcAccess`, related types)

- Quality/guardrails/validation:
  - `QualityScorer`, `builtinDimensions`
  - `ConventionGate`
  - `GuardrailEngine`, `GuardrailReporter`, builtin guardrail rule factories
  - `validateImports` (validation path) and import/contract checks in `quality/*`

- Code intelligence and workflow helpers:
  - `buildRepoMap`, `extractSymbols`, `buildImportGraph`
  - `chunkByAST`, `CodeSearchService`, `TokenBudgetManager`
  - git/CI/review/PR/migration utility exports

- Version constant:
  - `dzupagent_CODEGEN_VERSION` is exported as `'0.2.0'`.

## Dependencies
Declared package dependencies and peer dependencies:

- Runtime dependencies:
  - `@dzupagent/core`
  - `@dzupagent/adapter-types`

- Peer dependencies:
  - `@langchain/core`
  - `@langchain/langgraph`
  - `zod`
  - `tree-sitter-wasms` (optional)
  - `web-tree-sitter` (optional)

- Build/test toolchain:
  - TypeScript + `tsup` (entrypoints: `src/index.ts`, `src/vfs.ts`, `src/tools.ts`, `src/runtime.ts`, `src/compat.ts`)
  - Vitest (`node` environment)

## Integration Points
Current integration seams used by upstream packages/apps:

- LLM + token accounting contracts from `@dzupagent/core/llm`.
- Eventing contracts from `@dzupagent/core/events` (`DzupEventBus`, execution-run-id enforcement utilities).
- Adapter execution contract from `@dzupagent/adapter-types` (`AgentCLIAdapter` and event stream).
- Semantic indexing/search through core vector-store abstractions (`SemanticStore`).
- LangChain message/tool ecosystem through `@langchain/core` and package tool factories.
- Sandbox provider selection/config via `createSandbox` and downstream workspace/tool execution.

## Testing and Observability
Testing reality in this package:

- Test runner: Vitest (`vitest run`).
- Include patterns: `src/**/*.test.ts`, `src/**/*.spec.ts`.
- Current test file count in `src`: 92.
- Coverage provider/reporters: V8 with `text` and `json-summary`.
- Coverage thresholds: statements 60, branches 50, functions 50, lines 60.

Observability hooks:

- `CodegenRunEngine` can emit normalized adapter/tool lifecycle events to a provided `DzupEventBus`.
- `PipelineExecutor` supports `onProgress` and `onCheckpoint` callbacks.
- `SelfCorrectionLoop` supports lifecycle listeners for iteration/fixed/exhausted events.
- `streaming/` defines typed stream events and merging helpers for multi-source codegen streams.

## Risks and TODOs
Current risks visible from implementation/export shape:

- Surface-area risk: root `index.ts` exports a very large mixed-stability API, making compatibility management harder.
- Dual import-validation paths: both `src/validation/import-validator.ts` and `src/quality/import-validator.ts` are public and can confuse consumers.
- Transitional API risk: `src/compat.ts` is deprecated but still exported; migration pressure and docs need to stay synchronized.
- Multi-provider sandbox consistency: lifecycle and capability assumptions differ across Docker/E2B/Fly/WASM/K8s paths.
- Documentation drift risk: README/generated metadata and architecture docs can diverge from rapidly changing exports.

TODO candidates for maintainers:

- Define and enforce a stricter stability policy for root exports vs subpath exports.
- Clarify or consolidate import-validation API split.
- Continue migration guidance away from `/compat` toward `/vfs`, `/tools`, and `/runtime`.
- Add stronger automated checks tying docs/examples to exported signatures and versioned entrypoints.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
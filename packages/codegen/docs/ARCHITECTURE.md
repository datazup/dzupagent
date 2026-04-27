# @dzupagent/codegen Architecture

## Scope
`@dzupagent/codegen` is the DzupAgent package for code-generation runtime primitives and supporting automation workflows. The scope in this package includes:

- In-memory and copy-on-write file state (`src/vfs/*`) and workspace abstractions (`src/workspace/*`).
- LLM-driven generation, incremental edits, and run orchestration (`src/generation/*`, `src/correction/*`, `src/pipeline/*`).
- Execution backends and isolation layers (`src/sandbox/*`, including Docker, E2B, Fly, K8s, WASM, pool/audit/volumes).
- Validation, quality, guardrails, conventions, and policy checks (`src/quality/*`, `src/validation/*`, `src/guardrails/*`, `src/conventions/*`).
- Code intelligence utilities (`src/repomap/*`, `src/chunking/*`, `src/search/*`, `src/context/*`, `src/contract/*`).
- Developer workflow helpers for git, CI, review, PR, and migration (`src/git/*`, `src/ci/*`, `src/review/*`, `src/pr/*`, `src/migration/*`).
- LangChain-compatible tool factories for generation/edit/validation operations (`src/tools/*`).

Out of scope for this package: application-specific product workflows (for example Codev tenancy/workspace policy decisions) that should live in consuming apps.

## Responsibilities
This package is responsible for:

- Providing a large public TypeScript API from `src/index.ts` (runtime classes, utility functions, and contract types).
- Running file-generation flows either directly through `ModelRegistry` (`CodeGenService`) or through adapter orchestration (`CodegenRunEngine`).
- Staging, diffing, patching, and optionally syncing generated code via VFS/workspace/sandbox bridges.
- Executing validation and repair loops with retry/escalation controls (`PipelineExecutor`, `SelfCorrectionLoop`).
- Enforcing architecture and coding constraints through convention and guardrail engines.
- Supplying semantic indexing/search over code chunks using a pluggable `SemanticStore` backend.
- Exposing composable units for downstream orchestrators rather than one monolithic end-to-end product runtime.

## Structure
Top-level source directories under `src/`:

- `adaptation` and `migration`: framework/language adaptation and migration planning helpers.
- `chunking`, `repomap`, `search`: AST/symbol extraction, import graphing, chunking, semantic search.
- `ci`, `pr`, `review`, `git`: CI status parsing, PR state transitions, review checks, git tooling.
- `context`: token budget and context compression strategies.
- `contract`, `validation`, `quality`: API extraction and quality/validation checks.
- `conventions`, `guardrails`: convention detection/enforcement and rule-based architecture guardrails.
- `correction`: iterative evaluate-reflect-fix loop and lesson extraction hooks.
- `generation`: file generation services, parsing, incremental generation, test generation, adapter-bridge run engine.
- `pipeline`: phase definitions, execution engine, guardrail gate, budget gate, fix escalation, skill injection.
- `sandbox`: protocol(s), provider implementations, hardening/security tiers, pooling, auditing, WASM, K8s.
- `streaming`: stream event types and async stream merge fan-in.
- `tools`: LangChain tool factories for file edits, generation, validation, tests, preview.
- `vfs`: virtual filesystem, patch engine, snapshots, checkpoint manager, workspace runner.
- `workspace`: local/sandboxed workspace adapters and factory.
- `__tests__`: package tests (83 test files currently matching `src/**/*.test.ts`).

Package metadata highlights:

- `package.json` exports only the root entry (`dist/index.js`, `dist/index.d.ts`).
- Runtime dependencies: `@dzupagent/core`, `@dzupagent/adapter-types`.
- Peer dependencies: `@langchain/core`, `@langchain/langgraph`, `zod`, optional `tree-sitter-wasms` and `web-tree-sitter`.

## Runtime and Control Flow
Primary runtime paths in current code:

1. `CodeGenService.generateFile(...)`
- Resolves a model from `ModelRegistry`.
- Builds a generation prompt from file path, purpose, reference files, and context.
- Invokes LangChain model messages (`SystemMessage`, `HumanMessage`).
- Extracts the largest fenced code block and returns token usage via `extractTokenUsage`.

2. `CodegenRunEngine.generateFile(...)`
- If adapter is configured, routes generation through `AgentCLIAdapter.execute(...)`.
- Emits normalized run/tool events to `DzupEventBus` where configured, including execution-run-id hardening via `requireTerminalToolExecutionRunId`.
- Falls back to `CodeGenService` when no adapter is present.

3. `PipelineExecutor.execute(...)`
- Topologically sorts phase configs by dependencies.
- Applies optional condition checks, budget gate checks, and per-phase skill resolution.
- Executes each phase with timeout and retry policy (`immediate` or `backoff`).
- Optionally runs guardrail gate post-phase using caller-provided `buildGuardrailContext`.
- Returns per-phase status and final state snapshot.

4. `SelfCorrectionLoop.run(...)`
- Iterates evaluation -> reflection -> fix with configurable max iterations/cost.
- Uses injected `CodeEvaluator` and `CodeFixer` implementations.
- Optionally invokes `ReflectionNode` and `LessonExtractor`.
- Emits lifecycle callbacks (`onIteration`, `onFixed`, `onExhausted`).

5. VFS/sandbox execution bridge (`WorkspaceRunner.run(...)`)
- Materializes VFS snapshot into sandbox via `uploadFiles`.
- Executes command with timeout options.
- Optionally syncs changed files back into VFS (`syncBack`).

6. Semantic indexing/search (`CodeSearchService`)
- Chunks files with AST-aware chunker.
- Upserts chunks into configured `SemanticStore` collection.
- Executes query-based and symbol-based searches with metadata filters.

## Key APIs and Types
Representative entry points exported from `src/index.ts`:

- Generation: `CodeGenService`, `CodegenRunEngine`, `GenerateFileParams`, `GenerateFileResult`.
- Pipeline: `GenPipelineBuilder`, `PipelineExecutor`, `PhaseConfig` variants, `DEFAULT_ESCALATION`, `runGuardrailGate`, `runBudgetGate`.
- Correction: `SelfCorrectionLoop`, `ReflectionNode`, `LessonExtractor`, `SelfCorrectionConfig`, `CorrectionResult`.
- VFS/workspace: `VirtualFS`, `CopyOnWriteVFS`, patch helpers, `WorkspaceRunner`, `LocalWorkspace`, `SandboxedWorkspace`, `WorkspaceFactory`.
- Sandbox: `SandboxProtocol`, `SandboxProtocolV2`, `createSandbox`, provider classes (Docker/E2B/Fly/Mock/K8s/WASM), security tier/profile helpers.
- Quality/validation: `QualityScorer`, builtin quality dimensions, import/contract validators, `ConventionGate`.
- Guardrails: `GuardrailEngine`, `GuardrailReporter`, builtin rule factories.
- Intelligence/search: `buildRepoMap`, `chunkByAST`, `CodeSearchService`, token-budget helpers.
- Tooling: `createWriteFileTool`, `createEditFileTool`, `createGenerateFileTool`, `createRunTestsTool`, `createValidateTool`, `createPreviewAppTool`.
- Workflow helpers: git/PR/CI/review/migration exports.
- Streaming: `CodegenStreamEvent`, `mergeCodegenStreams`.

Notable API reality check:

- `dzupagent_CODEGEN_VERSION` is currently exported as `'0.1.0'` in `src/index.ts` while `package.json` version is `0.2.0`.

## Dependencies
Runtime/internal dependency roles:

- `@dzupagent/core`
- model registry access, token extraction, backoff utility, skill resolution interfaces, event bus types, sub-agent typing.
- `@dzupagent/adapter-types`
- adapter execution contracts for `CodegenRunEngine` adapter path.
- `@langchain/core`
- message and tool primitives used by generation/reflection/lesson-extraction and tool factories.
- `@langchain/langgraph`
- peer requirement for graph/pipeline usage in consumers (types and orchestration compatibility).
- `zod`
- tool and schema validation.
- `web-tree-sitter` and `tree-sitter-wasms` (optional peers)
- optional AST parsing improvements for repomap/chunking paths.

Build/test toolchain:

- TypeScript + tsup for build output.
- Vitest (`node` environment) for tests.
- Coverage threshold config in `vitest.config.ts`: statements 60, branches 50, functions 50, lines 60.

## Integration Points
This package integrates with the rest of DzupAgent and consumers via:

- Root export surface (`@dzupagent/codegen`) consumed by app/runtime packages.
- `ModelRegistry` and `SemanticStore` contracts from `@dzupagent/core`.
- Adapter-driven execution via `AgentCLIAdapter` in `CodegenRunEngine`.
- Sandbox providers selected by `createSandbox(...)` and used by `WorkspaceRunner` and tooling.
- Skill resolution seam in pipeline (`SkillRegistry`/`SkillLoader` from core).
- LangChain tool instances created by `src/tools/*` and `src/git/git-tools.ts`.
- Optional `DzupEventBus` emission path for agent/tool observability in adapter-based codegen runs.

## Testing and Observability
Testing posture from current package layout/config:

- 83 test files under `src/**` (`*.test.ts`) covering VFS, sandbox providers, pipeline, tools, quality, guardrails, generation, correction, git/review, repomap/search, and workspace abstractions.
- Vitest include patterns: `src/**/*.test.ts`, `src/**/*.spec.ts`.
- Coverage configured with V8 provider and JSON summary/text reporters.

Observability hooks currently present:

- `CodegenRunEngine` forwards adapter lifecycle/tool events into `DzupEventBus` when provided.
- `SelfCorrectionLoop` exposes callback listeners for iteration/fixed/exhausted events.
- `PipelineExecutor` supports progress callbacks and checkpoints.
- Streaming module defines typed stream events and a merge utility for multi-source stream fan-in.

## Risks and TODOs
Current code-level risks visible in this package:

- Version constant drift: `dzupagent_CODEGEN_VERSION` in `src/index.ts` does not match package version.
- Sandbox lifecycle mismatch risk: `WorkspaceRunner` uploads before execute; E2B/Fly implementations require readiness assertions in `uploadFiles`.
- API surface complexity: root `index.ts` exports a very large mixed-stability surface, increasing compatibility management overhead.
- Duplicate import-validation semantics: both `validation/import-validator.ts` and `quality/import-validator.ts` are exported with different result shapes.
- Documentation drift risk: README examples and generated metadata can diverge from source signatures/runtime behavior.

Concrete TODO candidates:

- Align `dzupagent_CODEGEN_VERSION` with `package.json` versioning strategy.
- Normalize sandbox provider lifecycle semantics (`uploadFiles`/`execute` initialization behavior).
- Define stricter stability governance for root exports (already partially tracked in `docs/api-tiers.md`).
- Unify import-validation entry points or document intended split explicitly.
- Add automated API-example checks to catch doc drift.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js.
- 2026-04-26: rewritten from current local implementation in `packages/codegen/src`, `package.json`, `README.md`, and existing package docs.

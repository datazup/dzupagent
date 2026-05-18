# Generation Architecture (`packages/codegen/src/generation`)

## Scope
This document covers only `packages/codegen/src/generation` in `@dzupagent/codegen`:

- `code-block-parser.ts`
- `code-gen-service.ts`
- `codegen-run-engine.ts`
- `incremental-gen.ts`
- `test-generator.ts`

It also references direct integration seams outside this folder when they consume these APIs (`src/index.ts`, `src/runtime.ts`, `src/tools/generate-file.tool.ts`, and generation-focused tests).

## Responsibilities
The generation subsystem is responsible for:

- Building file-generation prompts and invoking an LLM through `ModelRegistry` (`CodeGenService`).
- Providing an adapter-routed generation path with event normalization and optional event-bus emission (`CodegenRunEngine`).
- Parsing markdown code-fence output and extracting the dominant code payload (`code-block-parser`).
- Offering heuristic incremental-edit helpers for section detection and patch application (`incremental-gen`).
- Producing structured test-generation specs/prompts from source targets (`test-generator`).

It does not execute tests, run sandbox commands, or orchestrate pipeline DAG execution directly.

## Structure
Current files and roles:

- `code-block-parser.ts`
- Exports `CodeBlock`, `parseCodeBlocks`, `extractLargestCodeBlock`, `detectLanguage`.
- Uses regex fence parsing and extension-to-language mapping with `text` fallback.

- `code-gen-service.ts`
- Exports `GenerateFileParams`, `GenerateFileResult`, `CodeGenService`.
- Implements direct model invocation via `registry.getModel(...)`, LangChain messages, and token-usage extraction.

- `codegen-run-engine.ts`
- Exports `CodegenRunEngineConfig`, `CodegenRunEngine`.
- Routes generation through `AgentCLIAdapter` when available.
- Falls back to internal `CodeGenService` when only `registry` is configured.
- Normalizes adapter events to `DzupEventBus` and enforces terminal tool correlation via `requireTerminalToolExecutionRunId`.

- `incremental-gen.ts`
- Exports `CodeSection`, `IncrementalChange`, `IncrementalResult`.
- Exports `splitIntoSections`, `detectAffectedSections`, `applyIncrementalChanges`, `buildIncrementalPrompt`.
- Uses line/regex heuristics for top-level declaration boundaries.

- `test-generator.ts`
- Exports `TestStrategy`, `TestFramework`, `TestGenConfig`, `TestTarget`, `ExportInfo`, `TestSpec`, `TestCase`.
- Exports `determineTestStrategy`, `extractExports`, `buildTestPath`, `generateTestSpecs`.
- Generates test prompts and suggested test cases, not runnable tests.

## Runtime and Control Flow
Primary runtime paths:

1. Direct model path (`CodeGenService.generateFile`)
- Detect language from `filePath`.
- Build prompt from `filePath`, `purpose`, optional `referenceFiles`, optional `context`.
- Resolve model from registry (`options.modelTier ?? 'codegen'`).
- Invoke model with `SystemMessage` and `HumanMessage`.
- Convert response content to string, extract largest code block, map token usage, return `GenerateFileResult`.

2. Adapter path (`CodegenRunEngine.generateFile` with `adapter`)
- Build adapter `AgentInput` (`prompt`, `systemPrompt`, `maxTurns`, optional `workingDirectory`).
- Stream `adapter.execute(...)` events.
- Track active session/tool context and forward mapped events to bus when configured.
- Stop on `adapter:failed`; require `adapter:completed` for success.
- Extract code from completed result and map adapter usage to core `TokenUsage`.

3. Fallback path (`CodegenRunEngine.generateFile` without `adapter`)
- Requires constructor-configured `registry`.
- Delegates to internal `CodeGenService`.

4. Incremental-edit helper flow
- `splitIntoSections` partitions top-level declarations.
- `detectAffectedSections` chooses candidate sections from token overlap.
- `buildIncrementalPrompt` prepares focused prompt text.
- `applyIncrementalChanges` applies `add`/`replace`/`delete` operations sorted by descending line position.

5. Test-spec helper flow
- `determineTestStrategy` picks `unit|integration|component|e2e` from path hints.
- `extractExports` collects exported symbols (regex-based).
- `generateTestSpecs` creates prompts/cases and output paths via `buildTestPath`.

Event mapping in `CodegenRunEngine.forwardEvent`:

- `adapter:started` -> `agent:started`
- `adapter:completed` -> `agent:completed`
- `adapter:failed` -> `agent:failed` and optionally `tool:error` when failure happens during an active tool call
- `adapter:stream_delta` -> `agent:stream_delta`
- `adapter:tool_call` -> `tool:called`
- `adapter:tool_result` -> `tool:result`
- `adapter:message` and `adapter:progress` are intentionally ignored

## Key APIs and Types
Publicly exported generation APIs come from `src/index.ts` and `src/runtime.ts`:

- `CodeGenService`
- `GenerateFileParams`
- `GenerateFileResult`
- `CodegenRunEngine`
- `CodegenRunEngineConfig`
- `CodeBlock`
- `parseCodeBlocks`
- `extractLargestCodeBlock`
- `detectLanguage`
- `CodeSection`
- `IncrementalChange`
- `IncrementalResult`
- `splitIntoSections`
- `detectAffectedSections`
- `applyIncrementalChanges`
- `buildIncrementalPrompt`
- `TestStrategy`
- `TestFramework`
- `TestGenConfig`
- `TestTarget`
- `ExportInfo`
- `TestSpec`
- `TestCase`
- `determineTestStrategy`
- `extractExports`
- `buildTestPath`
- `generateTestSpecs`

Key runtime contracts visible in code:

- `GenerateFileResult.source` is always `'llm'`.
- `CodegenRunEngine` constructor throws unless at least one of `adapter` or `registry` is provided.
- `CodegenRunEngine.usesAdapter` reports whether adapter routing is active.
- Terminal tool events (`tool:result`, `tool:error`) require an execution run id through `requireTerminalToolExecutionRunId`.

## Dependencies
Direct dependencies used by generation files:

- `@dzupagent/core/llm`
- `ModelRegistry`, `ModelTier`, `TokenUsage`, `extractTokenUsage`

- `@dzupagent/core/events`
- `DzupEventBus`, `requireTerminalToolExecutionRunId`

- `@dzupagent/adapter-types`
- `AgentCLIAdapter`, `AgentInput`, `AgentEvent`, `AgentCompletedEvent`, `AgentFailedEvent`, adapter `TokenUsage`

- `@langchain/core/messages`
- `SystemMessage`, `HumanMessage`

Package-level dependency declarations (`packages/codegen/package.json`) also include peer dependencies `@langchain/core`, `@langchain/langgraph`, `zod`, and optional `web-tree-sitter` / `tree-sitter-wasms`.

## Integration Points
Verified integration points in the current codebase:

- Root exports: `src/index.ts` re-exports all generation APIs.
- Runtime subpath: `src/runtime.ts` re-exports generation APIs behind `@dzupagent/codegen/runtime`.
- Tool bridge: `src/tools/generate-file.tool.ts` consumes `CodeGenService` and exposes LangChain tool `generate_file`.
- Core eventing: `CodegenRunEngine` can emit normalized `agent:*` and `tool:*` events to a provided `DzupEventBus`.
- Adapter bridge: `CodegenRunEngine` consumes `AgentCLIAdapter.execute(...)` streams and converts adapter completion usage into core token usage format.

## Testing and Observability
Generation behavior is primarily covered by these tests:

- `src/__tests__/code-block-parser.test.ts`
- Fence parsing, largest-block extraction, language detection map.

- `src/__tests__/incremental-gen-and-test-generator.test.ts`
- Section splitting, affected-section detection, incremental apply/prompt behavior.
- Test strategy detection, export extraction, path generation, test-spec generation.
- This file also includes `parallel-sampling` coverage from `vfs`, so it is mixed-scope.

- `src/__tests__/codegen-run-engine.unit.test.ts`
- Constructor guards, adapter input shape, event mapping/order, ignored event types, content extraction, adapter failure paths.

- `src/__tests__/codegen-run-engine.correlation.test.ts`
- Execution-run-id enforcement for terminal tool events and mid-tool failure handling.

- `src/__tests__/tools-suite.test.ts`
- `createGenerateFileTool` integration with `CodeGenService` and tool output formatting.

Observability surfaces in this subsystem:

- Adapter path: event forwarding through `DzupEventBus` (`agent:*`, `tool:*`).
- Direct `CodeGenService` path: no internal event emission/logging hooks.
- Package test/coverage settings come from `packages/codegen/vitest.config.ts` (`v8` coverage with 60/50/50/60 thresholds).

## Risks and TODOs
Current risks from implementation reality:

- Prompt-building duplication: `CodeGenService.generateFile` and `CodegenRunEngine` maintain similar message-construction logic separately.
- Heuristic parsing limits: code blocks, sections, and export extraction are regex-based and can miss advanced syntax/forms.
- Fallback confidence gap: adapter path has deep tests; direct `CodeGenService` path has comparatively less dedicated test coverage.
- Correlation strictness: missing execution-run-id on terminal tool events hard-fails generation when event bus forwarding is enabled.
- Mixed test scope: incremental/test-generator tests share a file with unrelated VFS `parallel-sampling` tests, which can reduce subsystem signal clarity.

Practical TODO direction:

- Consolidate prompt construction into one shared helper used by both generation entry points.
- Add direct `CodeGenService` unit tests that assert prompt shape, response normalization, and token-usage extraction.
- Consider optional diagnostics hooks for the direct model path to match adapter-path observability.
- Consider splitting mixed-scope tests into subsystem-specific files for clearer maintenance boundaries.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

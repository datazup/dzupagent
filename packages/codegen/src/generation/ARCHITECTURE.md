# Generation Architecture (`packages/codegen/src/generation`)

## Scope
This document covers the generation subsystem under `packages/codegen/src/generation`:

- `code-block-parser.ts`
- `code-gen-service.ts`
- `codegen-run-engine.ts`
- `incremental-gen.ts`
- `test-generator.ts`

It is limited to what exists in the current local codebase. It does not describe package-wide pipeline, sandbox, or VFS internals except where generation APIs integrate with them.

## Responsibilities
The generation subsystem provides five concrete responsibilities:

- Parse and normalize LLM output that contains markdown code fences.
- Generate full-file content through a `ModelRegistry` path (`CodeGenService`).
- Route generation through an adapter event stream with optional event-bus forwarding (`CodegenRunEngine`), with direct-registry fallback.
- Plan and apply line/section-level incremental edits using regex and line-oriented heuristics.
- Produce LLM-facing test-generation specs (prompt + suggested cases), not runnable tests.

## Structure
### `code-block-parser.ts`
- `parseCodeBlocks(text): CodeBlock[]`
- `extractLargestCodeBlock(text): string`
- `detectLanguage(filePath): string`

Role:
- Parses fenced blocks with regex (` ```lang ... ``` `).
- Chooses the largest parsed code block when multiple are present.
- Maps file extensions to prompt-language labels (fallback: `text`).

### `code-gen-service.ts`
- `GenerateFileParams`
- `GenerateFileResult`
- `CodeGenService`

Role:
- Builds a prompt from `filePath`, `purpose`, optional `referenceFiles`, optional `context`.
- Resolves a model from `ModelRegistry` (default tier `codegen`, overridable via `modelTier`).
- Invokes the model with `SystemMessage` + `HumanMessage`.
- Extracts code content and token usage (`extractTokenUsage` from `@dzupagent/core`).

### `codegen-run-engine.ts`
- `CodegenRunEngineConfig`
- `CodegenRunEngine`

Role:
- Entry point that prefers adapter execution when `adapter` is configured.
- Builds adapter input (prompt/systemPrompt/maxTurns/optional workingDirectory).
- Consumes adapter async events, derives final output from `adapter:completed`.
- Normalizes selected adapter events onto `DzupEventBus` when provided.
- Enforces terminal tool correlation with `requireTerminalToolExecutionRunId`.
- Falls back to `CodeGenService` when only `registry` is provided.

### `incremental-gen.ts`
- `CodeSection`
- `IncrementalChange`
- `IncrementalResult`
- `splitIntoSections(...)`
- `detectAffectedSections(...)`
- `applyIncrementalChanges(...)`
- `buildIncrementalPrompt(...)`

Role:
- Splits code into top-level sections using pattern-based detection.
- Detects candidate sections from token overlap in free-text change requests.
- Applies `add`/`replace`/`delete` changes in descending line order.
- Produces compact incremental prompts listing affected and unaffected sections.

### `test-generator.ts`
- `TestStrategy`, `TestFramework`, `TestGenConfig`
- `TestTarget`, `ExportInfo`, `TestSpec`, `TestCase`
- `determineTestStrategy(...)`
- `extractExports(...)`
- `buildTestPath(...)`
- `generateTestSpecs(...)`

Role:
- Selects test strategy from file-path conventions (`unit`, `integration`, `component`, `e2e`).
- Extracts exported symbols with regex (no AST dependency).
- Produces deterministic test-file paths.
- Builds structured test prompts and suggested case sets.

## Runtime and Control Flow
### Full generation via direct model path
```text
caller
  -> new CodeGenService(registry, { modelTier? })
  -> generateFile(params, systemPrompt)
    -> detectLanguage(filePath)
    -> build user prompt (purpose + optional refs/context)
    -> registry.getModel(modelTier || "codegen")
    -> model.invoke([SystemMessage, HumanMessage])
    -> normalize response content to string
    -> extractLargestCodeBlock(...)
    -> extractTokenUsage(...)
    -> return { content, source: "llm", tokensUsed, language }
```

### Full generation via adapter path
```text
caller
  -> new CodegenRunEngine({ adapter, eventBus?, workingDirectory?, maxTurns?, registry? })
  -> generateFile(params, systemPrompt)
    -> generateViaAdapter(...) when adapter exists
    -> adapter.execute(agentInput) async stream
    -> track active session/tool for correlation
    -> forward selected events to DzupEventBus (optional)
    -> on adapter:failed => throw
    -> on missing adapter:completed => throw
    -> extractLargestCodeBlock(completed.result)
    -> convert adapter usage to core TokenUsage
    -> return GenerateFileResult
```

Forwarded event mappings currently implemented:
- `adapter:started` -> `agent:started`
- `adapter:completed` -> `agent:completed`
- `adapter:failed` -> `agent:failed` (and `tool:error` when failure occurs during active tool execution)
- `adapter:stream_delta` -> `agent:stream_delta`
- `adapter:tool_call` -> `tool:called`
- `adapter:tool_result` -> `tool:result`
- `adapter:message` and `adapter:progress` are intentionally ignored.

### Engine fallback behavior
```text
CodegenRunEngine.generateFile(...)
  -> if adapter absent:
       use internal CodeGenService built from registry/modelTier
```

### Incremental editing helpers
```text
original content
  -> splitIntoSections
  -> detectAffectedSections(changeDescription)
  -> buildIncrementalPrompt(...)
  -> (external caller obtains new/changed section content)
  -> applyIncrementalChanges(...)
  -> updated content + change stats
```

### Test-spec generation helpers
```text
TestTarget[]
  -> determineTestStrategy(filePath)
  -> extractExports(content)
  -> generate suggested cases
  -> buildTestPath(filePath, config)
  -> build LLM prompt
  -> TestSpec[]
```

## Key APIs and Types
Generation exports are re-exported from `packages/codegen/src/index.ts`:

- `CodeGenService`
- `GenerateFileParams`, `GenerateFileResult`
- `CodegenRunEngine`
- `CodegenRunEngineConfig`
- `parseCodeBlocks`, `extractLargestCodeBlock`, `detectLanguage`
- `CodeBlock`
- `splitIntoSections`, `detectAffectedSections`, `applyIncrementalChanges`, `buildIncrementalPrompt`
- `CodeSection`, `IncrementalChange`, `IncrementalResult`
- `determineTestStrategy`, `extractExports`, `generateTestSpecs`, `buildTestPath`
- `TestStrategy`, `TestFramework`, `TestGenConfig`, `TestTarget`, `ExportInfo`, `TestSpec`, `TestCase`

Important behavioral contracts:
- `GenerateFileResult.source` is currently fixed to `'llm'`.
- `CodegenRunEngine` constructor requires at least one of `adapter` or `registry`.
- `CodegenRunEngine.usesAdapter` reflects whether adapter routing is active.

## Dependencies
Direct generation-subsystem dependencies:

- `@dzupagent/core`
  - `ModelRegistry`, `ModelTier`, `TokenUsage`, `DzupEventBus`
  - `extractTokenUsage`
  - `requireTerminalToolExecutionRunId`
- `@dzupagent/adapter-types`
  - `AgentCLIAdapter`, `AgentEvent`, and related adapter event payload types
- `@langchain/core/messages`
  - `SystemMessage`, `HumanMessage` for direct model invocation path

Package-level context from `packages/codegen/package.json`:
- Runtime dependencies include `@dzupagent/core` and `@dzupagent/adapter-types`.
- Peer dependencies include `@langchain/core`, `@langchain/langgraph`, and `zod` (generation code directly uses `@langchain/core`; `zod` is used by tools, not by files in `src/generation`).

## Integration Points
Current integration seams in the codebase:

- Public package export surface:
  - All generation APIs are exported through `packages/codegen/src/index.ts`.
- Tooling integration:
  - `packages/codegen/src/tools/generate-file.tool.ts` accepts a `CodeGenService` and exposes a LangChain tool named `generate_file`.
  - The tool maps `referenceCode` into `referenceFiles.reference` and returns JSON with content/language/source/token total.
- Adapter/orchestration integration:
  - `CodegenRunEngine` consumes `AgentCLIAdapter.execute(...)` streams and can emit normalized events to the shared event bus.
- Core model integration:
  - `CodeGenService` relies on `ModelRegistry.getModel(...)` and model `invoke(...)` compatibility.

## Testing and Observability
Generation-focused tests present in `packages/codegen/src/__tests__`:

- `code-block-parser.test.ts`
  - Covers markdown fence parsing, largest-block extraction, and extension-based language detection.
- `incremental-gen-and-test-generator.test.ts`
  - Covers section splitting/detection, incremental patch operations, prompt builder behavior, strategy selection, export extraction, path generation, and test-spec generation.
  - This file also contains unrelated `parallel-sampling` tests (VFS helpers), so it is mixed-scope.
- `codegen-run-engine.unit.test.ts`
  - Covers constructor guards, event mapping behavior, adapter input shaping, content extraction, error paths, and ignored adapter events.
- `codegen-run-engine.correlation.test.ts`
  - Covers `executionRunId` enforcement for `tool:result` and `tool:error` paths.
- `tools-suite.test.ts` (integration-adjacent)
  - Verifies `createGenerateFileTool` calls `CodeGenService.generateFile(...)` correctly and formats output JSON.

Observability currently available:
- `CodegenRunEngine` can emit lifecycle and tool events via `DzupEventBus`.
- Direct `CodeGenService` path does not emit events on its own.

Test/validation config context:
- `packages/codegen/vitest.config.ts` includes `src/**/*.test.ts` and `src/**/*.spec.ts`.
- Coverage thresholds are package-wide (statements 60, branches 50, functions 50, lines 60).

## Risks and TODOs
- Prompt-building duplication:
  - `CodeGenService.generateFile(...)` and `CodegenRunEngine` `buildUserMessage(...)` use near-identical prompt construction logic; drift risk exists.
- Fallback-path confidence:
  - `CodegenRunEngine` fallback behavior is implemented, but current dedicated tests primarily exercise adapter execution paths.
- Regex-only parsing limits:
  - `parseCodeBlocks` only matches fences with `\w*` language tags.
  - `splitIntoSections` and `extractExports` are heuristic and can miss complex syntax/forms.
- Incremental section matching quality:
  - `detectAffectedSections` relies on token/name overlap; semantic mismatches are possible for vague change descriptions.
- Event correlation strictness:
  - Tool terminal events intentionally fail when execution run ID cannot be resolved; this protects correctness but can hard-fail adapters with incomplete correlation metadata.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-26: rewritten from current local implementation in `packages/codegen/src/generation`, plus `packages/codegen/src/index.ts`, `packages/codegen/src/tools/generate-file.tool.ts`, `packages/codegen/package.json`, `packages/codegen/README.md`, and `packages/codegen/vitest.config.ts`.


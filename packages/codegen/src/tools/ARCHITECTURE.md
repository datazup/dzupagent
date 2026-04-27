# Tools Architecture (`packages/codegen/src/tools`)

## Scope
This document covers the `@dzupagent/codegen` tools layer implemented in:

- `src/tools/write-file.tool.ts`
- `src/tools/edit-file.tool.ts`
- `src/tools/multi-edit.tool.ts`
- `src/tools/generate-file.tool.ts`
- `src/tools/run-tests.tool.ts`
- `src/tools/validate.tool.ts`
- `src/tools/preview-app.tool.ts`
- `src/tools/lint-validator.ts`
- `src/tools/tool-context.ts`

Out of scope:

- Git tools in `src/git/*`
- Pipeline/guardrail orchestration in `src/pipeline/*` and `src/guardrails/*`
- Runtime tool resolution in `packages/server/src/runtime/tool-resolver.ts` (referenced only as an integration point)

## Responsibilities
The tools subsystem provides LangChain-compatible tool factories and lightweight lint helpers for codegen workflows.

Current responsibilities are:

- Define tool names, input schemas, and output contracts for file mutation/generation/validation/test/preview tasks.
- Bridge tool execution between in-memory `VirtualFS` and optional `Workspace` implementations (`CodegenToolContext`).
- Provide output normalization for model-facing loops (mostly JSON strings, with text summaries for edit tools).
- Offer low-cost syntax checking (`quickSyntaxCheck`) and optional sandboxed ESLint parsing with fallback (`sandboxLintCheck`).

## Structure
`src/tools` currently has three groups:

- File mutation tools:
  - `write_file`: metadata-first write intent, optionally workspace-backed writes.
  - `edit_file`: sequential search/replace edits in a single file.
  - `multi_edit`: batched search/replace edits across files.
- Execution/quality tools:
  - `generate_file`: delegates generation to `CodeGenService`.
  - `run_tests`: executes one command through `SandboxProtocol`.
  - `validate_feature`: delegates scoring to `QualityScorer`.
  - `preview_app`: runs a dev command in a session-based sandbox and exposes a URL.
- Shared types/utilities:
  - `CodegenToolContext` (`vfs?`, `workspace?`) in `tool-context.ts`.
  - `quickSyntaxCheck` and `sandboxLintCheck` in `lint-validator.ts`.

Implementation split between `tool(...)` and `DynamicStructuredTool`:

- Uses `tool(...)`: `write_file`, `generate_file`, `run_tests`, `validate_feature`.
- Uses `DynamicStructuredTool`: `edit_file`, `multi_edit`, `preview_app`.

`edit_file` and `multi_edit` explicitly use `DynamicStructuredTool` to avoid nested schema interop issues called out in source comments/tests.

## Runtime and Control Flow
### 1) `write_file`
- Input: `{ filePath, content }`.
- If `context.workspace` exists, writes immediately via `workspace.writeFile(...)`.
- Otherwise, returns a JSON payload describing a successful write intent; caller must apply state mutation externally.
- Output shape:
  - Success: `{ action: 'write_file', filePath, size, success: true }`
  - Error (workspace mode): `{ action: 'write_file', filePath, success: false, error }`

### 2) `edit_file`
- Input: `{ filePath, edits[] }`, each edit `{ oldText, newText, replaceAll? }`.
- Resolves runtime backend:
  - If passed `CodegenToolContext`, prefers `workspace`; otherwise uses `context.vfs`.
  - If passed `VirtualFS`, uses it directly.
- Reads file, applies edits sequentially, writes modified content back only if at least one edit succeeds.
- Returns plain text status (not JSON), including partial-failure summaries.

### 3) `multi_edit`
- Input: `{ fileEdits[] }`, each entry `{ filePath, edits[] }`.
- Reads and mutates only `VirtualFS` (no workspace branch).
- Skips missing files and keeps processing the rest.
- Commits pending writes after processing all entries.
- Returns plain text status with per-file outcomes.

### 4) `generate_file`
- Input: `{ filePath, purpose, referenceCode? }`.
- Calls `CodeGenService.generateFile(...)` with optional `referenceFiles.reference`.
- Returns JSON result with generated content and aggregate token count (`inputTokens + outputTokens`).

### 5) `run_tests`
- Input: `{ testCommand?, timeoutMs? }`.
- Checks `sandbox.isAvailable()` first.
- Executes command via `sandbox.execute(...)` (`npx vitest run --reporter=json` by default).
- Returns JSON with success flag, exit code, truncation-limited logs (`stdout` 5000 chars, `stderr` 2000 chars), and timeout marker.

### 6) `validate_feature`
- Input: `{ featureId, vfsSnapshot, context? }`.
- Casts optional context into `QualityContext` and delegates to `QualityScorer.evaluate(...)`.
- Returns JSON payload including `quality`, `success`, per-dimension outputs, errors, and warnings.
- Tool name is `validate_feature`; returned action string is `validate`.

### 7) `preview_app`
- Input: `{ command, port, timeoutMs?, sessionId? }`.
- Uses `SandboxProtocolV2`:
  - Start/reuse session.
  - Expose port.
  - Execute command via `executeStream(...)`.
- Health resolution:
  - First `stdout`/`stderr` event => `ready`.
  - `exit` event => `ready` on code 0, otherwise `error`.
  - stream exception => `error`.
  - no early signal can remain `starting`.
- Returns JSON: `{ sessionId, url, health, message? }`.

### 8) Lint utilities
- `quickSyntaxCheck(filePath, content)`:
  - Applies only to `ts/tsx/js/jsx/vue` extensions.
  - Tracks braces/brackets/parens plus string/template/comment states.
  - Returns `LintResult` with `LintError[]`.
- `sandboxLintCheck(filePath, content, sandbox)`:
  - Runs ESLint JSON via sandbox command.
  - Parses severity `>= 2` as errors.
  - Falls back to `quickSyntaxCheck` on sandbox/parse/no-message paths.

## Key APIs and Types
Tool factories:

- `createWriteFileTool(context?: CodegenToolContext)`
- `createEditFileTool(vfsOrContext: VirtualFS | CodegenToolContext)`
- `createMultiEditTool(vfs: VirtualFS)`
- `createGenerateFileTool(codeGenService: CodeGenService, defaultSystemPrompt: string)`
- `createRunTestsTool(sandbox: SandboxProtocol)`
- `createValidateTool(scorer: QualityScorer)`
- `createPreviewAppTool(sandbox: SandboxProtocolV2)`

Utility APIs:

- `quickSyntaxCheck(filePath: string, content: string): LintResult`
- `sandboxLintCheck(filePath: string, content: string, sandbox: SandboxProtocol): Promise<LintResult>`

Primary types in this folder:

- `CodegenToolContext` (`vfs?: VirtualFS`, `workspace?: Workspace`)
- `LintError`, `LintResult`
- `PreviewAppResult`

Export surface:

- Re-exported from `packages/codegen/src/index.ts` as part of `@dzupagent/codegen` package API.

## Dependencies
Direct package dependencies relevant to this subsystem:

- Runtime deps (`package.json`):
  - `@dzupagent/core`
  - `@dzupagent/adapter-types`
- Peer deps used by tool implementations:
  - `@langchain/core` (tool factories/types)
  - `zod` (schemas)

Internal codegen dependencies consumed by tool modules:

- `../vfs/virtual-fs.js`
- `../workspace/types.js`
- `../sandbox/sandbox-protocol.js`
- `../sandbox/sandbox-protocol-v2.js`
- `../generation/code-gen-service.js`
- `../quality/quality-scorer.js`
- `../quality/quality-types.js`

## Integration Points
Confirmed integrations in current repo:

- `packages/codegen/src/index.ts` exports all tool factories and related types.
- `packages/codegen/src/workspace/__tests__/workspace-integration.test.ts` validates workspace-backed `createWriteFileTool(...)` behavior end-to-end.
- `packages/codegen/src/ci/failure-router.ts` references tool names (`edit_file`, `run_tests`, `write_file`) in fix strategy suggestions.
- `packages/core/src/security/tool-permission-tiers.ts` classifies `write_file`, `edit_file`, `multi_edit`, and `generate_file` in default `log` tier.
- `packages/core/src/subagent/subagent-spawner.ts` only extracts file deltas from a narrow tool set (`write_file`, `edit_file`, `create_file`) and only from specific arg keys.
- `packages/server/src/runtime/tool-resolver.ts` currently auto-resolves git tools from `@dzupagent/codegen`; tools from `src/tools/*` are not auto-wired there.

Documentation alignment note:

- `packages/codegen/README.md` still describes some outdated signatures (`createWriteFileTool(vfs)`, `createValidateTool(sandbox)`), while current implementations use `createWriteFileTool(context?)` and `createValidateTool(scorer)`.

## Testing and Observability
Tests directly covering this subsystem include:

- `src/__tests__/tools-suite.test.ts`
- `src/__tests__/edit-file-tool.test.ts`
- `src/__tests__/multi-edit-tool.test.ts`
- `src/__tests__/validate-tool.test.ts`
- `src/__tests__/preview-app-tool.test.ts`
- `src/__tests__/lint-validator.test.ts`
- `src/__tests__/branch-coverage-edits.test.ts`
- `src/__tests__/branch-coverage-sandbox-lint.test.ts`

Coverage intent in tests:

- Core tool names and output payloads.
- Partial-success/failure behavior for edit tools.
- Workspace-backed branches (`write_file`, `edit_file`).
- `preview_app` session start/reuse/error and stream event branches.
- `sandboxLintCheck` parse-success and fallback branches.

Observability characteristics in implementation:

- Tools return explicit action/result payloads to calling orchestrators.
- `run_tests` includes bounded log snippets and `timedOut` signal.
- `preview_app` emits a coarse health state (`starting|ready|error`) and optional message.
- No direct metrics/tracing emission inside tool modules; telemetry is expected to be handled by higher-level runtime/event layers.

## Risks and TODOs
- `validate_feature` naming mismatch: tool name is `validate_feature`, but payload action is `validate`, and other packages commonly reference `validate` as a tool concept.
- File extraction mismatch risk in `SubAgentSpawner`: extractor only understands `{path|file_path|filePath}` + `{content|new_content|newContent}` patterns and does not parse `multi_edit` or `generate_file` result payloads.
- `multi_edit` is VFS-only while `write_file`/`edit_file` can run with `Workspace`; mixed usage can create inconsistent write paths in workspace-first flows.
- `preview_app` readiness heuristic is event-first (first `stdout`/`stderr` => ready) rather than protocol-level health probing; false-ready states are possible for noisy startup logs.
- `sandboxLintCheck` shells content through `echo ${JSON.stringify(content)}`; very large content and shell quoting/size edge cases are still command-shape sensitive.
- Documentation drift remains in package README tool signatures and should be updated to match current code.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js


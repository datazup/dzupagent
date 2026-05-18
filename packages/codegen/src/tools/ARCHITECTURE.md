# Tools Architecture (`packages/codegen/src/tools`)

## Scope
This document describes the tool modules implemented under `packages/codegen/src/tools`:

- `write-file.tool.ts`
- `edit-file.tool.ts`
- `multi-edit.tool.ts`
- `generate-file.tool.ts`
- `run-tests.tool.ts`
- `validate.tool.ts`
- `preview-app.tool.ts`
- `lint-validator.ts`
- `tool-context.ts`

It also references how these modules are exported through:

- `packages/codegen/src/index.ts` (root package API)
- `packages/codegen/src/tools.ts` (`@dzupagent/codegen/tools` facade)

Out of scope:

- Git tooling in `packages/codegen/src/git/*`
- Workspace implementation details in `packages/codegen/src/workspace/*`
- Runtime tool resolution and activation in `packages/server/src/runtime/tool-resolver.ts`

## Responsibilities
The tools layer provides LangChain-compatible tool factories for common codegen actions plus lightweight lint validation helpers.

Current responsibilities:

- Define stable tool names, input schemas, and return payloads for file writing/editing, generation, test execution, validation, and preview.
- Bridge file operations across `VirtualFS` and optional `Workspace` via `CodegenToolContext`.
- Apply write-permission fail-fast checks for workspace-aware write tools when `permissionTier` is provided.
- Return model-consumable outputs:
  - JSON string payloads for `write_file`, `generate_file`, `run_tests`, `validate_feature`, and `preview_app`.
  - Human-readable text summaries for `edit_file` and `multi_edit`.
- Provide two lint checks:
  - `quickSyntaxCheck` (local delimiter/string/comment scanner for JS/TS/Vue-family files)
  - `sandboxLintCheck` (sandbox ESLint JSON parse, with fallback to `quickSyntaxCheck`)

## Structure
`src/tools` is organized as follows:

- File mutation tools:
  - `createWriteFileTool` (`write_file`)
  - `createEditFileTool` (`edit_file`)
  - `createMultiEditTool` (`multi_edit`)
- Generation/validation/execution tools:
  - `createGenerateFileTool` (`generate_file`)
  - `createRunTestsTool` (`run_tests`)
  - `createValidateTool` (`validate_feature`)
  - `createPreviewAppTool` (`preview_app`)
- Shared tool context and lint utilities:
  - `CodegenToolContext` (`vfs?`, `workspace?`, `permissionTier?`)
  - `quickSyntaxCheck`, `sandboxLintCheck`, `LintError`, `LintResult`

Tool-construction style in current code:

- Uses `tool(...)` from `@langchain/core/tools`:
  - `write-file.tool.ts`
  - `generate-file.tool.ts`
  - `run-tests.tool.ts`
  - `validate.tool.ts`
- Uses `DynamicStructuredTool`:
  - `edit-file.tool.ts`
  - `multi-edit.tool.ts`
  - `preview-app.tool.ts`

## Runtime and Control Flow
1. `write_file` (`createWriteFileTool`)
- Optional issuance guard: when `context.permissionTier` exists, `assertTierAllowsWrite` runs before tool construction.
- Invocation input: `{ filePath, content }`.
- If `context.workspace` exists, the tool writes immediately with `workspace.writeFile`.
- On workspace write success/failure, returns JSON payload with `success` and optional `error`.
- Without workspace, returns JSON write intent only; caller must apply the state mutation separately.

2. `edit_file` (`createEditFileTool`)
- Accepts either `VirtualFS` or `CodegenToolContext`.
- For `CodegenToolContext`, it prefers `workspace`; otherwise falls back to `context.vfs`.
- Optional issuance guard for context mode: `assertTierAllowsWrite(permissionTier, 'edit_file')`.
- Reads target file, applies edits sequentially, and writes back only if at least one edit succeeded.
- `replaceAll` toggles global replacement; otherwise only first match is replaced.
- Returns text summaries, including partial-failure and all-failed cases.
- If workspace read throws `WorkspacePathSecurityError`, returns that explicit error text rather than masking it as not found.

3. `multi_edit` (`createMultiEditTool`)
- Works on `VirtualFS` only.
- Input: `{ fileEdits: [{ filePath, edits: [{ oldText, newText }] }] }`.
- Each file is processed independently:
  - missing file => skipped
  - matching edits => staged in `pending`
- Writes staged changes after processing all file entries.
- Returns text summary with per-file results and counts.

4. `generate_file` (`createGenerateFileTool`)
- Input: `{ filePath, purpose, referenceCode? }`.
- Delegates to `CodeGenService.generateFile(...)`, passing optional `referenceFiles.reference`.
- Returns JSON payload with generated content metadata:
  - `action`, `filePath`, `content`, `language`, `source`, `tokensUsed`
  - `tokensUsed` is `inputTokens + outputTokens`.

5. `run_tests` (`createRunTestsTool`)
- Checks `sandbox.isAvailable()` first.
- If unavailable, returns JSON error payload without execution.
- Executes command through `SandboxProtocol.execute` with default:
  - `npx vitest run --reporter=json`
  - default timeout `60000`.
- Returns JSON payload including `exitCode`, `timedOut`, and truncated logs (`stdout` max 5000 chars, `stderr` max 2000 chars).

6. `validate_feature` (`createValidateTool`)
- Input: `{ featureId, vfsSnapshot, context? }`.
- Casts optional `context` to `QualityContext`.
- Delegates to `QualityScorer.evaluate(vfsSnapshot, qualityContext)`.
- Returns JSON payload with `quality`, `success`, `dimensions`, `errors`, and `warnings`.
- Tool name is `validate_feature`; result payload action is `validate`.

7. `preview_app` (`createPreviewAppTool`)
- Input: `{ command, port, timeoutMs?, sessionId? }`.
- Uses `SandboxProtocolV2` flow:
  - start or reuse session
  - expose port
  - stream command execution through `executeStream`
- Health mapping:
  - first `stdout` or `stderr` => `ready`
  - `exit` with `0` => `ready`
  - `exit` non-zero or thrown exception => `error`
  - no early event before timeout window can remain `starting`
- Returns JSON payload: `{ sessionId, url, health, message? }`.

8. Lint validators
- `quickSyntaxCheck(filePath, content)`:
  - Active only for `ts`, `tsx`, `js`, `jsx`, `vue`.
  - Tracks braces, brackets, parens, string/template states, and comment states.
  - Returns `{ valid, errors }`.
- `sandboxLintCheck(filePath, content, sandbox)`:
  - Executes ESLint JSON via sandbox command.
  - Converts messages with `severity >= 2` to `LintError[]`.
  - Falls back to `quickSyntaxCheck` when sandbox execution or JSON parsing is not usable.

## Key APIs and Types
Primary factories and helpers:

- `createWriteFileTool(context?: CodegenToolContext)`
- `createEditFileTool(vfsOrContext: VirtualFS | CodegenToolContext)`
- `createMultiEditTool(vfs: VirtualFS)`
- `createGenerateFileTool(codeGenService: CodeGenService, defaultSystemPrompt: string)`
- `createRunTestsTool(sandbox: SandboxProtocol)`
- `createValidateTool(scorer: QualityScorer)`
- `createPreviewAppTool(sandbox: SandboxProtocolV2)`
- `quickSyntaxCheck(filePath: string, content: string): LintResult`
- `sandboxLintCheck(filePath: string, content: string, sandbox: SandboxProtocol): Promise<LintResult>`

Core local types:

- `CodegenToolContext`
  - `vfs?: VirtualFS`
  - `workspace?: Workspace`
  - `permissionTier?: PermissionTier`
- `LintError`, `LintResult`
- `PreviewAppResult`

Public export entrypoints:

- Root API: `packages/codegen/src/index.ts` exports all of the above.
- Subpath API: `packages/codegen/src/tools.ts` re-exports `src/tools/*` plus git/workspace/PTC surfaces for `@dzupagent/codegen/tools`.
- Package export map (`package.json`) exposes `./tools` -> `dist/tools.js`.

## Dependencies
External dependencies used directly by `src/tools/*`:

- `@langchain/core/tools` (`tool`, `DynamicStructuredTool`)
- `zod` (tool input schema definitions)

Internal dependencies used directly by `src/tools/*`:

- `../vfs/virtual-fs.js`
- `../workspace/types.js`
- `../generation/code-gen-service.js`
- `../quality/quality-scorer.js`
- `../quality/quality-types.js`
- `../sandbox/sandbox-protocol.js`
- `../sandbox/sandbox-protocol-v2.js`
- `../sandbox/permission-tiers.js`

Package-level context (`packages/codegen/package.json`):

- Runtime deps: `@dzupagent/core`, `@dzupagent/adapter-types`
- Peer deps relevant to tools API: `@langchain/core`, `zod`

## Integration Points
Documented and code-confirmed integration points:

- `packages/codegen/src/index.ts` exports tool factories/types in the root `@dzupagent/codegen` API.
- `packages/codegen/src/tools.ts` exports these tool modules as part of `@dzupagent/codegen/tools`.
- `packages/codegen/src/ci/failure-router.ts` recommends `edit_file`, `write_file`, and `run_tests` in failure strategies.
- `packages/core/src/security/tool-permission-tiers.ts` classifies `write_file`, `edit_file`, `multi_edit`, and `generate_file` in `DEFAULT_LOG_TOOLS`.
- `packages/core/src/subagent/subagent-spawner.ts` only extracts file changes for `write_file`, `edit_file`, and `create_file` from tool-call args.
- `packages/server/src/runtime/tool-resolver.ts` dynamically resolves git/connectors/MCP tools; it does not auto-register `src/tools/*` codegen tools directly.
- `packages/codegen/README.md` currently contains stale signatures for tool factories (`createWriteFileTool(vfs)`, `createValidateTool(sandbox)`), while code uses `createWriteFileTool(context?)` and `createValidateTool(scorer)`.

## Testing and Observability
Direct test coverage for the tools layer includes:

- `src/__tests__/tools-suite.test.ts`
- `src/__tests__/edit-file-tool.test.ts`
- `src/__tests__/multi-edit-tool.test.ts`
- `src/__tests__/preview-app-tool.test.ts`
- `src/__tests__/validate-tool.test.ts`
- `src/__tests__/lint-validator.test.ts`
- `src/__tests__/branch-coverage-edits.test.ts`
- `src/__tests__/branch-coverage-sandbox-lint.test.ts`
- `src/workspace/__tests__/workspace-integration.test.ts` (workspace-backed write path integration)

Observed behavior from implementation/tests:

- `edit_file` and `multi_edit` tests call `_call(...)` directly as a workaround for nested-schema interop issues noted in comments.
- `run_tests` explicitly verifies output truncation and sandbox availability handling.
- `preview_app` covers session reuse, expose-port failures, stream event branches, and stream exceptions.
- `sandboxLintCheck` covers clean ESLint output, severity filtering, and all fallback paths.

Observability characteristics:

- Tools communicate outcomes through structured return payloads (or deterministic text summaries for edit tools).
- `run_tests` and `preview_app` include runtime-state details (`exitCode`, `timedOut`, `health`, `message`) suitable for higher-level event logging.
- No direct metrics/tracing emission exists inside `src/tools/*`; telemetry is expected from orchestration/runtime layers.

## Risks and TODOs
- Tool/action naming drift: `validate_feature` tool returns `action: "validate"` in payload.
- Output-shape divergence: file edit tools return text, while most others return JSON strings; downstream parsers must branch by tool.
- `multi_edit` only supports `VirtualFS`, while `write_file`/`edit_file` support workspace-backed execution, creating mixed behavior in workspace-first flows.
- `SubAgentSpawner` file extraction remains limited to argument shapes for `write_file`/`edit_file`/`create_file`; it does not parse `multi_edit` or `generate_file` result payloads.
- `preview_app` readiness is based on first stream event or exit status, not on explicit HTTP health probing.
- `sandboxLintCheck` shells code through `echo ${JSON.stringify(content)}`; very large payloads and shell-escaping edges remain possible.
- `createWriteFileTool`/`createEditFileTool` enforce permission tiers at tool construction, but there is no dedicated test in `src/__tests__` that asserts the throw path for read-only tiers.
- `packages/codegen/README.md` tool API section is out of sync with current signatures.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js


# Tools Architecture (`packages/codegen/src/tools`)

This document describes the architecture of the codegen tools layer, including feature inventory, behavior flow, practical usage examples, in-repo and cross-package references, and current test coverage.

## 1. Scope

Folder contents:

- `edit-file.tool.ts`
- `generate-file.tool.ts`
- `lint-validator.ts`
- `multi-edit.tool.ts`
- `preview-app.tool.ts`
- `run-tests.tool.ts`
- `validate.tool.ts`
- `write-file.tool.ts`

Primary responsibilities:

- expose LangChain-compatible tool factories for file generation/editing/validation/testing/preview workflows,
- define tool input contracts (Zod schemas) and normalized JSON string outputs,
- provide lightweight lint validation utilities (`quickSyntaxCheck`, `sandboxLintCheck`).

## 2. Module Inventory

## 2.1 `write-file.tool.ts`

Factory:

- `createWriteFileTool()`

Tool name:

- `write_file`

Behavior:

- returns serialized metadata (`action`, `filePath`, `size`, `success`) for a write intent,
- does not mutate `VirtualFS` directly.

Key detail:

- callers must apply the write to state themselves after parsing tool output.

## 2.2 `edit-file.tool.ts`

Factory:

- `createEditFileTool(vfs: VirtualFS)`

Tool name:

- `edit_file`

Behavior:

- applies one or more sequential search/replace edits in a single file,
- supports `replaceAll` per edit,
- reports complete success, partial success, or full failure textually.

Implementation note:

- implemented via `DynamicStructuredTool` due nested schema reliability concerns in `tool()` helper.

## 2.3 `multi-edit.tool.ts`

Factory:

- `createMultiEditTool(vfs: VirtualFS)`

Tool name:

- `multi_edit`

Behavior:

- applies batched edits across multiple files (`fileEdits[]`),
- skips missing files without aborting the batch,
- commits only files with at least one successful replacement.

## 2.4 `generate-file.tool.ts`

Factory:

- `createGenerateFileTool(codeGenService: CodeGenService, defaultSystemPrompt: string)`

Tool name:

- `generate_file`

Behavior:

- delegates generation to `CodeGenService.generateFile(...)`,
- forwards file path, purpose, and optional reference code,
- returns generated content, language, source, and aggregate token usage.

## 2.5 `run-tests.tool.ts`

Factory:

- `createRunTestsTool(sandbox: SandboxProtocol)`

Tool name:

- `run_tests`

Behavior:

- checks sandbox availability first,
- executes test command in sandbox,
- truncates output payload (`stdout` to 5000 chars, `stderr` to 2000 chars),
- returns success from `exitCode === 0`.

## 2.6 `validate.tool.ts`

Factory:

- `createValidateTool(scorer: QualityScorer)`

Tool name:

- `validate_feature`

Behavior:

- executes `QualityScorer.evaluate(vfsSnapshot, context)`,
- returns quality score, dimension results, errors, and warnings.

## 2.7 `preview-app.tool.ts`

Factory:

- `createPreviewAppTool(sandbox: SandboxProtocolV2)`

Tool name:

- `preview_app`

Behavior:

- starts or reuses a long-lived sandbox session,
- exposes a requested port,
- streams startup command events (`stdout`/`stderr`/`exit`) to infer health,
- returns `{ sessionId, url, health, message? }`.

## 2.8 `lint-validator.ts`

Utilities:

- `quickSyntaxCheck(filePath, content): LintResult`
- `sandboxLintCheck(filePath, content, sandbox): Promise<LintResult>`

Behavior:

- `quickSyntaxCheck`: lightweight delimiter/comment/string aware checker for JS/TS/Vue family files,
- `sandboxLintCheck`: attempts sandboxed ESLint JSON parse and falls back to `quickSyntaxCheck` on failures.

## 3. End-to-End Flow

## 3.1 File change intent flow (`write_file`/`edit_file`/`multi_edit`)

```text
Agent/tool call
  -> tool schema validation
  -> tool logic (VFS read/transform or metadata packaging)
  -> JSON/text result to orchestrator
  -> orchestrator applies resulting state updates (if applicable)
```

Notes:

- `write_file` is metadata-first (no direct write).
- `edit_file` and `multi_edit` mutate `VirtualFS` internally for successful edits.

## 3.2 Generation flow (`generate_file`)

```text
generate_file tool call
  -> CodeGenService.generateFile(params, systemPrompt)
     -> ModelRegistry model invocation
     -> code block extraction
     -> token usage extraction
  -> tool returns JSON result with content/language/source/tokensUsed
```

## 3.3 Validation and test loop (`validate_feature` + `run_tests`)

```text
validate_feature
  -> QualityScorer.evaluate(vfsSnapshot, context)
  -> quality payload (score + dimensions + diagnostics)

run_tests
  -> sandbox availability check
  -> sandbox.execute(testCommand)
  -> output truncation + pass/fail projection
```

## 3.4 Live preview flow (`preview_app`)

```text
preview_app
  -> startSession (or reuse sessionId)
  -> exposePort
  -> executeStream(command)
     -> first stdout/stderr => health=ready
     -> exit(0)            => ready
     -> exit(!0)           => error
  -> return URL + health
```

## 4. Feature Catalog

## 4.1 Contract-first tool interfaces

- every tool defines a strict Zod schema,
- tool outputs are normalized into machine-parseable JSON strings (except edit tools, which return structured human-readable status text).

## 4.2 Batched file editing with partial failure tolerance

- both edit tools continue processing independent edits after failures,
- users/agents receive explicit failure summaries per edit or file.

## 4.3 Sandboxed execution safeguards

- `run_tests` blocks execution if sandbox is unavailable,
- output is bounded to reduce token and log bloat,
- `preview_app` isolates dev servers in session-based sandboxes.

## 4.4 Quality gate abstraction

- `validate_feature` is scorer-driven and dimension-extensible through `QualityScorer`.

## 4.5 Lightweight lint fallback

- `sandboxLintCheck` gracefully degrades to zero-dependency syntax checks when ESLint execution/parsing fails.

## 5. Usage Examples

## 5.1 `write_file` plus external state application

```ts
import { createWriteFileTool, VirtualFS } from '@dzupagent/codegen'

const vfs = new VirtualFS()
const writeTool = createWriteFileTool()

const raw = await writeTool.invoke({
  filePath: 'src/hello.ts',
  content: 'export const hello = "world"\n',
})

const result = JSON.parse(String(raw))
if (result.success) {
  // Tool only returns metadata; caller applies state.
  vfs.write(result.filePath, 'export const hello = "world"\n')
}
```

## 5.2 `edit_file` targeted mutation

```ts
import { VirtualFS, createEditFileTool } from '@dzupagent/codegen'

const vfs = new VirtualFS({ 'src/app.ts': 'const port = 3000\n' })
const editTool = createEditFileTool(vfs)

await editTool.invoke({
  filePath: 'src/app.ts',
  edits: [{ oldText: '3000', newText: '8080' }],
})
```

## 5.3 `multi_edit` cross-file batch update

```ts
import { VirtualFS, createMultiEditTool } from '@dzupagent/codegen'

const vfs = new VirtualFS({
  'src/a.ts': 'export const A = 1\n',
  'src/b.ts': 'export const B = 1\n',
})

const multi = createMultiEditTool(vfs)
await multi.invoke({
  fileEdits: [
    { filePath: 'src/a.ts', edits: [{ oldText: '1', newText: '2' }] },
    { filePath: 'src/b.ts', edits: [{ oldText: '1', newText: '2' }] },
  ],
})
```

## 5.4 `generate_file` with reference code

```ts
import { createGenerateFileTool, CodeGenService } from '@dzupagent/codegen'

const tool = createGenerateFileTool(codeGenService as CodeGenService, 'You are a strict TS generator.')

const raw = await tool.invoke({
  filePath: 'src/routes/users.ts',
  purpose: 'HTTP routes for users CRUD',
  referenceCode: 'export type User = { id: string }',
})

const generated = JSON.parse(String(raw))
console.log(generated.content)
```

## 5.5 `run_tests` in sandbox

```ts
import { createRunTestsTool } from '@dzupagent/codegen'

const runTests = createRunTestsTool(sandbox)
const raw = await runTests.invoke({
  testCommand: 'yarn test --runInBand',
  timeoutMs: 90_000,
})

const result = JSON.parse(String(raw))
console.log(result.success, result.exitCode)
```

## 5.6 `validate_feature` against snapshot

```ts
import { createValidateTool, QualityScorer } from '@dzupagent/codegen'

const scorer = new QualityScorer()
const validate = createValidateTool(scorer)

const raw = await validate.invoke({
  featureId: 'feat-auth-01',
  vfsSnapshot: { 'src/auth.ts': 'export const login = () => true' },
  context: { techStack: { runtime: 'node' } },
})

const quality = JSON.parse(String(raw))
console.log(quality.quality, quality.success)
```

## 5.7 `preview_app` for dev-server URL

```ts
import { createPreviewAppTool } from '@dzupagent/codegen'

const preview = createPreviewAppTool(sandboxV2)
const raw = await preview.invoke({
  command: 'npm run dev',
  port: 3000,
  timeoutMs: 30_000,
})

const result = JSON.parse(String(raw))
console.log(result.url, result.health)
```

## 6. Typical Use Cases

1. Agentic code patching loop: `edit_file`/`multi_edit` for focused deltas instead of full rewrites.
2. Scaffold-and-refine workflow: `generate_file` creates baseline implementation, then edit tools apply corrections.
3. Quality gate in CI-like loops: `run_tests` + `validate_feature` before commit or merge proposals.
4. Live app demo from generated code: `preview_app` launches isolated dev server and returns a shareable URL.
5. Fast local safety checks: `quickSyntaxCheck` in pre-flight validations where full ESLint is unavailable.

## 7. In-Repo References

## 7.1 Primary internal references (`@dzupagent/codegen`)

- Public exports: `packages/codegen/src/index.ts` exports all tool factories and lint helpers.
- Tests:
  - `packages/codegen/src/__tests__/tools-suite.test.ts`
  - `packages/codegen/src/__tests__/edit-file-tool.test.ts`
  - `packages/codegen/src/__tests__/multi-edit-tool.test.ts`
  - `packages/codegen/src/__tests__/validate-tool.test.ts`
  - `packages/codegen/src/__tests__/preview-app-tool.test.ts`
  - `packages/codegen/src/__tests__/lint-validator.test.ts`
- Documentation references:
  - `packages/codegen/README.md` tools list
  - `packages/codegen/src/streaming/ARCHITECTURE.md` preview flow
  - `packages/codegen/src/ci/failure-router.ts` uses tool names in strategy hints (`edit_file`, `write_file`, `run_tests`)

## 7.2 Cross-package references and usage semantics

`@dzupagent/core`:

- `packages/core/src/subagent/subagent-spawner.ts` interprets tool-call payloads by tool name:
  - write-like tools (`write_file`, `generate_file`, etc.) are treated as content-bearing tool calls for file extraction,
  - edit-like tools (`edit_file`, `multi_edit`) are replayed as search/replace operations against parent files.
- `packages/core/src/security/tool-permission-tiers.ts` classifies tool names (`write_file`, `edit_file`, `multi_edit`, `generate_file`) into the log tier.

`@dzupagent/agent`:

- `packages/agent/src/templates/agent-templates.ts` includes tool names in suggested profiles (for example code generator/refactoring/test writer paths use `write_file`, `edit_file`, `run_tests`).

`@dzupagent/server`:

- `packages/server/src/runtime/tool-resolver.ts` currently resolves codegen package integration for git tools only (`createGitTools` + `GitExecutor`); this tools folder is not directly auto-wired there today.

## 8. Test Coverage

## 8.1 Executed validation commands

Executed in this analysis:

```bash
yarn workspace @dzupagent/codegen test \
  src/__tests__/tools-suite.test.ts \
  src/__tests__/edit-file-tool.test.ts \
  src/__tests__/multi-edit-tool.test.ts \
  src/__tests__/lint-validator.test.ts \
  src/__tests__/validate-tool.test.ts \
  src/__tests__/preview-app-tool.test.ts
```

Result:

- 6 test files passed
- 51 tests passed

Coverage command executed:

```bash
yarn workspace @dzupagent/codegen test:coverage -- \
  src/__tests__/tools-suite.test.ts \
  src/__tests__/edit-file-tool.test.ts \
  src/__tests__/multi-edit-tool.test.ts \
  src/__tests__/lint-validator.test.ts \
  src/__tests__/validate-tool.test.ts \
  src/__tests__/preview-app-tool.test.ts
```

Notes:

- tests passed,
- command exited non-zero because package-wide global coverage thresholds apply to the whole package while only tool-focused tests were run.

## 8.2 File-level coverage (`src/tools/*`)

From `packages/codegen/coverage/coverage-summary.json`:

- `edit-file.tool.ts`: lines 98.73%, branches 94.44%, functions 100%, statements 98.73%
- `generate-file.tool.ts`: lines 100%, branches 100%, functions 100%, statements 100%
- `lint-validator.ts`: lines 75.18%, branches 92.98%, functions 50%, statements 75.18%
- `multi-edit.tool.ts`: lines 98.8%, branches 94.11%, functions 100%, statements 98.8%
- `preview-app.tool.ts`: lines 94.32%, branches 82.6%, functions 100%, statements 94.32%
- `run-tests.tool.ts`: lines 100%, branches 100%, functions 100%, statements 100%
- `validate.tool.ts`: lines 100%, branches 100%, functions 100%, statements 100%
- `write-file.tool.ts`: lines 100%, branches 100%, functions 100%, statements 100%

## 8.3 Behavioral coverage map

- `write-file`: metadata payload shape, size accounting, path handling.
- `run-tests`: availability guard, default/custom command, pass/fail/timeout, output truncation.
- `generate-file`: argument forwarding, reference code pass-through, token aggregation, response shape.
- `edit-file`: sequential edits, missing file handling, partial failures, `replaceAll`.
- `multi-edit`: multi-file operations, partial failures, missing files, all-fail path.
- `validate-feature`: scorer invocation and result mapping.
- `preview-app`: session lifecycle, reuse path, startup failures, port exposure failures, stream event variants, thrown stream errors.
- `quickSyntaxCheck`: delimiter mismatch, comment/string/template handling, extension gating.

## 8.4 Remaining gaps

1. `sandboxLintCheck(...)` is effectively untested in this suite (`lint-validator.ts` uncovered lines 104-137).
2. `preview_app` timeout branch without emitted stream events remains partially uncovered (uncovered lines 122-129).
3. Long-preview truncation branches in edit tools are minimally covered (`edit-file.tool.ts` and `multi-edit.tool.ts` uncovered preview-truncation lines).

## 9. Integration Observations and Risks

1. Tool-name drift:
- `validate.tool.ts` registers `validate_feature`, while broader ecosystem references commonly mention `validate`.

2. Payload-shape mismatch risk for `multi_edit` with cross-package extraction:
- codegen tool input shape is `fileEdits[]`,
- `SubAgentSpawner` edit extraction logic currently expects top-level `filePath` + `edits`.

3. `generate_file` extraction assumption mismatch:
- `SubAgentSpawner` treats `generate_file` as a write-like tool expecting content in args,
- current `generate_file` tool returns generated content in result JSON, not in input args.

4. Documentation drift in package README:
- README still documents `createWriteFileTool(vfs)` and `createValidateTool(sandbox)`,
- current signatures are `createWriteFileTool()` and `createValidateTool(scorer)`.

These items are not blockers for isolated tool usage, but they are important for end-to-end agent orchestration consistency across packages.

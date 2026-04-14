# Generation Architecture (`packages/codegen/src/generation`)

This document describes the architecture of the generation subsystem in `@dzupagent/codegen`, including feature inventory, runtime flow, usage examples, real in-repo references, and test coverage status.

## 1. Scope

Folder contents:

- `code-block-parser.ts`
- `code-gen-service.ts`
- `codegen-run-engine.ts`
- `incremental-gen.ts`
- `test-generator.ts`

Primary responsibilities:

- Parse and normalize LLM code output (`code-block-parser.ts`).
- Generate full files via model invocation (`code-gen-service.ts`).
- Route generation through adapter policy or fallback direct model calls (`codegen-run-engine.ts`).
- Support section-based incremental edits (`incremental-gen.ts`).
- Generate test specifications/prompts from source exports (`test-generator.ts`).

## 2. Module Topology

## 2.1 `code-block-parser.ts` (response normalization utilities)

Public API:

- `parseCodeBlocks(text): CodeBlock[]`
- `extractLargestCodeBlock(text): string`
- `detectLanguage(filePath): string`

Role:

- Extract fenced markdown code blocks.
- Pick the largest block as final code payload.
- Infer prompt language tag from file extension.

## 2.2 `code-gen-service.ts` (direct model generation)

Public API:

- `CodeGenService`
- `GenerateFileParams`
- `GenerateFileResult`

Role:

- Build user/system prompt payload for a target file.
- Invoke model via `ModelRegistry`.
- Normalize response with `extractLargestCodeBlock`.
- Return generated content + token usage.

## 2.3 `codegen-run-engine.ts` (adapter-aware orchestration)

Public API:

- `CodegenRunEngine`
- `CodegenRunEngineConfig`

Role:

- Preferred entry-point when adapter-level controls are needed.
- Uses `AgentCLIAdapter.execute(...)` when adapter is configured.
- Falls back to `CodeGenService` when only `ModelRegistry` is available.
- Optionally forwards adapter events to `DzupEventBus` in normalized form.

## 2.4 `incremental-gen.ts` (section-level edit planning/apply)

Public API:

- `splitIntoSections`
- `detectAffectedSections`
- `applyIncrementalChanges`
- `buildIncrementalPrompt`

Role:

- Heuristically split file into imports/functions/classes/interfaces/types/const sections.
- Detect likely impacted sections from free-text change description.
- Apply add/replace/delete edits while preserving unaffected lines.
- Build focused prompt containing only affected sections and an unchanged-section list.

## 2.5 `test-generator.ts` (test spec generation)

Public API:

- `determineTestStrategy`
- `extractExports`
- `buildTestPath`
- `generateTestSpecs`

Role:

- Infer test strategy (`unit`, `integration`, `component`, `e2e`) from path conventions.
- Extract exported symbols with regex.
- Build deterministic test file path.
- Produce LLM test prompts and suggested test case matrix.

## 3. End-to-End Flows

## 3.1 Full-file generation flow (direct path)

```text
caller
  -> CodeGenService.generateFile(params, systemPrompt)
      -> detectLanguage(filePath)
      -> build user prompt (+ reference files + context)
      -> modelRegistry.getModel(tier)
      -> model.invoke([SystemMessage, HumanMessage])
      -> extractLargestCodeBlock(response)
      -> extractTokenUsage(response)
      -> return { content, language, source: 'llm', tokensUsed }
```

## 3.2 Full-file generation flow (adapter path)

```text
caller
  -> CodegenRunEngine.generateFile(params, systemPrompt)
      -> adapter exists? yes
      -> buildUserMessage(params)
      -> adapter.execute(agentInput) [async event stream]
      -> capture adapter:completed or adapter:failed
      -> forward adapter events to DzupEventBus (optional)
      -> extractLargestCodeBlock(completed.result)
      -> map adapter usage -> core TokenUsage
      -> return GenerateFileResult

fallback path:
  -> no adapter
  -> CodeGenService.generateFile(...)
```

## 3.3 Incremental generation flow

```text
original file content
  -> splitIntoSections()
  -> detectAffectedSections(changeDescription)
  -> buildIncrementalPrompt(...)
  -> (external LLM step returns changed section text)
  -> applyIncrementalChanges(original, changes)
  -> updated full content + change stats
```

## 3.4 Test spec flow

```text
source file path + content
  -> extractExports(content)
  -> determineTestStrategy(filePath, content)
  -> generateTestCases(exports, strategy)
  -> buildTestPath(filePath)
  -> buildTestPrompt(...)
  -> TestSpec { prompt, testCases, strategy, testFilePath }
```

## 4. Feature Catalog

## 4.1 Markdown code-block extraction

Description:

- Parses fenced code blocks using regex and returns all blocks.
- Useful when model responses include prose plus code.

Behavior:

- If blocks exist, `extractLargestCodeBlock` chooses the largest block by content length.
- If no blocks exist, returns trimmed raw response.

## 4.2 Language inference for prompting

Description:

- Extension-to-language mapping for prompt tagging (`.ts -> typescript`, `.py -> python`, etc.).

Behavior:

- Unknown extensions default to `'text'`.

## 4.3 Prompt assembly with references/context

Description:

- `CodeGenService` and `CodegenRunEngine` use equivalent user prompt structure:
  - file path
  - purpose
  - inferred language
  - optional embedded reference files
  - optional key/value context

Benefit:

- Keeps adapter and fallback paths aligned in prompt semantics.

## 4.4 Adapter policy bridge and normalized events

Description:

- `CodegenRunEngine` can route requests through adapter execution lifecycle.

Forwarded events:

- `adapter:started -> agent:started`
- `adapter:completed -> agent:completed`
- `adapter:failed -> agent:failed`
- `adapter:stream_delta -> agent:stream_delta`
- `adapter:tool_call -> tool:called`
- `adapter:tool_result -> tool:result`

Benefit:

- Enables provider policy/telemetry/routing without changing generation call sites.

## 4.5 Incremental section heuristics

Description:

- Regex classifier recognizes imports/functions/classes/interfaces/types/const/enum.
- Consecutive imports are merged into one logical section.

Benefit:

- Avoids full-file regeneration for localized changes.

## 4.6 Change impact detection

Description:

- Token-overlap matching between change description and section names.
- Auto-includes imports when any non-import section is affected.

Benefit:

- Keeps prompts smaller while preserving likely dependency edits.

## 4.7 Structured incremental patch application

Description:

- Applies add/replace/delete operations sorted by descending line position.
- Tracks changed vs preserved line counts.

Benefit:

- Stable splice behavior even when multiple edits are applied in one pass.

## 4.8 Test-spec generation for LLM-driven test authoring

Description:

- Produces strategy + test cases + source-backed prompt, not final executable tests.

Includes:

- function/class/const-focused test suggestions
- integration-specific HTTP-style cases
- optional TDD mode instruction

## 5. Usage Examples

## 5.1 Direct full-file generation

```ts
import { CodeGenService } from '@dzupagent/codegen'
import type { ModelRegistry } from '@dzupagent/core'

const service = new CodeGenService(registry as ModelRegistry, { modelTier: 'codegen' })

const result = await service.generateFile(
  {
    filePath: 'src/services/user.service.ts',
    purpose: 'CRUD service with validation and repository abstraction',
    referenceFiles: {
      'src/types/user.ts': 'export interface User { id: string; email: string }',
    },
    context: {
      framework: 'express',
      style: 'strict types, no any',
    },
  },
  'You are a senior TypeScript code generator.',
)

console.log(result.language) // "typescript"
console.log(result.content)
```

## 5.2 Adapter-routed generation

```ts
import { CodegenRunEngine } from '@dzupagent/codegen'

const engine = new CodegenRunEngine({
  adapter, // AgentCLIAdapter
  eventBus, // optional
  workingDirectory: process.cwd(),
  maxTurns: 1,
})

const file = await engine.generateFile(
  {
    filePath: 'src/routes/users.routes.ts',
    purpose: 'Express routes for users list/create endpoints',
  },
  'Generate production-ready route code.',
)
```

## 5.3 Incremental edit workflow

```ts
import {
  splitIntoSections,
  detectAffectedSections,
  buildIncrementalPrompt,
  applyIncrementalChanges,
} from '@dzupagent/codegen'

const sections = splitIntoSections(existingSource)
const affected = detectAffectedSections(sections, 'Add pagination to listUsers and adjust imports')
const prompt = buildIncrementalPrompt(
  'src/users.service.ts',
  sections,
  affected,
  'Add cursor pagination to listUsers',
)

// ...LLM returns updated section code...
const result = applyIncrementalChanges(existingSource, [
  { section: 'listUsers', operation: 'replace', newContent: updatedListUsersCode },
])
```

## 5.4 Generate test specs/prompts

```ts
import { extractExports, generateTestSpecs } from '@dzupagent/codegen'

const source = 'export function add(a: number, b: number) { return a + b }'
const exports = extractExports(source)

const specs = generateTestSpecs([
  {
    filePath: 'src/utils/math.ts',
    content: source,
    exports,
  },
])

console.log(specs[0]?.testFilePath) // src/__tests__/utils/math.test.ts
console.log(specs[0]?.prompt)
```

## 6. Use Cases

1. Full-file bootstrapping:
- Generate new modules from purpose + conventions + references.
2. Policy-compliant generation:
- Route generation through adapters to enforce approval, telemetry, or provider routing policy.
3. Cost-aware edits:
- Use incremental prompts to edit only impacted sections and reduce token usage.
4. Test-planning automation:
- Generate structured test plans and prompts before writing implementation tests.
5. Multi-stage generation pipelines:
- Combine this subsystem with VFS, quality gates, and correction loops in `@dzupagent/codegen`.

## 7. In-Repo References and Current Usage

## 7.1 Export surface

Generation APIs are publicly re-exported from `packages/codegen/src/index.ts`, so external consumers can import from `@dzupagent/codegen`.

## 7.2 Intra-package runtime usage

Direct runtime consumer found:

- `packages/codegen/src/tools/generate-file.tool.ts`
  - Depends on `CodeGenService` (injected) and exposes `generate_file` tool wrapper.

Other generation modules (`CodegenRunEngine`, incremental functions, test-generator functions, code-block parser helpers) are currently not wired into other runtime modules in this repository beyond export surface and tests.

## 7.3 Cross-package references

Repository-wide code search shows:

- `packages/server/src/runtime/tool-resolver.ts` dynamically imports `@dzupagent/codegen`, but currently consumes git tooling exports only (`createGitTools`, `GitExecutor`) rather than generation APIs.
- `packages/create-dzupagent/src/templates/codegen.ts` includes `@dzupagent/codegen` as template dependency, but without direct symbol-level generation imports.
- `packages/evals/src/__tests__/sandbox-contracts.test.ts` conditionally imports `@dzupagent/codegen` sandbox classes (`MockSandbox`, `DockerSandbox`), not generation APIs.

Conclusion:

- The generation subsystem is mostly an exported capability plus internally tested utilities today.
- Runtime orchestration around generation is still relatively thin inside the monorepo (mainly via `createGenerateFileTool`).

## 8. Test Coverage and Validation Status

## 8.1 Tests executed during this analysis (2026-04-04)

Command:

- `yarn workspace @dzupagent/codegen test src/__tests__/incremental-gen-and-test-generator.test.ts src/__tests__/tools-suite.test.ts`

Result:

- 2 test files passed
- 90 tests passed
- No failures

## 8.2 Focused coverage evidence

Command:

- `yarn workspace @dzupagent/codegen test:coverage src/__tests__/incremental-gen-and-test-generator.test.ts src/__tests__/tools-suite.test.ts`

Notes:

- Tests passed, but command exits non-zero because global package coverage thresholds are enforced across all source files.
- Coverage data was still generated at `packages/codegen/coverage/coverage-summary.json`.

Generation-folder line coverage from that run:

- `generation/incremental-gen.ts`: `96.12%`
- `generation/test-generator.ts`: `100%`
- `generation/code-block-parser.ts`: `0%`
- `generation/code-gen-service.ts`: `0%`
- `generation/codegen-run-engine.ts`: `0%`

Generation-folder aggregate (from console report):

- statements/lines: `55.15%`
- branches: `84.07%`
- functions: `80%`

## 8.3 What is covered well

- `incremental-gen.ts`
  - section splitting, import merge behavior, section detection, line numbering
  - affected-section token matching
  - add/replace/delete operations and multi-change ordering
  - incremental prompt composition
- `test-generator.ts`
  - strategy selection rules
  - export extraction patterns
  - path generation rules
  - spec/test-case/prompt generation including TDD mode
- `tools/generate-file.tool.ts`
  - verifies `CodeGenService.generateFile` invocation contract and output serialization

## 8.4 Coverage gaps

No direct tests currently cover:

- `code-block-parser.ts`
  - multi-block parsing edge cases, malformed fence handling, language-tag edge formats
- `code-gen-service.ts`
  - prompt construction correctness with refs/context
  - token usage extraction behavior and non-string model response handling
- `codegen-run-engine.ts`
  - adapter success/failure/no-completed-event paths
  - event-bus forwarding mappings
  - adapter vs fallback path parity

## 9. Limitations and Improvement Opportunities

1. Regex-based parsing limitations:
- `parseCodeBlocks` and export/section detection are intentionally heuristic and can miss uncommon syntax shapes.
2. Duplicate section names:
- `applyIncrementalChanges` matches by `section` name; duplicate names across scopes can cause ambiguity.
3. Runtime adoption gap:
- `CodegenRunEngine` is exported but currently has no in-repo runtime consumer, so adapter-bridge behavior depends primarily on future integration + dedicated tests.
4. Documentation drift risk:
- `packages/codegen/README.md` quick-start examples appear to reflect an older `CodeGenService` usage shape; alignment with current constructor/signature should be maintained to avoid integration confusion.

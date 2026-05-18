# Subagent Architecture (`packages/core/src/subagent`)

## Scope
This document covers the implementation currently present in:

- `packages/core/src/subagent/subagent-types.ts`
- `packages/core/src/subagent/subagent-spawner.ts`
- `packages/core/src/subagent/file-merge.ts`

It also references direct package-level integration points that expose this module:

- `packages/core/src/index.ts`
- `packages/core/src/facades/orchestration.ts`
- `packages/core/src/pipeline.ts`
- `packages/core/package.json`
- `packages/core/src/__tests__/subagent-spawner.test.ts`
- `packages/core/src/__tests__/facades.test.ts`

## Responsibilities
The subagent module provides a focused runtime primitive for delegated child-agent execution within `@dzupagent/core`.

Implemented responsibilities are:

- Define subagent config/result/usage contracts (`SubAgentConfig`, `SubAgentResult`, `SubAgentUsage`) and runtime defaults (`REACT_DEFAULTS`).
- Run a one-shot child invocation (`spawn`) with optional parent-file context injection.
- Run an iterative tool-calling child loop (`spawnReAct`) with iteration and depth limits.
- Resolve child models from either:
  - explicit `BaseChatModel`, or
  - registry tier (`ModelTier`) through `ModelRegistry`.
- Attach structured-output capabilities to the resolved model when requested.
- Optionally hydrate child system prompts with selected skill content via optional `SkillLoader`.
- Capture file writes from known file tools and merge back to parent file maps (`spawnAndMerge`, `mergeFileChanges`, `fileDataReducer`).

## Structure
### `subagent-types.ts`
Defines:

- `SubAgentConfig`
- `SubAgentUsage`
- `SubAgentResult`
- `REACT_DEFAULTS` (`maxIterations: 10`, `timeoutMs: 120_000`, `maxDepth: 3`)

`SubAgentConfig` includes model selection, tool list, skill names, optional structured-output capabilities, iteration/timeout controls, recursion depth marker (`_depth`), and optional `contextFilter`.

### `subagent-spawner.ts`
Defines:

- `SubAgentSpawner` class with public methods:
  - `spawn`
  - `spawnReAct`
  - `spawnAndMerge`

Private helpers in this file:

- `resolveModel`
- `buildSystemPrompt`
- `buildContextBlock`
- `extractFilesFromToolCall`

It also defines `FILE_TOOL_NAMES` as:
- `write_file`
- `edit_file`
- `create_file`

### `file-merge.ts`
Defines:

- `mergeFileChanges(parent, child, strategy?)`
  - strategy: `'last-write-wins' | 'conflict-error'`
- `fileDataReducer(current, update)`
  - `null` values delete files from the result map

## Runtime and Control Flow
### `spawn(config, task, parentFiles?)`
1. Resolve model using `resolveModel`:
- default to registry tier `'codegen'` when `config.model` is missing
- resolve tier name through `ModelRegistry` when `config.model` is a string
- use provided model instance when `config.model` is a model object
- always run through `attachStructuredOutputCapabilities(...)`

2. Build system prompt with optional skill content (`buildSystemPrompt`).

3. Build parent file context block (`buildContextBlock`) and append it to the human task message.

4. If tools exist and the model supports `bindTools`, bind tools before invoking.

5. Invoke once and return:
- `messages: [response]`
- `files: {}`
- metadata with `agentName` and `modelUsed`

### `spawnReAct(config, task, parentFiles?)`
1. Enforce recursion guard:
- `currentDepth = config._depth ?? 0`
- stop early if `currentDepth >= (options.maxDepth ?? REACT_DEFAULTS.maxDepth)`

2. Resolve iteration and timeout controls:
- `maxIterations = config.maxIterations ?? REACT_DEFAULTS.maxIterations`
- `timeoutMs = config.timeoutMs ?? REACT_DEFAULTS.timeoutMs`

3. Resolve/bind model and initialize message history (`SystemMessage`, `HumanMessage`).

4. Start loop up to `maxIterations`:
- check abort state first
- invoke model
- accumulate usage via `extractTokenUsage`
- append AI response
- inspect `AIMessage.tool_calls`
- if no tool calls, finish
- otherwise execute each tool call and append `ToolMessage` for:
  - success payload
  - missing tool errors
  - thrown tool errors

5. For recognized file tools, extract file path/content from tool args into `files`.

6. Mark `hitIterationLimit = true` if loop reaches last allowed iteration.

7. Clear timeout timer in `finally` and return full result:
- complete `messages`
- collected `files`
- `metadata` with `agentName`, `modelUsed`, and `depth`
- aggregated `usage`
- `hitIterationLimit`

### `spawnAndMerge(config, task, parentFiles)`
- Chooses:
  - `spawnReAct` when tools are configured
  - `spawn` when tools are not configured
- Merges child `result.files` into `parentFiles` using `mergeFileChanges(...)`
- Returns `{ result, mergedFiles }`

### File extraction and merge semantics
- Path aliases: `path`, `file_path`, `filePath`
- Content aliases: `content`, `new_content`, `newContent`
- `mergeFileChanges` default strategy is `last-write-wins`
- `conflict-error` throws when both parent and child define the same file with different content
- `fileDataReducer` supports deletion by setting update value to `null`

## Key APIs and Types
### Class
- `SubAgentSpawner`
  - constructor:
    - `(registry: ModelRegistry, options?: { skillLoader?: SkillLoader; maxDepth?: number })`
  - methods:
    - `spawn(config, task, parentFiles?)`
    - `spawnReAct(config, task, parentFiles?)`
    - `spawnAndMerge(config, task, parentFiles)`

### Types
- `SubAgentConfig`
  - required: `name`, `description`, `systemPrompt`
  - optional: `model`, `structuredOutputCapabilities`, `tools`, `skills`, `middleware`, `maxIterations`, `timeoutMs`, `_depth`, `contextFilter`
- `SubAgentUsage`
  - `inputTokens`, `outputTokens`, `llmCalls`
- `SubAgentResult`
  - `messages`, `files`, `metadata`, optional `usage`, optional `hitIterationLimit`

### Constants and functions
- `REACT_DEFAULTS`
- `mergeFileChanges(...)`
- `fileDataReducer(...)`

## Dependencies
Direct external imports in `src/subagent/*`:

- `@langchain/core/messages`
- `@langchain/core/language_models/chat_models`
- `@langchain/core/tools`

Direct internal imports in `src/subagent/*`:

- `../llm/model-registry.js`
- `../llm/invoke.js` (`extractTokenUsage`)
- `../llm/structured-output-capabilities.js`
- `../llm/model-config.js` (types)
- `../skills/skill-loader.js` (type in constructor options)
- `../middleware/types.js` (type in `SubAgentConfig`)
- local subagent files (`./subagent-types.js`, `./file-merge.js`)

Package-level context (`packages/core/package.json`):

- ESM package (`"type": "module"`)
- build/test scripts use `tsup`, `tsc`, `vitest`
- peer dependency on `@langchain/core` (`>=1.0.0`)

## Integration Points
Subagent exports are re-exposed through three active surfaces:

- Root barrel: `@dzupagent/core` (`src/index.ts`)
- Orchestration facade: `@dzupagent/core/orchestration` (`src/facades/orchestration.ts`)
- Pipeline subpath: `@dzupagent/core/pipeline` (`src/pipeline.ts`)

Exported symbols across those surfaces:

- `SubAgentSpawner`
- `REACT_DEFAULTS`
- `SubAgentConfig`, `SubAgentResult`, `SubAgentUsage`
- `mergeFileChanges`, `fileDataReducer`

Runtime collaborators required by callers:

- `ModelRegistry` instance passed to `SubAgentSpawner`
- optional `SkillLoader` for skill prompt hydration
- optional `StructuredToolInterface[]` for ReAct tool execution paths

## Testing and Observability
### Tests
Primary behavior coverage exists in `src/__tests__/subagent-spawner.test.ts`:

- `spawn` single-turn invocation behavior
- parent file context injection
- structured-output capability attachment on direct model instance
- ReAct loop behavior with:
  - normal tool call + final response
  - max iteration stop
  - missing tools
  - tool execution errors
- file extraction from `write_file` tool args
- max-depth guard behavior
- cumulative token usage accumulation
- `spawnAndMerge` mode selection and merge result

Facade/export coverage in `src/__tests__/facades.test.ts` confirms `SubAgentSpawner` is available through orchestration facade exports.

### Observability
The subagent module itself does not emit metrics or logs directly. Operational signals are returned in `SubAgentResult`:

- full message trace (`messages`)
- usage counters (`usage`)
- stop hints in metadata (`stoppedReason`, `depth`)
- iteration cap marker (`hitIterationLimit`)

## Risks and TODOs
Current code-visible limitations:

- `SubAgentConfig.middleware` is part of the public type but is not consumed by `SubAgentSpawner`.
- Timeout is tracked via `AbortController`, but the signal is not passed into model/tool invocations, so long-running calls are not forcibly cancelled.
- `buildContextBlock` inlines complete file contents, which can significantly increase prompt size and token cost on large parent snapshots.
- File extraction is intentionally narrow:
  - only known tool names are considered
  - only simple path/content arg aliases are parsed
  - tool result payload is ignored for file extraction
- Unknown skill names are silently skipped (no warning channel in this module).
- Synthetic fallback tool call IDs use timestamp/random generation, which is non-deterministic for strict replay correlation.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js


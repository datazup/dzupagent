# Subagent Architecture (`packages/core/src/subagent`)

## Scope

This document describes the subagent subsystem in `@dzupagent/core`:

- `subagent-types.ts`
- `subagent-spawner.ts`
- `file-merge.ts`

It covers features, execution flow, usage patterns, references in other packages, and current test coverage.

## Purpose

The subagent module provides a compact orchestration primitive for isolated child-agent execution with optional ReAct tool-calling and file-change propagation back into a parent virtual file system (VFS).

Primary goals:

- Run specialized child tasks with independent prompts/tools.
- Support iterative LLM + tool loops with bounded execution.
- Track aggregate token usage for subagent runs.
- Merge child file outputs back into parent state.

## Public API Surface

### Types (`subagent-types.ts`)

- `SubAgentConfig`
  - Identity and prompt: `name`, `description`, `systemPrompt`
  - Model override: concrete `BaseChatModel` or `ModelTier`
  - Runtime controls: `maxIterations`, `timeoutMs`, internal `_depth`
  - Optional enrichments: `tools`, `skills`, `middleware`, `contextFilter`
- `SubAgentUsage`
  - Cumulative `inputTokens`, `outputTokens`, and `llmCalls`
- `SubAgentResult`
  - `messages`, extracted `files`, `metadata`, optional `usage`, optional `hitIterationLimit`
- `REACT_DEFAULTS`
  - `maxIterations: 10`
  - `timeoutMs: 120_000`
  - `maxDepth: 3`

### Runtime Class (`subagent-spawner.ts`)

- `SubAgentSpawner`
  - `spawn(config, task, parentFiles?)`
  - `spawnReAct(config, task, parentFiles?)`
  - `spawnAndMerge(config, task, parentFiles)`

### File Merge Utilities (`file-merge.ts`)

- `mergeFileChanges(parent, child, strategy?)`
  - strategies: `'last-write-wins'` (default), `'conflict-error'`
- `fileDataReducer(current, update)`
  - LangGraph-style reducer supporting `null` deletes

## Feature Breakdown

### 1) Model Resolution

`SubAgentSpawner.resolveModel(...)` resolves model in this order:

1. `config.model` omitted -> `registry.getModel('codegen')`
2. `config.model` is tier string -> `registry.getModel(config.model)`
3. `config.model` is a concrete model instance -> use directly

Design impact:

- Defaults are centralized in registry policy.
- Subagents can pin model tiers without rebuilding registry logic.

### 2) Single-Turn Mode (`spawn`)

`spawn(...)` executes one LLM invocation:

1. Resolve model.
2. Build final system prompt (optionally inject skills).
3. Build optional file-context block from `parentFiles`.
4. Send `[SystemMessage, HumanMessage(task + context)]`.
5. Return one response message plus metadata.

Notes:

- If tools are present and model supports `bindTools`, tools are bound before invoke.
- No iterative tool loop is performed in this mode.
- `files` in the result are currently returned as an empty object.

### 3) ReAct Tool-Calling Loop (`spawnReAct`)

`spawnReAct(...)` runs iterative LLM/tool orchestration:

1. Enforce recursion depth cap (`config._depth` vs `maxDepth`).
2. Resolve model and bind tools.
3. Initialize message history with system + task/context.
4. Start timeout controller (`AbortController` + timer).
5. Iterate up to `maxIterations`:
   - invoke model
   - accumulate token usage via `extractTokenUsage(...)`
   - inspect `AIMessage.tool_calls`
   - execute each tool sequentially
   - append `ToolMessage` results/errors
   - collect file writes from known file tools
6. Stop on:
   - no further tool calls
   - timeout signal
   - iteration limit reached
7. Return full message trace, files, usage, metadata.

Failure behavior:

- Missing tool: non-fatal `ToolMessage` error back to model.
- Tool throw: non-fatal `ToolMessage` with error text.
- Timeout: loop stops cleanly and appends timeout AI message.

### 4) Skill Injection

`buildSystemPrompt(...)` appends skill content when:

- `config.skills` is provided, and
- `SubAgentSpawner` was created with `options.skillLoader`.

Injected format:

`## Skill: <name>` followed by loaded skill content.

### 5) Parent Context Filtering

`buildContextBlock(...)` optionally exposes parent files to the subagent via:

- default: `{ files: parentFiles }`
- custom: `config.contextFilter(parentState)`

Only `filtered.files` is serialized into the prompt.

### 6) File Extraction from Tool Calls

`extractFilesFromToolCall(...)` records file outputs only for:

- `write_file`
- `edit_file`
- `create_file`

Supported argument aliases:

- path: `path`, `file_path`, `filePath`
- content: `content`, `new_content`, `newContent`

### 7) Merge Semantics

`spawnAndMerge(...)`:

- chooses `spawnReAct` when tools are present
- otherwise falls back to `spawn`
- merges `parentFiles` + `result.files` using `mergeFileChanges(...)`

`mergeFileChanges(...)` details:

- `last-write-wins`: child overrides parent keys.
- `conflict-error`: throws when same path has different content.

### 8) Reducer for Concurrent Updates

`fileDataReducer(current, update)` applies partial updates:

- string value -> set/replace file
- `null` value -> delete file

This is suitable for graph-state reducers where multiple branches update a shared VFS shape.

## Execution Flow

### A) Single-turn `spawn`

```text
SubAgentConfig + task + optional parentFiles
  -> resolveModel()
  -> buildSystemPrompt() (+ optional skills)
  -> buildContextBlock() (+ optional filtered files)
  -> model.invoke([SystemMessage, HumanMessage])
  -> SubAgentResult { messages[1], files: {}, metadata }
```

### B) ReAct `spawnReAct`

```text
SubAgentConfig + task + optional parentFiles
  -> depth check (maxDepth)
  -> resolveModel() + bindTools()
  -> seed messages
  -> start timeout controller
  -> loop until break/maxIterations:
       invoke model
       collect usage
       if no tool_calls: done
       for each tool_call:
         find tool
         invoke tool (or emit ToolMessage error)
         append ToolMessage
         extract file changes (file tools)
  -> return SubAgentResult { full trace, files, usage, flags }
```

### C) Merge path `spawnAndMerge`

```text
spawn/spawnReAct result + parentFiles
  -> mergeFileChanges(parent, child)
  -> { result, mergedFiles }
```

## Usage Examples

### 1) Basic single-turn subagent

```ts
import { ModelRegistry } from '@dzupagent/core'
import { SubAgentSpawner } from '@dzupagent/core/orchestration'

const registry = new ModelRegistry()
// register providers/tiers before use

const spawner = new SubAgentSpawner(registry)

const result = await spawner.spawn(
  {
    name: 'summarizer',
    description: 'Summarizes implementation notes',
    systemPrompt: 'You summarize technical notes into concise bullets.',
    model: 'fast',
  },
  'Summarize the latest patch rationale.',
)
```

### 2) ReAct with tools + merge files

```ts
import { SubAgentSpawner } from '@dzupagent/core/orchestration'
import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'

const writeFileTool = new DynamicStructuredTool({
  name: 'write_file',
  description: 'Write a file in virtual workspace',
  schema: z.object({ path: z.string(), content: z.string() }),
  func: async ({ path, content }) => `Wrote ${path} (${content.length} chars)`,
})

const { result, mergedFiles } = await spawner.spawnAndMerge(
  {
    name: 'implementer',
    description: 'Creates implementation files',
    systemPrompt: 'Generate code and call tools as needed.',
    tools: [writeFileTool],
    maxIterations: 6,
    timeoutMs: 60_000,
  },
  'Create src/feature.ts exporting runFeature().',
  { 'README.md': '# Workspace' },
)
```

### 3) Limit file exposure with `contextFilter`

```ts
const result = await spawner.spawnReAct(
  {
    name: 'focused-editor',
    description: 'Works only on src/',
    systemPrompt: 'Edit only source files.',
    tools: [writeFileTool],
    contextFilter: (state) => {
      const files = (state.files as Record<string, string>) ?? {}
      return {
        files: Object.fromEntries(
          Object.entries(files).filter(([p]) => p.startsWith('src/')),
        ),
      }
    },
  },
  'Refactor parser implementation.',
  parentFiles,
)
```

### 4) Explicit merge conflict detection

```ts
import { mergeFileChanges } from '@dzupagent/core/orchestration'

const merged = mergeFileChanges(parentFiles, childFiles, 'conflict-error')
```

## References and Usage in Other Packages

### Export surfaces inside `@dzupagent/core`

- Root export: `packages/core/src/index.ts` re-exports:
  - `SubAgentSpawner`
  - `REACT_DEFAULTS`
  - `SubAgentConfig`, `SubAgentResult`, `SubAgentUsage`
  - `mergeFileChanges`, `fileDataReducer`
- Orchestration facade: `packages/core/src/facades/orchestration.ts` re-exports the same subagent APIs.

This means downstream consumers should generally import from:

- `@dzupagent/core` or
- `@dzupagent/core/orchestration`

### Cross-package references

Current non-core package reference is type-level:

- `packages/codegen/src/pipeline/phase-types.ts`
  - imports `SubAgentConfig` from `@dzupagent/core`
  - defines `SubAgentPhaseConfig` containing `subagent: SubAgentConfig`

Implication:

- `codegen` currently uses subagent contracts for pipeline configuration typing.
- No direct runtime instantiation of `SubAgentSpawner` was found outside `@dzupagent/core` in current repository state.

## Test Coverage

### Direct tests

Primary suite:

- `packages/core/src/__tests__/subagent-spawner.test.ts` (12 tests)

Covered behaviors include:

- single-turn `spawn` response and parent file context injection
- ReAct loop success path (tool call -> tool message -> final answer)
- max-iteration limit handling (`hitIterationLimit`)
- missing tool handling
- tool execution error recovery (non-fatal)
- file extraction from `write_file` args
- recursion depth guard behavior
- default constants in `REACT_DEFAULTS`
- cumulative token usage aggregation
- `spawnAndMerge` branch selection (ReAct vs single-turn)

Secondary structural coverage:

- `packages/core/src/__tests__/facades.test.ts` validates export availability for `SubAgentSpawner` via facade.

### Focused coverage run

Command executed:

```bash
yarn workspace @dzupagent/core test:coverage src/__tests__/subagent-spawner.test.ts --coverage.include=src/subagent/**/*.ts
```

Observed file metrics (`packages/core/coverage/coverage-summary.json`):

- `src/subagent/subagent-spawner.ts`
  - statements/lines: `93.53%`
  - branches: `68.25%`
  - functions: `100%`
- `src/subagent/subagent-types.ts`
  - statements/lines/branches/functions: `100%` (type/constants surface)
- `src/subagent/file-merge.ts`
  - statements/lines: `56.86%`
  - branches: `50%`
  - functions: `50%`

### Gaps and risks

1. `file-merge.ts` has no dedicated direct tests in current suite.
2. `spawnReAct` timeout-abort branch is implemented but not explicitly covered by dedicated tests.
3. `buildSystemPrompt` skill-loader path is not directly tested in `subagent-spawner.test.ts`.
4. `contextFilter` edge behavior (invalid return shape, empty files) lacks explicit test cases.
5. `SubAgentConfig.middleware` is type-level only in this module; it is not applied by `SubAgentSpawner`.
6. `_depth` is honored for guard checks but depth incrementing is expected to be managed by caller/orchestrator.

## Summary

`src/subagent` is a focused orchestration primitive that combines:

- bounded subagent execution (`maxDepth`, `maxIterations`, `timeoutMs`)
- optional ReAct tool loops with resilient error handling
- token usage accumulation
- file-change extraction and deterministic merge utilities

The core loop behavior is well-covered by tests, while merge helper coverage and a few edge-path tests remain the primary opportunities to harden confidence.

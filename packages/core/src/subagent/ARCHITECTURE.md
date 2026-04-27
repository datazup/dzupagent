# Subagent Architecture (`packages/core/src/subagent`)

## Scope

This document describes the implementation in `packages/core/src/subagent`:

- `subagent-types.ts`
- `subagent-spawner.ts`
- `file-merge.ts`

It is limited to code that currently exists in `@dzupagent/core` and its direct integrations in this package.

## Responsibilities

- Provide a `SubAgentSpawner` runtime for creating child-agent executions from a parent workflow.
- Support two execution modes:
- Single-turn spawn (`spawn`)
- Iterative tool-calling ReAct loop (`spawnReAct`)
- Resolve the model for a sub-agent from either:
- An explicit `BaseChatModel` instance
- A `ModelTier` resolved through `ModelRegistry`
- Attach structured-output capability metadata to the resolved model when `structuredOutputCapabilities` is supplied.
- Optionally enrich the sub-agent system prompt with selected skill content via `SkillLoader`.
- Build an optional parent-file context block and append it to the task prompt.
- Capture file edits from recognized file-writing tool calls and optionally merge them back into parent files.

## Structure

| File | Purpose |
|---|---|
| `subagent-types.ts` | Shared contracts: `SubAgentConfig`, `SubAgentUsage`, `SubAgentResult`, and `REACT_DEFAULTS`. |
| `subagent-spawner.ts` | `SubAgentSpawner` implementation (`spawn`, `spawnReAct`, `spawnAndMerge`) and private helpers for model resolution, skill prompt building, context shaping, and file extraction. |
| `file-merge.ts` | Merge and reducer helpers for file snapshots: `mergeFileChanges` and `fileDataReducer`. |

## Runtime and Control Flow

1. `spawn(config, task, parentFiles?)`:
- Resolves model via `resolveModel` (`config.model` or `registry.getModel('codegen')`).
- Applies optional structured-output capability override (`attachStructuredOutputCapabilities`).
- Builds system prompt (base prompt plus optional loaded skills).
- Builds optional file-context block from `parentFiles` and optional `contextFilter`.
- Optionally binds tools when tools are provided and model supports `bindTools`.
- Invokes once and returns a `SubAgentResult` with one AI response and empty `files`.

2. `spawnReAct(config, task, parentFiles?)`:
- Enforces recursion-depth guard (`_depth` compared against `options.maxDepth` or `REACT_DEFAULTS.maxDepth`).
- Resolves/binds model and tools, creates initial `SystemMessage` + `HumanMessage`.
- Starts timeout watchdog with `AbortController`.
- Iterates up to `maxIterations`:
- Invokes model.
- Aggregates token usage via `extractTokenUsage`.
- Reads `AIMessage.tool_calls`.
- Executes each tool call and appends `ToolMessage` with result or error.
- Extracts file updates from recognized file tools (`write_file`, `edit_file`, `create_file`).
- Stops when no tool calls remain, timeout is observed, or iteration cap is reached.
- Returns full message trace, usage totals, metadata, file map, and `hitIterationLimit`.

3. `spawnAndMerge(config, task, parentFiles)`:
- Chooses `spawnReAct` when tools are configured; otherwise uses `spawn`.
- Merges `parentFiles` and `result.files` via `mergeFileChanges`.
- Returns both raw `result` and `mergedFiles`.

## Key APIs and Types

- `SubAgentConfig`
- Required: `name`, `description`, `systemPrompt`
- Optional: `model`, `structuredOutputCapabilities`, `tools`, `skills`, `middleware`, `maxIterations`, `timeoutMs`, `_depth`, `contextFilter`
- `SubAgentUsage`
- `inputTokens`, `outputTokens`, `llmCalls`
- `SubAgentResult`
- `messages`, `files`, `metadata`, optional `usage`, optional `hitIterationLimit`
- `REACT_DEFAULTS`
- `maxIterations: 10`
- `timeoutMs: 120_000`
- `maxDepth: 3`
- `SubAgentSpawner`
- Constructor: `(registry: ModelRegistry, options?: { skillLoader?: SkillLoader; maxDepth?: number })`
- Public methods: `spawn`, `spawnReAct`, `spawnAndMerge`
- `mergeFileChanges(parent, child, strategy?)`
- Strategies: `'last-write-wins'` (default), `'conflict-error'`
- `fileDataReducer(current, update)`
- Applies updates and treats `null` values as delete signals.

## Dependencies

- External packages:
- `@langchain/core/messages`
- `@langchain/core/language_models/chat_models`
- `@langchain/core/tools`
- Internal `packages/core` modules:
- `../llm/model-registry.js`
- `../llm/invoke.js`
- `../llm/structured-output-capabilities.js`
- `../skills/skill-loader.js`
- `./file-merge.js`
- Type dependencies from other internal modules:
- `ModelTier`, `StructuredOutputModelCapabilities` from `../llm/model-config.js`
- `AgentMiddleware` from `../middleware/types.js`

## Integration Points

- Root package exports (`src/index.ts`) expose:
- `SubAgentSpawner`
- `REACT_DEFAULTS`
- `SubAgentConfig`, `SubAgentResult`, `SubAgentUsage`
- `mergeFileChanges`, `fileDataReducer`
- Orchestration facade (`src/facades/orchestration.ts`) re-exports the same subagent API for `@dzupagent/core/orchestration`.
- Stable entrypoint (`src/stable.ts`) exports facade namespaces from `src/facades/index.ts`; subagent APIs are consumed via the `orchestration` namespace.
- Advanced entrypoint (`src/advanced.ts`) re-exports the full root surface, including subagent APIs.
- Subagent execution relies on caller-provided runtime wiring:
- A `ModelRegistry` instance is mandatory.
- Optional `SkillLoader` enables skill content injection.
- Tool implementations are caller-supplied `StructuredToolInterface[]`.

## Testing and Observability

- `src/__tests__/subagent-spawner.test.ts` covers:
- Single-turn `spawn`
- Parent-file context injection
- Structured-output capability attachment on direct model instances
- ReAct loop behavior (tool success, missing tool, tool error)
- Iteration-limit handling
- Depth guard behavior
- Usage aggregation
- `spawnAndMerge` branch behavior
- Subagent behavior is observable through returned data:
- `metadata` includes `agentName`, `modelUsed`, and `depth` (ReAct path)
- `usage` tracks aggregate token/call counts for ReAct runs
- `messages` includes `ToolMessage` entries for both successful and failed tool calls
- No dedicated logger or metrics hook is implemented inside `src/subagent`; observability is primarily via return payloads and upstream event/telemetry layers in other modules.

## Risks and TODOs

- `SubAgentConfig.middleware` is defined but not consumed by `SubAgentSpawner`.
- Timeout handling uses `AbortController`, but `model.invoke(...)` and `tool.invoke(...)` are not passed abort signals, so in-flight calls are not forcibly canceled.
- `buildContextBlock` embeds full file contents directly in prompt text, which can increase token usage for large parent snapshots.
- File extraction is intentionally narrow:
- Tool name must be one of `write_file`, `edit_file`, `create_file`.
- Path/content extraction only checks a fixed alias set (`path`/`file_path`/`filePath`, `content`/`new_content`/`newContent`).
- Unknown `config.skills` entries are silently ignored if not discovered by `SkillLoader`.
- `subagent-spawner.ts` generates fallback tool-call ids using `Date.now()` and `Math.random()`, which is non-deterministic for trace replay.

## Changelog

- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
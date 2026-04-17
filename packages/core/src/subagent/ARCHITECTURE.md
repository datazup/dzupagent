# Subagent Architecture (`packages/core/src/subagent`)

## Scope

This document covers the subagent implementation in `packages/core/src/subagent`: `subagent-types.ts`, `subagent-spawner.ts`, and `file-merge.ts`.

It documents current behavior in code, not planned behavior.

## Responsibilities

- Run a child agent in isolated message history with its own system prompt and optional tools.
- Support a bounded ReAct loop (LLM call -> tool calls -> tool results -> next LLM call).
- Pass selected parent file context into the child prompt.
- Collect file outputs from known file-writing tool calls.
- Merge child file outputs back into parent virtual file state.
- Return run metadata and token usage summaries for ReAct runs.

## Structure

| File | Purpose |
|---|---|
| `subagent-types.ts` | Defines `SubAgentConfig`, `SubAgentUsage`, `SubAgentResult`, and `REACT_DEFAULTS`. |
| `subagent-spawner.ts` | Implements `SubAgentSpawner` with `spawn`, `spawnReAct`, and `spawnAndMerge`. |
| `file-merge.ts` | Implements `mergeFileChanges` and `fileDataReducer` for virtual file state composition. |

## Runtime and Control Flow

1. `spawn(config, task, parentFiles?)`: resolves model (`config.model` or registry default `codegen`), builds system prompt (optionally with loaded skills), adds optional parent file context, invokes model once, and returns a single AI response with metadata and empty `files`.
2. `spawnReAct(config, task, parentFiles?)`: enforces recursion depth guard, resolves and optionally tool-binds model, initializes message history, starts timeout controller, loops up to `maxIterations`, executes tool calls sequentially, appends tool results/errors, extracts file changes from recognized file tools, and returns full trace with usage and flags.
3. `spawnAndMerge(config, task, parentFiles)`: chooses `spawnReAct` when tools are present, otherwise `spawn`, then merges `parentFiles` with `result.files` using `mergeFileChanges`.

## Key APIs and Types

- `SubAgentConfig`: required fields are `name`, `description`, `systemPrompt`; optional fields include `model`, `tools`, `skills`, `maxIterations`, `timeoutMs`, `_depth`, `contextFilter`, and `middleware`.
- `SubAgentUsage`: aggregates `inputTokens`, `outputTokens`, and `llmCalls` across ReAct iterations.
- `SubAgentResult`: contains `messages`, `files`, `metadata`, optional `usage`, and optional `hitIterationLimit`.
- `REACT_DEFAULTS`: `maxIterations: 10`, `timeoutMs: 120_000`, `maxDepth: 3`.
- `mergeFileChanges(parent, child, strategy?)`: supports `last-write-wins` (default) and `conflict-error`.
- `fileDataReducer(current, update)`: applies keyed updates where `null` deletes a file path.

## Dependencies

- External: `@langchain/core/messages`, `@langchain/core/language_models/chat_models`, and `@langchain/core/tools`.
- Internal: `../llm/model-registry.ts` (model lookup), `../llm/invoke.ts` (token usage extraction), `../skills/skill-loader.ts` (optional skill prompt injection), and `./file-merge.ts` (parent/child file merge).

## Integration Points

- Root exports from `src/index.ts`: `SubAgentSpawner`, `REACT_DEFAULTS`, `SubAgentConfig`, `SubAgentResult`, `SubAgentUsage`, `mergeFileChanges`, and `fileDataReducer`.
- Facade exports from `src/facades/orchestration.ts`: same subagent API surface for `@dzupagent/core/orchestration` consumers.
- Stable path availability: `@dzupagent/core/stable` exposes `facades/index.ts`, where subagent APIs are accessible via the `orchestration` namespace.
- Caller contract: caller owns depth bookkeeping (`_depth` progression) and provides `ModelRegistry` plus optional `SkillLoader`.

## Testing and Observability

- `src/__tests__/subagent-spawner.test.ts` validates single-turn execution, ReAct loop behavior, iteration limits, missing-tool and tool-error handling, file extraction, depth guard, usage aggregation, and `spawnAndMerge` branching.
- `src/__tests__/facades.test.ts` validates facade-level export availability for `SubAgentSpawner`.
- Focused validation command run during refresh: `yarn vitest run src/__tests__/subagent-spawner.test.ts` (12 tests passing).
- Built-in observability in results: `metadata` captures `agentName`/`modelUsed` (and `depth` in ReAct mode), `usage` captures token/call totals, and tool failures are represented as `ToolMessage` entries in the returned trace.

## Risks and TODOs

- `SubAgentConfig.middleware` is currently type-level only and is not applied in `SubAgentSpawner`.
- Timeout currently sets an abort flag, but `model.invoke(...)` and `tool.invoke(...)` are not passed abort signals, so in-flight operations are not forcibly canceled.
- `buildContextBlock` serializes full file contents into prompt text; large parent VFS snapshots can significantly increase token cost.
- File extraction is intentionally narrow and only recognizes tool names `write_file`, `edit_file`, and `create_file` with a limited alias set for path/content args.
- `buildSystemPrompt` silently skips unknown skill names when requested skills are not discovered.
- `file-merge.ts` has no dedicated unit test file; coverage is indirect through higher-level tests.

## Changelog

- 2026-04-16: automated refresh via scripts/refresh-architecture-docs.js
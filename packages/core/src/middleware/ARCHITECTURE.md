# Middleware Architecture (`packages/core/src/middleware`)

## Scope
This document covers the middleware subsystem in `@dzupagent/core` under:

- `src/middleware/types.ts`
- `src/middleware/cost-tracking.ts`
- `src/middleware/cost-attribution.ts`
- `src/middleware/langfuse.ts`

It also references direct runtime consumers in `packages/agent` and `packages/server` where those consumers define real behavior for the `AgentMiddleware` contract.

## Responsibilities
The middleware module has four concrete responsibilities:

- Define the core middleware hook contract (`AgentMiddleware`) used by agent runtimes.
- Provide deterministic token-cost estimation helpers (`calculateCostCents`, `getModelCosts`) and a persistence interface contract (`CostTracker`).
- Aggregate per-call costs into multi-dimensional reports (`CostAttributionCollector`).
- Provide optional Langfuse callback handler creation via lazy import (`createLangfuseHandler`) without a hard dependency.

## Structure
| File | Main exports | Purpose |
| --- | --- | --- |
| `types.ts` | `AgentMiddleware` | Hook contract for model wrapping, tool result wrapping, pre-run setup, and middleware-provided tools. |
| `cost-tracking.ts` | `calculateCostCents`, `getModelCosts`, `CostTracker` | Model pricing table and cost calculation primitive in integer cents. |
| `cost-attribution.ts` | `CostAttributionCollector`, `CostAttribution*` report types | In-memory recording and aggregation by agent, tool, run, and model. |
| `langfuse.ts` | `createLangfuseHandler`, `LangfuseConfig`, `LangfuseHandlerOptions` | Optional Langfuse callback handler factory with dynamic `langfuse-langchain` import. |

Export surfaces in `@dzupagent/core`:

- Root export (`src/index.ts`) re-exports all middleware APIs including Langfuse helpers.
- Orchestration facade (`src/facades/orchestration.ts`) re-exports middleware contract and cost-attribution/cost-tracking APIs, but not `createLangfuseHandler`.

## Runtime and Control Flow
1. Middleware declaration:
- Consumers construct `AgentMiddleware[]` in application/runtime code or plugin wiring.

2. Runtime integration in `packages/agent`:
- `DzupAgent` builds `AgentMiddlewareRuntime` with `config.middleware`.
- `resolveTools()` appends middleware-provided tools after base tools.
- `runBeforeAgentHooks()` executes each `beforeAgent` with `{}` and swallows hook errors.
- `invokeModel()` uses the first middleware that defines `wrapModelCall`; otherwise falls back to `model.invoke`.
- `transformToolResult()` pipelines all `wrapToolCall` handlers in registration order and ignores wrapper errors.

3. Cost calculation usage:
- `calculateCostCents` is called by:
- `packages/agent/src/guardrails/iteration-budget.ts` for cumulative budget tracking.
- `packages/agent/src/agent/run-engine.ts` when emitting `llm:invoked` events.
- `packages/server/src/runtime/dzip-agent-run-executor.ts` for final run `costCents`.

4. Attribution collector flow:
- `CostAttributionCollector.record()` merges explicit entry values with optional collector context defaults.
- `getReport()` computes totals and buckets (`byAgent`, `byTool`, `byRun`, `byModel`) on demand from in-memory entries.
- `reset()` clears entries only.

5. Langfuse handler flow:
- `createLangfuseHandler()` returns `null` unless enabled and keys are present.
- When configured, it dynamically imports `langfuse-langchain` and instantiates `CallbackHandler`.
- Import/construction failure is treated as non-fatal and returns `null`.

## Key APIs and Types
`AgentMiddleware` (`types.ts`):

- `name: string`.
- `tools?: StructuredToolInterface[]`.
- `beforeAgent?(state): Promise<Partial<Record<string, unknown>>>`.
- `wrapModelCall?(model, messages, config): Promise<BaseMessage>`.
- `wrapToolCall?(toolName, input, result): Promise<string>`.

Observed runtime semantics (implemented in `packages/agent/src/agent/middleware-runtime.ts`):

- `beforeAgent` return values are currently ignored.
- first `wrapModelCall` wins.
- all `wrapToolCall` handlers are chained.
- errors in `beforeAgent` / `wrapToolCall` are swallowed.

`cost-tracking.ts`:

- `calculateCostCents(usage: TokenUsage): number`.
- `getModelCosts(modelName): { input: number; output: number } | null`.
- `CostTracker.trackUsage({ tenantId, userId, usage, context }): Promise<void>` interface.
- Pricing source: local `MODEL_COSTS` table (cents per 1M tokens) with default fallback for unknown models.

`cost-attribution.ts`:

- `CostAttribution` entry: `agentId`, optional `toolName`/`runId`, `costCents`, token split (`input`, `output`, `total`), `model`, `timestamp`.
- `CostAttributionCollector` methods: `record`, `getReport`, `getAgentCost`, `getRunCost`, `setContext`, `reset`.
- Buckets accumulate `costCents`, total tokens, and call count.

`langfuse.ts`:

- `LangfuseConfig`: `publicKey`, `secretKey`, optional `baseUrl`, optional `enabled`.
- `LangfuseHandlerOptions`: `sessionId`, `userId`, `metadata`, `tags`.
- `createLangfuseHandler(config, options): Promise<unknown | null>`.

## Dependencies
Internal dependencies inside `@dzupagent/core`:

- `cost-tracking.ts` imports `TokenUsage` from `src/llm/invoke.ts`.
- No middleware file depends on other core subsystems at runtime besides that type linkage.

External dependencies:

- `types.ts` depends on `@langchain/core` types (`BaseMessage`, `BaseChatModel`, `StructuredToolInterface`).
- `langfuse.ts` uses dynamic runtime import of `langfuse-langchain` (optional consumer-installed package).

Package-level context (`packages/core/package.json`):

- `@langchain/core` is a peer dependency, matching middleware type usage.
- `langfuse-langchain` is not listed as a direct dependency, consistent with lazy optional loading.

## Integration Points
Primary integrations:

- Agent runtime: `packages/agent/src/agent/middleware-runtime.ts`, `dzip-agent.ts`, and `run-engine.ts`.
- Plugin system: `packages/core/src/plugin/plugin-types.ts` and `plugin-registry.ts` allow plugins to contribute `AgentMiddleware[]`.
- Sub-agent config typing: `packages/core/src/subagent/subagent-types.ts` includes `middleware?: AgentMiddleware[]`.
- Cost consumers: `packages/agent/src/guardrails/iteration-budget.ts` and `packages/server/src/runtime/dzip-agent-run-executor.ts`.

Current non-integrated or weakly integrated points:

- `SubAgentConfig.middleware` is type-level only; `subagent-spawner.ts` does not apply middleware at runtime.
- `CostAttributionCollector` is exported and tested but has no direct wired consumer in `packages/agent` or `packages/server`.
- `createLangfuseHandler` is exported and documented, but no direct in-repo runtime call site currently uses it.

## Testing and Observability
Direct tests in scope:

- `src/middleware/__tests__/cost-attribution.test.ts` covers collector recording, aggregation buckets, context behavior, reset, and totals.

Indirect behavior coverage in adjacent packages:

- `packages/agent/src/__tests__/middleware-runtime.test.ts` validates runtime semantics for hook execution, wrapper precedence, tool result chaining, and fault tolerance.

Current testing gaps in this scope:

- No dedicated unit tests for `cost-tracking.ts` pricing/default behavior and rounding semantics.
- No dedicated unit tests for `langfuse.ts` enabled/disabled paths and dynamic-import failure handling.

Observability characteristics:

- Middleware module itself does not emit logs or metrics.
- It enables observability indirectly through cost calculation used in event emission and optional Langfuse callback creation.

## Risks and TODOs
- `AgentMiddleware.beforeAgent` return type suggests state mutation, but current runtime ignores returned partial state; either wire merge semantics or narrow the contract docs/types.
- `CostAttributionCollector.reset()` clears entries but keeps context; comment says it resets context overrides, but implementation does not. Align docs/comments with behavior or reset context explicitly.
- `createLangfuseHandler` returns `unknown | null`, which keeps core decoupled but weakens type safety for consumers; consider a light typed callback interface if coupling constraints allow.
- `MODEL_COSTS` is static and local; model naming drift across providers can silently fall back to default pricing.
- `packages/core/README.md` middleware examples are partially stale (`calculateCostCents(usage, modelId)` and per-1K wording) versus current API/units.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
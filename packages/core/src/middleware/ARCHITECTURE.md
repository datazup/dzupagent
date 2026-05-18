# Middleware Architecture (`packages/core/src/middleware`)

## Scope
This document describes the middleware subsystem in `packages/core/src/middleware` and its direct integration points in `packages/core`, plus verified consumers in `packages/agent` and `packages/server`.

Included implementation files:
- `types.ts`
- `cost-tracking.ts`
- `cost-attribution.ts`
- `langfuse.ts`
- `__tests__/cost-attribution.test.ts`

Reference surfaces used for this refresh:
- `packages/core/src/index.ts`
- `packages/core/src/llm.ts`
- `packages/core/src/facades/orchestration.ts`
- `packages/core/src/plugin/plugin-types.ts`
- `packages/core/src/plugin/plugin-registry.ts`
- `packages/core/src/subagent/subagent-types.ts`
- `packages/core/package.json`
- `packages/core/README.md`
- `packages/agent/src/agent/middleware-runtime.ts`
- `packages/agent/src/agent/agent-types-config.ts`
- `packages/agent/src/agent/run-engine-generate-tool-loop.ts`
- `packages/agent/src/agent/rate-limit-coordinator.ts`
- `packages/agent/src/guardrails/iteration-budget.ts`
- `packages/server/src/runtime/dzip-agent-run-executor.ts`

## Responsibilities
- Define the middleware contract (`AgentMiddleware`) used by agent runtimes to contribute tools and wrap model/tool execution.
- Provide token-usage cost helpers (`calculateCostCents`, `getModelCosts`) and a `CostTracker` interface for host-owned persistence.
- Provide in-memory aggregation of invocation costs (`CostAttributionCollector`) with report buckets by agent, tool, run, and model.
- Provide optional Langfuse callback construction (`createLangfuseHandler`) with runtime-only loading of `langfuse-langchain`.

## Structure
| File | Purpose | Main exports |
| --- | --- | --- |
| `types.ts` | Runtime middleware contract for agent integrations | `AgentMiddleware` |
| `cost-tracking.ts` | Static model pricing map and token-to-cost calculation | `calculateCostCents`, `getModelCosts`, `CostTracker` |
| `cost-attribution.ts` | Cost entry capture and aggregated reporting | `CostAttributionCollector`, `CostAttribution`, `CostBucket`, `CostReport`, `CostAttributionConfig` |
| `langfuse.ts` | Optional Langfuse callback handler factory | `createLangfuseHandler`, `LangfuseConfig`, `LangfuseHandlerOptions` |
| `__tests__/cost-attribution.test.ts` | Unit tests for attribution behavior | test suite |

Re-export surface:
- Re-exported from `packages/core/src/index.ts`.
- Re-exported from `packages/core/src/llm.ts`.
- `packages/core/src/facades/orchestration.ts` re-exports middleware type and cost/attribution helpers, but not `createLangfuseHandler`.

## Runtime and Control Flow
1. Definition and registration.
`AgentMiddleware` implementations are provided by consumers (including plugins). In core plugin types, `DzupPlugin.middleware?: AgentMiddleware[]`, and `PluginRegistry.getMiddleware()` flattens registered plugin middleware into one list.
2. Runtime execution semantics (implemented in `packages/agent`).
`AgentMiddlewareRuntime.resolveTools()` appends `middleware.tools`; `runBeforeAgentHooks()` invokes each `beforeAgent({})` and ignores errors; `invokeModel()` uses the first middleware with `wrapModelCall` or falls back to `model.invoke(messages)`; `transformToolResult()` applies every `wrapToolCall` in order, ignoring wrapper failures.
3. Cost calculation path.
`calculateCostCents(usage)` reads `usage.model`, resolves pricing from `MODEL_COSTS` (fallback `default`), computes input/output cost using per-1M-token rates, and returns `Math.ceil(total)`. `getModelCosts(name)` returns explicit prices or `null`.
4. Attribution aggregation path.
`CostAttributionCollector.record()` merges explicit entry values with collector context defaults; `getReport()` returns totals and per-dimension buckets; `getAgentCost()` and `getRunCost()` provide focused sums; `setContext()` updates default tagging fields; `reset()` clears entries.
5. Langfuse handler path.
`createLangfuseHandler()` returns `null` unless enabled with keys. On enabled path, it dynamic-imports `langfuse-langchain`, creates `CallbackHandler` with config/options, and returns `null` on import/constructor errors.

## Key APIs and Types
`AgentMiddleware` (`types.ts`):
- `name: string`
- `tools?: StructuredToolInterface[]`
- `wrapModelCall?: (model: BaseChatModel, messages: BaseMessage[], config?: Record<string, unknown>) => Promise<BaseMessage>`
- `wrapToolCall?: (toolName: string, input: Record<string, unknown>, result: string) => Promise<string>`
- `beforeAgent?: (state: Record<string, unknown>) => Promise<Partial<Record<string, unknown>>>`

`CostTracker` (`cost-tracking.ts`):
- `trackUsage({ tenantId, userId, usage, context }): Promise<void>`

`cost-tracking.ts` APIs:
- `calculateCostCents(usage: TokenUsage): number`
- `getModelCosts(modelName: string): { input: number; output: number } | null`
- Current pricing keys: `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-opus-4-6`, `gpt-5-mini`, `gpt-5`, `gemini-2.5-pro`, `gemini-2.5-flash`, `default`.

`cost-attribution.ts` APIs:
- `CostAttribution` fields: `agentId`, optional `toolName`, optional `runId`, `costCents`, `tokens`, `model`, `timestamp`.
- `CostReport` fields: `totalCostCents`, `totalTokens`, `byAgent`, `byTool`, `byRun`, `byModel`, `entries`.
- `CostAttributionCollector` methods: `record`, `getReport`, `getAgentCost`, `getRunCost`, `setContext`, `reset`.

`langfuse.ts` APIs:
- `LangfuseConfig`: `publicKey`, `secretKey`, optional `baseUrl`, optional `enabled`.
- `LangfuseHandlerOptions`: optional `sessionId`, `userId`, `metadata`, `tags`.
- `createLangfuseHandler(config, options): Promise<unknown | null>`.

## Dependencies
Internal dependencies:
- `cost-tracking.ts` depends on `TokenUsage` from `../llm/invoke.js`.

External dependencies:
- `types.ts` depends on LangChain core types from `@langchain/core/messages`, `@langchain/core/language_models/chat_models`, and `@langchain/core/tools`.
- `langfuse.ts` depends on runtime availability of `langfuse-langchain` through dynamic import.

Package dependency contract (`packages/core/package.json`):
- `@langchain/core` is declared as a peer dependency.
- `langfuse-langchain` is not declared in dependencies or peers, so Langfuse integration is optional and consumer-provided.

## Integration Points
Within `packages/core`:
- Publicly exported via `src/index.ts` and `src/llm.ts`.
- Partially exported via `src/facades/orchestration.ts` (`AgentMiddleware`, cost helpers, attribution collector/types).
- Used by plugin and subagent type surfaces:
- `src/plugin/plugin-types.ts` (`DzupPlugin.middleware?: AgentMiddleware[]`)
- `src/plugin/plugin-registry.ts` (`getMiddleware(): AgentMiddleware[]`)
- `src/subagent/subagent-types.ts` (`middleware?: AgentMiddleware[]`)

Cross-package usage in `dzupagent`:
- `packages/agent/src/agent/agent-types-config.ts` exposes `middleware?: AgentMiddleware[]`.
- `packages/agent/src/agent/middleware-runtime.ts` applies middleware semantics at runtime.
- `calculateCostCents` is used in:
- `packages/agent/src/agent/run-engine-generate-tool-loop.ts`
- `packages/agent/src/agent/rate-limit-coordinator.ts`
- `packages/agent/src/guardrails/iteration-budget.ts`
- `packages/server/src/runtime/dzip-agent-run-executor.ts`

Current non-usage inside repo:
- No direct runtime call site for `createLangfuseHandler` was found outside exports.
- `CostAttributionCollector` usage is currently test-focused in `packages/core`.

## Testing and Observability
Implemented tests in this module:
- `src/middleware/__tests__/cost-attribution.test.ts` covers recording, bucket aggregation, totals, context defaulting/overrides, and reset behavior.

Related tests outside this folder:
- `packages/agent/src/__tests__/middleware-runtime.test.ts` validates middleware runtime behavior.
- `packages/core/src/__tests__/plugin-mcp-deep.test.ts` exercises plugin middleware aggregation through registry.
- `packages/core/src/__tests__/w15-b1-facades.test.ts` includes a basic `calculateCostCents` smoke assertion.

Observed gaps:
- No dedicated tests for `cost-tracking.ts` pricing map integrity or rounding boundaries.
- No dedicated tests for `langfuse.ts` enablement gates or dynamic import failure handling.

Observability behavior:
- Middleware files do not emit events themselves.
- Cost values from `calculateCostCents` are consumed by agent/server flows that emit runtime telemetry and budget events.

## Risks and TODOs
- `AgentMiddleware.beforeAgent` returns partial state, but the current runtime invocation path in `packages/agent` does not consume that returned state.
- `CostAttributionCollector.reset()` comment says it resets context overrides, but implementation resets only `entries`.
- `createLangfuseHandler()` returns `unknown | null`, which keeps coupling low but provides weak static typing for callback consumers.
- `calculateCostCents()` silently falls back to `default` pricing for unknown models, which can mask model-mapping drift.
- `packages/core/README.md` examples include stale import and usage snippets relative to the current export map and token usage shape.
- `packages/core/src/__tests__/w15-b1-facades.test.ts` calls `calculateCostCents()` with `modelName` instead of `model`, so the test does not verify model-specific pricing behavior.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
# Middleware Architecture (`packages/core/src/middleware`)

## Scope
This document analyzes the middleware subsystem implemented in:

- `types.ts`
- `cost-tracking.ts`
- `cost-attribution.ts`
- `langfuse.ts`

It covers features, execution flow, usage patterns, cross-package references, and current test coverage.

## Why This Module Exists
The middleware module is the extension and observability surface between agent runtime behavior and operational concerns:

- behavior interception (`AgentMiddleware` hooks around model/tool execution)
- lightweight per-call cost estimation (`calculateCostCents`)
- in-memory multi-dimensional cost aggregation (`CostAttributionCollector`)
- optional Langfuse callback integration (`createLangfuseHandler`)

This keeps `@dzupagent/core` reusable while allowing higher layers (`@dzupagent/agent`, `@dzupagent/server`) to opt into middleware, tracing, and cost controls.

## Module Responsibilities

| File | Responsibility |
| --- | --- |
| `types.ts` | Defines the `AgentMiddleware` contract consumed by runtimes. |
| `cost-tracking.ts` | Defines known model pricing table, `calculateCostCents`, and `CostTracker` interface. |
| `cost-attribution.ts` | Implements `CostAttributionCollector` and reporting types (`CostReport`, `CostBucket`). |
| `langfuse.ts` | Provides lazy/dynamic Langfuse callback handler creation for LangChain. |

## Feature Set

### 1. Agent middleware contract (`types.ts`)
`AgentMiddleware` defines a minimal, optional hook set:

- `name: string` (required identifier)
- `tools?: StructuredToolInterface[]` (inject tools)
- `beforeAgent?` (pre-run hook)
- `wrapModelCall?` (model invocation override)
- `wrapToolCall?` (tool-result transform hook)

Important runtime semantics (as currently implemented by `@dzupagent/agent`):

- `beforeAgent` hooks are executed sequentially; errors are swallowed.
- `wrapModelCall` is **single-winner**: first middleware that defines it takes control.
- `wrapToolCall` is **pipeline-style**: all wrappers run in registration order.
- middleware errors in `beforeAgent` and `wrapToolCall` are non-fatal.

### 2. Cost calculation primitives (`cost-tracking.ts`)
`cost-tracking.ts` provides:

- `MODEL_COSTS` map (input/output cents per 1M tokens)
- `calculateCostCents(usage)`
- `getModelCosts(modelName)`
- `CostTracker` interface for pluggable persistence implementations

Cost formula:

- input cost: `(inputTokens / 1_000_000) * inputRate`
- output cost: `(outputTokens / 1_000_000) * outputRate`
- final cost: `Math.ceil(inputCost + outputCost)`

Behavioral notes:

- unknown model names use `MODEL_COSTS.default`
- `Math.ceil` guarantees integer cents, potentially rounding tiny values up to `1`

### 3. Cost attribution collector (`cost-attribution.ts`)
`CostAttributionCollector` records and aggregates cost entries with dimensions:

- agent (`byAgent`)
- tool (`byTool`)
- run (`byRun`)
- model (`byModel`)
- global totals (`totalCostCents`, `totalTokens`)

Key capabilities:

- context-based tagging (`setContext`) for `agentId`, `runId`, `toolName`
- explicit entry values override context values
- convenience queries: `getAgentCost(agentId)`, `getRunCost(runId)`
- `reset()` clears all recorded entries

### 4. Optional Langfuse handler (`langfuse.ts`)
`createLangfuseHandler(config, options)`:

- returns `null` when disabled/misconfigured
- dynamically imports `langfuse-langchain`
- returns `new CallbackHandler({...})` when import/config are valid
- catches import/runtime errors and returns `null`

Design intent:

- no hard dependency on Langfuse package in core
- consumers can install Langfuse only where needed

## Runtime Flow

### Flow A: Middleware in `DzupAgent` execution
1. `DzupAgent` builds `AgentMiddlewareRuntime` from `config.middleware`.
2. `prepareRunState(...)` resolves tools through middleware (`runtime.resolveTools(...)`).
3. `prepareRunState(...)` runs `runtime.runBeforeAgentHooks()`.
4. model invocation uses `runtime.invokeModel(...)`:
   - first `wrapModelCall` wins, otherwise `model.invoke(...)`.
5. each tool result is passed through `runtime.transformToolResult(...)` sequentially.
6. transformed output is written back into the message/tool loop.

Primary implementation references:

- `packages/agent/src/agent/dzip-agent.ts`
- `packages/agent/src/agent/middleware-runtime.ts`
- `packages/agent/src/agent/run-engine.ts`

### Flow B: Cost estimation in agent/server paths
1. token usage is produced or estimated per run/call.
2. `calculateCostCents(usage)` is invoked.
3. resulting cents feed budget checks or run result metadata.

Current in-repo usages:

- `packages/agent/src/guardrails/iteration-budget.ts` (running budget)
- `packages/server/src/runtime/dzip-agent-run-executor.ts` (run output cost)

### Flow C: Attribution aggregation
1. caller records `CostAttribution` events into `CostAttributionCollector`.
2. collector merges with active context defaults.
3. `getReport()` aggregates totals and per-dimension buckets.
4. caller consumes report for reporting/billing dashboards.

Current in-repo status:

- collector is exported and tested in `@dzupagent/core`
- no direct runtime integration found in `@dzupagent/agent` or `@dzupagent/server`

### Flow D: Langfuse callbacks
1. consumer calls `createLangfuseHandler(...)`.
2. if non-null, returned handler is passed into model callback plumbing.
3. LangChain emits trace events through handler.

Current in-repo status:

- helper is exported from `@dzupagent/core`
- no direct in-repo runtime call sites found

## Cross-Package References and Usage

### `AgentMiddleware` references
- `packages/agent/src/agent/agent-types.ts`: runtime config accepts `middleware?: AgentMiddleware[]`.
- `packages/agent/src/agent/middleware-runtime.ts`: concrete execution semantics.
- `packages/core/src/plugin/plugin-types.ts`: plugins can contribute middleware.
- `packages/core/src/plugin/plugin-registry.ts`: aggregates plugin middleware via `getMiddleware()`.
- `packages/core/src/subagent/subagent-types.ts`: `SubAgentConfig` includes optional middleware field.

Observed integration detail:

- `SubAgentConfig.middleware` is currently type-level only; `subagent-spawner.ts` does not apply it.

### Cost tracking references
- `packages/agent/src/guardrails/iteration-budget.ts`: updates cumulative budget with `calculateCostCents`.
- `packages/server/src/runtime/dzip-agent-run-executor.ts`: computes run `costCents` for executor result.

### Cost attribution references
- exported in `packages/core/src/index.ts` and `packages/core/src/facades/orchestration.ts`
- directly tested in `packages/core/src/middleware/__tests__/cost-attribution.test.ts`
- no direct usage in `agent`/`server` runtime paths

### Langfuse references
- exported in `packages/core/src/index.ts`
- documented in `packages/core/README.md`
- no direct usage in runtime packages found

## Usage Examples

### Example 1: Define middleware for tools + model + tool-result transform
```ts
import { AIMessage } from '@langchain/core/messages'
import type { AgentMiddleware } from '@dzupagent/core'

export const auditMiddleware: AgentMiddleware = {
  name: 'audit',

  beforeAgent: async (_state) => {
    // initialize per-run state or emit telemetry
    return {}
  },

  wrapModelCall: async (_model, _messages, config) => {
    // Optional override (first middleware with wrapModelCall wins)
    return new AIMessage({ content: `intercepted by ${String(config?.agentId ?? 'unknown')}` })
  },

  wrapToolCall: async (toolName, _input, result) => {
    return `[tool:${toolName}] ${result}`
  },
}
```

### Example 2: Estimate cost for a usage record
```ts
import { calculateCostCents, getModelCosts, type TokenUsage } from '@dzupagent/core'

const usage: TokenUsage = {
  model: 'gpt-5-mini',
  inputTokens: 12_000,
  outputTokens: 2_000,
}

const costCents = calculateCostCents(usage)
const pricing = getModelCosts('gpt-5-mini')
```

### Example 3: Aggregate attribution by agent/run/model/tool
```ts
import { CostAttributionCollector } from '@dzupagent/core'

const collector = new CostAttributionCollector({ agentId: 'planner', runId: 'run-42' })
collector.setContext({ toolName: 'edit_file' })

collector.record({
  agentId: '', // falls back to context agentId
  model: 'claude-sonnet-4-6',
  costCents: 6,
  tokens: { input: 2000, output: 500, total: 2500 },
  timestamp: new Date(),
})

const report = collector.getReport()
console.log(report.byAgent['planner']?.costCents)
console.log(report.byTool['edit_file']?.calls)
```

### Example 4: Attach Langfuse callback when available
```ts
import { createLangfuseHandler } from '@dzupagent/core'

const handler = await createLangfuseHandler(
  {
    enabled: true,
    publicKey: process.env['LANGFUSE_PUBLIC_KEY'] ?? '',
    secretKey: process.env['LANGFUSE_SECRET_KEY'] ?? '',
    baseUrl: process.env['LANGFUSE_HOST'],
  },
  {
    sessionId: 'run-42',
    userId: 'user-1',
    tags: ['prod', 'agent'],
  },
)

// If not null, pass into your LangChain model/chain callback config.
```

## Test Coverage

### Direct tests in `packages/core`
- `packages/core/src/middleware/__tests__/cost-attribution.test.ts`
  - 14 tests
  - covers recording, aggregation (`byAgent`, `byTool`, `byRun`, `byModel`), totals,
    context behavior, constructor defaults, and reset semantics

Executed check:

- `cd packages/core && yarn test src/middleware/__tests__/cost-attribution.test.ts`
  - result: 14/14 passing

### Related integration tests in `packages/agent`
Middleware runtime semantics are validated in agent tests:

- `packages/agent/src/__tests__/middleware-runtime.test.ts` (5 tests)
- `packages/agent/src/__tests__/middleware-hooks.test.ts` (2 tests)
- `packages/agent/src/__tests__/dzip-agent-run-parity.test.ts` (4 tests)

Executed check:

- `cd packages/agent && yarn test src/__tests__/middleware-runtime.test.ts src/__tests__/middleware-hooks.test.ts src/__tests__/dzip-agent-run-parity.test.ts`
  - result: 11/11 passing

### Coverage status summary for middleware files
From a targeted coverage run in `packages/core`:

- `cost-attribution.ts`: effectively covered by dedicated tests
- `cost-tracking.ts`: no direct tests
- `langfuse.ts`: no direct tests
- `types.ts`: type-only surface (runtime coverage not meaningful)

Note:

- `yarn test:coverage src/middleware/__tests__/cost-attribution.test.ts` generated file-level coverage data,
  but command exited non-zero due package-wide global coverage thresholds.

## Current Gaps / Risks

1. `beforeAgent` return values are currently ignored by runtime.
The `AgentMiddleware` type suggests state mutation (`Promise<Partial<...>>`), but `AgentMiddlewareRuntime.runBeforeAgentHooks()` invokes hooks with `{}` and does not merge returned values.

2. No first-party tests for `cost-tracking.ts` pricing behavior.
Model table correctness, rounding behavior, and unknown-model fallback are currently unverified by direct unit tests.

3. No first-party tests for `langfuse.ts` dynamic import paths.
Enabled/disabled config behavior and import-failure fallback are not currently validated by tests.

4. `SubAgentConfig.middleware` is not applied in subagent execution path.
The type accepts middleware, but `SubAgentSpawner` does not consume it.

# Hooks Architecture (`packages/core/src/hooks`)

## Scope
This document describes the hook subsystem implemented in:

- `hook-types.ts`
- `hook-runner.ts`
- `index.ts`

It covers features, execution flow, usage patterns, cross-package references, and current test coverage.

## Why This Module Exists
The hooks module provides a typed lifecycle extension surface for agent runs, tools, pipeline phases, approvals, and budget events.

Design intent:

- let consumers observe and customize lifecycle behavior without changing core runtime logic
- isolate hook failures so agent execution can continue
- support both non-mutating hooks and mutating hooks (input/result transformation)
- support merging hooks from multiple sources (for example plugins + app-level config)

## Module Responsibilities

| File | Responsibility |
| --- | --- |
| `hook-types.ts` | Defines `HookContext` and the `AgentHooks` lifecycle contract. |
| `hook-runner.ts` | Implements execution helpers: `runHooks`, `runModifierHook`, `mergeHooks`. |
| `index.ts` | Barrel export for hook types + runner utilities. |

## Feature Set

### 1. Typed lifecycle contract (`AgentHooks`)
`AgentHooks` defines optional async hooks grouped by lifecycle:

- Run lifecycle
  - `onRunStart(ctx)`
  - `onRunComplete(ctx, result)`
  - `onRunError(ctx, error)`
- Tool lifecycle
  - `beforeToolCall(toolName, input, ctx)` (can modify input)
  - `afterToolCall(toolName, input, result, ctx)` (can modify result)
  - `onToolError(toolName, error, ctx)`
- Pipeline lifecycle
  - `onPhaseChange(phase, previousPhase, ctx)`
  - `onApprovalRequired(plan, ctx)`
- Budget lifecycle
  - `onBudgetWarning(level, usage, ctx)`
  - `onBudgetExceeded(reason, usage, ctx)`

### 2. Shared context object (`HookContext`)
Each lifecycle hook can receive a consistent context payload:

- `agentId`
- `runId`
- `eventBus?`
- `metadata: Record<string, unknown>`

This enables hooks to correlate operations by run and emit events through the same bus.

### 3. Sequential execution with error isolation (`runHooks`)
`runHooks(...)` executes a list of hook functions in order. If one throws:

- error is caught
- optional event bus emits `{ type: 'hook:error', hookName, message }`
- remaining hooks still run

This gives at-least-attempted fan-out semantics, rather than fail-fast semantics.

### 4. Modifier hook semantics (`runModifierHook`)
`runModifierHook<T>(...)` allows controlled transformation of a value:

- if hook is missing: returns original `currentValue`
- if hook returns `undefined`/`void`: pass-through original value
- if hook returns a concrete value: replace current value
- if hook throws: emit `hook:error` and keep original value

This is designed for safe mutation points such as tool input/result post-processing.

### 5. Multi-source composition (`mergeHooks`)
`mergeHooks(...)` accepts multiple partial hook objects and merges them key-by-key into arrays.

Example outcome:

- input: `[{ onRunStart: fnA }, { onRunStart: fnB, onToolError: fnC }]`
- output: `{ onRunStart: [fnA, fnB], onToolError: [fnC] }`

This lets call sites execute all registered handlers for a lifecycle stage.

### 6. Event model integration
`hook-runner.ts` integrates with the event model by emitting `hook:error`, which is part of `DzupEvent` in `packages/core/src/events/event-types.ts`.

## Execution Flow

### Flow A: Non-modifying hook fan-out
1. Caller builds/collects hook list for a lifecycle point.
2. Caller invokes `runHooks(hooks, eventBus, hookName, ...args)`.
3. Runner iterates hooks sequentially.
4. Each hook receives the same argument list.
5. Failures are converted to `hook:error`; execution continues.
6. Caller resumes normal runtime path.

### Flow B: Modifier hook transform
1. Caller has a current value (`currentValue`) and optional modifier hook.
2. Caller invokes `runModifierHook(hook, eventBus, hookName, currentValue, ...args)`.
3. Hook executes once.
4. Return handling:
   - concrete value -> replace
   - `undefined` -> pass-through
   - throw -> emit `hook:error`, pass-through
5. Caller uses returned value for downstream logic.

### Flow C: Composition from multiple providers
1. Collect partial hook sets (for example plugin hooks + local hooks).
2. Merge via `mergeHooks(...)`.
3. For each lifecycle key, run corresponding array through `runHooks`.
4. For modifier keys, invoke each function in explicit pipeline order or use `runModifierHook` per stage.

## Current In-Repo Integration State
As of this analysis, the hook utilities are fully implemented in `core` but not yet wired into the primary `@dzupagent/agent` runtime loop via direct calls to `runHooks` / `runModifierHook`.

Observed state:

- `runHooks`, `runModifierHook`, `mergeHooks`
  - exported from `@dzupagent/core`
  - exported from `@dzupagent/core/orchestration`
  - no direct runtime call sites outside `hook-runner.ts` itself
- plugin system supports hook declaration/collection
  - `DzupPlugin.hooks?: Partial<AgentHooks>`
  - `PluginRegistry.getHooks(): Partial<AgentHooks>[]`
  - but no in-repo caller currently consumes `getHooks()` to execute lifecycle hooks

Implication: the subsystem is available as infrastructure/API surface, but full end-to-end lifecycle execution wiring appears incomplete in current runtime paths.

## Cross-Package References and Usage

### `@dzupagent/core`
- Re-exported from `packages/core/src/index.ts`
- Re-exported from orchestration facade: `packages/core/src/facades/orchestration.ts`
- `AgentHooks` type is used by plugin contracts in:
  - `packages/core/src/plugin/plugin-types.ts`
  - `packages/core/src/plugin/plugin-registry.ts`

### `@dzupagent/agent`
- `HookContext` is imported for approval condition typing:
  - `packages/agent/src/approval/approval-types.ts`
  - `packages/agent/src/approval/approval-gate.ts`
- This is a type-level dependency (approval context), not invocation of core hook runner utilities.

### `@dzupagent/otel`
- Consumes `hook:error` at event-model level:
  - `packages/otel/src/event-metric-map/empty-events.ts`
  - `packages/otel/src/__tests__/otel-bridge.test.ts`
- Behavior: `hook:error` is recognized but intentionally mapped to no metrics.

### `@dzupagent/express`
- Contains its own router hooks (`beforeAgent`, `afterAgent`, `onError`) in `packages/express/src/types.ts`.
- These are Express-router lifecycle hooks, separate from `AgentHooks` in `core/hooks`.

## Usage Examples

### Example 1: Run lifecycle fan-out (`runHooks`)
```ts
import { createEventBus, runHooks, type HookContext, type AgentHooks } from '@dzupagent/core'

const eventBus = createEventBus()

const ctx: HookContext = {
  agentId: 'planner',
  runId: 'run-123',
  eventBus,
  metadata: { tenantId: 't-1' },
}

const hooks: Array<AgentHooks['onRunStart']> = [
  async (c) => {
    c.eventBus?.emit({ type: 'agent:started', agentId: c.agentId, runId: c.runId })
  },
  async () => {
    // Any thrown error becomes hook:error and does not abort the run
    throw new Error('telemetry backend unavailable')
  },
]

await runHooks(hooks as Array<((...args: never[]) => Promise<void>) | undefined>, eventBus, 'onRunStart', ctx)
```

### Example 2: Tool result transformation (`runModifierHook`)
```ts
import { runModifierHook, type AgentHooks } from '@dzupagent/core'

const redactSecrets: AgentHooks['afterToolCall'] = async (_tool, _input, result) => {
  return result.replaceAll(/api[_-]?key\s*=\s*\S+/gi, 'api_key=[REDACTED]')
}

const original = 'status=ok api_key=abcd1234'
const transformed = await runModifierHook(
  redactSecrets as ((...args: never[]) => Promise<string | void>),
  undefined,
  'afterToolCall',
  original,
  'shell.exec',
  {},
  original,
  { agentId: 'a1', runId: 'r1', metadata: {} },
)

// transformed => "status=ok api_key=[REDACTED]"
```

### Example 3: Merge plugin + app hooks (`mergeHooks`)
```ts
import { mergeHooks, runHooks, type AgentHooks, type HookContext } from '@dzupagent/core'

const pluginHooks: Partial<AgentHooks> = {
  onRunStart: async (ctx) => {
    console.log(`[plugin] run start ${ctx.runId}`)
  },
}

const appHooks: Partial<AgentHooks> = {
  onRunStart: async (ctx) => {
    console.log(`[app] run start ${ctx.runId}`)
  },
}

const merged = mergeHooks<AgentHooks>(pluginHooks, appHooks)

const ctx: HookContext = { agentId: 'a1', runId: 'r1', metadata: {} }
const runStartHooks = merged.onRunStart as Array<((ctx: HookContext) => Promise<void>)> | undefined

await runHooks(
  runStartHooks as Array<((...args: never[]) => Promise<void>) | undefined>,
  undefined,
  'onRunStart',
  ctx,
)
```

## Testing and Coverage

### Dedicated tests for `packages/core/src/hooks`
Current status:

- no hook-focused test file exists under `packages/core/src/__tests__`
- no direct test assertions against `runHooks`, `runModifierHook`, or `mergeHooks`

### Observed indirect test signals
- `hook:error` event behavior is covered indirectly in OTel tests:
  - `packages/otel/src/__tests__/otel-bridge.test.ts`
  - `packages/otel/src/__tests__/event-metric-map.test.ts`

### Coverage evidence
From `packages/core/coverage/coverage-summary.json`:

- `packages/core/src/hooks/hook-runner.ts`
  - lines: `33.78%` (`25/74`)
  - functions: `0%` (`0/3`)
  - statements: `33.78%` (`25/74`)
- `hook-types.ts` and `index.ts`
  - mostly type/barrel definitions, and do not appear as meaningful executable runtime coverage targets

Interpretation:

- the hook runtime utility is currently under-tested relative to its API intent
- the event type (`hook:error`) has downstream compatibility checks, but core execution semantics are not directly validated

## Gaps and Recommended Next Tests

High-value tests to add in `packages/core/src/__tests__/hook-runner.test.ts`:

1. `runHooks` executes all hooks in order.
2. `runHooks` continues after a thrown error.
3. `runHooks` emits `hook:error` with expected `hookName` + message.
4. `runModifierHook` pass-through on missing hook.
5. `runModifierHook` pass-through on `undefined` return.
6. `runModifierHook` replacement on concrete return.
7. `runModifierHook` error path emits `hook:error` and returns original value.
8. `mergeHooks` combines multiple partial sets and preserves insertion order.

## Summary
The hooks module is a cleanly scoped extension layer with strong type contracts and safe failure behavior. The main architectural limitation today is adoption: hook execution utilities and plugin hook aggregation are exported and ready, but not yet wired through the main agent runtime path in this repository.

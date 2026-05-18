# Hooks Architecture (`packages/core/src/hooks`)

## Scope
This document describes the hook subsystem implemented in `packages/core/src/hooks` inside `@dzupagent/core`.

Primary files in scope:
- `src/hooks/hook-types.ts`
- `src/hooks/hook-runner.ts`
- `src/hooks/index.ts`

Package-local integration points covered here:
- `src/plugin/plugin-types.ts`
- `src/plugin/plugin-registry.ts`
- `src/events.ts`
- `src/index.ts`
- `src/facades/orchestration.ts`
- `src/facades/quick-start.ts`
- `src/events/event-types-platform.ts`

## Responsibilities
The hooks module provides low-level lifecycle extension primitives for runtime consumers:
- Define the hook contract (`AgentHooks`) and call context (`HookContext`).
- Execute non-modifying hooks in sequence with per-hook error isolation (`runHooks`).
- Execute optional value-modifying hooks with safe pass-through behavior (`runModifierHook`).
- Combine multiple partial hook sets into per-key arrays preserving input order (`mergeHooks`).

The module does not register plugins, discover hooks, or decide lifecycle invocation timing. Those behaviors are handled by consuming layers.

## Structure
- `hook-types.ts`
- Exposes `HookContext` with required `agentId`, `runId`, and `metadata`, plus optional `eventBus`.
- Exposes `AgentHooks` as optional async callbacks across run, tool, pipeline, and budget lifecycle points.

- `hook-runner.ts`
- `runHooks(...)` iterates an optional hook array, skips undefined entries, and emits `hook:error` when a hook throws.
- `runModifierHook<T>(...)` executes one optional modifier hook and returns either transformed output or original input.
- `mergeHooks<T>(...)` merges hook objects by key into arrays of functions.

- `index.ts`
- Local barrel re-exporting hook types and runner helpers.

## Runtime and Control Flow
Current package-level control flow:
1. Plugin authors can attach `hooks?: Partial<AgentHooks>` on `DzupPlugin` (`src/plugin/plugin-types.ts`).
2. `PluginRegistry.register(...)` stores plugins and emits `plugin:registered` (`src/plugin/plugin-registry.ts`).
3. `PluginRegistry.getHooks()` returns aggregated contributed hook objects as `Partial<AgentHooks>[]` in registration order.
4. Consumers merge returned sets via `mergeHooks(...)` into `hookName -> hook[]` maps.
5. Consumers execute lifecycle callbacks via `runHooks(...)` or `runModifierHook(...)`.
6. Hook failures are isolated and emitted as `{ type: 'hook:error', hookName, message }` through the provided event bus.

Observed current-state boundary in `packages/core/src`:
- Hook runner functions are exported and tested in this package.
- There is no non-test invocation site inside `packages/core/src` that directly calls `runHooks(...)` or `runModifierHook(...)`; execution timing is delegated to downstream runtime consumers.

## Key APIs and Types
- `HookContext`
- `agentId: string`
- `runId: string`
- `eventBus?: DzupEventBus`
- `metadata: Record<string, unknown>`

- `AgentHooks`
- Run lifecycle: `onRunStart`, `onRunComplete`, `onRunError`
- Tool lifecycle: `beforeToolCall`, `afterToolCall`, `onToolError`
- Pipeline lifecycle: `onPhaseChange`, `onApprovalRequired`
- Budget lifecycle: `onBudgetWarning`, `onBudgetExceeded`

- `runHooks(hooks, eventBus, hookName, ...args): Promise<void>`
- No-op when `hooks` is `undefined`.
- Executes hooks sequentially in array order.
- Catches each hook error independently.
- Emits `hook:error` only when `eventBus` is provided.

- `runModifierHook<T>(hook, eventBus, hookName, currentValue, ...args): Promise<T>`
- Returns `currentValue` when hook is missing.
- Returns transformed value when hook returns non-`undefined`.
- Passes through original value when hook returns `undefined`/`void`.
- On throw, emits `hook:error` (if bus exists) and returns `currentValue`.

- `mergeHooks<T>(...hookSets)`
- Accepts `Partial<T> | undefined` hook sets.
- Ignores undefined hook sets and non-function entries.
- Produces `Partial<Record<keyof T, Array<...>>>` with append order preserved.

## Dependencies
Direct hook-module imports:
- `../events/event-bus.js` (`DzupEventBus` type)
- `../events/event-types.js` (`BudgetUsage` type)

`@dzupagent/core` package context (`package.json`):
- Runtime dependencies: `@dzupagent/agent-types`, `@dzupagent/runtime-contracts`, `@dzupagent/security`
- Peer dependencies include `@langchain/core`, `@langchain/langgraph`, `zod`, tokenizer/vector packages

Hook implementation itself has no direct third-party runtime imports.

## Integration Points
Internal and public surfaces that expose hooks:
- Main core barrel exports hook types and runners (`src/index.ts`).
- `@dzupagent/core/events` facade exports hook types and runners (`src/events.ts`).
- `@dzupagent/core/orchestration` facade exports hook types and runners (`src/facades/orchestration.ts`).
- `@dzupagent/core/quick-start` facade exports `AgentHooks` type (`src/facades/quick-start.ts`).

Plugin integration:
- `DzupPlugin.hooks` is the hook contribution entry point.
- `PluginRegistry.getHooks()` is the package-local aggregation point.

Event model integration:
- `hook:error` and `plugin:registered` are part of `PlatformDomainEvent` (`src/events/event-types-platform.ts`) and therefore part of `DzupEvent`.

## Testing and Observability
Hook behavior tests in this package:
- `src/__tests__/hook-runner.test.ts`
- `src/__tests__/facade-orchestration.test.ts`
- `src/__tests__/w15-b1-facades.test.ts` (facade-level import/behavior coverage including hook helpers)
- `src/__tests__/plugin-mcp-deep.test.ts` (plugin hook aggregation via registry)

Covered behaviors include:
- Sequential execution and ordering.
- Undefined hook set and undefined entry handling.
- Continue-on-error semantics.
- `hook:error` emission for `Error` and non-`Error` throws.
- Modifier pass-through/transform behavior.
- Merge behavior across multiple hook sets.
- Registry-level hook aggregation ordering.

Current observability emitted by hook runner:
- Event-only failure signaling via `hook:error` (`hookName`, `message`).
- No built-in metrics, tracing spans, latency capture, or execution counters in `src/hooks`.

## Risks and TODOs
- Invocation ownership is external: hook helpers are exported utilities with no in-package production call path, so runtime consistency depends on consumers.
- `afterToolCall` is currently typed around `string` result payloads, which can limit strongly typed structured tool outputs.
- Error telemetry is intentionally minimal (`hookName`, `message`) and omits stack/cause and run correlation fields.
- Runner generics rely on broad function casting (`never[]` signatures plus runtime casts), reducing argument-level static precision.
- No built-in timeout/cancellation controls for long-running hook callbacks.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js


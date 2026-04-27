# Hooks Architecture (`packages/core/src/hooks`)

## Scope
This document covers the hook subsystem in `packages/core/src/hooks`:
- `hook-types.ts`
- `hook-runner.ts`
- `index.ts`

It describes the implemented hook contracts, execution helpers, exports, and current in-repo integration state for `@dzupagent/core`.

## Responsibilities
The hooks module provides three responsibilities:
- Define a typed lifecycle contract (`AgentHooks`) and shared invocation context (`HookContext`).
- Execute hook functions with error isolation (`runHooks`) and safe value transformation (`runModifierHook`).
- Merge hook sets from multiple providers (for example app hooks plus plugin hooks) into executable arrays (`mergeHooks`).

## Structure
- `hook-types.ts`
Defines:
- `HookContext` with `agentId`, `runId`, optional `eventBus`, and free-form `metadata`.
- `AgentHooks` lifecycle surface for run, tool, pipeline, approval, and budget callbacks.

- `hook-runner.ts`
Defines:
- `runHooks(...)`: sequential fan-out executor for non-mutating hooks.
- `runModifierHook<T>(...)`: single-hook transformer with pass-through fallback.
- `mergeHooks<T>(...)`: utility that converts multiple partial hook objects into per-key arrays.

- `index.ts`
Barrel export for `AgentHooks`, `HookContext`, and hook runner helpers.

## Runtime and Control Flow
1. Hook registration happens outside this module (for example via plugin objects exposing `hooks?: Partial<AgentHooks>`).
2. A caller selects a lifecycle hook key and collects functions.
3. `runHooks` executes each hook in order; failures are caught and converted into `hook:error` events when an event bus exists.
4. For transform-style points, `runModifierHook` executes one hook and returns:
- transformed value when hook returns non-`undefined`
- original value when hook is missing, returns `undefined`, or throws
5. `mergeHooks` is used to aggregate hook objects into `Record<key, fn[]>` so callers can apply consistent sequencing.

Current state in repository code:
- The utilities are implemented and exported from `@dzupagent/core` and `@dzupagent/core/orchestration`.
- `PluginRegistry.getHooks()` aggregates plugin hook objects.
- There are no non-test call sites currently invoking `runHooks` or `runModifierHook`; execution wiring is consumer-owned at this stage.

## Key APIs and Types
- `interface HookContext`
Fields:
- `agentId: string`
- `runId: string`
- `eventBus?: DzupEventBus`
- `metadata: Record<string, unknown>`

- `interface AgentHooks`
Hook groups:
- Run lifecycle: `onRunStart`, `onRunComplete`, `onRunError`
- Tool lifecycle: `beforeToolCall`, `afterToolCall`, `onToolError`
- Pipeline lifecycle: `onPhaseChange`, `onApprovalRequired`
- Budget lifecycle: `onBudgetWarning`, `onBudgetExceeded`

- `runHooks(hooks, eventBus, hookName, ...args): Promise<void>`
Behavior:
- no-op when `hooks` is `undefined`
- skips `undefined` entries
- executes sequentially
- catches throw, emits `{ type: 'hook:error', hookName, message }`, then continues

- `runModifierHook<T>(hook, eventBus, hookName, currentValue, ...args): Promise<T>`
Behavior:
- returns `currentValue` when hook is missing
- returns transformed value when hook returns concrete value
- returns `currentValue` when hook returns `undefined` or throws
- emits `hook:error` on throw when `eventBus` is present

- `mergeHooks<T>(...hookSets)`
Behavior:
- ignores `undefined` hook sets
- ignores non-function values
- accumulates functions per key in insertion order
- returns a partial key-to-array map suitable for iteration

## Dependencies
Direct internal dependencies in this module:
- `../events/event-bus.js`
`runHooks` and `runModifierHook` accept `DzupEventBus` for error event emission.
- `../events/event-types.js`
`AgentHooks` references `BudgetUsage` for budget callback payloads.

Package-level context:
- `@dzupagent/core` depends on `@dzupagent/agent-types` and `@dzupagent/runtime-contracts` (package metadata).
- Hook module itself does not import external runtime libraries directly.

## Integration Points
Inside `packages/core`:
- Root exports:
- `src/index.ts` exports `AgentHooks`, `HookContext`, `runHooks`, `runModifierHook`, `mergeHooks`.
- Facade exports:
- `src/facades/orchestration.ts` exports the same hook surface.
- `src/facades/quick-start.ts` exports `AgentHooks` type only.

Plugin subsystem:
- `src/plugin/plugin-types.ts`: `DzupPlugin` includes `hooks?: Partial<AgentHooks>`.
- `src/plugin/plugin-registry.ts`: `getHooks(): Partial<AgentHooks>[]` aggregates hook sets from registered plugins.

Cross-package type use:
- `packages/agent/src/approval/approval-types.ts` and `approval-gate.ts` import `HookContext` for approval condition typing.

Event model integration:
- `hook:error` is part of the `DzupEvent` union in `src/events/event-types.ts`.

## Testing and Observability
Hook execution tests in `packages/core`:
- `src/__tests__/hook-runner.test.ts`
Covers:
- ordered execution
- skip-undefined behavior
- undefined hook list no-op
- continue-on-error behavior
- `hook:error` emission including non-`Error` throws
- modifier pass-through and transform behavior
- `mergeHooks` aggregation behavior

Facade-level coverage:
- `src/__tests__/facade-orchestration.test.ts` validates hook runner behavior through orchestration exports.
- `src/__tests__/w15-b1-facades.test.ts` verifies facade surfaces (including hook exports) continue to work in broader facade test suites.

Observability path:
- Hook failures emit `hook:error` through `DzupEventBus` when a bus is provided.
- No additional metrics or tracing are emitted directly by the hook runner module.

## Risks and TODOs
- Runtime adoption gap:
No non-test runtime call sites currently execute `runHooks` / `runModifierHook`; consumers must wire lifecycle invocation explicitly.

- Type ergonomics:
Runner signatures use generic `(...args: never[])` hook function arrays and cast at invocation time. This keeps implementation simple but is less ergonomic for strict typed composition.

- Modifier hook shape constraint:
`afterToolCall` currently models `result` as `string` and return as `Promise<string | void>`. If tool result shapes widen in runtime consumers, this interface may need to generalize.

- Error payload minimalism:
`hook:error` emits `hookName` and message only; stack and structured cause data are intentionally omitted.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js.


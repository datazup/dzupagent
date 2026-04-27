# Events Architecture (`packages/core/src/events`)

## Scope
This document covers the event subsystem implemented in `@dzupagent/core` under `src/events`:

- `event-types.ts`
- `event-bus.ts`
- `agent-bus.ts`
- `degraded-operation.ts`
- `tool-event-correlation.ts`
- `index.ts`

It also describes in-repo integrations inside `packages/core` (facades, protocol, persistence, plugin, registry, and security modules) that consume these event primitives.

## Responsibilities
The events subsystem provides three distinct responsibilities:

- Define the canonical typed event contract (`DzupEvent`) used across core runtime features.
- Provide a fail-soft typed pub/sub bus (`DzupEventBus`) for lifecycle, telemetry, policy, workflow, and operational events.
- Provide a channel-based peer message bus (`AgentBus`) used by protocol internals for in-process request/response and streaming coordination.

Supporting responsibilities:

- Emit standardized degraded-mode signals via `emitDegradedOperation(...)`.
- Enforce non-empty terminal tool run correlation IDs via `requireTerminalToolExecutionRunId(...)`.

## Structure
| File | Purpose | Main exports |
| --- | --- | --- |
| `event-types.ts` | Canonical discriminated union for framework events | `DzupEvent`, `DzupEventOf`, `BudgetUsage`, `ToolStatSummary` |
| `event-bus.ts` | Typed in-process event bus with typed listeners and wildcard listeners | `DzupEventBus`, `createEventBus` |
| `agent-bus.ts` | Channel pub/sub bus for agent-to-agent in-process messaging, with bounded history | `AgentBus`, `AgentMessage`, `AgentMessageHandler` |
| `degraded-operation.ts` | Convenience emitter for degraded subsystem state | `emitDegradedOperation` |
| `tool-event-correlation.ts` | Guardrail for terminal tool-event run correlation IDs | `requireTerminalToolExecutionRunId`, `TerminalToolEventType`, `TerminalToolExecutionRunIdOptions` |
| `index.ts` | Events-folder barrel | `createEventBus`, event types, degraded helper, tool correlation helper |

Export notes from current code:

- Package root (`src/index.ts`) exports both `DzupEventBus` APIs and `AgentBus`.
- `src/events/index.ts` does not export `AgentBus`.
- `src/facades/orchestration.ts` exports both `createEventBus` and `AgentBus`.
- `src/facades/quick-start.ts` exports `createEventBus` and event types, not `AgentBus`.

## Runtime and Control Flow
1. `DzupEventBus` flow:
- Producers call `emit(event)`.
- Type-specific handlers registered via `on(type, handler)` run first.
- Wildcard handlers from `onAny(handler)` run for all events.
- Handler failures are isolated (sync throw and async rejection are caught and logged through `defaultLogger.error`).

2. `AgentBus` flow:
- Producers call `publish(fromAgent, channel, payload)`.
- Subscribers registered per-channel/per-agent via `subscribe(channel, agentId, handler)` receive messages.
- Messages are appended to bounded history (`maxHistory`, default `100`) before dispatch.
- Handler failures are isolated and logged.

3. Degraded signaling flow:
- Callers use `emitDegradedOperation(eventBus, subsystem, reason, recoverable?)`.
- Helper emits a `system:degraded` event with `timestamp: Date.now()` and `recoverable` defaulting to `true`.

4. Terminal tool correlation flow:
- Terminal tool event producers call `requireTerminalToolExecutionRunId(...)`.
- Function accepts direct `executionRunId` or fallback value.
- Empty/whitespace values are normalized away.
- Throws if neither value resolves to a non-empty ID.

Protocol integration detail in current code:

- `src/protocol/internal-adapter.ts` uses `AgentBus` channels keyed by extracted target agent IDs, and uses correlation channels (`__response:<id>`, `__stream:<id>`) for replies and streams.

## Key APIs and Types
`DzupEvent` (`event-types.ts`):

- Large discriminated union keyed by `type`.
- Includes categories implemented in current file: agent lifecycle, tool lifecycle, LLM/audit, memory, budget, pipeline, approvals, human-contact, adapter interactions, MCP server lifecycle, provider state, registry, identity, protocol, pipeline runtime, security, vector, telemetry, delegation, supervisor, hooks/plugins, quality loop, degraded/system operations, agent progress, recovery, execution ledger, persona registry, scheduler, skill lifecycle, workflow domain, run lifecycle/outcome scoring, mailbox, API keys, and flow compiler lifecycle.

`DzupEventBus` (`event-bus.ts`):

- `emit(event: DzupEvent): void`
- `on<T extends DzupEvent['type']>(type: T, handler: (event: DzupEventOf<T>) => void | Promise<void>): () => void`
- `once<T extends DzupEvent['type']>(type: T, handler: ...): () => void`
- `onAny(handler: (event: DzupEvent) => void | Promise<void>): () => void`

`AgentBus` (`agent-bus.ts`):

- `publish(fromAgent, channel, payload)`
- `subscribe(channel, agentId, handler)`
- `unsubscribe(channel, agentId)`
- `unsubscribeAll(agentId)`
- `getHistory(channel, limit?)`
- `listChannels()`
- `listSubscribers(channel)`

Tool-event correlation helper (`tool-event-correlation.ts`):

- `requireTerminalToolExecutionRunId(options)` for `tool:result` / `tool:error` enforcement.

## Dependencies
Direct module-level dependencies inside `src/events`:

- `event-types.ts` imports `ForgeErrorCode` type from `src/errors/error-codes.ts`.
- `event-bus.ts` and `agent-bus.ts` use `defaultLogger` from `src/utils/logger.ts`.
- `degraded-operation.ts` depends on `DzupEventBus` type.
- `tool-event-correlation.ts` has no external package dependencies.

Package-level context:

- `@dzupagent/core` has no additional runtime npm dependency specifically for the events subsystem.
- The subsystem is implemented as in-process TypeScript logic with no transport/storage dependency required by default.

## Integration Points
In-scope integrations in `packages/core`:

- `src/protocol/internal-adapter.ts`: uses `AgentBus` as in-process transport backbone.
- `src/persistence/event-log.ts`: `EventLogSink` captures all emitted events via `onAny` into an `EventLogStore`.
- `src/security/audit/audit-logger.ts`: subscribes with `onAny` and records selected event types into `ComplianceAuditStore`.
- `src/security/monitor/safety-monitor.ts`: attaches to `tool:error` and `memory:written`; emits `safety:*` events.
- `src/plugin/plugin-registry.ts`: registers plugin-declared handlers on `DzupEventBus`; emits `plugin:registered`.
- `src/registry/in-memory-registry.ts`: forwards registry events into optional `DzupEventBus`.
- `src/facades/quick-start.ts`: `createQuickAgent()` constructs and registers `eventBus` in DI container.

Public API integration surfaces in this package:

- Root entry (`src/index.ts`) and `orchestration` facade expose `AgentBus`.
- Root entry, `orchestration`, and `quick-start` expose `createEventBus` and event types.

## Testing and Observability
Direct tests in `packages/core/src/__tests__`:

- `event-bus.test.ts`: typed delivery, filtering by type, unsubscribe behavior, `once`, `onAny`, handler error isolation, multi-handler dispatch.
- `agent-bus.test.ts`: publish/subscribe behavior, channel isolation, unsubscribe/unsubscribeAll, bounded history, channel/subscriber listing, sync/async error isolation.
- `degraded-operation.test.ts`: verifies `system:degraded` payload and default `recoverable` behavior.
- `tool-event-correlation.test.ts`: verifies direct/fallback run ID resolution and throw path.
- `event-bus-flow.test.ts`: validates flow-compiler event lifecycle and ordering through `DzupEventBus`.
- `event-log.test.ts`: validates `EventLogSink` capture from event bus into in-memory log.
- `w15-h2-branch-coverage.test.ts`: additional branch coverage for bus edge cases (no handlers, wildcard unsubscribe, async rejection logging, set semantics).

Facade-level verification in scope:

- `facade-quick-start.test.ts`, `facade-orchestration.test.ts`, and `facades.test.ts` verify events APIs are exported and usable through curated subpath facades.

Observability characteristics:

- Both buses are fail-soft and log handler errors via `defaultLogger` (`console.error` by default).
- Event persistence/inspection is available through `InMemoryEventLog` + `EventLogSink` integration.

## Risks and TODOs
- `DzupEvent` is a large union maintained manually in one file. Drift risk is mainly schema governance and discoverability, not missing basic tests.
- `event-bus.ts` comments mention microtask execution, but handlers run inline; only async rejections are caught asynchronously. Comment/behavior alignment remains a maintenance risk.
- `EventLogSink` intentionally uses a minimal `EventBusLike` and fire-and-forget appends; append failures are swallowed by design, so log-write failures are not surfaced to callers.
- `registry/in-memory-registry.ts` forwards registry events with `event as DzupEvent`; this cast bypasses compile-time validation of exact event payload shape at the forwarding point.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js


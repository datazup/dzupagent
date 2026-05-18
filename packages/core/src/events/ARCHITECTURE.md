# Events Architecture (`packages/core/src/events`)

## Scope
This document describes the event subsystem implemented under `packages/core/src/events` and its immediate integration points in `packages/core`.

Primary files covered:
- `src/events/event-bus.ts`
- `src/events/agent-bus.ts`
- `src/events/event-types.ts`
- `src/events/event-types-shared.ts`
- `src/events/event-types-agent.ts`
- `src/events/event-types-llm-memory.ts`
- `src/events/event-types-orchestration.ts`
- `src/events/event-types-platform.ts`
- `src/events/event-types-domain.ts`
- `src/events/event-types-adapter.ts`
- `src/events/llm-audit-bridge.ts`
- `src/events/degraded-operation.ts`
- `src/events/tool-event-correlation.ts`
- `src/events/index.ts`

Related package entrypoints:
- `src/events.ts` (`@dzupagent/core/events` subpath)
- `src/index.ts` (root `@dzupagent/core` barrel)
- `src/facades/quick-start.ts`
- `src/facades/orchestration.ts`

Out of scope:
- persistence implementation details outside event-specific sinks
- protocol implementations other than the `AgentBus` usage surface
- package-level architecture outside this event subsystem

## Responsibilities
The subsystem provides:
- A typed, discriminated event contract (`DzupEvent`) composed from multiple domain-specific unions.
- A lightweight in-process event dispatcher (`DzupEventBus`) with `emit`, `on`, `once`, and `onAny`.
- A separate channel-based in-process message bus (`AgentBus`) used for peer-to-peer agent messaging.
- Event helper utilities:
- `attachLlmAuditEventBridge` to convert `LlmInvocationRecord` into `llm:invocation_recorded` events.
- `emitDegradedOperation` to emit consistent `system:degraded` events.
- `requireTerminalToolExecutionRunId` to enforce non-empty run correlation for terminal tool events.
- Stable export surfaces so consumers can import event primitives from:
- `@dzupagent/core`
- `@dzupagent/core/events`
- `@dzupagent/core/orchestration` (plus `AgentBus`)
- `@dzupagent/core/quick-start` (event bus only)

## Structure
| File | Purpose | Main exports |
| --- | --- | --- |
| `event-bus.ts` | Typed event bus for `DzupEvent` | `DzupEventBus`, `createEventBus`, `typedEmit` |
| `agent-bus.ts` | Channel-based peer bus with bounded in-memory history | `AgentBus`, `AgentMessage`, `AgentMessageHandler` |
| `event-types.ts` | Composes domain unions into the full event union | `DzupEvent`, `DzupEventOf`, `RunLifecycleEvent` |
| `event-types-shared.ts` | Shared payload contracts used by multiple unions | `BudgetUsage`, `LlmInvocationRecord`, `ToolStatSummary`, `AdapterRuntimeDzupEvent` |
| `event-types-agent.ts` | Agent/tool lifecycle and agent telemetry events | `AgentDomainEvent` |
| `event-types-llm-memory.ts` | LLM invocation, memory, and budget events | `LlmMemoryDomainEvent` |
| `event-types-orchestration.ts` | Flow/pipeline/approval/human-contact/MCP/provider/delegation/supervisor events | `OrchestrationDomainEvent` |
| `event-types-platform.ts` | Identity/registry/protocol/security/vector/quality/degraded/recovery/ledger events | `PlatformDomainEvent` |
| `event-types-domain.ts` | Persona/scheduler/skills/workflow/run/checkpoint/mail/api-key/flow-compiler events | `DomainLifecycleEvent` |
| `event-types-adapter.ts` | Adapter run/session/structured-output/UCL-enrichment events | `AdapterDomainEvent` |
| `llm-audit-bridge.ts` | Best-effort bridge from audit sink records to bus events | `attachLlmAuditEventBridge`, `LlmAuditSink` |
| `degraded-operation.ts` | Helper for degraded-mode event emission | `emitDegradedOperation` |
| `tool-event-correlation.ts` | Non-empty run-id enforcement for terminal tool events | `requireTerminalToolExecutionRunId`, `TerminalToolEventType`, `TerminalToolExecutionRunIdOptions` |
| `index.ts` | Local event barrel for internal imports | re-exports of event bus/types/helpers |

## Runtime and Control Flow
1. `DzupEventBus` dispatch flow (`event-bus.ts`):
- `emit(event)` looks up type-specific handlers, executes them, then executes wildcard handlers (`onAny`).
- Both synchronous exceptions and async promise rejections from handlers are caught and logged via `defaultLogger`.
- `once(type, handler)` wraps and self-unsubscribes before invoking the handler.

2. Optional call-site typing helper:
- `typedEmit(bus, event)` is a guarded wrapper (`bus?.emit(event)`) used to preserve union typing at call sites without manual casts.

3. `AgentBus` message flow (`agent-bus.ts`):
- `publish(fromAgent, channel, payload)` creates a timestamped `AgentMessage`, appends to shared history, trims to `maxHistory` (default `100`), and notifies channel subscribers.
- Subscriber exceptions and async rejections are isolated/logged and do not block delivery to other subscribers.
- Subscriptions are keyed by channel and subscriber agent id.

4. Protocol usage of `AgentBus` (`protocol/internal-adapter.ts`):
- `send()` extracts target agent id from `ForgeMessage.to`, publishes envelope payload to that target channel, and waits on `__response:<message.id>`.
- `stream()` publishes similarly and consumes responses on `__stream:<message.id>` until `stream_end`.
- `subscribe()` maps incoming channel payloads back to `ForgeMessage` and optionally publishes handler responses to correlation channels.

5. Helper flows:
- `attachLlmAuditEventBridge(bus)` returns an `LlmAuditSink` that emits `{ type: 'llm:invocation_recorded', ...record }` and swallows/logs emission failures.
- `emitDegradedOperation(...)` emits `system:degraded` with `timestamp: Date.now()` and default `recoverable: true`.
- `requireTerminalToolExecutionRunId(...)` normalizes/trim-checks direct and fallback run ids and throws when neither is usable.

## Key APIs and Types
Core APIs:
- `createEventBus(): DzupEventBus`
- `typedEmit(bus: DzupEventBus | undefined, event: DzupEvent): void`
- `attachLlmAuditEventBridge(bus, logger?): LlmAuditSink`
- `emitDegradedOperation(eventBus, subsystem, reason, recoverable?): void`
- `requireTerminalToolExecutionRunId(options): string`

`DzupEventBus` API:
- `emit(event)`
- `on(type, handler)`
- `once(type, handler)`
- `onAny(handler)`

`AgentBus` API:
- `publish(fromAgent, channel, payload)`
- `subscribe(channel, agentId, handler)`
- `unsubscribe(channel, agentId)`
- `unsubscribeAll(agentId)`
- `getHistory(channel, limit?)`
- `listChannels()`
- `listSubscribers(channel)`

Type model:
- `DzupEvent` is the union of:
- `AgentDomainEvent`
- `LlmMemoryDomainEvent`
- `OrchestrationDomainEvent`
- `PlatformDomainEvent`
- `DomainLifecycleEvent`
- `AdapterDomainEvent`
- `DzupEventOf<T>` narrows by `type` discriminator.
- `RunLifecycleEvent` narrows `adapter:run_*` events from `RunStatus`.
- Shared cross-cutting payloads include:
- `LlmInvocationRecord`
- `BudgetUsage`
- `ToolStatSummary`
- `AdapterProgressDzupEvent`
- `MapReduceDzupEvent`

## Dependencies
Direct imports inside `src/events/*` are internal package dependencies:
- `../utils/logger.js` (`defaultLogger`, `FrameworkLogger`) used by bus implementations and audit bridge.
- `../errors/error-codes.js` (`ForgeErrorCode`) used by agent event typing.
- `../tools/permission-tier.js` (`PermissionTier`) used by agent tool-filtering event typing.
- `../persistence/store-interfaces.js` (`RunStatus`) used by adapter run lifecycle typings.

Package runtime dependencies declared in `packages/core/package.json`:
- `@dzupagent/agent-types`
- `@dzupagent/runtime-contracts`
- `@dzupagent/security`

There are no direct third-party imports in `src/events/*`.

## Integration Points
Current in-package integrations include:
- `src/facades/quick-start.ts`: `createQuickAgent()` creates and registers a shared `DzupEventBus` in the DI container.
- `src/protocol/internal-adapter.ts`: uses `AgentBus` for in-process transport and correlation channels.
- `src/persistence/event-log.ts`: `EventLogSink.attach()` subscribes via `onAny` and appends all events to an `EventLogStore`.
- `src/security/audit/audit-logger.ts`: `ComplianceAuditLogger.attach()` subscribes via `onAny`, maps selected event types to audit actions, and redacts tool payload fields.
- `src/security/monitor/safety-monitor.ts`: subscribes to `tool:error` and `memory:written`; emits `safety:violation`, `safety:blocked`, and `safety:kill_requested`.
- `src/plugin/plugin-registry.ts`: wires plugin event handlers through `eventBus.on(...)` and emits `plugin:registered`.
- `src/registry/in-memory-registry-events.ts`: fans out registry events to local subscribers and optionally forwards them to the shared `DzupEventBus`.
- `src/mcp/mcp-manager.ts`: emits MCP lifecycle and test events (`mcp:server_*`, `mcp:test_*`) when an event bus is configured.
- `src/hooks/hook-runner.ts`: emits `hook:error` when hook execution fails.

## Testing and Observability
Direct subsystem tests:
- `src/__tests__/event-bus.test.ts`
- `src/__tests__/agent-bus.test.ts`
- `src/__tests__/event-bus-flow.test.ts`
- `src/__tests__/llm-audit-event.test.ts`
- `src/__tests__/degraded-operation.test.ts`
- `src/__tests__/tool-event-correlation.test.ts`

Related integration/behavior coverage:
- `src/__tests__/event-log.test.ts` validates event capture through `EventLogSink`.
- `src/__tests__/compliance-audit.test.ts` validates audit logging behavior from event bus events.
- `src/__tests__/security-monitor.test.ts` validates monitor subscriptions and emitted safety events.
- `src/__tests__/protocol/adapters.test.ts` validates `AgentBus` behavior through `InternalAdapter`.
- `src/__tests__/facade-quick-start.test.ts`, `src/__tests__/facade-orchestration.test.ts`, `src/__tests__/facades.test.ts`, and `src/__tests__/w15-b1-facades.test.ts` validate export and facade wiring.
- `src/__tests__/w15-h2-branch-coverage.test.ts` adds branch coverage for event-bus and agent-bus edge paths.

Observability characteristics:
- Event and message buses are fail-soft: handler failures are logged and isolated to preserve caller progress.
- `onAny` is the central fan-out seam used by event log and audit sinks.
- Persistence/retention is handled by downstream consumers (`EventLogSink` + `EventLogStore`), not by `src/events/*` directly.

## Risks and TODOs
- `event-bus.ts` comments still claim microtask async execution, but handlers currently execute inline (with async rejection catch only). Documentation and implementation are out of sync.
- `DzupEvent` is a large manually maintained union across many files, so discriminator/payload drift remains a maintenance risk.
- `dispatchRegistryEvent` forwards registry events with `event as DzupEvent`, which bypasses strict compile-time compatibility at that boundary.
- `EventLogSink.attach()` intentionally fire-and-forget appends and swallows write failures; event loss can be silent.
- `AgentBus` uses a single shared history array and channel filtering on reads, which can become inefficient with high message volume and many channels.
- `attachLlmAuditEventBridge`, `emitDegradedOperation`, and `requireTerminalToolExecutionRunId` are used in exports and tests, but currently have no in-package production call sites outside tests/docs.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

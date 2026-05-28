# Adapter Architecture: Codex Boundary and Tool-Loop Parity

This document defines the boundary between the adapter layer and agent core for tool-loop behavior, using the OpenAI adapter + orchestrator facade as the concrete reference implementation.

## Why this exists

P007a implemented tool-loop parity prerequisites in the adapter/facade path:
- provider tool-call IDs are preserved as `toolCallId` on `adapter:tool_call` events
- facade streaming can carry those events end-to-end
- tool-call/tool-result correlation is verifiable through `ToolSpanTracker`

P007b will finalize facade-level API semantics for tool result ingestion and app-facing loop ergonomics.

## Layer Boundary

### Adapter layer responsibilities (`packages/agent-adapters/src/**`)

The adapter layer is responsible for provider protocol translation, not business orchestration.

It owns:
- provider request/response wiring (HTTP/SSE/CLI SDK specifics)
- parsing provider-native tool call structures
- emitting unified `AgentEvent` / `AgentStreamEvent` variants
- preserving provider correlation fields (`toolCallId`, session IDs, usage)
- provider-specific normalization and streaming assembly

It does **not** own:
- product workflows, task/project semantics, personas, tenant policy
- long-lived memory policy decisions
- app UX around approvals, operator actions, or workflow DSL authoring

Concrete example:
- `packages/agent-adapters/src/openai/openai-tool-calls.ts`
  - `processSseChoice(...)` accumulates streaming fragments
  - `flush(...)` emits normalized `adapter:tool_call` events
  - OpenAI `call.id` is forwarded as `toolCallId`

### Agent core responsibilities (`packages/agent/**`, core orchestration primitives)

Agent core is responsible for orchestration and execution policy above provider protocols.

It owns:
- routing/orchestration strategies (single-run, parallel, supervisor, map-reduce, contract-net)
- memory/history policy and workflow/session lifecycle
- guardrails, approvals, retries/fallback policy
- app-level contract shaping for interactive tool loops

It does **not** parse raw provider wire formats.

## Facade vs Adapter

- **Adapter**: a provider implementation (`OpenAIAdapter`, `ClaudeAdapter`, etc.) that turns provider-native streams into unified events.
- **Facade**: orchestration entrypoint (`packages/agent-adapters/src/facade/orchestrator-facade.ts`) that routes requests through registry + pipeline + session handling and yields streamed events.

In practice:
1. `OrchestratorFacade.chatWithRaw(...)` delegates to `executeChatWithRaw(...)`.
2. `executeChatWithRaw(...)` routes through:
   - `ProviderAdapterRegistry.executeWithFallbackWithRaw(...)`
   - `EventBusBridge.bridgeWithRaw(...)`
   - `AdapterPipeline.wrapStream(...)`
3. The selected adapter emits normalized events.

The facade coordinates execution; adapters define provider translation semantics.

## Tool Call Emission Flow (OpenAI -> `toolCallId` -> AgentStreamEvent)

OpenAI streaming chunks deliver `tool_calls[]` deltas with `index`, `id`, and `function.arguments` fragments.

Reference path:
- `packages/agent-adapters/src/openai/openai-adapter.ts`
- `packages/agent-adapters/src/openai/openai-tool-calls.ts`

Flow details:
1. `OpenAIAdapter.mapRawEvent(...)` receives SSE chunk choices.
2. `OpenAIToolCallAccumulator.processSseChoice(...)` merges per-index fragments.
3. On `finish_reason === 'tool_calls'` (or final flush), `flush(...)` emits:
   - `type: 'adapter:tool_call'`
   - `toolName: <function.name>`
   - `input: <parsed function.arguments>`
   - `toolCallId: <OpenAI call.id>` when provided
4. These events become part of the facade stream (`chatWithRaw`) as `AgentStreamEvent` items.

## Tool Result Consumption and Correlation

Current P007a parity contract is event-level correlation, proven in tests.

### Correlation mechanism

`ToolSpanTracker` (`packages/agent-adapters/src/observability/tool-span-tracker.ts`) correlates call/result pairs:
- primary key: explicit call ID (`toolCallId`, plus compatible aliases)
- fallback: FIFO by `toolName` when no call ID is available

This ensures concurrent calls to the same tool can still be matched reliably when IDs are present.

### Proven round-trip behavior

Reference test:
- `packages/agent-adapters/src/__tests__/orchestrator-facade.test.ts`
- test case: `roundtrip: toolCallId propagates through adapter emit and consume`

The test proves:
1. OpenAI SSE `tool_calls[].id = "test-id-123"`
2. adapter emits `adapter:tool_call` with `toolCallId: "test-id-123"`
3. a corresponding `adapter:tool_result` carrying the same `toolCallId` is consumed by `ToolSpanTracker.take(...)`
4. the original span is resolved (call/result correlation succeeds)

## Emit -> Capture -> Consume Pipeline

```text
Provider (OpenAI SSE)
  tool_calls[index,id,function{ name, arguments... }]
           |
           v
OpenAIAdapter.mapRawEvent()
  -> OpenAIToolCallAccumulator.processSseChoice()
  -> flush() emits adapter:tool_call { toolCallId, toolName, input }
           |
           v
OrchestratorFacade.chatWithRaw()
  -> registry.executeWithFallbackWithRaw()
  -> bridgeWithRaw()
  -> pipeline.wrapStream()
           |
           v
AgentStreamEvent consumer
  - captures adapter:tool_call
  - later emits/receives adapter:tool_result with same toolCallId
           |
           v
ToolSpanTracker.take(tool_result)
  -> correlated call/result span
```

## P007a / P007b Split

### P007a (implemented)

- OpenAI adapter forwards provider call IDs to `toolCallId` in emitted tool-call events.
- Facade stream path preserves those events.
- Round-trip correlation is test-proven via `ToolSpanTracker` in facade tests.

### P007b (next)

- Finalize app-facing/facade contract for tool result ingestion semantics.
- Lock down any additional API shape needed for first-class tool loop handling beyond event-level parity.
- Keep provider-specific parsing in adapters; keep orchestration policy and UX semantics above the adapter boundary.

## Code References

- `packages/agent-adapters/src/openai/openai-tool-calls.ts`
  - `OpenAIToolCallAccumulator.flush(...)` is the adapter emit path for normalized `adapter:tool_call` events.
  - The emitted object includes `toolCallId: call.id` when OpenAI provides an ID.
- `packages/agent-adapters/src/facade/orchestrator-facade.ts`
  - `OrchestratorFacade.chatWithRaw(...)` is the facade stream entrypoint that preserves adapter-emitted events.
- `packages/agent-adapters/src/__tests__/orchestrator-facade.test.ts`
  - `roundtrip: toolCallId propagates through adapter emit and consume` proves tool-call/tool-result correlation through the facade path.

## Contributor guidance

When adding a new adapter or updating tool behavior:
- preserve provider call IDs as `toolCallId` whenever the provider exposes them
- emit `adapter:tool_call` only with a resolved `toolName`
- keep provider wire parsing in adapter files; do not move it into facade/core orchestration modules
- validate parity with a stream-level round-trip test (emit -> facade stream -> correlated result)

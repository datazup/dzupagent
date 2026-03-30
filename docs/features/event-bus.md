# DzipEventBus

The `DzipEventBus` is the central nervous system of `dzipagent`. It provides a typed, asynchronous, and fire-and-forget event system for monitoring, logging, and reacting to agent activities across all packages.

## Overview

The event bus is used to decouple core agent logic from side effects like telemetry, UI updates (in the playground), and third-party integrations.

```ts
import { createEventBus } from '@dzipagent/core';

const bus = createEventBus();

// Subscribe to specific events
bus.on('agent:started', (e) => {
  console.log(`Agent ${e.agentId} started run ${e.runId}`);
});

// Subscribe to ALL events
bus.onAny((e) => {
  trackTelemetry(e.type, e);
});
```

## Key Features

- **Strict Typing**: All events are defined in a discriminated union, providing full IDE completion and type safety for event payloads.
- **Async Resilience**: Handlers are executed safely. Errors in handlers (both synchronous and asynchronous) are caught and logged without crashing the main agent loop.
- **Wildcard Subscriptions**: The `onAny` method allows for global observers, which is useful for debugging and centralized logging.
- **Fire-and-Forget**: Emitting an event is non-blocking, ensuring that monitoring doesn't introduce latency to the agent's reasoning loop.

## Event Categories

### Agent Lifecycle
- `agent:started`, `agent:completed`, `agent:failed`
- `agent:stream_delta`, `agent:stream_done`

### Tool Execution
- `tool:called`, `tool:result`, `tool:error`
- `tool:latency` (telemetry-focused)

### Memory Operations
- `memory:written`, `memory:searched`, `memory:error`
- `memory:threat_detected`, `memory:quarantined` (security-focused)

### Guardrails and Budgets
- `budget:warning`, `budget:exceeded`
- `agent:stuck_detected`

### Infrastructure
- `mcp:connected`, `mcp:disconnected`
- `provider:failed`, `provider:circuit_opened`

## Integration with DzipAgent

When creating a `DzipAgent`, you can pass an `eventBus` instance in the configuration. The agent will then automatically emit relevant lifecycle and execution events.

```ts
const agent = new DzipAgent({
  name: 'MonitoringAgent',
  eventBus: myGlobalBus
});
```

## Best Practices

1. **Avoid Heavy Logic in Handlers**: Since handlers run on the same process, keeping them lightweight ensures they don't block the event loop.
2. **Use `once()` for Single Responses**: Use `once()` when you only care about the first occurrence of an event (e.g., waiting for an agent to start).
3. **Namespace Your Listeners**: If building a plugin system, consider wrapping the bus or prefixing your logic to avoid handler leaks.

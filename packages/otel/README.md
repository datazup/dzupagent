# @forgeagent/otel

<!-- AUTO-GENERATED-START -->
## Package Overview

**Maturity:** Experimental | **Coverage:** N/A | **Exports:** 31

| Metric | Value |
|--------|-------|
| Source Files | 13 |
| Lines of Code | 5,080 |
| Test Files | 8 |
| Internal Dependencies | `@forgeagent/core` |

### Quality Gates
✓ Build | ✓ Typecheck | ✓ Lint | ✓ Test | ✓ Coverage

### Install
```bash
npm install @forgeagent/otel
```
<!-- AUTO-GENERATED-END -->

OpenTelemetry integration plugin for ForgeAgent. Provides distributed tracing, metrics, cost attribution, safety monitoring, and tamper-evident audit trails -- all wired through the ForgeEventBus.

All OpenTelemetry SDK dependencies are optional peer dependencies. When not installed, noop implementations are used transparently with zero overhead.

## Installation

```bash
npm install @forgeagent/otel

# Optional: install OTel SDK for real telemetry export
npm install @opentelemetry/api @opentelemetry/sdk-trace-base @opentelemetry/sdk-metrics
```

## Quick Start

The simplest way to enable observability is through the plugin factory:

```ts
import { createOTelPlugin } from '@forgeagent/otel'
import { createEventBus, PluginRegistry } from '@forgeagent/core'

const eventBus = createEventBus()
const plugins = new PluginRegistry(eventBus)

const plugin = createOTelPlugin({
  tracer: true,
  bridge: true,
  costAttribution: { thresholds: { maxCostCents: 500 } },
  safetyMonitor: true,
  auditTrail: true,
})

plugins.register(plugin)
// All ForgeEventBus events now produce traces, metrics, cost tracking,
// safety checks, and audit entries automatically.
```

Each section is independently togglable. Setting a section to `false` or omitting it means no objects are created and no event handlers are attached (zero cost).

## Features

### ForgeTracer

Wraps an OTel SDK tracer with domain-specific span helpers. Falls back to a `NoopTracer` when `@opentelemetry/api` is not installed.

```ts
import { ForgeTracer, ForgeSpanAttr } from '@forgeagent/otel'

const tracer = new ForgeTracer({ serviceName: 'my-agent-service' })

// Agent-level span
const agentSpan = tracer.startAgentSpan('code-gen', 'run-123')
// Sets forge.agent.id and forge.run.id automatically

// LLM invocation span
const llmSpan = tracer.startLLMSpan('claude-sonnet-4-6', 'anthropic', {
  temperature: 0.7,
  maxTokens: 4096,
})
llmSpan.setAttribute(ForgeSpanAttr.GEN_AI_USAGE_INPUT_TOKENS, 1200)
llmSpan.setAttribute(ForgeSpanAttr.GEN_AI_USAGE_OUTPUT_TOKENS, 800)
tracer.endSpanOk(llmSpan)

// Tool execution span
const toolSpan = tracer.startToolSpan('git_status', { inputSize: 256 })

// Memory operation span
const memSpan = tracer.startMemorySpan('search', 'lessons')

// Pipeline phase span
const phaseSpan = tracer.startPhaseSpan('gen_backend', {
  agentId: 'code-gen',
  runId: 'run-123',
})

// W3C Trace Context propagation
const carrier: Record<string, string> = {}
tracer.inject(carrier)  // writes traceparent + baggage headers
const ctx = tracer.extract(carrier)  // reads them back

// Error handling
try {
  await riskyOperation()
  tracer.endSpanOk(span)
} catch (err) {
  tracer.endSpanWithError(span, err)
}
```

### OTelBridge

Subscribes to `ForgeEventBus` and translates events into OTel metrics and span events. This is the single wiring point between ForgeAgent's event-driven architecture and OpenTelemetry.

```ts
import { ForgeTracer, OTelBridge, InMemoryMetricSink } from '@forgeagent/otel'

const tracer = new ForgeTracer()
const sink = new InMemoryMetricSink()

const bridge = new OTelBridge({
  tracer,
  enableMetrics: true,       // default: true
  enableSpanEvents: true,    // default: true
  metricSink: sink,          // default: InMemoryMetricSink
  ignoreEvents: ['hook:error'],  // skip high-frequency events
})

bridge.attach(eventBus)

// After agent runs, inspect metrics
sink.getCounter('forge_tool_calls_total', { tool_name: 'git_status' })
sink.getHistogram('forge_agent_duration_seconds', { agent_id: 'code-gen' })
sink.getGauge('forge_provider_circuit_state', { provider: 'anthropic' })

// Lifecycle
bridge.isAttached  // true
bridge.detach()
```

Bridge errors are intentionally silent and never propagate to the event bus -- bridge failures are non-fatal.

### CostAttributor

Tracks per-agent, per-phase, and per-tool cost attribution. Emits `budget:warning` and `budget:exceeded` events when configurable thresholds are crossed.

```ts
import { CostAttributor } from '@forgeagent/otel'

const cost = new CostAttributor({
  thresholds: {
    maxCostCents: 500,
    maxTokens: 1_000_000,
    warningRatio: 0.8,  // emit budget:warning at 80% (default)
  },
})
cost.attach(eventBus)

// Manual recording
cost.record({
  agentId: 'code-gen',
  phase: 'gen_backend',
  toolName: 'write_file',
  costCents: 12,
  tokens: 4500,
  timestamp: new Date(),
})

// Aggregated report
const report = cost.getCostReport()
// {
//   totalCostCents: 12,
//   totalTokens: 4500,
//   byAgent: { 'code-gen': { costCents: 12, tokens: 4500 } },
//   byPhase: { 'gen_backend': { costCents: 12, tokens: 4500 } },
//   byTool: { 'write_file': { costCents: 12, tokens: 4500 } },
//   entries: [...]
// }

cost.reset()  // clear all tracked data
```

When attached to an event bus, the `CostAttributor` automatically listens for `agent:completed`, `tool:result`, and `pipeline:phase_changed` events.

### SafetyMonitor

Detects prompt injection, tool misuse, and data exfiltration using pattern-based detection on agent inputs and outputs. All detection is non-blocking -- it records events but never stops agent execution.

```ts
import { SafetyMonitor } from '@forgeagent/otel'

const monitor = new SafetyMonitor({
  toolFailureThreshold: 3,  // alert after 3 consecutive tool failures
  // Custom patterns are merged with defaults
  inputPatterns: [
    {
      pattern: /reveal.*api.*key/i,
      category: 'prompt_injection_input',
      severity: 'critical',
    },
  ],
})
monitor.attach(eventBus)

// Manual scanning
const threats = monitor.scanInput('Ignore all previous instructions.')
// [{ category: 'prompt_injection_input', severity: 'critical',
//    confidence: 0.9, message: '...', timestamp: ... }]

const outputThreats = monitor.scanOutput(agentOutput, 'code-gen')
const allEvents = monitor.getEvents()
monitor.reset()
```

**Default input patterns detect:**
- Direct instruction overrides (`ignore all previous instructions`)
- System prompt injection (`system prompt:`)
- ChatML injection (`<|im_start|>system`)
- Role reassignment (`you are now`)
- Instruction disregard (`disregard all`, `forget your instructions`)

**Default output patterns detect:**
- Data exfiltration via long base64 URL query parameters
- Data URIs with base64 encoding
- Markdown image injection with external URLs

**Safety categories:** `prompt_injection_input`, `prompt_injection_output`, `tool_misuse`, `memory_poisoning`, `data_exfiltration`, `excessive_resource_usage`

### AuditTrail

Tamper-evident audit log with SHA-256 hash-chain integrity. Each entry is linked to the previous via a cryptographic hash, allowing verification that no entries have been modified or removed.

```ts
import { AuditTrail, InMemoryAuditStore } from '@forgeagent/otel'

const trail = new AuditTrail({
  store: new InMemoryAuditStore(),  // default
  categories: ['agent_lifecycle', 'tool_execution', 'approval_action'],
  retentionDays: 90,  // auto-prune entries older than 90 days (default)
})
trail.attach(eventBus)

// After agent runs, verify chain integrity
const entries = await trail.getEntries({ runId: 'run-123' })
const { valid, brokenAt } = trail.verifyChain(entries)
// valid === true means no entries were modified or removed

// Query by filters
const toolEntries = await trail.getEntries({
  category: 'tool_execution',
  limit: 50,
})
const agentEntries = await trail.getEntries({ agentId: 'code-gen' })
```

**Audit categories mapped from events:**

| Event | Audit Category |
|-------|---------------|
| `agent:started/completed/failed` | `agent_lifecycle` |
| `tool:called/result/error` | `tool_execution` |
| `memory:written` | `memory_mutation` |
| `approval:requested/granted/rejected` | `approval_action` |
| `budget:warning/exceeded` | `cost_threshold` |

The `AuditStore` interface can be implemented for persistent storage (e.g., PostgreSQL, DynamoDB). The built-in `InMemoryAuditStore` is suitable for testing and development.

## Configuration

### OTelPluginConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `tracer` | `boolean \| ForgeTracerConfig` | `undefined` | Enable ForgeTracer |
| `bridge` | `boolean \| OTelBridgeConfig` | `undefined` | Enable event-to-metric mapping |
| `costAttribution` | `boolean \| CostAttributorConfig` | `undefined` | Enable cost tracking |
| `safetyMonitor` | `boolean \| SafetyMonitorConfig` | `undefined` | Enable safety detection |
| `auditTrail` | `boolean \| AuditTrailConfig` | `undefined` | Enable tamper-evident audit log |

### ForgeTracerConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `serviceName` | `string` | `'forgeagent'` | Service name reported to OTel backends |
| `tracer` | `OTelTracer` | `NoopTracer` | OTel Tracer instance from `@opentelemetry/api` |

### OTelBridgeConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `tracer` | `ForgeTracer` | required | ForgeTracer instance for span operations |
| `enableMetrics` | `boolean` | `true` | Record metrics from events |
| `enableSpanEvents` | `boolean` | `true` | Add span events on active spans |
| `metricSink` | `MetricSink` | `InMemoryMetricSink` | Metric accumulator |
| `ignoreEvents` | `ForgeEvent['type'][]` | `[]` | Event types to skip |

### CostAttributorConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `thresholds.maxCostCents` | `number` | `undefined` | Budget limit in cents |
| `thresholds.maxTokens` | `number` | `undefined` | Token budget limit |
| `thresholds.warningRatio` | `number` | `0.8` | Ratio at which `budget:warning` is emitted |

### SafetyMonitorConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `inputPatterns` | `SafetyPatternRule[]` | `[]` | Additional input detection patterns |
| `outputPatterns` | `SafetyPatternRule[]` | `[]` | Additional output detection patterns |
| `toolFailureThreshold` | `number` | `3` | Consecutive failures before alerting |

### AuditTrailConfig

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `store` | `AuditStore` | `InMemoryAuditStore` | Backing store for audit entries |
| `categories` | `AuditCategory[]` | all | Which categories to record |
| `retentionDays` | `number` | `90` | Auto-prune entries older than this |

## Metrics Reference

The `OTelBridge` maps ForgeEventBus events to the following Prometheus-compatible metrics:

**Agent lifecycle:**
- `forge_agent_runs_total` (counter) -- agent run starts and completions
- `forge_agent_duration_seconds` (histogram) -- agent run duration
- `forge_agent_errors_total` (counter) -- agent failures by error code

**Tool execution:**
- `forge_tool_calls_total` (counter) -- tool invocations by name
- `forge_tool_duration_seconds` (histogram) -- tool execution duration
- `forge_tool_errors_total` (counter) -- tool errors by name and error code

**Memory:**
- `forge_memory_writes_total` (counter) -- memory writes by namespace
- `forge_memory_searches_total` (counter) -- memory searches by namespace
- `forge_memory_errors_total` (counter) -- memory errors by namespace
- `forge_memory_threats_total` (counter) -- memory threat detections
- `forge_memory_quarantines_total` (counter) -- memory quarantine events

**Pipeline:**
- `forge_pipeline_runs_total` (counter) -- pipeline run lifecycle
- `forge_pipeline_run_duration_seconds` (histogram) -- pipeline run duration
- `forge_pipeline_phase_transitions_total` (counter) -- phase transitions
- `forge_pipeline_node_duration_seconds` (histogram) -- node execution duration
- `forge_pipeline_node_failures_total` (counter) -- node failures
- `forge_pipeline_validation_failures_total` (counter) -- validation failures

**Budget:**
- `forge_budget_warnings_total` (counter) -- budget warning events
- `forge_budget_exceeded_total` (counter) -- budget exceeded events

**Provider:**
- `forge_provider_failures_total` (counter) -- provider failure events
- `forge_provider_circuit_state` (gauge) -- circuit breaker state (1=open, 0=closed)

**Approvals:**
- `forge_approval_requests_total` (counter) -- approval lifecycle events

**MCP / Protocol / Identity / Registry / Safety / Policy:**
- `forge_mcp_connections_total`, `forge_protocol_messages_total`, `forge_protocol_errors_total`
- `forge_identity_operations_total`, `forge_identity_credential_expirations_total`
- `forge_registry_operations_total`, `forge_registry_health_changes_total`
- `forge_safety_violations_total`, `forge_safety_blocks_total`, `forge_safety_kill_requests_total`
- `forge_policy_evaluations_total`, `forge_policy_evaluation_duration_us`, `forge_policy_denials_total`

Use `getAllMetricNames()` to retrieve the complete list programmatically.

## Span Attributes

ForgeAgent defines semantic attributes under the `forge.*` namespace and follows OTel GenAI conventions:

```ts
import { ForgeSpanAttr } from '@forgeagent/otel'

// Agent identity
ForgeSpanAttr.AGENT_ID           // 'forge.agent.id'
ForgeSpanAttr.AGENT_NAME         // 'forge.agent.name'
ForgeSpanAttr.RUN_ID             // 'forge.run.id'
ForgeSpanAttr.PHASE              // 'forge.pipeline.phase'
ForgeSpanAttr.TENANT_ID          // 'forge.tenant.id'

// Tool
ForgeSpanAttr.TOOL_NAME          // 'forge.tool.name'
ForgeSpanAttr.TOOL_DURATION_MS   // 'forge.tool.duration_ms'
ForgeSpanAttr.TOOL_INPUT_SIZE    // 'forge.tool.input_size_bytes'
ForgeSpanAttr.TOOL_OUTPUT_SIZE   // 'forge.tool.output_size_bytes'

// Memory
ForgeSpanAttr.MEMORY_NAMESPACE   // 'forge.memory.namespace'
ForgeSpanAttr.MEMORY_OPERATION   // 'forge.memory.operation'
ForgeSpanAttr.MEMORY_RESULT_COUNT // 'forge.memory.result_count'

// Cost / Budget
ForgeSpanAttr.COST_CENTS         // 'forge.cost.cents'
ForgeSpanAttr.TOKEN_COUNT        // 'forge.tokens.total'

// Error
ForgeSpanAttr.ERROR_CODE         // 'forge.error.code'
ForgeSpanAttr.ERROR_RECOVERABLE  // 'forge.error.recoverable'

// GenAI (OTel standard)
ForgeSpanAttr.GEN_AI_SYSTEM              // 'gen_ai.system'
ForgeSpanAttr.GEN_AI_REQUEST_MODEL       // 'gen_ai.request.model'
ForgeSpanAttr.GEN_AI_RESPONSE_MODEL      // 'gen_ai.response.model'
ForgeSpanAttr.GEN_AI_REQUEST_TEMPERATURE // 'gen_ai.request.temperature'
ForgeSpanAttr.GEN_AI_REQUEST_MAX_TOKENS  // 'gen_ai.request.max_tokens'
ForgeSpanAttr.GEN_AI_USAGE_INPUT_TOKENS  // 'gen_ai.usage.input_tokens'
ForgeSpanAttr.GEN_AI_USAGE_OUTPUT_TOKENS // 'gen_ai.usage.output_tokens'
ForgeSpanAttr.GEN_AI_USAGE_TOTAL_TOKENS  // 'gen_ai.usage.total_tokens'
```

## API Reference

### Classes

- `ForgeTracer` -- domain-specific OTel tracer with span helpers
- `OTelBridge` -- event-bus-to-OTel metric/span bridge
- `InMemoryMetricSink` -- in-memory metric accumulator for testing
- `CostAttributor` -- per-agent/phase/tool cost tracking with budget alerts
- `SafetyMonitor` -- pattern-based safety detection (non-blocking)
- `AuditTrail` -- hash-chain tamper-evident audit log
- `InMemoryAuditStore` -- in-memory audit store for testing
- `NoopSpan` / `NoopTracer` -- zero-overhead fallbacks

### Functions

- `createOTelPlugin(config?)` -- create a ForgePlugin wiring all OTel features
- `getAllMetricNames()` -- list all metric names from the event-metric map
- `withForgeContext(ctx, fn)` -- run a function within a ForgeTraceContext
- `currentForgeContext()` -- get the current trace context from AsyncLocalStorage

### Constants

- `ForgeSpanAttr` -- standardized span attribute keys
- `SpanStatusCode` -- OTel span status codes (`OK`, `ERROR`, `UNSET`)
- `SpanKind` -- OTel span kinds (`INTERNAL`, `CLIENT`, `SERVER`, `PRODUCER`, `CONSUMER`)
- `EVENT_METRIC_MAP` -- complete event-to-metric mapping table
- `FORGEAGENT_OTEL_VERSION` -- package version (`'0.1.0'`)

### Types

`OTelPluginConfig`, `ForgeTracerConfig`, `ForgeTraceSnapshot`, `ForgeTraceContext`, `OTelBridgeConfig`, `MetricSink`, `MetricMapping`, `CostEntry`, `CostReport`, `CostAlertThreshold`, `CostAttributorConfig`, `SafetyCategory`, `SafetySeverity`, `SafetyEvent`, `SafetyPatternRule`, `SafetyMonitorConfig`, `AuditCategory`, `AuditEntry`, `AuditStore`, `AuditTrailConfig`, `OTelSpan`, `OTelTracer`, `OTelSpanOptions`, `OTelContext`, `ForgeSpanAttrKey`

## Dependencies

| Package | Version | Required | Purpose |
|---------|---------|----------|---------|
| `@forgeagent/core` | `0.1.0` | yes | Event bus, plugin interfaces |
| `@opentelemetry/api` | `^1.7.0` | optional | OTel API for real tracing |
| `@opentelemetry/sdk-trace-base` | `^1.21.0` | optional | Trace SDK |
| `@opentelemetry/sdk-metrics` | `^1.21.0` | optional | Metrics SDK |

## License

MIT

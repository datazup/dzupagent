# @dzupagent/agent-adapters Architecture

## 1. Overview

`@dzupagent/agent-adapters` is the optional adapter layer that integrates external AI agent CLIs and SDKs (Claude, Codex, Gemini, Qwen, Crush) into the DzupAgent framework. It provides a unified event-streaming interface, multi-provider routing and fallback, orchestration patterns, structured output, approvals, recovery, and workflow composition.

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Application Layer                        │
│  OrchestratorFacade · createOrchestrator · AdapterRegistry   │
├──────────────────────────────────────────────────────────────┤
│                     Routing Layer                            │
│  TagBasedRouter · CapabilityRouter · ContextAwareRouter      │
│  CostOptimizedRouter · RoundRobinRouter · CompositeRouter    │
├──────────────────────────────────────────────────────────────┤
│                    Orchestration Layer                       │
│  ParallelExecutor · SupervisorOrchestrator                   │
│  MapReduceOrchestrator · ContractNetOrchestrator             │
├──────────────────────────────────────────────────────────────┤
│                     Adapter Layer                            │
│  ClaudeAgentAdapter · CodexAdapter · GeminiCLIAdapter        │
│  QwenAdapter · CrushAdapter · OpenRouterAdapter              │
├──────────────────────────────────────────────────────────────┤
│                   Cross-Cutting Concerns                     │
│  Guardrails · Approvals · Recovery · Cost Tracking           │
│  Observability · Sessions · Checkpoints · Skills             │
└──────────────────────────────────────────────────────────────┘
```

## 3. Core Abstractions

### AgentCLIAdapter (interface)
The primary contract all adapters implement:
- `execute(input): AsyncGenerator<AgentEvent>` — start a new agent run
- `resumeSession(sessionId, input)` — resume a previous session
- `interrupt()` — abort the current run
- `healthCheck()` — verify provider availability
- `configure(config)` — merge runtime config
- `getCapabilities()` — declare provider feature flags

### AgentEvent (discriminated union)
All adapters emit normalized events:
- `adapter:started` — run began
- `adapter:message` — assistant turn
- `adapter:tool_call` — tool invocation
- `adapter:tool_result` — tool response
- `adapter:stream_delta` — streaming token
- `adapter:completed` — run finished
- `adapter:failed` — run errored

## 4. Provider Adapters

| Class | Provider | Transport |
|---|---|---|
| `ClaudeAgentAdapter` | Anthropic Claude | `@anthropic-ai/claude-agent-sdk` |
| `CodexAdapter` | OpenAI Codex | `@openai/codex-sdk` |
| `GeminiCLIAdapter` | Google Gemini | `gemini` CLI subprocess |
| `QwenAdapter` | Alibaba Qwen | OpenAI-compatible endpoint / CLI |
| `CrushAdapter` | Crush AI | `crush` CLI subprocess |
| `OpenRouterAdapter` | OpenRouter | OpenAI-compatible HTTP |

## 5. AdapterRegistry

Central registry for provider registration and execution:
- Registers adapters with metadata (tags, capabilities, cost model)
- Executes via router-selected primary with ordered fallback chain
- Health-aware selection with circuit breaker integration
- Parallel execution support via `ParallelExecutor`

## 6. Feature Inventory by Subsystem

### Routing
- `TagBasedRouter` — selects by task tags
- `CapabilityRouter` — selects by required capabilities
- `ContextAwareRouter` — selects by conversation context
- `CostOptimizedRouter` — minimizes token cost
- `RoundRobinRouter` — even load distribution
- `CompositeRouter` — chains multiple routers

### Orchestration
- `OrchestratorFacade` — unified high-level API (`run`, `parallel`, `race`, `supervisor`, `mapReduce`, `bid`, `chat`)
- `ParallelExecutor` — concurrent multi-adapter execution
- `SupervisorOrchestrator` — supervisor/specialist delegation
- `MapReduceOrchestrator` — fan-out/reduce pattern
- `ContractNetOrchestrator` — bid-based task allocation

### Operational Controls
- **Guardrails** — input/output validation, content filtering
- **Approvals** — human-in-the-loop gates with audit trail
- **Recovery** — retry policies, backoff, error escalation
- **Cost Tracking** — per-run token usage and cost models
- **Sessions** — resume, fork, and list session state
- **Checkpoints** — workflow state persistence and recovery

### Skills
- Skill projection from `.dzupagent/` config
- Version store for skill evolution tracking
- Capability matrix per provider

### .dzupagent/ Integration
- `WorkspaceResolver` — resolves project/global/workspace paths
- `DzupAgentImporter` — imports agent files from native formats
- `AgentFileLoader`, `MemoryLoader`, `SyncManager`

## 7. Cross-Package Dependencies

```
@dzupagent/agent-adapters
  ├── @dzupagent/core       (events, circuit breaker, security, lifecycle)
  ├── @dzupagent/agent      (DzupAgent interface, tool loop)
  ├── @dzupagent/memory     (memory enrichment, context)
  └── @langchain/core       (message types)
```

## 8. How To Use

### Basic adapter usage
```ts
import { ClaudeAgentAdapter } from '@dzupagent/agent-adapters'

const adapter = new ClaudeAgentAdapter()
for await (const event of adapter.execute({ prompt: 'Hello!' })) {
  if (event.type === 'adapter:message') console.log(event.content)
}
```

### Registry with routing
```ts
import { AdapterRegistry, TagBasedRouter } from '@dzupagent/agent-adapters'

const registry = new AdapterRegistry({ router: new TagBasedRouter() })
registry.register('claude', new ClaudeAgentAdapter(), { tags: ['code'] })
const result = await registry.execute({ prompt: 'Write a sort function', tags: ['code'] })
```

### High-level orchestration
```ts
import { createOrchestrator } from '@dzupagent/agent-adapters'

const orch = createOrchestrator(registry)
const results = await orch.parallel([
  { prompt: 'Task A' },
  { prompt: 'Task B' },
])
```

## 9. Error Codes

| Code | Meaning |
|---|---|
| `ADAPTER_SDK_NOT_INSTALLED` | Optional provider SDK not present |
| `ADAPTER_HEALTH_CHECK_FAILED` | Provider unavailable |
| `ADAPTER_SESSION_NOT_FOUND` | Resume target session missing |
| `ADAPTER_INTERRUPTED` | Run aborted via `interrupt()` |
| `ADAPTER_GUARDRAIL_VIOLATION` | Input/output rejected by guardrail |
| `ADAPTER_APPROVAL_DENIED` | Approval gate rejected the action |

## 10. Configuration

All adapters accept a `configure(config)` call to merge runtime options:
- `model` — provider-specific model identifier
- `timeoutMs` — per-turn timeout
- `maxTurns` — maximum conversation turns
- `systemPrompt` — static system instruction

## 11. Event Flow

```
execute({ prompt })
  → adapter:started
  → (zero or more) adapter:stream_delta
  → (zero or more) adapter:tool_call / adapter:tool_result
  → (one or more)  adapter:message
  → adapter:completed | adapter:failed
```

## 12. Extending with New Providers

1. Implement `AgentCLIAdapter` interface in `src/<provider>/`
2. Map provider-specific events to the normalized `AgentEvent` union
3. Export from `src/index.ts`
4. Add conformance tests in `src/__tests__/adapter-conformance.contract.test.ts`

## 13. Test Coverage Map

| Test file | Subsystem |
|---|---|
| `adapter-registry.test.ts` | AdapterRegistry, routing, fallback |
| `parallel-executor.test.ts` | ParallelExecutor concurrent execution |
| `parallel-executor.contract.test.ts` | ParallelExecutor contracts |
| `parallel-executor.stress.test.ts` | ParallelExecutor under load |
| `adapter-http-handler.test.ts` | HTTP handler integration |
| `adapter-recovery.test.ts` | Recovery policies and backoff |
| `architecture-doc.test.ts` | This document (guard against drift) |
| `adapter-conformance.contract.test.ts` | Per-provider conformance |
| `capability-router.test.ts` | CapabilityRouter selection |
| `context-aware-router.test.ts` | ContextAwareRouter selection |
| `supervisor.test.ts` | SupervisorOrchestrator |
| `map-reduce.test.ts` | MapReduceOrchestrator |
| `contract-net.test.ts` | ContractNetOrchestrator |
| `orchestrator-facade.test.ts` | OrchestratorFacade high-level API |
| `adapter-guardrails.test.ts` | Guardrail validation |
| `adapter-approval.test.ts` | Approval gates |
| `cost-tracking.test.ts` | Cost tracking and models |
| `adapter-lifecycle.test.ts` | Session lifecycle |
| `adapter-workflow.test.ts` | Workflow composition |
| `dzupagent-integration.test.ts` | .dzupagent/ file integration |

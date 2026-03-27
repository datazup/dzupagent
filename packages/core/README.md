# @dzipagent/core

<!-- AUTO-GENERATED-START -->
## Package Overview

**Maturity:** Beta | **Coverage:** 73% | **Exports:** 261

| Metric | Value |
|--------|-------|
| Source Files | 174 |
| Lines of Code | 39,592 |
| Test Files | 55 |
| Internal Dependencies | `@dzipagent/context`, `@dzipagent/memory`, `@dzipagent/memory-ipc` |

### Quality Gates
✓ Build | ✓ Typecheck | ✓ Lint | ✓ Test | ✓ Coverage

### Install
```bash
npm install @dzipagent/core
```
<!-- AUTO-GENERATED-END -->

[![Maturity: Stable](https://img.shields.io/badge/maturity-stable-brightgreen)](/docs/CAPABILITY_MATRIX.md)

> See the full [Capability Matrix](/docs/CAPABILITY_MATRIX.md) for per-package maturity levels, test coverage, and API surface area. The matrix is regenerated on every CI run.

Base agent infrastructure library providing reusable LLM agent building blocks: model registry, prompt management, memory, context engineering, middleware, persistence, routing, streaming, sub-agents, and skills. Built on LangChain and LangGraph.

## Installation

```bash
yarn add @dzipagent/core
# or
npm install @dzipagent/core
```

## Quick Start

Import only what you need via curated facades:

```typescript
// Get started fast
import { createQuickAgent } from '@dzipagent/core/quick-start';

// Memory-focused work
import { MemoryService, StoreFactory } from '@dzipagent/core/memory';

// Orchestration
import { DzipEventBus } from '@dzipagent/core/orchestration';

// Security
import { PolicyEngine, AuditTrail } from '@dzipagent/core/security';
```

Or import everything from the main entry point:
```typescript
import { MemoryService, DzipEventBus, PolicyEngine } from '@dzipagent/core';
```

### Classic Usage

```ts
import {
  ModelRegistry,
  PromptResolver,
  MemoryService,
  IntentRouter,
  createCheckpointer,
} from '@dzipagent/core'

// 1. Set up the model registry
const models = new ModelRegistry()
models.register('fast', { provider: 'anthropic', model: 'claude-haiku', ... })
models.register('smart', { provider: 'anthropic', model: 'claude-sonnet', ... })

// 2. Resolve a prompt template
const resolver = new PromptResolver(promptStore)
const prompt = await resolver.resolve({ key: 'feature-planner', level: 'tenant', tenantId })

// 3. Invoke with retry and timeout
import { invokeWithTimeout } from '@dzipagent/core'
const result = await invokeWithTimeout(model, messages, { timeoutMs: 30_000 })
```

## API Reference

### LLM

- `ModelRegistry` -- class to register, resolve, and instantiate LLM models by tier
- `invokeWithTimeout(model, messages, options): Promise<AIMessage>` -- invoke an LLM with a timeout
- `extractTokenUsage(response): TokenUsage` -- extract token usage from an LLM response
- `isTransientError(error): boolean` -- check if an error is retryable (rate limit, network, etc.)
- `DEFAULT_RETRY_CONFIG: RetryConfig` -- default retry configuration

**Types:** `LLMProviderConfig`, `ModelTier`, `ModelSpec`, `ModelOverrides`, `ModelFactory`, `TokenUsage`, `InvokeOptions`, `RetryConfig`

### Prompt

- `resolveTemplate(template, context): string` -- interpolate `{{variables}}` in a template string
- `extractVariables(template): string[]` -- extract all `{{variable}}` names from a template
- `validateTemplate(template, context): string[]` -- return names of missing variables
- `flattenContext(context): Record<string, string>` -- flatten a nested context object for interpolation
- `PromptResolver` -- class that resolves templates from a `PromptStore` with builtin/tenant/user hierarchy
- `PromptCache` -- in-memory cache for resolved prompts with TTL

**Types:** `PromptStore`, `ResolutionLevel`, `TemplateVariable`, `TemplateContext`, `ResolvedPrompt`, `StoredTemplate`, `PromptResolveQuery`, `BulkPromptQuery`

### Memory

- `createStore(config): BaseStore` -- factory to create a LangGraph-compatible memory store (Postgres or in-memory)
- `MemoryService` -- high-level service with helpers for reading/writing memories across 3-tier namespaces (tenant, project, thread)

**Types:** `StoreConfig`, `NamespaceConfig`, `FormatOptions`

### Context

- `shouldSummarize(messages, config): boolean` -- check if a message list exceeds threshold (count or tokens)
- `summarizeAndTrim(model, messages, config): Promise<BaseMessage[]>` -- summarize older messages and keep recent ones
- `formatSummaryContext(summary): string` -- format a summary for injection into system prompt
- `evictIfNeeded(messages, config): EvictionResult` -- evict messages to fit within a token budget

**Types:** `MessageManagerConfig`, `EvictionConfig`, `EvictionResult`

### Middleware

- `calculateCostCents(usage, modelId): number` -- calculate the cost in cents from token usage
- `getModelCosts(modelId): { inputPer1K, outputPer1K }` -- get per-1K-token costs for a model
- `createLangfuseHandler(config): CallbackHandler` -- create a LangChain callback handler for Langfuse observability

**Types:** `AgentMiddleware`, `CostTracker`, `LangfuseConfig`, `LangfuseHandlerOptions`

### Persistence

- `createCheckpointer(config): BaseCheckpointSaver` -- factory for LangGraph checkpointers (Postgres or memory)
- `SessionManager` -- manages agent session lifecycle (create, resume, list, delete)

**Types:** `CheckpointerConfig`

### Router

- `IntentRouter` -- routes user messages to the correct agent/handler based on intent classification
- `KeywordMatcher` -- fast keyword-based intent matching (used as first pass)
- `LLMClassifier` -- LLM-based intent classification (fallback for ambiguous inputs)

**Types:** `IntentRouterConfig`, `ClassificationResult`

### Streaming

- `SSETransformer` -- transforms LangGraph streaming events into standard Server-Sent Events

**Types:** `StandardSSEEvent`, `StandardEventType`

### Sub-agents

- `SubAgentSpawner` -- spawn and manage sub-agent executions within a parent graph
- `mergeFileChanges(base, changes): FileData[]` -- merge file changes from sub-agents into a base file set
- `fileDataReducer(current, update): FileData[]` -- LangGraph-compatible reducer for file data in state

**Types:** `SubAgentConfig`, `SubAgentResult`

### Skills

- `SkillLoader` -- loads skill definitions from the filesystem or database
- `injectSkills(systemPrompt, skills): string` -- inject skill descriptions into a system prompt

**Types:** `SkillDefinition`

### Version

- `dzipagent_CORE_VERSION: string` -- current package version (`'0.1.0'`)

## Facade Imports

`@dzipagent/core` exposes **curated facade entry points** that give you only the APIs relevant to your use case, reducing import surface and bundle size.

### Quick Start — `@dzipagent/core/quick-start`

Minimal bootstrap: DI container, event bus, model registry, memory, context management.

```ts
import { createQuickAgent, ModelRegistry, invokeWithTimeout } from '@dzipagent/core/quick-start'

// One-line agent bootstrap — wires container, event bus, and model registry
const { registry, eventBus, container } = createQuickAgent({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
})

// Or build up manually
const registry = new ModelRegistry()
registry.register('fast', { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' })
```

**Key exports:** `createQuickAgent`, `ForgeContainer`, `createContainer`, `createEventBus`, `ModelRegistry`, `invokeWithTimeout`, `MemoryService`, `createStore`, `shouldSummarize`, `summarizeAndTrim`, `evictIfNeeded`, `resolveConfig`

### Memory — `@dzipagent/core/memory`

Full memory subsystem: stores, retrieval, consolidation, decay, provenance, CRDT sync.

```ts
import { MemoryService, createStore, fusionSearch, SemanticConsolidator } from '@dzipagent/core/memory'

const store = createStore({ backend: 'postgres', connectionString: process.env.DATABASE_URL })
const memory = new MemoryService({ store, namespace: { tenant: 'acme', project: 'web-app' } })
```

**Key exports:** `MemoryService`, `createStore`, `WorkingMemory`, `VersionedWorkingMemory`, `ScopedMemoryService`, `DualStreamWriter`, `SleepConsolidator`, `ProvenanceWriter`, `StoreVectorSearch`, `KeywordFTSSearch`, `EntityGraphSearch`, `AdaptiveRetriever`, `SemanticConsolidator`

### Orchestration — `@dzipagent/core/orchestration`

Multi-agent routing, pipelines, sub-agents, skills, protocols, persistence.

```ts
import { IntentRouter, createEventBus, SubAgentSpawner } from '@dzipagent/core/orchestration'

const router = new IntentRouter({ routes: [...] })
const result = router.classify('Build a login page')
```

**Key exports:** `IntentRouter`, `KeywordMatcher`, `LLMClassifier`, `CostAwareRouter`, `SubAgentSpawner`, `SkillLoader`, `SkillManager`, `PipelineDefinitionSchema`, `serializePipeline`, `deserializePipeline`, `ProtocolRouter`, `createForgeMessage`, `InMemoryRunStore`, `MetricsCollector`, `Semaphore`, `ConcurrencyPool`

### Security — `@dzipagent/core/security`

Risk classification, secrets/PII detection, policy engine, audit trail, safety monitoring.

```ts
import { createRiskClassifier, scanForSecrets, PolicyEvaluator } from '@dzipagent/core/security'

const classifier = createRiskClassifier()
const risk = classifier.classify('DROP TABLE users')
```

**Key exports:** `createRiskClassifier`, `scanForSecrets`, `redactSecrets`, `detectPII`, `redactPII`, `PolicyEvaluator`, `InMemoryPolicyStore`, `ComplianceAuditLogger`, `createSafetyMonitor`, `createMemoryDefense`, `OutputPipeline`, `DataClassifier`

### All Facades — `@dzipagent/core/facades`

Import all facades as namespaces when you need cross-cutting access:

```ts
import { quickStart, memory, orchestration, security } from '@dzipagent/core/facades'

const agent = quickStart.createQuickAgent({ provider: 'anthropic', apiKey: '...' })
const risk = security.createRiskClassifier()
```

## Configuration

The package is configuration-driven. Key environment variables consumed by its services:

| Variable | Used by | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `createStore`, `createCheckpointer` | PostgreSQL connection string for persistent memory/checkpoints |
| `LANGFUSE_SECRET_KEY` | `createLangfuseHandler` | Langfuse secret key for observability |
| `LANGFUSE_PUBLIC_KEY` | `createLangfuseHandler` | Langfuse public key |
| `LANGFUSE_HOST` | `createLangfuseHandler` | Langfuse server URL |

## Peer Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@langchain/core` | `>=1.0.0` | Base LangChain types (messages, models, callbacks) |
| `@langchain/langgraph` | `>=1.0.0` | Graph execution, state management, checkpointing |
| `zod` | `>=4.0.0` | Schema validation for configs and tool parameters |

## License

MIT

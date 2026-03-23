# @forgeagent/core

Base agent infrastructure library providing reusable LLM agent building blocks: model registry, prompt management, memory, context engineering, middleware, persistence, routing, streaming, sub-agents, and skills. Built on LangChain and LangGraph.

## Installation

```bash
yarn add @forgeagent/core
# or
npm install @forgeagent/core
```

## Quick Start

```ts
import {
  ModelRegistry,
  PromptResolver,
  MemoryService,
  IntentRouter,
  createCheckpointer,
} from '@forgeagent/core'

// 1. Set up the model registry
const models = new ModelRegistry()
models.register('fast', { provider: 'anthropic', model: 'claude-haiku', ... })
models.register('smart', { provider: 'anthropic', model: 'claude-sonnet', ... })

// 2. Resolve a prompt template
const resolver = new PromptResolver(promptStore)
const prompt = await resolver.resolve({ key: 'feature-planner', level: 'tenant', tenantId })

// 3. Invoke with retry and timeout
import { invokeWithTimeout } from '@forgeagent/core'
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

- `FORGEAGENT_CORE_VERSION: string` -- current package version (`'0.1.0'`)

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

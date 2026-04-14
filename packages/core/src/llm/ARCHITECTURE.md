# LLM Architecture (`packages/core/src/llm`)

Last updated: 2026-04-03

## Scope

This document describes the LLM subsystem in `@dzupagent/core` under:

- `packages/core/src/llm/*`
- related public exports in `packages/core/src/index.ts`
- runtime usage in other packages (`server`, `agent`, `codegen`, `rag`, `test-utils`)

It covers:

- features and responsibilities
- end-to-end flow
- practical usage patterns and examples
- cross-package integration points
- current test coverage and gaps

## High-Level Design

The LLM subsystem is intentionally split into small, focused modules:

1. **Model typing and provider contract** (`model-config.ts`)
2. **Model/provider registry and fallback policy** (`model-registry.ts`)
3. **Invocation reliability and usage extraction** (`invoke.ts`)
4. **Retry/transient error classification** (`retry.ts`)
5. **Circuit-breaker state machine** (`circuit-breaker.ts`)
6. **Registry middleware contract** (`registry-middleware.ts`)
7. **Embedding model metadata registry** (`embedding-registry.ts`)

Primary design intent:

- keep provider wiring centralized in `ModelRegistry`
- separate "model selection" from "model invocation"
- expose simple primitives (`invokeWithTimeout`, `extractTokenUsage`, `estimateTokens`) that other packages can reuse without pulling registry internals

## Module Map

| File | Responsibility | Key Exports |
| --- | --- | --- |
| `model-config.ts` | Core types for model tiers, provider config, overrides, and custom factory contract | `ModelTier`, `ModelSpec`, `LLMProviderConfig`, `ModelOverrides`, `ModelFactory` |
| `model-registry.ts` | Provider registration, priority ordering, tier/name resolution, provider fallback with breaker checks, middleware registration | `ModelRegistry` |
| `invoke.ts` | Invocation wrapper with timeout + retry, token usage extraction, token estimation helper | `invokeWithTimeout`, `extractTokenUsage`, `estimateTokens`, `TokenUsage`, `InvokeOptions` |
| `retry.ts` | Retry defaults and transient error classifier | `isTransientError`, `DEFAULT_RETRY_CONFIG`, `RetryConfig` |
| `circuit-breaker.ts` | Generic closed/open/half-open breaker implementation | `CircuitBreaker`, `CircuitBreakerConfig`, `CircuitState` |
| `registry-middleware.ts` | Middleware hook interfaces around LLM invocation | `RegistryMiddleware`, `MiddlewareContext`, `MiddlewareResult`, `MiddlewareTokenUsage` |
| `embedding-registry.ts` | Metadata-only registry for embedding models (dimensions/cost/batch size) | `EmbeddingRegistry`, `COMMON_EMBEDDING_MODELS`, `createDefaultEmbeddingRegistry`, `EmbeddingModelEntry` |

## Core Features

### 1) Tiered model abstraction

`ModelTier` is fixed to:

- `chat`
- `reasoning`
- `codegen`
- `embedding`

This allows downstream packages to ask for capability-level tiers instead of hardcoding model IDs.

### 2) Provider registry with priority ordering

`ModelRegistry.addProvider(...)` accepts a provider config containing:

- provider id
- API key and optional base URL
- per-tier model mapping
- numeric priority (lower is preferred)

Providers are sorted by priority at registration time.

### 3) Default provider factory

`ModelRegistry` includes a default factory that supports:

- `anthropic` via `ChatAnthropic`
- `openai` via `ChatOpenAI`
- `openrouter` via `ChatOpenAI` and OpenRouter base URL
- `google` via OpenAI-compatible base URL
- `qwen` via OpenAI-compatible base URL

For `azure`, `bedrock`, and `custom`, default factory throws and requires `setFactory(...)`.

### 4) OpenAI reasoning-model temperature guard

`model-registry.ts` intentionally omits explicit `temperature` for reasoning-style models (`o*`, `gpt-5*`) because those models may reject non-default temperature settings.

### 5) Model resolution APIs

`ModelRegistry` provides several retrieval patterns:

- `getModel(tier, overrides?)`
- `getModelFromProvider(provider, tier, overrides?)`
- `getModelByName(modelName, overrides?)` with partial-name fallback
- `getSpec(tier)` for metadata-only lookup

### 6) Provider fallback with circuit-breaker gating

`getModelWithFallback(tier, overrides?)`:

- iterates providers by priority
- skips providers whose breaker is open (`canExecute() === false`)
- returns first model that can be instantiated
- records creation failures on breaker
- throws `ForgeError(code: 'ALL_PROVIDERS_EXHAUSTED')` if none work

### 7) Invocation wrapper with timeout + retry

`invokeWithTimeout(model, messages, options?)`:

- applies timeout via `Promise.race`
- retries transient failures based on `retry.maxAttempts`
- applies exponential backoff (`backoffMs * 2^(attempt-1)`, capped)
- emits usage via optional `onUsage` callback

### 8) Unified token usage extraction

`extractTokenUsage(...)` supports multiple metadata shapes:

- `usage_metadata` (LangChain standardized)
- `response_metadata.usage` (`input_tokens`/`output_tokens`)
- `response_metadata.usage` (`prompt_tokens`/`completion_tokens`)
- `response_metadata.usage_metadata`
- `response_metadata.tokenUsage` (legacy camelCase)

### 9) Lightweight token estimation helper

`estimateTokens(text)` uses `ceil(chars / 4)` as a coarse fallback.

### 10) Reusable transient-error classifier

`isTransientError(error)` uses message pattern matching for:

- rate limiting / overload
- 503/529
- timeout/network failures (`econnreset`, `fetch failed`, etc.)

### 11) Generic circuit-breaker primitive

`CircuitBreaker` supports:

- closed/open/half-open states
- failure threshold opening
- reset-timeout recovery probes
- explicit `recordSuccess()` / `recordFailure()`
- `reset()` for testability

This breaker is reused outside LLM calls as well (for MCP reliability).

### 12) Registry middleware contract

`registry-middleware.ts` defines middleware hooks (`beforeInvoke`, `afterInvoke`) and context/result types for caching/logging use-cases.

### 13) Embedding metadata registry

`EmbeddingRegistry` is a provider-agnostic catalog of embedding models and metadata:

- dimensions
- batch size
- cost per 1k tokens
- description

`ModelRegistry` creates a default instance at `registry.embeddings`.

## End-to-End Flow

### A) Standard registry + invoke flow

```text
register providers
  -> get model by tier/name/provider
  -> invokeWithTimeout(model, messages)
  -> optional retry/backoff on transient errors
  -> extract token usage from response metadata
```

### B) Fallback flow with provider health tracking

```text
getModelWithFallback(tier)
  -> provider #1 breaker canExecute?
    -> yes: create model
    -> no: skip
  -> provider #2 ...
  -> if none available: ForgeError(ALL_PROVIDERS_EXHAUSTED)

after invocation:
  -> recordProviderSuccess(provider) on success
  -> recordProviderFailure(provider, err) on failure (transient only)
```

### C) Token usage extraction precedence

```text
top-level usage_metadata
  -> response_metadata.usage (input/output)
  -> response_metadata.usage (prompt/completion)
  -> response_metadata.usage_metadata
  -> response_metadata.tokenUsage
  -> fallback zero usage
```

## Usage Examples

### 1) Basic provider registration and invocation

```ts
import { ModelRegistry, invokeWithTimeout } from '@dzupagent/core'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'

const registry = new ModelRegistry()
registry.addProvider({
  provider: 'anthropic',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  priority: 1,
  models: {
    chat: { name: 'claude-haiku-4-20250514', maxTokens: 2048 },
    codegen: { name: 'claude-sonnet-4-20250514', maxTokens: 8192 },
  },
})

const model = registry.getModel('chat', { streaming: false })
const response = await invokeWithTimeout(model, [
  new SystemMessage('You are concise.'),
  new HumanMessage('Summarize this error report.'),
], {
  timeoutMs: 30_000,
  onUsage: (usage) => console.log('usage', usage),
})
```

### 2) Provider fallback with breaker recording (recommended pattern)

```ts
const { model, provider } = registry.getModelWithFallback('chat', { streaming: false })

try {
  const response = await invokeWithTimeout(model, messages)
  registry.recordProviderSuccess(provider)
  return response
} catch (err) {
  if (err instanceof Error) {
    registry.recordProviderFailure(provider, err)
  }
  throw err
}
```

### 3) Custom provider factory (`azure`, `bedrock`, `custom`)

```ts
import type { ModelFactory } from '@dzupagent/core'

const factory: ModelFactory = (provider, spec, overrides) => {
  // Return a BaseChatModel-compatible implementation.
  // Example placeholder:
  return createMyCustomChatModel({
    provider: provider.provider,
    model: overrides?.model ?? spec.name,
    apiKey: provider.apiKey,
    maxTokens: overrides?.maxTokens ?? spec.maxTokens,
  })
}

registry.setFactory(factory)
```

### 4) Embedding metadata lookup

```ts
const openAiEmbeds = registry.embeddings.getByProvider('openai')
const defaultEmbed = registry.embeddings.getDefault()

if (defaultEmbed) {
  console.log(defaultEmbed.model, defaultEmbed.dimensions, defaultEmbed.costPer1kTokens)
}
```

## Cross-Package References and Usage

### Server package

- `packages/server/src/runtime/default-run-executor.ts`
  - Uses `getModelWithFallback(...)`.
  - Invokes model through `invokeWithTimeout(...)`.
  - Records provider success/failure on registry for breaker feedback.
- `packages/server/src/runtime/dzip-agent-run-executor.ts`
  - Uses `ModelRegistry` to resolve model names for usage/cost reporting.
- `packages/server/src/runtime/run-worker.ts`
  - Accepts `ModelRegistry` in worker execution context and propagates it through execution pipeline.

### Agent package

- `packages/agent/src/agent/dzip-agent.ts`
  - Resolves model tiers through registry (`getModel(...)`).
  - Uses `extractTokenUsage(...)` and `estimateTokens(...)` for budget accounting.
- `packages/agent/src/agent/tool-loop.ts`
  - Uses `extractTokenUsage(...)` on each LLM turn inside ReAct loop.

### Codegen package

- `packages/codegen/src/git/commit-message.ts`
  - Uses `invokeWithTimeout(...)` for time-bounded commit message generation.
- `packages/codegen/src/generation/code-gen-service.ts`
  - Uses `ModelRegistry.getModel(...)` and `extractTokenUsage(...)`.
- `packages/codegen/src/correction/reflection-node.ts`
  - Uses `ModelRegistry.getModel(...)` and `extractTokenUsage(...)` for structured critique flow.
- `packages/codegen/src/correction/lesson-extractor.ts`
  - Same LLM usage pattern as `reflection-node`.

### RAG package

- `packages/rag/src/chunker.ts`
- `packages/rag/src/retriever.ts`
- `packages/rag/src/assembler.ts`

These use `estimateTokens(...)` to enforce chunking/retrieval/context budgets.

### Core-internal consumers outside `src/llm`

- `packages/core/src/subagent/subagent-spawner.ts`
  - Uses registry model resolution and `extractTokenUsage(...)` in ReAct sub-agent loops.
- `packages/core/src/mcp/mcp-reliability.ts`
  - Reuses `CircuitBreaker` as a generic reliability primitive for MCP server health.
- `packages/core/src/router/cost-aware-router.ts`
  - Uses `ModelTier` type for router output contract.
- `packages/core/src/facades/quick-start.ts`
  - Provides simplified bootstrap API around `ModelRegistry` and `invokeWithTimeout`.

### Test utilities package

- `packages/test-utils/src/test-helpers.ts`
  - Creates `ModelRegistry` in default test harness config for consumers.

## Public API Surface

Re-exported from `packages/core/src/index.ts`:

- `ModelRegistry`
- `CircuitBreaker` + breaker types
- `invokeWithTimeout`, `extractTokenUsage`, `estimateTokens`
- `isTransientError`, `DEFAULT_RETRY_CONFIG`, `RetryConfig`
- `RegistryMiddleware` types
- `EmbeddingRegistry`, `createDefaultEmbeddingRegistry`, `COMMON_EMBEDDING_MODELS`
- model config types (`LLMProviderConfig`, `ModelTier`, `ModelSpec`, `ModelOverrides`, `ModelFactory`)

## Test Coverage

### Direct LLM module tests

Executed on 2026-04-03:

```bash
yarn workspace @dzupagent/core test src/__tests__/model-registry.test.ts src/__tests__/circuit-breaker.test.ts src/__tests__/extract-token-usage.test.ts
```

Result:

- `3` test files passed
- `47` tests passed total
  - `model-registry.test.ts`: `22`
  - `circuit-breaker.test.ts`: `9`
  - `extract-token-usage.test.ts`: `16`

### Coverage matrix by LLM file

| Module | Coverage status | Notes |
| --- | --- | --- |
| `model-registry.ts` | Good unit coverage | Provider registration/order, tier/provider/name resolution, overrides, fallback, middleware list/remove, custom factory |
| `circuit-breaker.ts` | Good unit coverage | State transitions, reset timeout, half-open success/failure, reset/default config |
| `invoke.ts` | Partial unit coverage | `extractTokenUsage` and `estimateTokens` are covered; `invokeWithTimeout` execution/retry/timeout behaviors do not have a dedicated direct test file |
| `retry.ts` | Limited direct coverage | Behavior exercised indirectly via `invokeWithTimeout` and mocked usage in model-registry tests; no dedicated retry-classification tests |
| `embedding-registry.ts` | No dedicated tests found | API is simple but untested directly (register/get/list/provider/default/remove) |
| `registry-middleware.ts` | Type-contract only | Hook registration/list/remove tested via `ModelRegistry`; no runtime pipeline execution tests (hooks are not invoked by current registry runtime) |
| `model-config.ts` | Type-only | Compile-time contract, no runtime logic |

### Integration-level references in tests

- `server` tests instantiate `ModelRegistry` in runtime wiring tests (for example `packages/server/src/__tests__/run-worker.test.ts`, `default-run-executor.test.ts`).
- these are mostly wiring tests and do not deeply validate LLM internals.

## Notable Gaps and Behavioral Caveats

1. `invokeWithTimeout` timeout does not cancel the underlying model request.
   - Current implementation rejects on timeout but does not propagate cancellation to `model.invoke(...)`.
2. `InvokeOptions.trackingContext` is currently accepted but not used.
3. `RegistryMiddleware` hooks are registrable but not wired into an invocation pipeline in `ModelRegistry`.
4. `CircuitBreaker` half-open attempt count is checked but not incremented in `canExecute()`, so `halfOpenMaxAttempts` is effectively not enforced.
5. `EmbeddingRegistry` is exported and attached to `ModelRegistry`, but there is minimal in-repo runtime usage of this metadata catalog.

## Recommended Next Tests

1. Add direct `invokeWithTimeout` tests:
   - transient retry behavior/backoff bounds
   - non-transient immediate failure
   - timeout behavior
   - `onUsage` callback robustness when callback throws
2. Add direct `retry.ts` classifier tests for representative error message variants.
3. Add direct `embedding-registry.ts` CRUD/list/default/provider tests.
4. Add regression test for breaker half-open attempt limiting once implementation increments attempts.
5. If middleware execution is introduced, add before/after hook ordering and short-circuit cache-path tests.


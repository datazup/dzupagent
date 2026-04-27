# LLM Architecture (`packages/core/src/llm`)

## Scope
This document describes the LLM layer implemented in `@dzupagent/core` under `packages/core/src/llm`:

- `model-config.ts`
- `model-registry.ts`
- `structured-output-capabilities.ts`
- `invoke.ts`
- `retry.ts`
- `circuit-breaker.ts`
- `registry-middleware.ts`
- `embedding-registry.ts`

It also covers direct package-local integrations in `packages/core/src` (facades, config, formats, subagent, MCP reliability) and key cross-package runtime consumers in `packages/agent` and `packages/server`.

## Responsibilities
The LLM layer is responsible for:

- Defining provider/model contracts (`ModelTier`, `LLMProviderConfig`, `ModelSpec`, overrides, structured-output capability metadata).
- Registering providers and resolving chat model instances by tier, provider, or model name.
- Providing priority-based fallback with per-provider circuit-breaker gating.
- Decorating model instances with normalized structured-output capability metadata.
- Wrapping invocation with timeout, retry/backoff, context-length error classification, and token-usage extraction.
- Exposing generic reliability primitives (`CircuitBreaker`, `KeyedCircuitBreaker`) used both in LLM routing and MCP reliability.
- Providing a metadata registry for embedding model selection (`EmbeddingRegistry`).
- Exposing middleware hook types for registry-level interception contracts.

## Structure
| File | Purpose | Main Exports |
| --- | --- | --- |
| `model-config.ts` | Core type contracts for providers, tiers, overrides, and structured-output metadata | `ModelTier`, `KnownLLMProvider`, `LLMProviderName`, `ModelSpec`, `LLMProviderConfig`, `ModelOverrides`, `ModelFactory`, `StructuredOutputModelCapabilities`, `StructuredOutputStrategy` |
| `structured-output-capabilities.ts` | Provider defaults and normalization helpers for structured-output capabilities; attaches metadata onto model instances | `attachStructuredOutputCapabilities`, `normalizeStructuredOutputCapabilities`, `getProviderStructuredOutputDefaults`, `getStructuredOutputDefaultsForProviderName`, `isKnownLLMProvider` |
| `model-registry.ts` | Provider registration, model creation (default + custom factory), fallback selection, breaker health, middleware list management | `ModelRegistry` |
| `invoke.ts` | Invocation utility with timeout + retry and token usage extraction helpers | `invokeWithTimeout`, `extractTokenUsage`, `estimateTokens`, `TokenUsage`, `InvokeOptions` |
| `retry.ts` | Retry defaults and error classification helpers | `DEFAULT_RETRY_CONFIG`, `isTransientError`, `isContextLengthError`, `RetryConfig` (+ `RetryPolicy` re-export) |
| `circuit-breaker.ts` | Generic circuit-breaker state machine and keyed registry wrapper | `CircuitBreaker`, `KeyedCircuitBreaker`, `CircuitBreakerConfig`, `CircuitState` |
| `registry-middleware.ts` | Middleware type contracts for pre/post invocation hooks | `RegistryMiddleware`, `MiddlewareContext`, `MiddlewareResult`, `MiddlewareTokenUsage` |
| `embedding-registry.ts` | Embedding metadata catalog + built-in model list | `EmbeddingRegistry`, `COMMON_EMBEDDING_MODELS`, `createDefaultEmbeddingRegistry`, `EmbeddingModelEntry` |

Public package exports are wired through `packages/core/src/index.ts` and the quick-start facade (`packages/core/src/facades/quick-start.ts`).

## Runtime and Control Flow
1. Provider bootstrap:
- Callers create `ModelRegistry`.
- Providers are added via `addProvider`, sorted by ascending `priority`.
- Optional overrides: `setFactory(...)` for custom transports, `setCircuitBreakerConfig(...)` for breaker behavior.

2. Model resolution:
- `getModel(tier)` returns first provider configured for that tier.
- `getModelFromProvider(provider, tier)` enforces provider/tier existence.
- `getModelByName(name)` resolves exact match first, then partial `includes` fallback.
- Resolved instances are decorated with `structuredOutputCapabilities`, sourced in this order:
  1. model spec `structuredOutput`
  2. provider `structuredOutputDefaults`
  3. built-in provider defaults from `structured-output-capabilities.ts`

3. Fallback routing:
- `getModelWithFallback(tier)` iterates providers by priority.
- Providers with open circuits (`canExecute() === false`) are skipped.
- Factory failures are collected and recorded in breaker state.
- Exhaustion throws `ForgeError` with code `ALL_PROVIDERS_EXHAUSTED`.

4. Invocation path:
- `invokeWithTimeout(model, messages, options)` wraps `model.invoke(...)` in `Promise.race` with timeout.
- Retries only transient failures (`isTransientError`) up to `maxAttempts`, with exponential backoff via `calculateBackoff`.
- Context-length failures (`isContextLengthError`) are converted to `ForgeError` code `CONTEXT_LENGTH_EXCEEDED` without retry.
- Optional `onUsage` callback receives usage parsed by `extractTokenUsage`.

5. Health feedback loop:
- Consumers are expected to call `recordProviderSuccess(provider)` or `recordProviderFailure(provider, error)` after invoke/stream completion.
- `recordProviderFailure` only increments breaker state for transient errors.
- `getProviderHealth()` returns current state per registered provider.

6. Structured-output strategy defaults:
- Anthropic defaults to `anthropic-tool-use`.
- OpenAI/Google/Qwen/Azure defaults to `openai-json-schema`.
- OpenRouter defaults to `generic-parse`.
- Bedrock/custom have no built-in defaults unless explicitly configured.

## Key APIs and Types
- `ModelRegistry`
  - Core methods: `addProvider`, `setFactory`, `setCircuitBreakerConfig`, `getModel`, `getModelFromProvider`, `getModelByName`, `getModelWithFallback`, `getSpec`, `recordProviderSuccess`, `recordProviderFailure`, `getProviderHealth`, `use/getMiddlewares/removeMiddleware`.
- `LLMProviderConfig`
  - Provider identity, API credentials, optional base URL, per-tier model map, optional structured-output defaults, and priority.
- `ModelOverrides`
  - Runtime overrides for model name, temperature, max tokens, streaming, and OpenAI-style `reasoningEffort`.
- `invokeWithTimeout`
  - Shared invoke primitive for timeout, retry, and usage callback behavior.
- `extractTokenUsage`
  - Handles multiple LangChain/provider metadata shapes (`usage_metadata`, `response_metadata.usage`, nested `usage_metadata`, legacy `tokenUsage`).
- `CircuitBreaker` and `KeyedCircuitBreaker`
  - Generic reliability primitives reused outside direct LLM invocation.
- `EmbeddingRegistry`
  - Provider-agnostic metadata registry for embedding model dimensions, batch sizes, and cost hints.

## Dependencies
Direct dependencies used by `src/llm`:

- `@langchain/core` (types: `BaseChatModel`, `BaseMessage`)
- `@langchain/anthropic` (`ChatAnthropic` default provider factory)
- `@langchain/openai` (`ChatOpenAI` default provider factory for openai/openrouter/google/qwen-compatible APIs)
- `@dzupagent/agent-types` (`RetryPolicy` type re-export)
- Internal core utilities/errors:
  - `../errors/forge-error.js`
  - `../utils/backoff.js`

Package-level metadata (`packages/core/package.json`):

- Runtime deps: `@dzupagent/agent-types`, `@dzupagent/runtime-contracts`
- Peer deps include `@langchain/core`, `@langchain/langgraph`, and `zod` (plus optional vector DB peers)
- LLM provider SDKs (`@langchain/anthropic`, `@langchain/openai`) are currently present in this package's `devDependencies` and are directly imported by runtime code in `model-registry.ts`.

## Integration Points
Within `packages/core`:

- `src/index.ts`: re-exports all LLM public APIs and types.
- `src/facades/quick-start.ts`: `createQuickAgent(...)` instantiates `ModelRegistry`, injects provider defaults, and registers chat/codegen specs.
- `src/config/config-loader.ts` and `src/config/config-schema.ts`: normalize and validate provider structured-output defaults using LLM capability helpers.
- `src/formats/structured-output-contract.ts`: consumes runtime `structuredOutputCapabilities` to determine schema provider and native structured-output strategy decisions.
- `src/subagent/subagent-spawner.ts`: attaches/reads structured-output capabilities and uses `extractTokenUsage`.
- `src/mcp/mcp-reliability.ts`: reuses `CircuitBreaker` for MCP server reliability management.

Cross-package runtime consumers:

- `packages/agent/src/agent/dzip-agent.ts`: resolves tiered models through `getModelWithFallback`, applies provider success/failure feedback.
- `packages/agent/src/agent/streaming-run.ts`: records provider success/failure around `model.stream(...)` path and uses token extraction fallback behavior.
- `packages/server/src/runtime/default-run-executor.ts`: resolves fallback model, invokes through `invokeWithTimeout`, logs usage, and updates provider health.
- `packages/server/src/routes/health.ts` and `packages/server/src/scorecard/integration-scorecard.ts`: surface `getProviderHealth()` output.

## Testing and Observability
Primary tests for this layer are in `packages/core/src/__tests__`:

- `model-registry.test.ts`: provider ordering, selection APIs, fallback behavior, middleware list operations, structured-output capability precedence.
- `invoke-with-timeout.test.ts`: success, timeout, transient retry, non-transient failure, usage callback handling.
- `extract-token-usage.test.ts`: coverage of token metadata extraction paths and precedence.
- `retry.test.ts`: transient error classifier behavior and default retry config.
- `circuit-breaker.test.ts`: state transitions, timeout recovery, reset behavior.
- `embedding-registry.test.ts`: CRUD/filter/default semantics and common-model bootstrap.

Observability surfaces:

- `InvokeOptions.onUsage` provides usage events to caller-owned telemetry/logging.
- `ModelRegistry.getProviderHealth()` exposes breaker state per provider.
- Downstream integrations (notably server run executor) already log usage/provider data and can report degraded provider health.

## Risks and TODOs
- `RegistryMiddleware` is defined and storable in `ModelRegistry`, but no `beforeInvoke`/`afterInvoke` execution pipeline exists in `model-registry.ts` or `invoke.ts`; currently this is a contract-only surface.
- `InvokeOptions.trackingContext` exists but is not consumed inside `invokeWithTimeout`.
- `invokeWithTimeout` uses timeout via `Promise.race` without abort/cancel support for the underlying provider request; slow calls may continue in the background after timeout.
- `isTransientError` and `isContextLengthError` rely on message substring matching, which is provider/SDK wording-sensitive.
- `getModelByName` partial-name fallback uses first `includes` match across providers, which can be ambiguous when multiple model IDs share substrings.
- Built-in OpenAI-compatible defaults for `google` and `qwen` route through `ChatOpenAI` compatibility mode; non-compatible or provider-native features require a custom factory.
- Embedding pricing/capacity data in `COMMON_EMBEDDING_MODELS` is static metadata and can drift from provider pricing.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js


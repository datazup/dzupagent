# LLM Architecture (`packages/core/src/llm`)

## Scope
This document describes the LLM subsystem implemented in `packages/core/src/llm` for `@dzupagent/core`.

In scope:
- `model-config.ts`
- `structured-output-capabilities.ts`
- `model-registry.ts`
- `invoke.ts`
- `resilient-invoker.ts`
- `retry.ts`
- `circuit-breaker.ts`
- `tokenizer.ts`
- `tokenizer-registry.ts`
- `embedding-registry.ts`
- `harness-profile.ts`
- `registry-middleware.ts`

Also covered:
- package entrypoints that export this surface (`src/index.ts`, `src/llm.ts`, `src/model.ts`)
- direct in-package consumers (config loading/validation, quick-start, structured-output formatting, sub-agent orchestration, MCP reliability, plugin context typing, token/cost persistence typing, prompt token estimation, and event/audit bridges)

## Responsibilities
The LLM subsystem is responsible for:
- defining model/provider contracts (`ModelTier`, `LLMProviderConfig`, `ModelSpec`, `ModelOverrides`)
- creating model instances via `ModelRegistry` + pluggable `ModelFactory`
- attaching normalized structured-output capability metadata to resolved model instances
- provider selection with priority ordering and selection-time failover (`getModelWithFallback`, `getModelFallbackCandidates`)
- invocation with timeout, transient retry, context-length normalization, and token-usage extraction (`invokeWithTimeout`, `extractTokenUsage`)
- invocation-time failover across model candidates (`ResilientModelInvoker`)
- provider health tracking using circuit breakers
- token estimation through tokenizer routing plus deterministic heuristic fallback
- embedding model metadata registry and built-in default catalog
- harness-profile registry for per-provider/per-model/per-tier override resolution
- middleware contract typing and registration storage on `ModelRegistry`

## Structure
| File | Purpose | Primary exports |
| --- | --- | --- |
| `model-config.ts` | Core types for providers, tiers, specs, structured-output metadata, and factory contracts | `ModelTier`, `KnownLLMProvider`, `LLMProviderName`, `StructuredOutputStrategy`, `StructuredOutputModelCapabilities`, `ModelSpec`, `LLMProviderConfig`, `ModelOverrides`, `ModelFactory` |
| `structured-output-capabilities.ts` | Structured-output defaults + normalization + attachment helpers | `attachStructuredOutputCapabilities`, `normalizeStructuredOutputCapabilities`, `getProviderStructuredOutputDefaults`, `getStructuredOutputDefaultsForProviderName`, `isKnownLLMProvider`, `inferStructuredOutputSchemaProvider` |
| `model-registry.ts` | Provider registry, model resolution, fallback-candidate generation, breaker tracking, harness registry hookup, middleware list management | `ModelRegistry`, `ModelFallbackCandidate` |
| `invoke.ts` | Invoke wrapper with timeout, retry, usage extraction, token estimation | `invokeWithTimeout`, `extractTokenUsage`, `estimateTokens`, `TokenUsage`, `InvokeOptions` |
| `resilient-invoker.ts` | Invocation-time fallback across provider/model candidates | `ResilientModelInvoker`, `ResilientInvokerOptions` |
| `retry.ts` | Retry defaults and transient/context-length classifiers | `DEFAULT_RETRY_CONFIG`, `isTransientError`, `isContextLengthError`, `RetryConfig`, `RetryPolicy` (re-export) |
| `circuit-breaker.ts` | Circuit breaker primitives for provider and keyed reliability control | `CircuitBreaker`, `KeyedCircuitBreaker`, `CircuitBreakerConfig`, `CircuitState` |
| `tokenizer.ts` | Tokenizer interfaces and implementations with optional backend loading | `Tokenizer`, `TokenizableMessage`, `HeuristicTokenizer`, `AnthropicTokenizer`, `TiktokenTokenizer` |
| `tokenizer-registry.ts` | Pattern-based tokenizer routing and default process-wide registry | `TokenizerRegistry`, `defaultTokenizerRegistry` |
| `embedding-registry.ts` | Embedding-model metadata registry + built-in entries | `EmbeddingRegistry`, `EmbeddingModelEntry`, `COMMON_EMBEDDING_MODELS`, `createDefaultEmbeddingRegistry` |
| `harness-profile.ts` | Versioned harness profile schema + best-match resolver | `HarnessProfileRegistry`, `HarnessProfile`, `ResolvedHarnessOverrides`, override interfaces |
| `registry-middleware.ts` | Middleware type contracts around registry invocation concerns | `RegistryMiddleware`, `MiddlewareContext`, `MiddlewareResult`, `MiddlewareTokenUsage` |

Export surfaces:
- `src/index.ts`: full core export surface including LLM subsystem and `HarnessProfileRegistry`
- `src/llm.ts`: broad LLM-oriented facade (modeling + invocation + tokenizer + prompt/router/middleware exports)
- `src/model.ts`: narrow model/invocation-focused facade

## Runtime and Control Flow
Provider registration and resolution:
1. Callers instantiate `ModelRegistry` and register providers via `addProvider`.
2. Providers are sorted by ascending `priority`.
3. `getModel`, `getModelFromProvider`, or `getModelByName` chooses a provider/spec.
4. `factory(provider, spec, overrides)` creates a `BaseChatModel`.
5. Structured-output capabilities are resolved and attached with precedence:
   `spec.structuredOutput` -> `provider.structuredOutputDefaults` -> built-in provider defaults.

Default factory behavior:
- `anthropic` -> `ChatAnthropic`
- `openai`, `openrouter`, `google`, `qwen` -> `ChatOpenAI` (OpenAI-compatible transport)
- `openrouter` default base URL: `https://openrouter.ai/api/v1`
- `google` default base URL: `https://generativelanguage.googleapis.com/v1beta/openai/`
- `qwen` default base URL: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- `azure`, `bedrock`, `custom`, and unknown strings require a custom `ModelFactory` and throw by default
- temperature is suppressed for reasoning families (`o*`, `gpt-5*`) in OpenAI/OpenRouter branches
- `reasoningEffort` is passed via `reasoning: { effort }` for OpenAI/OpenRouter branches

Selection-time fallback (`ModelRegistry`):
1. `getModelWithFallback(tier)` iterates providers by priority.
2. Skips providers with open breakers (`canExecute() === false`).
3. On factory failure, records breaker failure for that provider.
4. Returns first successful `{ model, provider }`.
5. Throws `ForgeError` with `code: 'ALL_PROVIDERS_EXHAUSTED'` if none are usable.

Candidate-chain generation:
1. `getModelFallbackCandidates(tier)` performs the same selection-time filtering.
2. Returns ordered `ModelFallbackCandidate[]` for caller-managed failover.
3. Throws `ALL_PROVIDERS_EXHAUSTED` if candidate set is empty.

Invocation (`invokeWithTimeout`):
1. Executes `Promise.race([model.invoke(messages), timeoutPromise])`.
2. Retries only transient failures (`isTransientError`) up to `retry.maxAttempts`.
3. Uses exponential backoff via `calculateBackoff`.
4. Maps context-length failures to `ForgeError(code: 'CONTEXT_LENGTH_EXCEEDED')`.
5. Emits token usage through `onUsage` callback when provided.

Invocation-time fallback (`ResilientModelInvoker`):
1. Walks provided `ModelFallbackCandidate[]` in order.
2. Invokes each candidate via `invokeWithTimeout`.
3. Non-transient failure short-circuits immediately (no provider hop).
4. Transient failure triggers optional `onFallback` and continues to next candidate.
5. Breaker updates (`recordProviderSuccess` / `recordProviderFailure`) are on by default and configurable with `updateBreakers`.
6. If all candidates fail transiently, throws `ForgeError(code: 'ALL_PROVIDERS_EXHAUSTED')`.

Tokenization and estimation:
1. `estimateTokens(text, model?)` resolves tokenizer from `defaultTokenizerRegistry`.
2. Defaults map `claude*` -> `AnthropicTokenizer`, `gpt-*`/`o*` -> `TiktokenTokenizer`.
3. Optional backends are lazy-loaded; failures fall back to `HeuristicTokenizer`.

Harness profile resolution:
1. `HarnessProfileRegistry` stores profiles by `id`.
2. `resolve({ provider, modelName, tier })` filters matches and ranks specificity.
3. Specificity scoring is `provider(4) + modelGlob(2) + tier(1)`.
4. `ModelRegistry.resolveHarnessOverrides(...)` proxies into attached harness registry.
5. LLM subsystem resolves overrides but does not auto-apply them to invocation behavior.

## Key APIs and Types
- `ModelRegistry`: registration/config (`addProvider`, `setFactory`, `setCircuitBreakerConfig`, `setHarnessProfileRegistry`), retrieval (`getModel`, `getModelFromProvider`, `getModelByName`, `getSpec`), fallback/health (`getModelWithFallback`, `getModelFallbackCandidates`, `recordProviderSuccess`, `recordProviderFailure`, `getProviderHealth`), and middleware list lifecycle (`use`, `getMiddlewares`, `removeMiddleware`).
- `invokeWithTimeout(model, messages, options)`: timeout + retry wrapper around `model.invoke`, with optional `onUsage` callback and context-length normalization to `ForgeError`.
- `extractTokenUsage(response, modelName?)`: supports multiple metadata shapes (`usage_metadata`, `response_metadata.usage`, `response_metadata.usage_metadata`, `response_metadata.tokenUsage`) and captures optional cache token counters.
- `ResilientModelInvoker`: orchestrates candidate-level fallback and optional breaker synchronization.
- `StructuredOutputModelCapabilities`: `preferredStrategy`, optional `schemaProvider`, optional `fallbackStrategies`.
- `CircuitBreaker` and `KeyedCircuitBreaker`: reusable reliability primitives used in LLM and MCP reliability layers.
- `Tokenizer` and `TokenizerRegistry`: synchronous token counting with provider-aware routing and fallback.
- `EmbeddingRegistry`: register/list/filter/default/remove operations for embedding metadata entries.
- `HarnessProfileRegistry`: per-context profile selection returning `ResolvedHarnessOverrides`.

## Dependencies
Direct external imports used under `src/llm`:
- `@langchain/core` (model/message types)
- `@langchain/anthropic` (`ChatAnthropic`)
- `@langchain/openai` (`ChatOpenAI`)
- `@dzupagent/agent-types` (`RetryPolicy` re-export)
- `node:module` (`createRequire` for optional tokenizer backend loading)

Internal core dependencies consumed by this subsystem:
- `../errors/forge-error.js`
- `../utils/backoff.js`

Optional runtime backends loaded lazily:
- `@anthropic-ai/tokenizer`
- `js-tiktoken`

Package metadata notes (`packages/core/package.json`):
- `@langchain/core` is declared as a peer dependency (and also present in dev dependencies)
- `@langchain/anthropic` and `@langchain/openai` are imported by runtime code and currently declared in `devDependencies`
- tokenizer backend dependencies are declared as optional peers via `peerDependenciesMeta`

## Integration Points
Direct in-package integrations:
- `src/facades/quick-start.ts`: wires `ModelRegistry` in `createQuickAgent` and applies provider structured-output defaults via `getProviderStructuredOutputDefaults`.
- `src/config/config-types.ts`: `ProviderConfig.structuredOutputDefaults` uses `StructuredOutputModelCapabilities`.
- `src/config/config-loader.ts`: normalizes provider structured-output defaults via LLM structured-output helpers.
- `src/config/config-schema.ts`: validates structured-output strategy and schema-provider values.
- `src/formats/structured-output-contract.ts`: consumes structured-output capabilities/types to choose runtime schema strategy.
- `src/subagent/subagent-spawner.ts`: uses `ModelRegistry` for model selection, attaches per-subagent structured-output capabilities, and aggregates usage via `extractTokenUsage`.
- `src/subagent/subagent-types.ts`: references `ModelTier` and `StructuredOutputModelCapabilities`.
- `src/plugin/plugin-types.ts`: plugin context exposes typed `modelRegistry`.
- `src/prompt/fragment-composer.ts`: uses `defaultTokenizerRegistry` for token-budget logic.
- `src/middleware/cost-tracking.ts`: consumes `TokenUsage` type.
- `src/persistence/run-state-store.ts` and `src/persistence/delta-run-state-store.ts`: consume `TokenUsage` for persisted run budget/usage state.
- `src/mcp/mcp-reliability.ts`: reuses `CircuitBreaker` and circuit types.
- `src/events/event-types-shared.ts` and `src/events/llm-audit-bridge.ts`: define and emit `LlmInvocationRecord` as `llm:invocation_recorded`.

Package export entrypoints:
- `src/index.ts` exports the full LLM surface including harness profile registry/types
- `src/llm.ts` exports LLM-focused facade APIs
- `src/model.ts` exports a narrower model/invocation surface

## Testing and Observability
LLM subsystem tests in `packages/core`:
- `src/__tests__/model-registry.test.ts`: provider ordering, tier/model resolution, structured-output capability precedence, fallback candidate behavior, and middleware registration/removal.
- `src/__tests__/resilient-invoker.test.ts`: transient vs non-transient fallback behavior, empty-candidate handling, breaker update toggles, and fallback callback behavior.
- `src/__tests__/invoke-with-timeout.test.ts`: timeout handling, retry behavior, and usage callback behavior.
- `src/__tests__/extract-token-usage.test.ts`: metadata-shape extraction and estimator behavior.
- `src/__tests__/retry.test.ts`: transient classifier and retry defaults.
- `src/__tests__/circuit-breaker.test.ts`: state transitions and reset behavior.
- `src/__tests__/tokenizer.test.ts`: backend fallback, message counting, and registry resolution order.
- `src/__tests__/embedding-registry.test.ts`: registry CRUD/list/filter/default behavior.
- `src/llm/__tests__/harness-profile.test.ts`: profile matching specificity, glob behavior, and update/remove semantics.
- `src/__tests__/llm-audit-event.test.ts`: `LlmInvocationRecord` compatibility and event bridge safety behavior.

Observability hooks:
- `InvokeOptions.onUsage` for per-call token telemetry
- `ModelRegistry.getProviderHealth()` for provider circuit-state snapshots
- `ResilientInvokerOptions.onFallback` for fallback-hop telemetry
- `attachLlmAuditEventBridge` for structured `llm:invocation_recorded` event emission

## Risks and TODOs
- `RegistryMiddleware` is currently a contract + storage surface; no built-in middleware execution pipeline is wired into `ModelRegistry` invocation paths.
- `InvokeOptions.trackingContext` exists in type shape but is not consumed by `invokeWithTimeout`.
- Timeout rejection does not cancel the underlying provider request; `Promise.race` only aborts caller wait.
- Harness profiles are resolvable but not auto-applied by the LLM module itself.
- Error classification (`isTransientError`, `isContextLengthError`) depends on message substrings and may miss provider-specific error formats.
- `getModelByName` includes partial-name matching (`spec.name.includes(...)`), which can be ambiguous.
- `google` and `qwen` paths are OpenAI-compatible adapters in default factory; native-provider SDK behavior requires a custom factory.
- `COMMON_EMBEDDING_MODELS` is static metadata (dimensions/cost/batch) and can drift from provider changes.
- Runtime constructors (`@langchain/anthropic`, `@langchain/openai`) are imported in source while currently declared in `devDependencies`, which is a packaging risk.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js


# `@dzupagent/core` Facades Architecture

## Scope
This document covers the facade layer under `packages/core/src/facades` and the package-level wiring that exposes those facades to consumers.

In scope:
- `src/facades/quick-start.ts`
- `src/facades/orchestration.ts`
- `src/facades/security.ts`
- `src/facades/index.ts`
- tier entrypoints `src/stable.ts` and `src/advanced.ts`
- public subpath exports in `packages/core/package.json`
- build entry wiring in `packages/core/tsup.config.ts`
- facade-focused tests in `packages/core/src/__tests__`
- facade-related usage guidance drift in `packages/core/README.md`

Out of scope:
- implementation internals of the modules re-exported by facades (router, policy engine, protocol runtime, etc.)

## Responsibilities
The facades provide curated import surfaces so consumers can choose a narrower API than the full root barrel.

Current facade responsibilities:
- `@dzupagent/core/quick-start`
  - exposes a minimal bootstrap surface (container, event bus, model registry, config helpers, selected errors/streaming)
  - owns the only runtime composition helper in this layer: `createQuickAgent(...)`
- `@dzupagent/core/orchestration`
  - exposes orchestration-adjacent contracts and utilities across events, hooks, plugins, routing, subagents, skills, pipeline, persistence stores, protocol, middleware, concurrency, observability, and trace propagation
- `@dzupagent/core/security`
  - exposes risk classification, permission tiers, outbound URL policy, secret/PII scanning, output filtering/sanitization, policy/audit, safety monitor, memory defense, and data classification
- `@dzupagent/core/facades`
  - namespace barrel: `quickStart`, `orchestration`, `security`
- `@dzupagent/core/stable`
  - curated facade-first tier, currently `export *` from `facades/index`
- `@dzupagent/core/advanced`
  - broad tier mirroring `src/index.ts` root exports

Explicit boundary currently enforced in source comments and tests:
- memory/context are not re-exported by core facades and should be imported from Layer 2 packages (`@dzupagent/memory`, `@dzupagent/context`)

## Structure
### Source layout
- `quick-start.ts`
  - curated re-exports for DI, events, errors, model registry/invoke, config helpers, hooks types, SSE transformer types
  - defines `QuickAgentOptions`, `QuickAgentResult`, provider defaults, and `createQuickAgent(...)`
- `orchestration.ts`
  - curated re-export barrel only (no local runtime orchestration logic)
- `security.ts`
  - curated re-export barrel only (no local runtime security engine logic)
  - includes `SecurityPolicyConfig` type re-export from `@dzupagent/security`
- `index.ts`
  - namespace barrel only:
    - `export * as quickStart`
    - `export * as orchestration`
    - `export * as security`

### Tier entrypoints
- `src/stable.ts`
  - documented as a narrow facade-first tier
  - re-exports `./facades/index.js`
- `src/advanced.ts`
  - documented as broad mirror tier
  - re-exports `./index.js`

### Package and build exposure
`package.json` exports these facade-related subpaths:
- `./quick-start` -> `dist/facades/quick-start.*`
- `./orchestration` -> `dist/facades/orchestration.*`
- `./security` -> `dist/facades/security.*`
- `./facades` -> `dist/facades/index.*`
- `./stable` -> `dist/stable.*`
- `./advanced` -> `dist/advanced.*`

`tsup.config.ts` includes matching entry files:
- `src/stable.ts`
- `src/advanced.ts`
- `src/facades/index.ts`
- `src/facades/quick-start.ts`
- `src/facades/orchestration.ts`
- `src/facades/security.ts`

## Runtime and Control Flow
Only `createQuickAgent(...)` in `quick-start.ts` executes runtime composition. The other facade files are static export surfaces.

`createQuickAgent(options)` flow:
1. Resolve provider model defaults using `PROVIDER_DEFAULTS` and `getQuickStartProviderDefaults(...)`.
2. Resolve structured output defaults:
- use `options.structuredOutputCapabilities` when provided
- otherwise use `getProviderStructuredOutputDefaults(options.provider)`
3. Instantiate bootstrap primitives:
- `container = createContainer()`
- `eventBus = createEventBus()`
- `registry = new ModelRegistry()`
4. Configure provider via `registry.addProvider(...)` with:
- provider credentials (`provider`, `apiKey`, optional `baseUrl`)
- optional structured-output defaults
- fixed `priority: 1`
- `chat` and `codegen` model names/token limits (defaults or overrides)
5. Register container services:
- `eventBus`
- `registry`
6. Return `{ container, eventBus, registry }`.

Current defaults verified in source/tests:
- chat max tokens default: `4096`
- codegen max tokens default: `8192`
- provider defaults include `anthropic`, `openai`, `openrouter`, `google`, `qwen`, `azure`, `bedrock`, plus `custom` fallback

## Key APIs and Types
### `@dzupagent/core/quick-start`
Core runtime helper and curated bootstrap exports:
- `createQuickAgent(options: QuickAgentOptions): QuickAgentResult`
- `QuickAgentOptions`, `QuickAgentResult`
- `ForgeContainer`, `createContainer`
- `createEventBus`, `DzupEventBus`, `DzupEvent`
- `ModelRegistry`, model/provider capability types
- `invokeWithTimeout`, `TokenUsage`, `InvokeOptions`
- `DEFAULT_CONFIG`, `resolveConfig`, `mergeConfigs`
- `SSETransformer`, `StandardSSEEvent`
- `ForgeError`, `ForgeErrorCode`

### `@dzupagent/core/orchestration`
Representative export groups:
- events/hooks: `AgentBus`, `runHooks`, `runModifierHook`, `mergeHooks`
- plugin layer: `PluginRegistry`, plugin discovery/ordering helpers
- routing: `IntentRouter`, `KeywordMatcher`, `LLMClassifier`, `CostAwareRouter`, `ModelTierEscalationPolicy`
- subagents/skills: `SubAgentSpawner`, `mergeFileChanges`, `SkillLoader`, `SkillManager`, `SkillLearner`, `createSkillChain`, `parseAgentsMd`
- pipeline: `PipelineDefinitionSchema`, node/edge schemas, `serializePipeline`, `deserializePipeline`, `autoLayout`
- orchestration persistence: `InMemoryRunStore`, `InMemoryAgentStore`, `InMemoryEventLog`
- protocol: `createForgeMessage`, `createResponse`, `createErrorResponse`, `ProtocolRouter`, `ProtocolBridge`, `A2AClientAdapter`
- middleware/concurrency: `calculateCostCents`, `getModelCosts`, `CostAttributionCollector`, `Semaphore`, `ConcurrencyPool`
- observability/tracing: `MetricsCollector`, `globalMetrics`, `HealthAggregator`, trace propagation helpers

### `@dzupagent/core/security`
Representative export groups:
- risk/tool tiers: `createRiskClassifier`, `DEFAULT_AUTO_APPROVE_TOOLS`, `DEFAULT_LOG_TOOLS`, `DEFAULT_REQUIRE_APPROVAL_TOOLS`
- network policy: `fetchWithOutboundUrlPolicy`, `validateOutboundUrl`, `isPublicIpAddress`
- scanners/redaction: `scanForSecrets`, `redactSecrets`, `detectPII`, `redactPII`
- output sanitization: `OutputPipeline`, `createDefaultPipeline`, `createHarmfulContentFilter`, `createClassificationAwareRedactor`
- policy/audit: `InMemoryPolicyStore`, `PolicyEvaluator`, `PolicyTranslator`, `InMemoryAuditStore`, `ComplianceAuditLogger`
- safety/memory defense: `createSafetyMonitor`, `getBuiltInRules`, `createMemoryDefense`
- classification: `DataClassifier`, `DEFAULT_CLASSIFICATION_PATTERNS`

### Namespace and tier surfaces
- `@dzupagent/core/facades`: namespace exports for `quickStart`, `orchestration`, `security`
- `@dzupagent/core/stable`: same namespace-level curated surface
- `@dzupagent/core/advanced`: broad mirror of `@dzupagent/core` root surface

## Dependencies
### Direct package dependencies (`package.json`)
- `@dzupagent/agent-types`
- `@dzupagent/runtime-contracts`
- `@dzupagent/security`

### Facade-level source dependencies
- `quick-start.ts`
  - local modules from `config`, `events`, `errors`, `llm`, `hooks`, `streaming`
- `orchestration.ts`
  - local modules from `events`, `hooks`, `plugin`, `router`, `subagent`, `skills`, `pipeline`, `persistence`, `protocol`, `middleware`, `concurrency`, `observability`, `telemetry`
- `security.ts`
  - local modules from `security/*` plus cross-package `SecurityPolicyConfig` type from `@dzupagent/security`

### Peer dependencies that may affect consumers
- `@langchain/core`
- `@langchain/langgraph`
- `zod`
- optional peers used by some surfaced modules: `@anthropic-ai/tokenizer`, `@lancedb/lancedb`, `apache-arrow`, `js-tiktoken`

## Integration Points
Primary consumer import choices:
1. Curated subpaths:
- `@dzupagent/core/quick-start`
- `@dzupagent/core/orchestration`
- `@dzupagent/core/security`
2. Namespace tier:
- `@dzupagent/core/facades`
- `@dzupagent/core/stable`
3. Broad tier:
- `@dzupagent/core/advanced`
- root `@dzupagent/core`

Cross-surface integration represented by facades:
- quick-start integrates container + event bus + model registry/provider registration for minimal startup
- orchestration integrates routing, protocol, stores, skills/subagents, and operational utilities
- security integrates policy/audit controls with scanning/redaction and output safety utilities

Compatibility relationship:
- `advanced` intentionally tracks root `index.ts` symbols
- `stable` intentionally tracks facade namespace surface

## Testing and Observability
Facade behavior is covered by dedicated tests in `src/__tests__`:
- `facades.test.ts`
  - namespace wiring and representative export smoke checks
  - asserts `memory` namespace is absent from facades/stable
  - validates `advanced` identity with root exports for representative symbols
- `facade-quick-start.test.ts`
  - validates `createQuickAgent` default/override behavior
  - provider coverage and structured output defaults/overrides
  - container singleton wiring and event bus/container helper behavior
- `facade-orchestration.test.ts`
  - behavior checks for `AgentBus`, hooks, stores, semaphore/pool, health aggregation, trace propagation, cost-aware helpers
- `facade-security.test.ts`
  - behavior checks for risk classifier, scanners/redaction, output pipeline, policy evaluator, safety monitor, classification defaults
- `w15-b1-facades.test.ts`
  - broader regression checks across quick-start/orchestration/security including policy translation, compliance audit logging/store integrity, harmful content/classification-aware redaction, and additional concurrency/protocol paths

Observability notes:
- facade modules themselves do not add independent telemetry
- observability primitives are surfaced from orchestration (`MetricsCollector`, `globalMetrics`, `HealthAggregator`, trace propagation helpers)

## Risks and TODOs
- README drift: `packages/core/README.md` still documents `@dzupagent/core/memory` and `memory` namespace in `@dzupagent/core/facades`, but current facades and exports expose only `quickStart`, `orchestration`, and `security`.
- API churn risk in curated barrels: `orchestration.ts` and `security.ts` aggregate many modules; accidental export changes can become external API breaks.
- `advanced` coupling risk: because `advanced.ts` re-exports root `index.ts`, any root export change propagates directly to `@dzupagent/core/advanced`.
- Maintenance TODO: keep `package.json` subpath exports, `tsup.config.ts` entry list, and facade tests aligned whenever facade files/tiers change.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
- 2026-05-17: rewritten against current `packages/core` facade source, tier entrypoints, export map, build entry configuration, and facade test suite.
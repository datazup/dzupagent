# `@dzupagent/core` Facades Architecture

## Scope
This document covers the curated facade layer under `packages/core/src/facades` and how it is published from `@dzupagent/core`.

In-scope files:
- `src/facades/quick-start.ts`
- `src/facades/orchestration.ts`
- `src/facades/security.ts`
- `src/facades/index.ts`
- `src/stable.ts`
- `src/advanced.ts`
- `package.json` export map
- facade-related tests under `src/__tests__`

Out of scope:
- internal implementation details of every re-exported subsystem (those belong to each module's own `ARCHITECTURE.md`)
- the removed `memory` facade implementation (no `src/facades/memory.ts` exists in current source tree)

## Responsibilities
The facades layer provides a smaller, domain-oriented API surface for consumers who do not want the full `@dzupagent/core` root barrel.

Current responsibilities:
- expose fast bootstrap and base runtime wiring via `@dzupagent/core/quick-start`
- expose orchestration-heavy primitives via `@dzupagent/core/orchestration`
- expose security and policy primitives via `@dzupagent/core/security`
- expose namespace-based grouped access via `@dzupagent/core/facades`
- support a facade-first tier at `@dzupagent/core/stable` (`quickStart`, `orchestration`, `security`)
- keep `@dzupagent/core/advanced` as an explicit alias of the full root surface (`src/index.ts`)

Important boundary: memory/context are intentionally not re-exported from facades (or the root barrel) and are expected to be consumed directly from Layer 2 packages (`@dzupagent/memory`, `@dzupagent/context`).

## Structure
Current facade module structure:

1. `quick-start.ts`
- selective exports: DI container, event bus types, error types, model registry and invoke helpers, config helpers, hook type, SSE transformer types
- local implementation: `QuickAgentOptions`, `QuickAgentResult`, `createQuickAgent()`
- provider-default map for `anthropic`, `openai`, `openrouter`, `google`, `qwen`, `azure`, `bedrock`, plus fallback `custom`

2. `orchestration.ts`
- pure curated re-export barrel over orchestration-adjacent modules
- grouped export sections: events, hooks, plugins, router, sub-agents, skills, pipeline schemas/types/helpers, in-memory run/event stores, protocol bridge/adapters, cost middleware, concurrency, observability, trace propagation

3. `security.ts`
- pure curated re-export barrel over security modules
- grouped export sections: risk classifier, tool-permission defaults, secrets/PII scanners, output pipeline, audit store/logger, policy store/evaluator/translator, safety monitor, memory defense, enhanced output filters, data classification

4. `index.ts`
- namespace exports only:
  - `quickStart`
  - `orchestration`
  - `security`

Entrypoint wiring:
- `src/stable.ts` re-exports `./facades/index.js` (facade namespace tier)
- `src/advanced.ts` re-exports `./index.js` (full core surface alias)
- `package.json` exports subpaths:
  - `./quick-start`
  - `./orchestration`
  - `./security`
  - `./facades`
  - `./stable`
  - `./advanced`

## Runtime and Control Flow
Only `quick-start.ts` owns runtime behavior. The other facade files are export barrels.

`createQuickAgent()` control flow:
1. Resolve provider defaults from `PROVIDER_DEFAULTS` (or fallback to `custom`).
2. Resolve structured-output defaults via `getProviderStructuredOutputDefaults(provider)`, unless caller overrides with `structuredOutputCapabilities`.
3. Instantiate `ForgeContainer`, `DzupEventBus` (`createEventBus()`), and `ModelRegistry`.
4. Register a single provider in `ModelRegistry#addProvider(...)` with:
- provider/apiKey/baseUrl
- optional structured-output defaults
- chat/codegen model specs and token limits
5. Register `eventBus` and `registry` factories in the container.
6. Return `{ container, eventBus, registry }`.

Operational implication:
- facade import paths are static API routing only; orchestration/security facades do not add behavior layers on top of re-exported modules.
- `stable` keeps consumers on namespace imports, while `advanced` intentionally tracks full root exports for compatibility.

## Key APIs and Types
`@dzupagent/core/quick-start`:
- `createQuickAgent(options: QuickAgentOptions): QuickAgentResult`
- `QuickAgentOptions`, `QuickAgentResult`
- `ForgeContainer`, `createContainer`
- `createEventBus`, `DzupEventBus`, `DzupEvent`
- `ModelRegistry`, provider/model capability types
- `invokeWithTimeout`, `TokenUsage`, `InvokeOptions`
- `DEFAULT_CONFIG`, `resolveConfig`, `mergeConfigs`
- `SSETransformer`, `StandardSSEEvent`
- `ForgeError`, `ForgeErrorCode`

`@dzupagent/core/orchestration` (representative subset):
- routing: `IntentRouter`, `CostAwareRouter`, `ModelTierEscalationPolicy`, `LLMClassifier`
- orchestration runtime: `AgentBus`, hook runners, `SubAgentSpawner`
- skills: `SkillLoader`, `SkillManager`, `SkillLearner`, `createSkillChain`, `parseAgentsMd`
- pipeline: `PipelineDefinitionSchema`, `serializePipeline`, `deserializePipeline`, `autoLayout` and node/edge/checkpoint types
- persistence: `InMemoryRunStore`, `InMemoryAgentStore`, `InMemoryEventLog`
- protocol: `createForgeMessage`, `createResponse`, `ProtocolRouter`, `ProtocolBridge`, `A2AClientAdapter`
- middleware/concurrency/observability: cost attribution helpers, `Semaphore`, `ConcurrencyPool`, `MetricsCollector`, `HealthAggregator`
- telemetry: `injectTraceContext`, `extractTraceContext`, `formatTraceparent`, `parseTraceparent`

`@dzupagent/core/security` (representative subset):
- risk and tool gating: `createRiskClassifier`, default permission tier lists
- scanning/redaction: `scanForSecrets`, `redactSecrets`, `detectPII`, `redactPII`
- output control: `OutputPipeline`, `createDefaultPipeline`
- policy: `InMemoryPolicyStore`, `PolicyEvaluator`, `PolicyTranslator`
- audit: `InMemoryAuditStore`, `ComplianceAuditLogger`
- monitor/defense: `createSafetyMonitor`, `getBuiltInRules`, `createMemoryDefense`
- classification/output filtering: `DataClassifier`, `DEFAULT_CLASSIFICATION_PATTERNS`, `createHarmfulContentFilter`, `createClassificationAwareRedactor`

`@dzupagent/core/facades` and `@dzupagent/core/stable`:
- namespace access to `quickStart`, `orchestration`, `security`
- no `memory` namespace in current code

## Dependencies
Facade-layer dependencies are mostly internal module imports from `src/*`; they do not add third-party runtime dependencies directly.

Package-level dependency context (`packages/core/package.json`):
- runtime dependencies: `@dzupagent/agent-types`, `@dzupagent/runtime-contracts`
- peer dependencies relevant to re-exported types/modules:
  - `@langchain/core`
  - `@langchain/langgraph`
  - `zod`
  - optional `@lancedb/lancedb`, `apache-arrow`

Build/publish dependency path:
- subpath exports in `package.json` point to `dist/facades/*.js` and `dist/*.js` (`stable`, `advanced`)
- `tsup` builds these entrypoints from `src/facades/*`, `src/stable.ts`, and `src/advanced.ts`

## Integration Points
Consumer integration options:
1. Subpath imports by domain:
- `@dzupagent/core/quick-start`
- `@dzupagent/core/orchestration`
- `@dzupagent/core/security`

2. Namespace import:
- `@dzupagent/core/facades`
- `@dzupagent/core/stable` (same namespace surface)

3. Full-surface opt-in:
- `@dzupagent/core/advanced` (mirror of root `@dzupagent/core`)

Cross-module integration represented by facade exports:
- orchestration facade bridges many module boundaries (events, router, skills, pipeline, protocol, persistence, middleware, concurrency, telemetry, observability)
- security facade bridges risk classification, content scanning/redaction, policy/audit, and safety monitoring
- quick-start facade provides a single bootstrap seam used to wire container + event bus + model registry with provider defaults

## Testing and Observability
Facade tests in `src/__tests__` provide both surface and behavioral checks:
- `facades.test.ts`:
  - verifies export availability for quick-start/orchestration/security namespaces
  - verifies `stable` namespace behavior
  - verifies `advanced` tracks root export identity for representative symbols
  - verifies memory namespace is absent from facades/stable
- `facade-quick-start.test.ts`:
  - verifies provider default model selection for multiple providers
  - verifies token defaults/overrides
  - verifies structured-output default behavior and custom overrides
  - verifies DI container wiring and singleton behavior
- `facade-orchestration.test.ts`:
  - validates behavior of exported orchestration primitives (`AgentBus`, hook runners, in-memory stores, semaphores, health checks, protocol helpers)
- `facade-security.test.ts`:
  - validates risk classification, scanners/redactors, output pipeline, policy evaluator, safety monitor, memory defense, and data classification behavior
- `w15-b1-facades.test.ts`:
  - regression bundle covering additional provider and edge-case behavior

Observability inside facades:
- no dedicated facade metrics layer exists
- observability is exposed by re-export (`MetricsCollector`, `HealthAggregator`, trace propagation helpers) through `@dzupagent/core/orchestration`

## Risks and TODOs
Current drift and maintenance risks visible from local code:

1. Stale build entry configuration:
- `tsup.config.ts` still references removed entries (`src/facades/memory.ts`, `src/memory-ipc.ts`), while those files are absent in `src/`.

2. README drift:
- `packages/core/README.md` still documents `@dzupagent/core/memory` imports and memory namespace examples under facades, which do not match current `package.json` exports or `src/facades/index.ts`.

3. Historical facade doc drift:
- prior `src/facades/ARCHITECTURE.md` content referenced `memory` facade/module and outdated topology.

Recommended follow-up:
- align `tsup.config.ts` entry list with existing source files
- refresh README facade examples to only include exported subpaths
- keep facade architecture docs synchronized with `package.json` exports and `src/facades/index.ts`

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-26: rewritten from current `packages/core/src/facades` implementation, package export map, and active facade tests.
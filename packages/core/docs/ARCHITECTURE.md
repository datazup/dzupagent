# @dzupagent/core Architecture

## Scope
This document describes the current implementation of `@dzupagent/core` in:

- `packages/core/src/**`
- `packages/core/package.json`
- `packages/core/README.md`
- package-local architecture docs under `packages/core/src/**/ARCHITECTURE.md`

It is focused on what is actually implemented and exported in this package today.

Public package entrypoints defined in `package.json`:

- `@dzupagent/core`
- `@dzupagent/core/stable`
- `@dzupagent/core/advanced`
- `@dzupagent/core/quick-start`
- `@dzupagent/core/orchestration`
- `@dzupagent/core/security`
- `@dzupagent/core/facades`
- `@dzupagent/core/vectordb`
- `@dzupagent/core/events`
- `@dzupagent/core/llm`
- `@dzupagent/core/tools`
- `@dzupagent/core/identity`
- `@dzupagent/core/persistence`
- `@dzupagent/core/plugins`
- `@dzupagent/core/pipeline`
- `@dzupagent/core/mcp`
- `@dzupagent/core/model`
- `@dzupagent/core/utils`

Current package size signals (from local source tree):

- `415` TypeScript source files under `src/`
- `117` `*.test.ts` files under `src/`

## Responsibilities
`@dzupagent/core` is the Layer 1 runtime primitive package for DzupAgent. It provides:

- Config and DI primitives (`config`, `ForgeContainer`, config loading/validation).
- Event contracts and in-process buses (`DzupEventBus`, `AgentBus`, typed event utilities).
- LLM provider registration, invocation resilience, retry, circuit-breaking, token estimation, and embedding model metadata.
- Prompt fragment/template composition and resolution.
- Routing and escalation policies for model-tier and intent classification.
- Protocol and identity utilities (Forge message schema, A2A helpers, signing, delegation, trust scoring).
- MCP client/server/bridge/resources/prompts/sampling support, plus in-memory manager and reliability helpers.
- Skill, workflow, and subagent primitives.
- Pipeline definition schemas, serialization/deserialization, and layout helper.
- Persistence utilities (LangGraph checkpointer helper, session IDs, in-memory stores, event logs, run journal, run-state snapshots, legacy run-record compatibility).
- Security primitives (risk tiers, policy evaluation, audit log, safety monitor, memory defense, outbound URL policy, PII/secrets redaction, classification).
- Observability and runtime utility primitives (metrics, health aggregation, trace propagation, concurrency, tool governance/statistics, output format adapters, guardrails).
- Vector DB abstraction and adapters (in-memory plus provider adapters through the vectordb submodule).

Deliberate boundary in current code:

- Root `src/index.ts` intentionally does not re-export full Layer 2 memory/context packages.
- Comments and tests enforce direct imports from `@dzupagent/memory` and `@dzupagent/context` where needed by consumers.

## Structure
Top-level entrypoint model:

- `src/index.ts`: broad root barrel.
- `src/stable.ts`: curated, facade-first surface (`facades/*` namespaces only).
- `src/advanced.ts`: explicit broad surface alias to root exports.
- `src/facades/*.ts`: curated slices (`quick-start`, `orchestration`, `security`, combined `facades`).
- Subpath barrels for focused domains: `events.ts`, `llm.ts`, `tools.ts`, `identity.ts`, `persistence.ts`, `plugins.ts`, `pipeline.ts`, `model.ts`, `utils.ts`, `mcp/index.ts`, `vectordb/index.ts`.

Main implementation domains in `src/`:

- `config`, `errors`, `events`, `hooks`, `plugin`
- `llm`, `prompt`, `router`, `context`, `middleware`, `streaming`
- `protocol`, `identity`, `mcp`
- `skills`, `subagent`, `flow`, `pipeline`
- `persistence`, `registry`, `vectordb`
- `security`, `tools`, `formats`, `structured`, `output`
- `observability`, `telemetry`, `concurrency`, `guardrails`, `utils`, `logging`, `i18n`

Build and packaging shape:

- Build tool: `tsup` with ESM output to `dist/`.
- Type declarations emitted by tsup DTS pipeline.
- tsup entries include all public subpath barrels plus `src/events/event-types.ts`.
- Public package exports are controlled by `package.json` `exports` map and are narrower than tsup outputs.

## Runtime and Control Flow
There is no single monolithic runtime class in this package; consumers compose primitives. The common control flow in current code is:

1. Bootstrap and dependency wiring.
- Create container (`createContainer`) and event bus (`createEventBus`).
- Optionally use `createQuickAgent()` to wire container, event bus, and a preconfigured `ModelRegistry`.

2. Model/provider setup.
- Register providers via `ModelRegistry.addProvider(...)`, priority-sorted.
- Resolve models by tier/provider/name.
- Attach structured-output capabilities during model resolution.

3. Invocation and resilience.
- Use `invokeWithTimeout(...)` for timeout + retry behavior.
- For fallback chains, use `ResilientModelInvoker` over `ModelFallbackCandidate[]`.
- Breaker state can be recorded per provider via registry methods.

4. Orchestration and routing.
- Use intent/classification components (`IntentRouter`, `KeywordMatcher`, `LLMClassifier`, cost-aware routing).
- Use subagent and skill primitives for multi-step execution.
- Use pipeline schema/serialization/layout tools for declarative workflows.

5. Security and governance checks.
- Apply policy/risk/monitoring and output sanitization (`PolicyEvaluator`, `createRiskClassifier`, `createSafetyMonitor`, `OutputPipeline`, redactors).
- Enforce outbound URL checks in network-bound flows (for example MCP HTTP calls via outbound URL policy wrapper).

6. Protocol and integration surfaces.
- Use MCP client and transport-agnostic MCP server (`DzupAgentMCPServer`) to expose/consume tools/resources/prompts/sampling.
- Use protocol/identity helpers for message envelope, signing, delegation, and trust handling.

7. Persistence and observability.
- Persist run/session artifacts through in-memory stores, event logs, journals, and snapshot stores when used by caller.
- Emit runtime events and collect metrics/health/trace context through observability primitives.

Notable implemented runtime details:

- Event bus emits are fire-and-forget; handler errors are caught/logged.
- MCP server handles: `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get`, `sampling/createMessage`.
- `createCheckpointer({ type: 'postgres' })` calls `setup()` before returning the saver.

## Key APIs and Types
Representative exported APIs (non-exhaustive, code-verified):

- DI/config: `ForgeContainer`, `createContainer`, `resolveConfig`, `validateConfig`.
- Events: `createEventBus`, `typedEmit`, `AgentBus`, `attachLlmAuditEventBridge`.
- LLM/model: `ModelRegistry`, `invokeWithTimeout`, `ResilientModelInvoker`, `CircuitBreaker`, `TokenBucket`, `TokenizerRegistry`, `EmbeddingRegistry`.
- Routing: `IntentRouter`, `CostAwareRouter`, `ModelTierEscalationPolicy`.
- MCP: `MCPClient`, `DzupAgentMCPServer`, `MCPResourceClient`, `createSamplingHandler`, `InMemoryMcpManager`, `McpReliabilityManager`.
- Security: `createRiskClassifier`, `scanForSecrets`, `detectPII`, `PolicyEvaluator`, `ComplianceAuditLogger`, `createSafetyMonitor`, `createMemoryDefense`, `fetchWithOutboundUrlPolicy`.
- Pipeline: `PipelineDefinitionSchema`, `serializePipeline`, `deserializePipeline`, `autoLayout`.
- Persistence: `createCheckpointer`, `SessionManager`, `InMemoryRunStore`, `InMemoryEventLog`, `InMemoryRunJournal`, `InMemoryRunStateStore`, `DeltaRunStateStore`, `InMemoryVersionedContextBackend`.
- Protocol/identity: `createForgeMessage`, `ProtocolRouter`, `A2AClientAdapter`, signing/delegation/trust helpers in `identity`.
- Tools/utilities: `createForgeTool`, `ToolGovernance`, `ToolStatsTracker`, `MetricsCollector`, `HealthAggregator`, `Semaphore`, `ConcurrencyPool`, `StuckDetector`.
- Vector DB: `SemanticStore`, `InMemoryVectorStore`, provider adapter exports under `@dzupagent/core/vectordb`.

Common types exposed:

- LLM: `LLMProviderConfig`, `ModelSpec`, `ModelOverrides`, `TokenUsage`, `RetryConfig`.
- Pipeline: `PipelineDefinition`, node/edge/checkpoint types.
- MCP: `MCPServerConfig`, `MCPToolDescriptor`, `MCPRequest`, `MCPResponse`, prompt/resource/sampling types.
- Persistence: `RunStore`, `Run`, `RunStatus`, `DzupRunState`, journal entry unions.
- Security: policy, audit, monitor, classification type families.
- Version constant: `dzupagent_CORE_VERSION` (currently `0.2.0`).

## Dependencies
Declared runtime dependencies:

- `@dzupagent/agent-types`
- `@dzupagent/runtime-contracts`
- `@dzupagent/security`

Declared peer dependencies:

- `@langchain/core`
- `@langchain/langgraph`
- `zod`
- optional peers: `@anthropic-ai/tokenizer`, `@lancedb/lancedb`, `apache-arrow`, `js-tiktoken`

Observed runtime imports in source that are currently listed in `devDependencies`:

- `@langchain/anthropic` (used in model factory).
- `@langchain/openai` (used in model factory and OpenAI-compatible providers).
- `@langchain/langgraph-checkpoint-postgres` (used by `createCheckpointer` for postgres mode).

Build/test dependencies and runtime assumptions:

- TypeScript + tsup + vitest.
- ESM package (`"type": "module"`), Node 20 build target in tsup.

## Integration Points
Within `@dzupagent/core`:

- Root barrel (`@dzupagent/core`) exposes the broadest surface.
- `stable` and `facades` entrypoints provide curated namespace-level usage.
- Domain subpaths (`/events`, `/llm`, `/model`, `/security`, `/mcp`, `/pipeline`, `/persistence`, `/tools`, `/utils`, `/vectordb`, etc.) provide narrower contracts.

Cross-package and external integration seams:

- LangChain model/checkpoint abstractions are used by LLM and persistence helpers.
- MCP subsystem integrates with HTTP/SSE/stdio transports and can bridge to LangChain tools.
- Security monitor and PII/injection detectors integrate with `@dzupagent/security`.
- Runtime contracts and shared primitive types come from `@dzupagent/agent-types` and `@dzupagent/runtime-contracts`.

Important public-surface distinctions:

- `@dzupagent/core/persistence` is narrower than root persistence exports.
- `src/persistence/index.ts` is narrower still and not equal to package subpath surface.
- `@dzupagent/core/vectordb` exports `LanceDBAdapter`, while root `@dzupagent/core` does not currently re-export that symbol.

## Testing and Observability
Package-level verification scripts:

- `yarn workspace @dzupagent/core build`
- `yarn workspace @dzupagent/core typecheck`
- `yarn workspace @dzupagent/core lint`
- `yarn workspace @dzupagent/core test`
- `yarn workspace @dzupagent/core test:coverage`

Current test layout:

- `117` test files across root `src/__tests__` plus module-local test directories (for example `src/llm/__tests__`, `src/mcp/__tests__`, `src/persistence/__tests__`, `src/flow/__tests__`, `src/vectordb/__tests__`).

Observed test focus areas:

- Export/facade and boundary invariants.
- LLM registry, timeout/retry/fallback behavior, token usage extraction.
- MCP client/server/resources/sampling/manager/reliability/security.
- Persistence journaling, run-state snapshots, versioned context backend.
- Security policy/audit/monitor/scanner behavior.
- Pipeline serialization/schema handling.

Observability primitives provided by package:

- Typed event buses: `DzupEventBus`, `AgentBus`.
- LLM audit-event bridge.
- Metrics collection and health aggregation.
- Lightweight trace context propagation helpers.
- Tool governance/statistics and run-event logging primitives.

## Risks and TODOs
- `README.md` examples include memory-oriented import paths (`@dzupagent/core/memory`) that are not exported by `package.json`; this can mislead consumers.
- Runtime imports from `@langchain/anthropic`, `@langchain/openai`, and `@langchain/langgraph-checkpoint-postgres` are currently sourced from `devDependencies`, which is a packaging/runtime-install risk.
- Root vs subpath export drift risk exists because tsup emits additional entry artifacts while `package.json` selectively exposes subpaths.
- `src/events/event-types.ts` is built as an entry artifact but not exposed through an explicit package export path.
- Public API breadth is large; accidental contract changes are likely without strict barrel curation and export-parity tests.
- Memory/context boundary is intentionally strict; examples/docs must continue avoiding Layer 2 re-export assumptions.
- In-memory defaults (stores, MCP manager, registry) are suitable for local/test but not durable production persistence by themselves.
- Vector DB export asymmetry can surprise consumers (`LanceDBAdapter` only via `@dzupagent/core/vectordb` currently).

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js
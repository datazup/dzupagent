# @dzupagent/core Architecture

## Scope
`@dzupagent/core` is the foundational runtime package in the `dzupagent` monorepo for reusable orchestration primitives, safety controls, message/protocol contracts, and execution utilities.

This document is scoped to the current code under `packages/core`, with emphasis on:
- `src/`
- `package.json`
- `README.md`
- `docs/` and in-module `ARCHITECTURE.md` files

Published package entrypoints currently declared in [`package.json`](../package.json):
- `@dzupagent/core` (root barrel)
- `@dzupagent/core/stable` (facade namespace tier)
- `@dzupagent/core/advanced` (alias of root barrel)
- `@dzupagent/core/quick-start`
- `@dzupagent/core/orchestration`
- `@dzupagent/core/security`
- `@dzupagent/core/facades`

## Responsibilities
The package owns cross-cutting, app-agnostic primitives that other DzupAgent packages and apps build on:
- Configuration layering and lightweight DI (`config/*`)
- Typed eventing and agent bus messaging (`events/*`)
- Model/provider registry with retry and circuit-breaking (`llm/*`)
- Prompt fragments, templating, and cache/resolver utilities (`prompt/*`)
- Routing and model-tier escalation helpers (`router/*`)
- Protocol/message envelope and adapter routing (`protocol/*`)
- MCP client/server bridge, reliability, and security helpers (`mcp/*`)
- Plugin and hook lifecycle mechanisms (`plugin/*`, `hooks/*`)
- Skills parsing/loading/management/learning and workflow command parsing (`skills/*`)
- Persistence abstractions and in-memory stores (`persistence/*`)
- Pipeline definition/schemas/layout/serialization (`pipeline/*`)
- Security stack (risk, PII/secrets, policy, audit, monitor, memory defense) (`security/*`)
- Observability and health aggregation (`observability/*`, `telemetry/*`)
- Concurrency controls (`concurrency/*`)
- Registry/capability matching and optional semantic search (`registry/*`)
- Vector DB adapters and embeddings (`vectordb/*`)

Explicit boundary in code: memory/context packages are not re-exported from core root and should be consumed directly from Layer 2 packages (`@dzupagent/memory`, `@dzupagent/context`).

## Structure
Top-level source structure under `src/`:
- API tiers: `index.ts`, `stable.ts`, `advanced.ts`, `facades/*`
- Runtime modules: `config`, `events`, `llm`, `router`, `protocol`, `mcp`, `pipeline`, `persistence`, `security`, `skills`, `plugin`, `hooks`, `registry`, `vectordb`, `tools`, `formats`, `streaming`, `identity`, `observability`, `telemetry`, `concurrency`, `prompt`, `output`, `flow`, `context`, `i18n`, `errors`, `utils`
- Tests: broad `src/**/__tests__` coverage plus package-level tests (`*.test.ts`)

API tier intent:
- `index.ts`: broad export surface for framework-level composition.
- `advanced.ts`: explicit alias to full root surface.
- `stable.ts`: narrow facade-first tier (`quickStart`, `orchestration`, `security` namespaces via `facades/index.ts`).
- facade subpaths expose curated groups without importing the entire root barrel.

Build/test packaging:
- Build uses `tsup` to ESM output in `dist/`.
- Type declarations emitted by `tsup` (`dts` enabled).
- Unit/integration tests use Vitest in Node environment.

## Runtime and Control Flow
A typical runtime composition path in this package looks like:
1. Resolve config layers using `resolveConfig()` (`defaults <- file <- env <- runtime`).
2. Build wiring with `ForgeContainer` and shared services (event bus, model registry, etc.).
3. Route/classify work via `IntentRouter` (`heuristic -> keyword -> llm -> default`).
4. Resolve model/provider through `ModelRegistry`, with optional fallback and circuit breaker checks.
5. Execute LLM call with `invokeWithTimeout()` and transient retry logic from `llm/retry.ts`.
6. Apply security/output controls (for example `OutputPipeline`, policy evaluator, scanners).
7. Emit and consume typed events via `DzupEventBus`/`AgentBus`.
8. Persist or checkpoint run artifacts through in-memory stores or LangGraph checkpointer adapters.
9. Optionally bridge tools/resources/protocol calls through MCP and protocol adapters.

Notable operational behavior in current code:
- Event handlers are isolated so handler failures do not crash emitters.
- Several subsystems intentionally degrade non-fatally (for example MCP connection/invocation paths returning error results instead of crashing the caller).
- Pipeline definitions are JSON-serializable contracts with schema and validation helpers.

## Key APIs and Types
Representative APIs exported from current root/facades:
- Config/DI:
  - `ForgeContainer`, `createContainer`
  - `resolveConfig`, `mergeConfigs`, `loadEnvConfig`, `loadFileConfig`, `validateConfig`
- Events:
  - `createEventBus`, `DzupEventBus`, `AgentBus`
  - `emitDegradedOperation`, `requireTerminalToolExecutionRunId`
- LLM:
  - `ModelRegistry`
  - `invokeWithTimeout`, `extractTokenUsage`, `isTransientError`, `DEFAULT_RETRY_CONFIG`
  - `CircuitBreaker`, `KeyedCircuitBreaker`, `EmbeddingRegistry`
- Routing:
  - `IntentRouter`, `KeywordMatcher`, `LLMClassifier`, `CostAwareRouter`, `ModelTierEscalationPolicy`
- Security:
  - `createRiskClassifier`, `scanForSecrets`, `detectPII`, `OutputPipeline`
  - `PolicyEvaluator`, `PolicyTranslator`, `InMemoryPolicyStore`
  - `ComplianceAuditLogger`, `createSafetyMonitor`, `createMemoryDefense`
- Protocol/MCP:
  - `createForgeMessage`, `ProtocolRouter`, `ProtocolBridge`, `InternalAdapter`
  - `MCPClient`, `DzupAgentMCPServer`, `InMemoryMcpManager`, `McpReliabilityManager`
- Persistence/Pipeline:
  - `createCheckpointer`, `SessionManager`, `InMemoryRunStore`, `InMemoryRunJournal`
  - `PipelineDefinitionSchema`, `serializePipeline`, `deserializePipeline`, `autoLayout`
- Skills/Plugins/Hooks:
  - `SkillLoader`, `SkillManager`, `SkillLearner`, `WorkflowCommandParser`, `WorkflowRegistry`
  - `PluginRegistry`, `discoverPlugins`, `resolvePluginOrder`
  - `runHooks`, `runModifierHook`, `mergeHooks`

Key type families:
- `ForgeConfig`, `ProviderConfig`
- `LLMProviderConfig`, `ModelTier`, `ModelSpec`
- `ForgeMessage*` protocol types
- `PipelineDefinition`, `PipelineNode`, `PipelineEdge`
- `Policy*`, `Safety*`, `Risk*`, `Classification*`
- `RunJournalEntry*`, `RunStore` and related persistence contracts

## Dependencies
Declared in `packages/core/package.json`:
- Runtime dependencies:
  - `@dzupagent/agent-types`
  - `@dzupagent/runtime-contracts`
- Peer dependencies:
  - `@langchain/core`
  - `@langchain/langgraph`
  - `zod`
  - optional: `@lancedb/lancedb`, `apache-arrow`
- Dev dependencies include concrete provider/checkpointer packages used by code paths/tests:
  - `@langchain/anthropic`, `@langchain/openai`
  - `@langchain/langgraph-checkpoint-postgres`

Code-level external integration usage includes:
- LangChain chat models for provider instantiation
- LangGraph `MemorySaver` and Postgres checkpointer path
- Zod schemas in typed contracts (pipeline/formats/protocol and related modules)

## Integration Points
Primary integration surfaces for other packages/apps:
- Facade imports for app-safe consumption:
  - `@dzupagent/core/quick-start`
  - `@dzupagent/core/orchestration`
  - `@dzupagent/core/security`
  - `@dzupagent/core/stable` and `@dzupagent/core/facades`
- Root/advanced imports for framework-level consumers needing full surface.
- Flow/pipeline/type contracts used as boundaries with orchestration/compiler layers (`flow/*`, `pipeline/*`, `protocol/*`).
- Runtime-contract and agent-types alignment through explicit type imports/re-exports in `skills/*` and `llm/retry.ts`.

Current code also indicates integration boundaries that are intentionally not exposed from core:
- Memory/context live in separate packages and should be imported directly there, not through core.

## Testing and Observability
Testing:
- Vitest configuration in `vitest.config.ts` (`environment: node`, explicit include globs, V8 coverage).
- Coverage excludes barrels/tests/fixtures and is centrally threshold-managed.
- Package currently contains broad test coverage across modules under `src/**/__tests__`.

Observability mechanisms in package code:
- `DzupEventBus` typed event stream with wildcard subscriptions.
- Metrics primitives: `MetricsCollector`, `globalMetrics`.
- Health checks: `HealthAggregator` and typed health report contracts.
- Trace context helpers in `telemetry/trace-propagation.ts` (lightweight propagation without OpenTelemetry SDK dependency).
- Cost attribution middleware and tool stats/governance utilities.

## Risks and TODOs
Code/documentation drift visible in the current local codebase:
- `src/index.ts` exports `dzupagent_CORE_VERSION = '0.2.0'`, matching the `package.json` version.
- `tsup.config.ts` still includes entries for removed files (`src/memory-ipc.ts`, `src/facades/memory.ts`).
- `README.md` still references `@dzupagent/core/memory`, but that subpath is not present in `package.json` exports.
- In-module architecture docs under `src/**/ARCHITECTURE.md` likely contain stale examples tied to removed memory facade paths.

Recommended follow-up:
- Align exported version constant with package versioning policy.
- Remove stale tsup entries or restore intended files explicitly.
- Refresh README/examples to match actual published subpath exports.
- Run docs regeneration after export-surface cleanup.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js
- 2026-04-26: rewritten from current `packages/core` implementation (`src`, package exports, tests, and module docs), with explicit drift notes for stale build/docs surfaces.

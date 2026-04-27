# @dzupagent/agent-adapters Architecture

## Scope
This document describes the architecture of `@dzupagent/agent-adapters` as implemented in `packages/agent-adapters`.

Included scope:
- Package runtime surface under `src/`.
- Public API exported from `src/index.ts` and published via package `exports`.
- Provider adapters, routing, orchestration, workflow, recovery, policy, HTTP, plugin, MCP, persistence, learning, and `.dzupagent` integration.
- Package-level tests and observability hooks.

Out of scope:
- Internal implementation details of upstream dependencies (`@dzupagent/core`, `@dzupagent/agent`, `@dzupagent/adapter-types`) except where they define integration boundaries.

## Responsibilities
`@dzupagent/agent-adapters` is the adapter and orchestration layer that normalizes provider runtimes and exposes a single execution/control surface.

Primary responsibilities:
- Provide a unified adapter contract via `AgentCLIAdapter` and normalized `AgentEvent` streams.
- Host concrete provider integrations: Claude, Codex, Gemini (CLI + SDK), Qwen, Crush, Goose, OpenRouter, and OpenAI.
- Route and fail over execution using `ProviderAdapterRegistry` + routing strategies.
- Expose high-level orchestration APIs (`run`, `chat`, `parallel`, `race`, `supervisor`, `mapReduce`, `bid`) via `OrchestratorFacade`.
- Manage session continuity across providers (`SessionRegistry`) and workflow-level state/checkpointing.
- Apply governance controls: approval, guardrails, policy compilation/conformance, recovery strategies, and escalation.
- Provide transport/integration boundaries: HTTP handler, plugin interfaces, agent bridge, MCP tool sharing/adapter config.
- Provide skill/memory enrichment and `.dzupagent` config ingestion for runtime prompt/context injection.

## Structure
Top-level package layout:
- `src/types.ts`: compatibility re-export of `@dzupagent/adapter-types`.
- `src/index.ts`: root barrel export (current publish target).
- `src/<provider>/`: provider adapters (`claude`, `codex`, `gemini`, `qwen`, `crush`, `goose`, `openrouter`, `openai`).
- `src/base/`: shared CLI adapter utilities.
- `src/registry/`: provider registry, router implementations, event-bus bridge, learning router.
- `src/facade/`: orchestration facade (`OrchestratorFacade`).
- `src/orchestration/`: `ParallelExecutor`, `SupervisorOrchestrator`, `MapReduceOrchestrator`, `ContractNetOrchestrator`.
- `src/workflow/`: declarative workflow builder/runtime/validator/template resolver.
- `src/session/`: workflow sessions, conversation history/compression, checkpointing.
- `src/persistence/` and `src/runs/`: file checkpoint store, run manager, run-event store/log paths.
- `src/middleware/`: memory enrichment, cost tracking/optimization/models, sanitizer, middleware pipeline.
- `src/approval/`, `src/guardrails/`, `src/policy/`, `src/recovery/`: control-plane and recovery layers.
- `src/http/`: framework-agnostic HTTP handler, schemas, rate limiter.
- `src/integration/`, `src/plugin/`, `src/mcp/`: agent bridge, plugin SDK/loader, MCP integration.
- `src/skills/`: skill projection, compilers, telemetry, capability matrix, version stores.
- `src/dzupagent/` and `src/ucl/`: `.dzupagent` loaders, config/import/sync support, frontmatter parsing.
- `src/observability/` and `src/streaming/`: tracing and stream serialization.
- `src/testing/`: A/B testing utilities.
- `src/__tests__/`: package test suites.

Entry surfaces inside source:
- Plane files exist (`src/providers.ts`, `src/orchestration.ts`, `src/http.ts`, `src/recovery.ts`, `src/workflow.ts`, `src/learning.ts`, `src/persistence.ts`).
- Published package `exports` currently exposes only `"."` (`dist/index.js` / `dist/index.d.ts`), so root import is the externally declared entrypoint.

## Runtime and Control Flow
Core single-run flow (`OrchestratorFacade.run`):
1. Construct `AgentInput` + `TaskDescriptor` from prompt and options.
2. Optionally apply `.dzupagent` enrichment (`WorkspaceResolver` + `loadDzupAgentConfig` + `EnrichmentPipeline.apply`).
3. Optionally compile policy (`compilePolicyForProvider`) and run conformance checks (`PolicyConformanceChecker`).
4. Execute through `ProviderAdapterRegistry.executeWithFallback`.
5. Bridge events to core bus (`EventBusBridge`), then wrap with cost tracking and guardrails if configured.
6. Optionally gate stream via `AdapterApprovalGate`.
7. Consume stream; success requires an explicit `adapter:completed` event.

Registry fallback flow (`ProviderAdapterRegistry.executeWithFallback`):
1. Select currently routable providers (registered, not disabled, circuit breaker allows execution).
2. Route using active `TaskRoutingStrategy`.
3. Build fallback order: selected provider -> router fallbacks -> remaining healthy providers.
4. Execute providers sequentially until a terminal completion event is observed.
5. On each failure: record breaker state, emit failure telemetry, continue fallback chain.
6. If all providers fail: throw `ALL_ADAPTERS_EXHAUSTED` (`ForgeError`).

Multi-turn flow (`OrchestratorFacade.chat` + `SessionRegistry.executeMultiTurnWithRaw`):
1. Resolve/create workflow session.
2. Build effective prompt with optional conversation handoff context.
3. Resolve provider (`options.provider` or workflow active provider or registry routing).
4. Reuse/resume provider session IDs when available.
5. Persist conversation entries, usage counters, active provider, and linked provider sessions.

Parallel and advanced orchestration:
- `ParallelExecutor` supports `first-wins`, `all`, `best-of-n`, with timeout and cancellation propagation.
- `SupervisorOrchestrator` decomposes goal into subtasks and executes with bounded parallelism.
- `MapReduceOrchestrator` chunks input, maps by provider execution, then reduces.
- `ContractNetOrchestrator` generates bids, ranks/selects, and executes winner with fallback bidders.
- Workflow DSL compiles to `PipelineRuntime` (`@dzupagent/agent`) and supports `step`, `parallel`, `branch`, `transform`, and `loop` nodes.

Recovery flow (`AdapterRecoveryCopilot`):
1. Track execution trace (`ExecutionTraceCapture`) and failure context.
2. Select strategy (`retry-same-provider`, `retry-different-provider`, `increase-budget`, `simplify-task`, `escalate-human`, `abort`).
3. Apply strategy with optional cross-provider handoff (`CrossProviderHandoff`) and backoff.
4. Emit recovery/cancellation outcome and return structured recovery result.

## Key APIs and Types
Core contract types (re-exported from `@dzupagent/adapter-types` through `src/types.ts`):
- `AgentCLIAdapter`
- `AdapterProviderId`
- `AgentInput`
- `AgentEvent` / `AgentStreamEvent`
- `TaskDescriptor`
- `RoutingDecision`
- `TaskRoutingStrategy`
- `TokenUsage`, `HealthStatus`, `SessionInfo`

Primary runtime APIs:
- `ProviderAdapterRegistry`
- `OrchestratorFacade` and `createOrchestrator`
- Routing strategies: `TagBasedRouter`, `CostOptimizedRouter`, `RoundRobinRouter`, `CompositeRouter`, `CapabilityRouter`, `ContextAwareRouter`, `LearningRouter`
- Orchestration engines: `ParallelExecutor`, `SupervisorOrchestrator`, `MapReduceOrchestrator`, `ContractNetOrchestrator`
- Workflow/session: `AdapterWorkflowBuilder` / `defineWorkflow`, `SessionRegistry`, `WorkflowCheckpointer`, `ConversationCompressor`, `DefaultCompactionStrategy`
- Governance and control: `AdapterGuardrails`, `AdapterApprovalGate`, `AdapterRecoveryCopilot`, `compilePolicyForProvider`, `PolicyConformanceChecker`
- Integration APIs: `AdapterHttpHandler`, `AgentIntegrationBridge`, `RegistryExecutionPort`, `createAdapterPlugin`, `AdapterPluginLoader`, `MCPToolSharingBridge`, `InMemoryMcpAdapterManager`
- Persistence and runs: `FileCheckpointStore`, `RunManager`, `RunEventStore`

Provider catalog and product gating:
- `PROVIDER_CATALOG` defines runtime/product/monitoring capabilities.
- `getProductProviders()` filters by `productIntegrated: true`.
- `ProviderAdapterRegistry.registerProductionAdapters()` consults catalog capabilities when deciding what to register.

## Dependencies
Package metadata (`package.json`):
- Runtime dependencies: `@dzupagent/adapter-types`, `@dzupagent/agent`, `@dzupagent/core`.
- Peer dependencies: `@langchain/core`, `zod`.
- Optional dependencies: `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`.

Runtime/tooling dependencies used by source:
- Dynamic import in `GeminiSDKAdapter`: `@google/generative-ai`.
- Node platform APIs: `child_process`, `fs`, `path`, streams, `crypto`, `fetch`.
- Build/test toolchain: `tsup`, `typescript`, `vitest`.

Build packaging:
- `tsup` entry: `src/index.ts`.
- Output format: ESM + declaration files.
- `external` marks workspace `@dzupagent/*` imports and optional SDKs as external.

## Integration Points
Core event system:
- `EventBusBridge` translates adapter events into `DzupEventBus` events, including tool correlation and execution run IDs.

HTTP transport (`AdapterHttpHandler`):
- Routes: `POST /run`, `POST /supervisor`, `POST /parallel`, `POST /bid`, `POST /approve/:id`, `GET /health`, `GET /health/detailed`, `GET /cost`.
- Features: auth hooks (`tokenValidator` / API key), optional rate limiting, SSE stream output via `StreamingHandler`, request validation via Zod schemas.

Agent/tool integration:
- `RegistryExecutionPort` adapts registry execution to provider-port usage.
- `AgentIntegrationBridge` and `AdapterAsToolWrapper` expose adapter execution as tool-like invocations.

Plugin and MCP integration:
- Plugin lifecycle: `createAdapterPlugin`, `defineAdapterPlugin`, `AdapterPluginLoader`.
- MCP layer: `MCPToolSharingBridge` plus `InMemoryMcpAdapterManager` for server/binding config.

`.dzupagent` capability ingestion:
- `WorkspaceResolver` and `.dzupagent` loaders (`DzupAgentFileLoader`, `DzupAgentMemoryLoader`, `DzupAgentImporter`, `DzupAgentAgentLoader`, `DzupAgentSyncer`) supply policy/skill/memory-aware runtime enrichment.

## Testing and Observability
Test setup:
- Framework: Vitest (`environment: node`).
- Test discovery: `src/**/*.test.ts` and `src/**/*.spec.ts`.
- Current test file count in `src/__tests__`: 130 `*.test.ts` files.
- Coverage thresholds in `vitest.config.ts`: statements 70, lines 70, branches 60, functions 60.

Coverage focus areas represented by tests:
- Provider adapters and normalization.
- Registry routing/fallback/circuit behavior.
- Orchestration engines and workflow DSL behavior.
- HTTP schemas and handler routes.
- Approval/guardrails/recovery logic.
- Plugin, MCP, session, run manager/event store, and `.dzupagent` loaders/sync flows.

Observability surfaces:
- `EventBusBridge` emits bus-level lifecycle and tool events.
- `AdapterTracer` + `createTracingMiddleware` record spans/events for adapter execution.
- `CostTrackingMiddleware` aggregates usage/cost and emits budget events.
- `StreamingHandler` serializes event streams as SSE/JSONL/NDJSON with progress tracking.
- Recovery trace store (`ExecutionTraceCapture`) preserves route/recovery decisions and observed events.

## Risks and TODOs
- Package export map only declares `"."`; plane entry files (`src/http.ts`, `src/workflow.ts`, etc.) exist but are not declared as package subpath exports.
- `request-schemas.ts` provider enum omits `openai` and `gemini-sdk`, while both provider IDs exist in adapter/runtime types.
- `PROVIDER_CATALOG` omits an `openai` entry; `registerProductionAdapters()` relies on catalog lookup and can silently skip providers not cataloged.
- `GeminiSDKAdapter` depends on runtime availability of `@google/generative-ai`, but that package is loaded dynamically and is not declared in package dependencies/optionalDependencies.
- Source imports `@dzupagent/agent-types` (`guardrails/adapter-guardrails.ts`), but package metadata does not list it as a dependency/peer/optional dependency.
- Architecture drift test (`src/__tests__/architecture-doc.test.ts`) still asserts legacy heading strings from the old doc format and may fail against the new required section layout.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js


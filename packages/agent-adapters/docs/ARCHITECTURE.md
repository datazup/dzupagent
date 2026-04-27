# @dzupagent/agent-adapters Architecture

## Scope
This document covers the current implementation of `@dzupagent/agent-adapters` in `packages/agent-adapters`, based on:
- `src/` runtime code and exports.
- `package.json`, `tsup.config.ts`, `vitest.config.ts`.
- Existing package docs under `docs/`.

Included:
- Provider adapters and event normalization.
- Routing/registry and fallback execution.
- Orchestration, workflow, recovery, policy, approval, guardrails.
- HTTP/plugin/MCP/integration boundaries.
- Session/persistence/learning/dzupagent-UCL surfaces.
- Test and observability surfaces in this package.

Excluded:
- Internal implementation details of upstream packages (`@dzupagent/core`, `@dzupagent/agent`, `@dzupagent/adapter-types`) beyond integration points used here.

## Responsibilities
`@dzupagent/agent-adapters` is the provider integration and orchestration layer between app/runtime callers and concrete provider backends.

Current responsibilities:
- Normalize execution behind `AgentCLIAdapter` and canonical `AgentEvent`/`AgentStreamEvent` contracts.
- Provide built-in adapters: Claude, Codex, Gemini CLI, Gemini SDK, Qwen, Crush, Goose, OpenRouter, OpenAI.
- Route tasks and perform sequential fallback with circuit-breaker-aware gating (`ProviderAdapterRegistry`).
- Expose a high-level facade (`OrchestratorFacade`) for `run`, `chat`, `parallel`, `race`, `supervisor`, `mapReduce`, and `bid`.
- Provide workflow and orchestration primitives (`AdapterWorkflow`, `ParallelExecutor`, `SupervisorOrchestrator`, `MapReduceOrchestrator`, `ContractNetOrchestrator`).
- Apply operational controls: approval, guardrails, policy compilation/conformance, recovery strategies, and cost tracking.
- Provide integration adapters for HTTP, plugin lifecycle, execution ports, and MCP tool/binding management.
- Support `.dzupagent` file-based skill/memory/agent loading and enrichment.

## Structure
Current source layout:
- `src/index.ts`: root barrel export for published package API.
- `src/types.ts`: compatibility re-export from `@dzupagent/adapter-types`.
- `src/providers.ts`, `src/orchestration.ts`, `src/workflow.ts`, `src/recovery.ts`, `src/learning.ts`, `src/persistence.ts`, `src/http.ts`: plane-specific barrels in source.
- `src/<provider>/`: provider implementations (`claude`, `codex`, `gemini`, `qwen`, `crush`, `goose`, `openrouter`, `openai`).
- `src/registry/`: registry, routers, event-bus bridge.
- `src/facade/`: `OrchestratorFacade` and factory.
- `src/orchestration/`: supervisor/parallel/map-reduce/contract-net implementations.
- `src/workflow/`: workflow DSL, compilation to `PipelineRuntime`, validation/template resolution.
- `src/session/`: workflow session state, checkpointer, compression/compaction.
- `src/persistence/` and `src/runs/`: file checkpoint/run persistence, run JSONL event store.
- `src/middleware/`: memory enrichment, cost tracking/optimization/models, sanitizer, middleware pipeline.
- `src/approval/`, `src/guardrails/`, `src/recovery/`, `src/policy/`: control-plane modules.
- `src/http/`: framework-agnostic handler + schemas + rate limiter.
- `src/integration/`, `src/plugin/`, `src/mcp/`: execution bridge, plugin SDK/loader, MCP management/tool sharing.
- `src/skills/`, `src/dzupagent/`, `src/ucl/`: skill projection/telemetry/versioning and `.dzupagent` loaders.
- `src/observability/`, `src/streaming/`: tracing and stream formatting.
- `src/output/`: structured-output validation adapters.
- `src/__tests__/` and `src/dzupagent/__tests__/`: package tests.

Packaging/build structure:
- Build entry is `src/index.ts` (`tsup.config.ts`).
- Package `exports` currently exposes only `"."` -> `dist/index.js` / `dist/index.d.ts`.
- Plane barrels are real source modules but are not currently declared package subpath exports.

## Runtime and Control Flow
Primary run flow (`OrchestratorFacade.run`):
1. Build `AgentInput` and `TaskDescriptor` from prompt/options.
2. Apply optional `.dzupagent` enrichment.
3. Compile/apply optional policy overrides (`compilePolicyForProvider`) and conformance checks.
4. Execute through `ProviderAdapterRegistry.executeWithFallback`.
5. Bridge events to bus (`EventBusBridge`) and apply post-stream wrappers (cost tracking, guardrails).
6. Optionally gate stream via `AdapterApprovalGate`.
7. Require terminal `adapter:completed`; otherwise fail with `ADAPTER_EXECUTION_FAILED`.

Registry fallback flow (`ProviderAdapterRegistry.executeWithFallbackWithRaw`):
1. Compute healthy provider set (registered, enabled, breaker permits execution).
2. Route task via active `TaskRoutingStrategy`.
3. Build ordered provider chain: primary -> explicit fallback providers -> remaining healthy providers.
4. Stream provider events, tracking terminal completion/failure signals.
5. Record breaker success/failure and emit registry/provider events on the event bus.
6. Synthesize failure events for non-terminal streams.
7. Throw `ALL_ADAPTERS_EXHAUSTED` when no provider completes.

Multi-turn chat flow (`OrchestratorFacade.chatWithRaw`):
1. Resolve/create workflow session ID in `SessionRegistry`.
2. Build per-turn input and adapter options.
3. Optionally apply `.dzupagent` enrichment and policy overrides.
4. Execute via `SessionRegistry.executeMultiTurnWithRaw` against registry.
5. Bridge and wrap stream similarly to `run`.

Workflow DSL flow (`AdapterWorkflow`):
1. `AdapterWorkflowBuilder` collects step/parallel/branch/transform/loop nodes.
2. `WorkflowValidator` validates graph and template usage.
3. Workflow compiles to `PipelineDefinition` + node handlers.
4. `PipelineRuntime` (`@dzupagent/agent`) executes compiled graph.
5. Step execution delegates to registry fallback execution and emits workflow lifecycle events.

Recovery flow (`AdapterRecoveryCopilot` family):
1. Capture execution traces/events (`ExecutionTraceCapture`).
2. Select policy strategy (`RecoveryPolicySelector`, `RECOVERY_POLICIES`).
3. Retry same/different provider, adjust budgets/prompts, handoff context, or escalate.
4. Return structured success/failure/cancelled result and optional escalation summary.

## Key APIs and Types
Core contracts (re-exported via `src/types.ts`):
- `AdapterProviderId`, `AgentCLIAdapter`, `AgentInput`, `TaskDescriptor`.
- `AgentEvent`, `AgentStreamEvent`, and event variants.
- `TaskRoutingStrategy`, `RoutingDecision`, `HealthStatus`, `TokenUsage`.

Primary runtime APIs:
- `ProviderAdapterRegistry` (registering, routing, fallback execution, health/circuit state).
- `OrchestratorFacade` and `createOrchestrator`.
- Routers: `TagBasedRouter`, `CostOptimizedRouter`, `RoundRobinRouter`, `CompositeRouter`, `CapabilityRouter`, `LearningRouter`, `ContextAwareRouter`.
- Orchestration engines: `ParallelExecutor`, `SupervisorOrchestrator`, `MapReduceOrchestrator`, `ContractNetOrchestrator`.
- Workflow/session: `AdapterWorkflowBuilder`/`defineWorkflow`, `SessionRegistry`, `WorkflowCheckpointer`, `ConversationCompressor`.
- Recovery/control: `AdapterRecoveryCopilot`, `AdapterApprovalGate`, `AdapterGuardrails`, policy compiler + conformance checker.
- Transport/integration: `AdapterHttpHandler`, `EventBusBridge`, `RegistryExecutionPort`, plugin APIs, MCP manager/tool sharing bridge.
- Persistence and logging: `FileCheckpointStore`, `RunManager`, `RunEventStore`, `runLogRoot`.

Provider capability policy surface:
- `PROVIDER_CATALOG` + helpers (`getMonitorableProviders`, `getProductProviders`, `getProviderCapabilities`).
- `registerProductionAdapters` / `registerExperimentalAdapters` enforce catalog-driven product vs experimental registration.

## Dependencies
Declared runtime dependencies:
- `@dzupagent/adapter-types`
- `@dzupagent/agent`
- `@dzupagent/agent-types`
- `@dzupagent/core`

Peer dependencies:
- `@langchain/core`
- `zod`

Optional dependencies:
- `@anthropic-ai/claude-agent-sdk`
- `@openai/codex-sdk`

Runtime/tooling notes from implementation:
- `GeminiSDKAdapter` dynamically imports `@google/generative-ai` (runtime optional, not declared in `package.json`).
- CLI-backed adapters depend on external binaries (`gemini`, `qwen`, `crush`, `goose`) being available in `PATH`.
- Build uses `tsup` (ESM + d.ts) with entry `src/index.ts`; workspace `@dzupagent/*` and optional SDKs are externalized.
- Testing uses Vitest in Node environment with configured coverage thresholds (statements/lines 70, branches/functions 60).

## Integration Points
Event bus integration:
- `EventBusBridge` maps adapter stream events to `DzupEventBus` events.
- Includes tool-call/result/error emission and terminal event run correlation (`executionRunId` handling).

HTTP integration (`AdapterHttpHandler`):
- Endpoints: `POST /run`, `POST /supervisor`, `POST /parallel`, `POST /bid`, `POST /approve/:id`, `GET /health`, `GET /health/detailed`, `GET /cost`.
- Supports token/API-key auth hooks, optional rate limiting, JSON or streaming responses, and Zod request validation.

Agent/runtime integration:
- `RegistryExecutionPort` implements `ProviderExecutionPort` over registry fallback execution.
- `AgentIntegrationBridge` and `AdapterAsToolWrapper` expose adapter runs as tool-like invocations.

Plugin integration:
- `createAdapterPlugin` wires registry/event bridge/cost/session subsystems into plugin lifecycle.
- `defineAdapterPlugin` and `AdapterPluginLoader` support plugin definition/loading patterns.

MCP integration:
- `MCPToolSharingBridge` shares and projects tools across providers.
- `InMemoryMcpAdapterManager` manages server registry, provider bindings, connectivity tests, and effective config resolution.

`.dzupagent` integration:
- `WorkspaceResolver`, config loaders, importer/syncer, and UCL loaders integrate file-based skill/memory/agent definitions into execution enrichment.

## Testing and Observability
Testing:
- Test runner: Vitest (`vitest.config.ts`).
- Current package test file count: 131 `*.test.ts` files under `src/__tests__/` and `src/dzupagent/__tests__/`.
- Coverage config includes broad `src/**/*.ts` with test/index exclusions and threshold gates.
- Test suites cover adapter behavior, routing/fallback, orchestration patterns, workflow DSL, recovery/approval/guardrails, HTTP handler/schemas, MCP/plugin/integration surfaces, and persistence/session/dzupagent loaders.

Observability surfaces:
- `EventBusBridge` emits lifecycle/tool/progress events to core event bus.
- `AdapterTracer` and tracing middleware add span/event instrumentation.
- `CostTrackingMiddleware` tracks usage/cost and emits budget-related events.
- `StreamingHandler` serializes stream output for SSE/JSONL/NDJSON formats.
- `RunEventStore` persists raw + normalized + artifact event logs and run summaries.
- Recovery trace capture stores execution traces and decisions for post-failure analysis.

## Risks and TODOs
- Package docs describe subpath API tiers (`docs/api-surface.md`), but `package.json` currently exports only the root entrypoint.
- `RunRequestSchema` provider enum excludes valid adapter IDs such as `openai` and `gemini-sdk`, limiting direct HTTP selection.
- `PROVIDER_CATALOG` does not include an `openai` entry, so catalog-driven product/experimental registration paths can skip it.
- `normalizeEvent` handles `openrouter` but not `openai`; OpenAI raw payload normalization is currently absent in this utility.
- `GeminiSDKAdapter` requires `@google/generative-ai` at runtime but this dependency is not declared in package metadata.
- `src/__tests__/architecture-doc.test.ts` asserts headings in root `packages/agent-adapters/ARCHITECTURE.md`, not this `docs/ARCHITECTURE.md`, so this document is not guarded by that test.

## Changelog
- 2026-04-26: automated refresh via scripts/refresh-architecture-docs.js


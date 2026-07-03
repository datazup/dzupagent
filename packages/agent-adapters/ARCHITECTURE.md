# @dzupagent/agent-adapters Architecture

## Scope

This document describes the current implementation of `@dzupagent/agent-adapters` in `packages/agent-adapters`.

Included scope:

- Runtime modules under `src/`.
- Published API from `src/index.ts` plus package export-map subpaths.
- Provider adapters, routing, orchestration, workflow, policy, approval, recovery, guardrails, HTTP, persistence, and integration modules.
- `.dzupagent`/UCL loaders and skill tooling included in this package.
- Package-local testing and observability surfaces.

Out of scope:

- Internal implementation details of upstream packages such as `@dzupagent/core`, `@dzupagent/agent`, `@dzupagent/adapter-types`, and `@dzupagent/adapter-rules` beyond how this package calls them.

## Responsibilities

`@dzupagent/agent-adapters` is the provider integration and orchestration layer for DzupAgent runtimes.

Current responsibilities:

- Expose a unified provider contract (`AgentCLIAdapter`) and normalized event stream (`AgentEvent` / `AgentStreamEvent`).
- Provide concrete adapters for `claude`, `codex`, `gemini` (CLI + SDK), `qwen`, `crush`, `goose`, `openrouter`, and `openai`.
- Route tasks and execute fallback chains with health/circuit-breaker awareness (`ProviderAdapterRegistry`).
- Provide high-level orchestration APIs through `OrchestratorFacade` (`run`, `chat`, `parallel`, `race`, `supervisor`, `mapReduce`, `bid`).
- Support workflow execution (`AdapterWorkflow`) and session/checkpoint lifecycle.
- Enforce control-plane rules via policy compilation/conformance, approval, guardrails, and recovery.
- Provide integration surfaces for HTTP handlers, plugin loading, MCP tool sharing, and adapter-as-tool bridges.
- Provide `.dzupagent`/UCL ingestion helpers, skill projection/compilers, and run-event persistence for script automation.

## Structure

Top-level source layout:

- `src/index.ts`: compatibility root barrel; broad export surface.
- `src/types.ts`: re-export bridge for `@dzupagent/adapter-types`.
- Plane barrels: `src/providers.ts`, `src/orchestration.ts`, `src/workflow.ts`, `src/http.ts`, `src/persistence.ts`, `src/learning.ts`, `src/recovery.ts`, `src/skills.ts`, `src/enrichment.ts`.
- Provider modules: `src/claude`, `src/codex`, `src/gemini`, `src/qwen`, `src/crush`, `src/goose`, `src/openrouter`, `src/openai`.
- Registry/routing: `src/registry/*`.
- Facade: `src/facade/*`.
- Orchestration engines: `src/orchestration/*`.
- Workflow DSL/runtime: `src/workflow/*`.
- Session/checkpointing: `src/session/*`.
- Persistence + run logs: `src/persistence/*`, `src/runs/*`.
- Middleware and policy/control planes: `src/middleware/*`, `src/policy/*`, `src/approval/*`, `src/guardrails/*`, `src/recovery/*`, `src/pipeline/*`.
- Integration surfaces: `src/http/*`, `src/integration/*`, `src/plugin/*`, `src/mcp/*`.
- DzupAgent/UCL and skills: `src/dzupagent/*`, `src/ucl/*`, `src/skills/*`.
- Observability/streaming/utilities: `src/observability/*`, `src/streaming/*`, `src/utils/*`, `src/base/*`.
- Tests: `src/**/*.test.ts` (including `src/__tests__` and module-local tests).

Published package subpaths (`package.json` `exports`):

- `.`
- `./providers`
- `./orchestration`
- `./workflow`
- `./http`
- `./persistence`
- `./pipeline`
- `./runs`
- `./integration`
- `./dzupagent`
- `./rules`
- `./learning`
- `./recovery`
- `./skills`
- `./enrichment`
- `./fleet-executors`
- `./subagents`

## Runtime and Control Flow

Primary single-run path (`OrchestratorFacade.run`):

1. Build input/task from prompt and run options.
2. Prepare input through `AdapterPipeline.prepare(...)`:
   - UCL enrichment (`UCLEnrichmentStep`) when enabled.
   - Policy override application (`PolicyEnforcementPipeline`).
3. Resolve and execute provider stream via `ProviderAdapterRegistry.executeWithFallback(...)`.
4. Bridge provider events to runtime bus (`EventBusBridge`) and wrap stream with guardrails/approval pipeline steps.
5. Consume until terminal completion (`adapter:completed`) or fail if exhausted.

Registry fallback path (`ProviderAdapterRegistry` + `AdapterRegistryRouter`):

1. Select routable adapters (registered, enabled, breaker-allowed/healthy).
2. Route with active strategy (`TaskRoutingStrategy`).
3. Build attempt order: primary decision, router fallbacks, then remaining healthy adapters.
4. Execute sequential attempts with optional timeout (`executionTimeoutMs` / per-call `input.options.timeoutMs`).
5. Record success/failure and breaker transitions via `AdapterHealthMonitor`; emit event-bus notifications when configured.
6. Throw `ALL_ADAPTERS_EXHAUSTED` semantics when no provider reaches terminal success.

Chat/session path (`OrchestratorFacade.chatWithRaw`):

1. Resolve workflow session via `SessionRegistry`.
2. Route provider and reuse or create provider session linkage.
3. Execute through registry while persisting conversation/session state.
4. Reapply pipeline controls similarly to single-run execution.

Workflow path (`AdapterWorkflow`):

1. Build workflow graph with `AdapterWorkflowBuilder`.
2. Validate references/structure (`WorkflowValidator`, `WorkflowStepResolver`).
3. Execute composed steps (`step`, `parallel`, `branch`, `loop`, `transform`) against registry-backed provider execution.

Recovery and escalation path:

1. Capture traces (`ExecutionTraceCapture`).
2. Select strategy (`RecoveryPolicySelector` / `RECOVERY_POLICIES`).
3. Retry, handoff, adjust, escalate, or cancel (`AdapterRecoveryCopilot`, `CrossProviderHandoff`, escalation handlers).

## Key APIs and Types

Core contracts (re-exported from `@dzupagent/adapter-types`):

- `AgentCLIAdapter`
- `AdapterProviderId`
- `AgentInput`
- `AgentEvent` / `AgentStreamEvent`
- `TaskDescriptor`
- `TaskRoutingStrategy` and `RoutingDecision`

Primary runtime APIs:

- `ProviderAdapterRegistry`
- `OrchestratorFacade` and `createOrchestrator`
- Providers: `ClaudeAgentAdapter`, `CodexAdapter`, `GeminiCLIAdapter`, `GeminiSDKAdapter`, `QwenAdapter`, `CrushAdapter`, `GooseAdapter`, `OpenRouterAdapter`, `OpenAIAdapter`
- Routers: `TagBasedRouter`, `CostOptimizedRouter`, `RoundRobinRouter`, `CompositeRouter`, `CapabilityRouter`, `LearningRouter`, `ContextAwareRouter`
- Orchestration engines: `ParallelExecutor`, `SupervisorOrchestrator`, `MapReduceOrchestrator`, `ContractNetOrchestrator`
- Workflow/session: `defineWorkflow`, `AdapterWorkflowBuilder`, `SessionRegistry`, `WorkflowCheckpointer`, `ConversationCompressor`
- Controls: `AdapterApprovalGate`, `AdapterGuardrails`, `AdapterRecoveryCopilot`, `compilePolicyForProvider`, `PolicyConformanceChecker`
- Rules bridge: `prepareAdapterRuleRuntime`, `withAdapterRuleRuntimePlan`, `projectAdapterRuleRuntimePlan`, `getAdapterRuleRuntimePlan`
- Transport/integration: `AdapterHttpHandler`, `RegistryExecutionPort`, `AgentIntegrationBridge`, plugin SDK/loader exports, MCP manager/tool sharing exports
- Persistence/logging: `FileCheckpointStore`, `RunManager`, `RunEventStore`, `ScriptRunEventStore`

## Dependencies

From `package.json`:

- Runtime deps: `@dzupagent/adapter-rules`, `@dzupagent/adapter-types`, `@dzupagent/agent`, `@dzupagent/agent-types`, `@dzupagent/core`, `@dzupagent/runtime-contracts`, `@dzupagent/security`.
- Peer deps: `@langchain/core`, `zod`.
- Optional deps: `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@google/generative-ai`.

Build/test/tooling:

- Build: `tsup` via `tsup.config.ts` (ESM + d.ts, multiple entry points including `src/dzupagent/index.ts` and `src/rules.ts`).
- Typecheck: `tsc --noEmit`.
- Test: `vitest` with coverage thresholds (statements 70, lines 70, branches 60, functions 60).

Runtime assumptions:

- CLI adapters require external binaries where applicable (`gemini`, `qwen`, `crush`, `goose`; plus local SDK/CLI availability checks for Claude/Codex integrations).

## Integration Points

Core/event integration:

- `EventBusBridge` translates adapter stream events into Dzup event bus semantics.
- Registry can attach a `DzupEventBus` and emits provider/circuit lifecycle events.

HTTP integration:

- `AdapterHttpHandler` supports run/supervisor/parallel/bid/approve and health/cost endpoints.
- Request validation uses Zod schemas from `src/http/request-schemas.ts`.
- `SlidingWindowRateLimiter` provides optional request throttling.

Agent/tool integration:

- `RegistryExecutionPort` exposes fallback execution as a provider execution port.
- `AgentIntegrationBridge` and `AdapterAsToolWrapper` bridge adapter execution into tool-style invocation.

Plugin and MCP integration:

- Plugin surfaces: `createAdapterPlugin`, `defineAdapterPlugin`, `AdapterPluginLoader`.
- MCP surfaces: `MCPToolSharingBridge`, `InMemoryMcpAdapterManager`.

Rules and DzupAgent integration:

- `src/rules.ts` bridges `@dzupagent/adapter-rules` runtime plans into adapter input/config and governance diagnostics.
- `src/dzupagent/*` and `src/ucl/*` load/work with workspace `.dzupagent` memory, agents, skills, import/sync workflows.

## Testing and Observability

Testing:

- Runner: Vitest (`vitest.config.ts`, `environment: node`).
- Test files currently present under `src`: 158 `*.test.ts` files.
- Package includes targeted suites for adapters, routing/fallback, workflow/orchestration, HTTP schemas/handlers, recovery/approval/guardrails, plugin/MCP bridges, rules runtime projection, and persistence/run stores.
- `src/__tests__/architecture-doc.test.ts` validates architecture docs against export-map expectations.

Observability:

- `AdapterTracer` and tracing middleware provide span/event tracing.
- `StreamingHandler` supports stream serialization formats and progress mapping.
- `CostTrackingMiddleware` and cost model/optimization modules provide usage/cost telemetry.
- `RunEventStore` and `ScriptRunEventStore` persist execution/run evidence for automation flows.
- Recovery trace modules persist failure/recovery context for postmortems.

## Risks and TODOs

- Root entrypoint remains very broad for backward compatibility; API growth should prefer plane subpaths.
- Subpath exports exist for major planes, but several secondary domains still only flow through root barrel, increasing accidental coupling risk.
- Optional provider SDK/CLI dependencies create runtime capability variance across environments.
- HTTP routability and normalization behavior differ by provider and require ongoing parity checks as providers evolve.
- Large surface area (adapters + workflow + recovery + plugin + MCP + dzupagent tooling) increases regression risk; package relies heavily on its extensive test suite to catch cross-plane drift.

## Changelog

- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js

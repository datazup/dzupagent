# @dzupagent/agent-adapters Architecture

## Scope
This document describes the current implementation of `@dzupagent/agent-adapters` under `packages/agent-adapters`.

In scope:
- Runtime modules in `src/`.
- Published API surface from `package.json` `exports` and `tsup.config.ts` entrypoints.
- Provider adapters, registry/routing/fallback execution, orchestration/workflow planes, control-plane modules (policy/approval/guardrails/recovery), and integration planes (HTTP, plugin, MCP, runs, dzupagent/UCL).
- Package-local tests and observability surfaces.

Out of scope:
- Internal implementation details of upstream packages (`@dzupagent/core`, `@dzupagent/agent`, `@dzupagent/adapter-types`, `@dzupagent/adapter-rules`, `@dzupagent/runtime-contracts`) except where this package integrates with them.

## Responsibilities
`@dzupagent/agent-adapters` is the framework layer that standardizes provider execution and multi-provider orchestration.

Current responsibilities:
- Provide a shared adapter contract (`AgentCLIAdapter`) and normalized event model (`AgentEvent` / `AgentStreamEvent`).
- Implement provider adapters for `claude`, `codex`, `gemini`, `gemini-sdk`, `qwen`, `crush`, `goose`, `openrouter`, and `openai`.
- Manage provider registration, health/circuit-breaker gating, task routing, and fallback execution via `ProviderAdapterRegistry`.
- Offer a high-level runtime facade (`OrchestratorFacade`) with `run`, `chat`, `parallel`, `race`, `supervisor`, `mapReduce`, and `bid` patterns.
- Apply execution controls through composable pipeline steps: UCL enrichment, policy projection/conformance transport, approval wrapping, and guardrail wrapping.
- Expose integration surfaces for HTTP handlers, plugin lifecycle loading, MCP tool sharing/adapter management, and provider-execution bridge ports.
- Persist run/checkpoint evidence and managed script-run records via `RunEventStore`, `ScriptRunEventStore`, `RunManager`, and file checkpoint stores.
- Bridge adapter-rules runtime plans into adapter input/config through `./rules` helpers.

## Structure
Source layout (high-level):
- `src/index.ts`: compatibility root barrel (broad export surface).
- `src/types.ts`: canonical contract re-export bridge from `@dzupagent/adapter-types`.
- Provider plane: `src/providers.ts`, `src/provider-catalog.ts`, `src/<provider>/*`, `src/normalize*.ts`.
- Registry/routing plane: `src/registry/*` (`adapter-registry`, `registry-core`, `registry-router`, routers, health monitor, event bridge).
- Facade plane: `src/facade/*` (`createOrchestrator`, facade class, run coordinator, orchestration pattern wiring).
- Orchestration engines: `src/orchestration/*` (parallel, supervisor, map-reduce, contract-net).
- Workflow/session plane: `src/workflow/*`, `src/session/*`, `src/pipeline/*`, `src/context/*`.
- Control plane: `src/policy/*`, `src/approval/*`, `src/guardrails/*`, `src/recovery/*`.
- Integration/transport plane: `src/http*`, `src/integration/*`, `src/plugin/*`, `src/mcp/*`.
- Learning/testing/support plane: `src/learning*`, `src/testing/*`, `src/middleware/*`, `src/observability/*`, `src/streaming/*`, `src/utils/*`, `src/base/*`.
- DzupAgent/UCL plane: `src/dzupagent/*`, `src/ucl/*`, `src/skills/*`, `src/enrichment/*`.
- Persistence/runs plane: `src/persistence/*`, `src/runs/*`.

Published export-map subpaths (from `package.json`):
- `.`
- `./providers`
- `./orchestration`
- `./workflow`
- `./http`
- `./persistence`
- `./runs`
- `./integration`
- `./dzupagent`
- `./rules`
- `./learning`
- `./recovery`

Build entrypoints (`tsup.config.ts`) currently include:
- `src/index.ts`
- `src/providers.ts`
- `src/orchestration.ts`
- `src/workflow.ts`
- `src/http.ts`
- `src/persistence.ts`
- `src/learning.ts`
- `src/recovery.ts`
- `src/runs/index.ts`
- `src/integration/index.ts`
- `src/dzupagent/index.ts`
- `src/rules.ts`

## Runtime and Control Flow
Primary facade flow (`createOrchestrator` + `OrchestratorFacade.run`):
1. `createOrchestrator` composes runtime dependencies (`ProviderAdapterRegistry`, `EventBusBridge`, optional `CostTrackingMiddleware`, `SessionRegistry`, and `AdapterPipeline`).
2. `run()` delegates to `executeRun(...)` in `facade-run-coordinator.ts`.
3. `AdapterPipeline.prepare(...)` applies UCL enrichment first (`UCLEnrichmentStep`), then policy context/overrides (`PolicyEnforcementPipeline`).
4. `ProviderAdapterRegistry.executeWithFallback(...)` is invoked with routing metadata.
5. Stream is bridged to bus (`EventBusBridge.bridge`) and wrapped by pipeline post-stream controls (guardrails and optional approval gate).
6. `run()` waits for terminal `adapter:completed`; missing completion surfaces as `ADAPTER_EXECUTION_FAILED`.

Registry fallback flow (`AdapterRegistryRouter.executeWithFallbackWithRaw`):
1. Collect healthy, enabled adapters (`AdapterRegistryCore` + `AdapterHealthMonitor`).
2. Route task with active strategy (`TaskRoutingStrategy`, default `TagBasedRouter`).
3. Build fallback order (`primary -> explicit fallbacks -> remaining healthy adapters`).
4. For each attempt: project policy/guardrail options, attach timeout/abort controls, stream provider events, and classify attempt outcome.
5. Record breaker transitions (`recordSuccess`/`recordFailure`) and emit lifecycle/provider events.
6. Return early on first success; throw exhausted failure when all attempts fail.

Chat/session flow (`OrchestratorFacade.chatWithRaw`):
1. Resolve or create workflow ID in `SessionRegistry`.
2. Build chat input and apply the same pre-execution pipeline.
3. Execute multi-turn stream via `SessionRegistry.executeMultiTurnWithRaw(...)` and registry fallback path.
4. Bridge/wrap stream the same way as `run`, then yield raw or filtered events depending on caller API (`chatWithRaw` vs `chat`).

Rules runtime projection flow (`./rules` subpath):
1. Optionally load rule files/directories (`RuleLoader`).
2. Compile to `RuntimePlan` (`RuleCompiler`), collecting diagnostics.
3. Project plan into `AgentInput` and provider config patches (`projectAdapterRuleRuntimePlan`).
4. Expose attached-plan retrieval (`getAdapterRuleRuntimePlan`) and watch-path resolution helpers.
5. Optionally emit governance diagnostics for loader/compiler outcomes.

## Key APIs and Types
Core contracts:
- `AgentCLIAdapter`, `AgentInput`, `AdapterProviderId`, `TaskDescriptor`, `TaskRoutingStrategy`, `RoutingDecision`.
- Event and usage contracts: `AgentEvent`, `AgentStreamEvent`, `TokenUsage`, `HealthStatus`.

Provider and registry APIs:
- Adapters: `ClaudeAgentAdapter`, `CodexAdapter`, `GeminiCLIAdapter`, `GeminiSDKAdapter`, `QwenAdapter`, `CrushAdapter`, `GooseAdapter`, `OpenRouterAdapter`, `OpenAIAdapter`.
- Registry/routing: `ProviderAdapterRegistry`, `TagBasedRouter`, `CostOptimizedRouter`, `RoundRobinRouter`, `CompositeRouter`, `CapabilityRouter`, `LearningRouter`, `ContextAwareRouter`.
- Catalog and normalization: `PROVIDER_CATALOG`, `getProductProviders`, `getMonitorableProviders`, `normalizeEvent`.

Orchestration/workflow APIs:
- Facade: `createOrchestrator`, `OrchestratorFacade`.
- Patterns: `ParallelExecutor`, `SupervisorOrchestrator`, `MapReduceOrchestrator`, `ContractNetOrchestrator`.
- Workflow DSL: `AdapterWorkflowBuilder`, `AdapterWorkflow`, `defineWorkflow`, `typedStep`, `WorkflowValidator`, `WorkflowStepResolver`.
- Session/checkpoint: `SessionRegistry`, `WorkflowCheckpointer`, `InMemoryCheckpointStore`, `ConversationCompressor`.

Control-plane APIs:
- Policy: `compilePolicyForProvider`, `PolicyConformanceChecker`.
- Approval/guardrails/recovery: `AdapterApprovalGate`, `AdapterGuardrails`, `AdapterStuckDetector`, `AdapterRecoveryCopilot`, `RecoveryPolicySelector`, `RECOVERY_POLICIES`, `CrossProviderHandoff`.
- Rules bridge: `prepareAdapterRuleRuntime`, `projectAdapterRuleRuntimePlan`, `withAdapterRuleRuntimePlan`, `getAdapterRuleRuntimePlan`.

Integration and persistence APIs:
- HTTP: `AdapterHttpHandler`, `SlidingWindowRateLimiter`, `RunRequestSchema`/`SupervisorRequestSchema`/`ParallelRequestSchema`/`BidRequestSchema`/`ApproveRequestSchema`.
- Runtime bridge: `RegistryExecutionPort`, `runAgentExecution`.
- Plugin/MCP: `createAdapterPlugin`, `AdapterPluginLoader`, `MCPToolSharingBridge`, `InMemoryMcpAdapterManager`.
- Persistence/runs: `FileCheckpointStore`, `RunManager`, `RunEventStore`, `ScriptRunEventStore`, `runLogRoot`.

## Dependencies
Runtime dependencies (`package.json`):
- `@dzupagent/adapter-rules`
- `@dzupagent/adapter-types`
- `@dzupagent/agent`
- `@dzupagent/agent-types`
- `@dzupagent/core`
- `@dzupagent/runtime-contracts`
- `@dzupagent/security`

Peer dependencies:
- `@langchain/core`
- `zod`

Optional dependencies:
- `@anthropic-ai/claude-agent-sdk`
- `@openai/codex-sdk`
- `@google/generative-ai`

Tooling and build/test dependencies:
- Build: `tsup` (ESM + d.ts, Node 20 target).
- Typecheck: `tsc --noEmit`.
- Tests: `vitest`.

Runtime assumptions:
- CLI-backed providers require corresponding local binaries/CLI runtime where applicable.
- Optional SDK-backed adapters are capability-gated by optional package availability and adapter health checks.

## Integration Points
- `@dzupagent/core` eventing and circuit-breaker primitives:
  - Registry and router emit lifecycle/provider events via `DzupEventBus`.
  - Health monitor uses circuit-breaker semantics to gate execution attempts.
- `@dzupagent/agent` pipeline runtime and higher-level execution:
  - Workflow execution and runtime integration paths depend on shared agent/runtime contracts.
- `@dzupagent/adapter-rules`:
  - `./rules` subpath compiles/projects `RuntimePlan` data into adapter runtime inputs.
- HTTP hosting frameworks:
  - `AdapterHttpHandler` uses framework-neutral request/response types and can be wrapped by Express/Fastify/Hono adapters.
- Script/runtime bridge consumers:
  - `./integration` and `./runs` support external automation runners by exposing registry execution and durable run artifacts.
- `.dzupagent` workspace content:
  - `./dzupagent` loaders/syncers project local skill/memory/agent assets into runtime prompts/config.

## Testing and Observability
Testing:
- Vitest config includes `src/**/*.test.ts` and `src/**/*.spec.ts`.
- Current repository snapshot contains 158 `*.test.ts` files under `src/`.
- Coverage thresholds (`v8`) are enforced at package level:
  - statements: 70
  - lines: 70
  - branches: 60
  - functions: 60
- Architecture drift guard exists in `src/__tests__/architecture-doc.test.ts` and asserts export-map alignment for both architecture documents.

Observability surfaces:
- `EventBusBridge` for runtime/bus event projection.
- `AdapterTracer` and tracing middleware for span/event instrumentation.
- `StreamingHandler` and HTTP streaming helpers for response/event stream formatting.
- Cost and budget telemetry through `CostTrackingMiddleware` and optimization modules.
- Durable run evidence via `RunEventStore` and managed script-run records via `ScriptRunEventStore`.
- Recovery traces and escalation records via recovery modules (`ExecutionTraceCapture`, escalation handlers).

## Risks and TODOs
- Root barrel (`src/index.ts`) remains intentionally broad for compatibility; API surface can drift unless new exports are added to explicit subpaths first.
- Provider capabilities are intentionally non-uniform (for example product-integrated vs framework-only providers in `PROVIDER_CATALOG`), which requires callers to honor catalog gates.
- HTTP schema provider allowlist depends on `HTTP_ROUTABLE_PROVIDER_IDS`; provider capability changes require schema parity updates.
- Optional SDK and CLI dependencies create environment-specific behavior; health checks and fallback routing are required for robust runtime behavior.
- Registry/router logic combines policy transport compatibility, fallback ordering, and timeout handling; changes in one area can regress others without targeted tests.

## Changelog
- 2026-05-17: automated refresh via scripts/refresh-architecture-docs.js


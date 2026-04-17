# @dzupagent/agent-adapters Architecture

## Scope
This document describes the current architecture of `@dzupagent/agent-adapters` in `packages/agent-adapters`, based on the implementation under `src/`, package metadata, and existing tests.

Included in scope:
- Adapter implementations and the unified adapter contract/event model.
- Registry, routing, fallback execution, and orchestration layers.
- Session/state/persistence, output shaping, policy/approval/recovery, and HTTP transport.
- Plugin/MCP/tool integration surfaces and `.dzupagent` capability loading.
- Test and observability surfaces in this package.

Out of scope:
- Internal architecture of other packages (`@dzupagent/core`, `@dzupagent/agent`, etc.) beyond how this package consumes them.

## Responsibilities
`@dzupagent/agent-adapters` is the execution and orchestration bridge between DzupAgent and provider-specific agent runtimes.

Primary responsibilities:
- Normalize heterogeneous provider runtimes (SDK and CLI) behind `AgentCLIAdapter`.
- Standardize streamed execution state through unified `AgentEvent` variants.
- Route tasks to providers and handle fallback/circuit-breaker-aware failover.
- Provide orchestration patterns: single-run facade, parallel, race, supervisor, map-reduce, contract-net, and workflow DSL.
- Apply operational controls: guardrails, approval gates, cost tracking/optimization, recovery strategies, and tracing.
- Expose framework-neutral integration surfaces (HTTP handler, plugin API, tool wrappers, MCP sharing, execution port bridge).
- Load and project `.dzupagent` skills/memory/agent definitions into runtime prompts and metadata.

## Structure
Top-level source modules:
- `src/types.ts`: re-exports `@dzupagent/adapter-types` as the canonical contract.
- `src/index.ts`: public API barrel with all exports.
- `src/<provider>/`: provider adapters (`claude`, `codex`, `gemini`, `qwen`, `crush`, `goose`, `openrouter`).
- `src/base/`: shared CLI adapter base class (`BaseCliAdapter`).
- `src/registry/` and `src/context/`: registry, routers, event bridge, context-aware routing/injection.
- `src/facade/`: high-level orchestrator facade (`OrchestratorFacade`, `createOrchestrator`).
- `src/orchestration/`: `ParallelExecutor`, `SupervisorOrchestrator`, `MapReduceOrchestrator`, `ContractNetOrchestrator`.
- `src/workflow/`: workflow DSL builder/runtime, template resolution, validation.
- `src/session/` and `src/persistence/`: session registry, conversation compression/compaction, checkpointing, run lifecycle.
- `src/middleware/`, `src/guardrails/`, `src/approval/`, `src/recovery/`, `src/policy/`: operational governance stack.
- `src/output/` and `src/streaming/`: structured output validation and stream formatting.
- `src/observability/`: tracing and tracing middleware.
- `src/http/`: framework-neutral HTTP handler, request schemas, rate limiting.
- `src/plugin/`, `src/integration/`, `src/mcp/`: plugin loading, tool wrapping, MCP bridging and MCP adapter config management.
- `src/skills/` and `src/dzupagent/`: skill compilation/projection/versioning/telemetry and `.dzupagent` file/memory/agent import/sync/load.
- `src/testing/`: A/B runner utilities.
- `src/utils/`: process spawning, event normalization, provider helpers, URL validation, batched event emission, error aliases.

## Runtime and Control Flow
Core run path (`OrchestratorFacade.run`):
1. Build `AgentInput` + `TaskDescriptor` from prompt/options.
2. Optionally enrich with `.dzupagent` skills and memory (`applyDzupAgentEnrichment`).
3. Optionally compile/enforce provider policy (`compilePolicyForProvider` + `PolicyConformanceChecker`).
4. Execute via `AdapterRegistry.executeWithFallback`.
5. Wrap stream with `EventBusBridge`, optional `CostTrackingMiddleware`, optional `AdapterGuardrails`, optional `AdapterApprovalGate`.
6. Consume events and require an `adapter:completed` terminal event to return success.

Registry fallback path (`AdapterRegistry.executeWithFallback`):
1. Resolve healthy providers (`disabled` filtered, circuit breaker `canExecute`).
2. Route using current `TaskRoutingStrategy`.
3. Build ordered provider list: primary, decision fallbacks, remaining healthy.
4. Try each provider sequentially until explicit `adapter:completed` is observed.
5. On failure, record breaker failure, emit provider failure event, and continue.
6. If all fail, throw `ALL_ADAPTERS_EXHAUSTED`.

Multi-turn chat path (`OrchestratorFacade.chat` + `SessionRegistry.executeMultiTurn`):
1. Resolve/create workflow session.
2. Optionally prepend conversation handoff context and compressed history.
3. Reuse provider session IDs when available (`resumeSessionId`).
4. Execute with fallback through registry.
5. Persist provider session links, conversation entries, and usage counters.

Orchestration engines:
- `ParallelExecutor`: `first-wins`, `all`, `best-of-n`, with cancellation/timeout handling.
- `SupervisorOrchestrator`: decomposition + dependency-aware delegated execution with bounded concurrency.
- `MapReduceOrchestrator`: chunk -> map via registry -> reduce, with per-chunk stats.
- `ContractNetOrchestrator`: bid generation/scoring, winner execution, ranked fallback bidders.
- `AdapterWorkflow`: declarative pipeline compiled to `PipelineRuntime` (`@dzupagent/agent`), supporting `step`, `parallel`, `branch`, `transform`, `loop`.

Recovery flow (`AdapterRecoveryCopilot`):
1. Execute attempt and trace decisions/events.
2. On failure, select strategy (`retry-same-provider`, `retry-different-provider`, `increase-budget`, `simplify-task`, `escalate-human`, `abort`).
3. For cross-provider retries, inject partial-progress handoff (`CrossProviderHandoff`).
4. Apply exponential backoff/jitter between attempts.
5. Return success, escalation outcome, cancellation event, or exhausted failure result.

Provider execution modes:
- SDK-backed: `ClaudeAgentAdapter`, `CodexAdapter`, `GeminiSDKAdapter`.
- CLI-backed via `BaseCliAdapter`: `GeminiCLIAdapter`, `QwenAdapter`, `CrushAdapter`, `GooseAdapter`.
- HTTP-backed: `OpenRouterAdapter` (SSE parsing over `fetch`).

## Key APIs and Types
Core contracts (from `@dzupagent/adapter-types`, re-exported by this package):
- `AgentCLIAdapter`
- `AgentInput`
- `AgentEvent` union (`adapter:started`, `adapter:message`, `adapter:tool_call`, `adapter:tool_result`, `adapter:stream_delta`, `adapter:completed`, `adapter:failed`, `recovery:cancelled`, `adapter:memory_recalled`, `adapter:skills_compiled`)
- `TaskDescriptor`, `RoutingDecision`, `TaskRoutingStrategy`
- `AdapterProviderId = 'claude' | 'codex' | 'gemini' | 'gemini-sdk' | 'qwen' | 'crush' | 'goose' | 'openrouter'`

Primary runtime APIs:
- `AdapterRegistry`: adapter registration, health, fallback execution, circuit-breaker recording, router configuration.
- `OrchestratorFacade` / `createOrchestrator`: `run`, `chat`, `parallel`, `race`, `supervisor`, `mapReduce`, `bid`, `shutdown`, `getCostReport`.
- Routers: `TagBasedRouter`, `CostOptimizedRouter`, `RoundRobinRouter`, `CompositeRouter`, `CapabilityRouter`, `ContextAwareRouter`, `LearningRouter`, `CostOptimizationEngine`.
- Workflow/session/persistence: `defineWorkflow`, `AdapterWorkflowBuilder`, `SessionRegistry`, `WorkflowCheckpointer`, `FileCheckpointStore`, `RunManager`.
- Governance: `AdapterGuardrails`, `AdapterApprovalGate`, `AdapterRecoveryCopilot`, policy compiler/conformance APIs.
- Transport/integration: `AdapterHttpHandler`, `createAdapterPlugin`, `AdapterPluginLoader`, `AgentIntegrationBridge`, `RegistryExecutionPort`, `MCPToolSharingBridge`, `InMemoryMcpAdapterManager`.
- Skill/projection APIs: `SkillProjector`, `AdapterSkillRegistry`, provider skill compilers, version stores, telemetry, capability matrix builder.
- `.dzupagent` APIs: workspace resolution, config loading, importer/syncer, skill/memory/agent loaders.

Provider capability snapshot (as implemented):
- `claude`: resume+fork supported; SDK-backed.
- `codex`: resume supported; SDK-backed; no fork.
- `gemini`: CLI adapter with resume support.
- `gemini-sdk`: streaming API adapter; no resume.
- `qwen`: CLI adapter with resume support.
- `crush`: CLI adapter; resume unsupported.
- `goose`: CLI adapter with resume support.
- `openrouter`: HTTP adapter; resume unsupported.

## Dependencies
Declared package dependencies (`package.json`):
- `@dzupagent/adapter-types`
- `@dzupagent/agent`
- `@dzupagent/core`

Peer dependencies:
- `@langchain/core` (type-level/compat surface)
- `zod` (HTTP request schema validation)

Optional dependencies:
- `@anthropic-ai/claude-agent-sdk`
- `@openai/codex-sdk`

Dynamic/runtime optional imports used by implementation:
- `@google/generative-ai` in `GeminiSDKAdapter`.

External runtime prerequisites:
- CLI binaries in `PATH` for CLI adapters: `gemini`, `qwen`, `crush`, `goose`.
- Node.js platform APIs (`child_process`, `fs/promises`, `fetch`, streams, crypto).

Build/test toolchain:
- `tsup` (ESM + d.ts output from `src/index.ts`)
- `typescript` (`NodeNext`, strict mode)
- `vitest` (node environment, coverage thresholds configured)

## Integration Points
HTTP integration (`AdapterHttpHandler`):
- Routes: `POST /run`, `POST /supervisor`, `POST /parallel`, `POST /bid`, `POST /approve/:id`, `GET /health`, `GET /health/detailed`, `GET /cost`.
- Supports optional auth (`tokenValidator` or API key), rate limiting, SSE streaming responses (`StreamingHandler`).

Plugin integration:
- `createAdapterPlugin` provides DzupPlugin-compatible lifecycle wiring around registry/event bridge/cost/session subsystems.
- `defineAdapterPlugin` and `AdapterPluginLoader` support third-party adapter plugin discovery and registration.

Execution/tool bridge integration:
- `RegistryExecutionPort` implements `ProviderExecutionPort` (`@dzupagent/agent`) over registry fallback execution.
- `AgentIntegrationBridge` and `AdapterAsToolWrapper` expose adapters as tool-callable units, including routed composite tools.

MCP integration:
- `MCPToolSharingBridge` shares tools across adapters and can emit provider-specific tool config payloads.
- `InMemoryMcpAdapterManager` manages MCP server definitions, per-provider bindings, and effective config resolution.

`.dzupagent` integration:
- `WorkspaceResolver`, `loadDzupAgentConfig`, file/memory/agent loaders, importer, and syncer provide a file-based capability/memory layer consumed by `OrchestratorFacade`.

## Testing and Observability
Testing:
- Test framework: Vitest (`environment: node`).
- Test corpus: 109 files under `src/__tests__/`.
- Coverage configuration includes thresholds (`statements/lines 70`, `branches/functions 60`).
- Coverage breadth includes adapters, routing, orchestration, workflow runtime, HTTP schemas/handler, plugin/MCP integration, approval/recovery policies, dzupagent sync/import/load paths, and utility behavior.

Observability and runtime telemetry:
- `EventBusBridge` maps adapter-level events to `DzupEventBus` events.
- `AdapterTracer` and `createTracingMiddleware` emit span-style timing and lifecycle metadata.
- `StreamingHandler` converts event streams to SSE/JSONL/NDJSON with progress modeling.
- `CostTrackingMiddleware` emits budget warnings/exceeded events and aggregates provider cost/tokens.
- `AdapterGuardrails` emits stuck/budget warnings and guardrail violations.
- `RunManager` provides run lifecycle accounting and aggregate stats.
- `BatchedEventEmitter` batches non-critical bus events while preserving immediate emission for critical event classes.

## Risks and TODOs
- `DzupAgentSyncer.planSync('codex')` is intentionally unimplemented and returns a warning-only plan (`Codex sync is not yet implemented`).
- Resume support is provider-specific; `GeminiSDKAdapter`, `OpenRouterAdapter`, and `CrushAdapter` reject `resumeSession`.
- `http/request-schemas.ts` provider enum excludes `'gemini-sdk'` even though `'gemini-sdk'` is a valid `AdapterProviderId`; HTTP validation currently cannot target that provider directly.
- `GeminiSDKAdapter` dynamically imports `@google/generative-ai`, but this package does not declare it in dependencies/optionalDependencies; runtime setup must install it explicitly.
- Provider policy conformance is uneven by design: many controls degrade to middleware enforcement (tool policies, native budget/network/approval toggles) depending on provider.
- Architecture drift guard currently tests `packages/agent-adapters/ARCHITECTURE.md` (`src/__tests__/architecture-doc.test.ts`), not `packages/agent-adapters/docs/ARCHITECTURE.md`.

## Changelog
- 2026-04-16: automated refresh via scripts/refresh-architecture-docs.js
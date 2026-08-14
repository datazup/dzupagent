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
- Enforce opt-in provider input budgets with revision-bound local reservation
  counters and, for OpenAI Responses, authoritative provider preflight plus
  terminal usage reconciliation.
- Expose source-bound Codex App Server capability observation, a bounded
  optional base execution backend, and durable-goal lifecycle operations as a
  narrow provider-session companion. Provider completion and goal state are
  not repository completion authority.

## Structure

Top-level source layout:

- `src/index.ts`: compatibility root barrel; broad export surface.
- `src/codex-goal-control.ts`: narrow Codex App Server durable-goal companion.
- `src/types.ts`: re-export bridge for `@dzupagent/adapter-types`.
- Plane barrels: `src/providers.ts`, `src/orchestration.ts`, `src/workflow.ts`, `src/http.ts`, `src/persistence.ts`, `src/learning.ts`, `src/recovery.ts`, `src/skills.ts`, `src/enrichment.ts`, `src/hard-budget.ts`.
- Monitoring barrels: `src/introspection/index.ts` for installation probing,
  deterministic live/replayed run-event capability observation, effective
  drift detection, and re-probe policy; `src/observability/dashboard.ts` for
  dashboard projection.
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

### Codex App Server capability admission

`./codex-goal-control` exposes three separate layers:

1. Trusted discovery first resolves the canonical executable and records a
   bounded SHA-256 digest of its bytes. `observeInstalledCodexAppServerCapability`
   binds that artifact digest to the returned descriptor and runs only provider-free Codex
   version, schema-help, and version-specific schema-generation probes through
   the existing absolute-path, credential-scrubbed probe boundary. It uses a
   unique managed home and schema directory, finite
   process/output/file/count/size/depth ceilings, and removes the entire raw
   generated corpus before returning.
2. `materializeCodexAppServerCapabilityDescriptor` validates the exact
   initialize, thread start/resume, turn start/interrupt, stream, terminal
   usage, approval/input-request, and thread goal request/result/event shapes.
   It advertises only the observed base execution, stream, usage, interrupt,
   and goal-control capabilities as native. Interaction resolution and all
   other unobserved controls remain unsupported with emulation forbidden.
3. `CodexAppServerAdapter` requires an admitted descriptor-bound attempt before
   process creation. Runtime construction also requires the private resolved
   executable identity used by observation; before every observation probe and
   runtime spawn the process boundary rechecks the canonical path and artifact
   digest. Runtime also checks regular-file type and execute access, spawns that
   canonical path without PATH lookup, then rechecks the digest before sending
   `initialize`. Its private shared stdio
   client initializes once,
  uses monotonic request ids, correlates responses, validates and discards the
  complete observed initialize result, validates complete thread and turn
  results/notifications, and compares the admitted CLI version plus requested
  cwd, model, and sandbox against the provider's effective thread response.
  It requires the exact observed
  empty-object interrupt acknowledgement before returning `accepted: true`, and applies finite line,
   aggregate, queue, pending-request, frame, request, execution, and cleanup
   limits, and fails closed on malformed/duplicate/late frames, overflow,
   timeout, process death, stale turns, executable drift, or cleanup failure.
   One monotonic deadline starts at execution entry and supplies only its
   remaining budget to executable qualification, initialize, thread
   start/resume, turn start, and stream observation. Once local timeout or
   cancellation wins, later deltas, interactions, usage, or successful terminal
   frames cannot restore completion. Supplied-signal cancellation and the
   adapter-wide emergency interrupt are registered before executable
   qualification and cover initialize/initialized, thread start/resume, and
   turn start. Before an exact turn identity exists they abort setup and close
   any created client; afterward they enter the exact-turn interrupt path, so a
   stalled setup cannot wait for the execution deadline. Exact interrupt callers
   share one provider acknowledgement promise and return `accepted: true` only
   after it succeeds.
   Interrupt acknowledgement has a separate at-most-250 ms grace; cleanup then
   performs at most one SIGTERM wait and one SIGKILL wait, each at most one
   second by default and only tighten-able. Initialize/initialized failure awaits
   that same cleanup promise. Provider approval/input requests are surfaced but
   never answered before a local terminal decision.

The returned durable object is only a
`ProviderSessionCapabilityDescriptor`. It contains the sanitized installed
version, logical schema reference, exact SHA-256, and capability facts. It does
not contain generated schema objects, raw probe output, credentials, objectives,
thread ids, an attempt binding, effect authority, retry/fallback authority, or
repository completion authority. It also never contains the private executable
path or process identity. The existing Codex factory keeps SDK as the
default, CLI as an explicit fallback, and App Server as an explicit
binding-required option; the goal-control factory requires the same resolved
identity and has no PATH fallback. The App Server backend retains no raw
provider frames and has no production profile.

Published package subpaths (`package.json` `exports`):

- `.`
- `./codex-goal-control`
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
- `./hard-budget`
- `./fleet-executors`
- `./subagents`
- `./routing`
- `./introspection`
- `./observability/dashboard`

The package root remains a compatibility surface. New monitoring code imports
contracts from `@dzupagent/adapter-types/monitoring/*` and consumers use the two
cohesive implementation subpaths above instead of growing either package root.

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
4. Compile and conform the active provider policy for each attempt. Forward a
   cloned, narrowed `activePolicy` plus its conformance mode in typed
   `policyContext`; controller-only projected guardrails and execution metadata
   are excluded from that typed policy context. Existing compiled option and
   guardrail overlays remain a separate compatibility transport.
5. Project native tool controls at the provider edge. The Claude SDK query
   builder applies `allowedTools`/`disallowedTools` after provider options so
   configuration cannot widen the active policy, and uses `tools: []` for a
   strict empty allowlist. Claude CLI treats `--allowedTools` as auto-approval,
   so warn-only workspace-write attempts also receive the complete native
   `--disallowedTools` complement as their enforcement boundary.
6. Execute sequential attempts with optional timeout (`executionTimeoutMs` / per-call `input.options.timeoutMs`).
7. Record success/failure and breaker transitions via `AdapterHealthMonitor`; emit event-bus notifications when configured.
8. Throw `ALL_ADAPTERS_EXHAUSTED` semantics when no provider reaches terminal success.

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
- Monitoring: `AdapterInstallationInspector`, provider inspectors, capability-manifest helpers, and `DashboardProjectionSubscriber`

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

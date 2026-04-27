# `@dzupagent/agent-adapters` API Surface Inventory

Status: living document. Generated as part of audit fix MJ-ARCH-05 to separate
the root provider-adapter surface from orchestration, HTTP, recovery, approval,
learning, persistence, and workflow DSL planes.

The root entrypoint (`@dzupagent/agent-adapters`) re-exports every plane for the
compatibility window. New consumers should prefer the narrowest subpath that
satisfies their need so optional SDK dependencies remain tree-shakeable.

## Subpath Map

| Subpath | Plane | Purpose |
| --- | --- | --- |
| `@dzupagent/agent-adapters` | (root) | Compatibility re-export of every plane below. Keep importing this only for legacy code. |
| `@dzupagent/agent-adapters/providers` | providers | Stable provider IDs, adapter contracts, provider registry primitives, and adapter factories (Claude/Codex/Gemini/Qwen/Crush/Goose/OpenAI/OpenRouter). |
| `@dzupagent/agent-adapters/orchestration` | orchestration | OrchestratorFacade, supervisor/parallel/map-reduce/contract-net patterns, sessions, context routing, integration bridge. |
| `@dzupagent/agent-adapters/http` | http | HTTP handler, request schemas (Zod), rate limiter, SSE streaming. |
| `@dzupagent/agent-adapters/recovery` | recovery | Recovery copilot, recovery policies, escalation handlers, cross-provider handoff, approval gates, guardrails. |
| `@dzupagent/agent-adapters/workflow` | workflow | Workflow DSL (builder, executor, template resolver, validator). |
| `@dzupagent/agent-adapters/learning` | learning | Learning loop, learning router, A/B testing, interaction policy, enrichment pipeline. |
| `@dzupagent/agent-adapters/persistence` | persistence | File checkpoint store, run manager, run event store. |

## Plane Contents

### providers (`./providers`)
- Types: `AdapterProviderId`, `AdapterCapabilityProfile`, `AgentInput`, `AgentEvent` (and all event variants), `TokenUsage`, `HealthStatus`, `SessionInfo`, `EnvFilterConfig`, `AdapterConfig`, `AgentCLIAdapter`, `TaskDescriptor`, `RoutingDecision`, `TaskRoutingStrategy`, `GovernanceEvent`, `GovernanceEventKind`.
- Adapter factories: `ClaudeAgentAdapter`, `CodexAdapter`, `GeminiCLIAdapter`, `GeminiSDKAdapter`, `QwenAdapter`, `CrushAdapter`, `GooseAdapter`, `OpenRouterAdapter`, `OpenAIAdapter`.
- Registry primitives: `ProviderAdapterRegistry`, `TagBasedRouter`, `CostOptimizedRouter`, `RoundRobinRouter`, `CompositeRouter`, `CapabilityRouter`.
- Provider catalog: `PROVIDER_CATALOG`, `getMonitorableProviders`, `getProductProviders`, `getProviderCapabilities`.
- Normalization: `normalizeEvent`.
- Helpers: `resolveFallbackProviderId`, `requireFallbackProviderId`, `isBinaryAvailable`, `spawnAndStreamJsonl`, `filterSensitiveEnvVars`, `DzupError`.

### orchestration (`./orchestration`)
- Facade: `OrchestratorFacade`, `createOrchestrator`, `OrchestratorConfig`.
- Patterns: `SupervisorOrchestrator`, `ParallelExecutor`, `MapReduceOrchestrator`, `ContractNetOrchestrator`.
- Sessions: `SessionRegistry`, `WorkflowCheckpointer`, `InMemoryCheckpointStore`, `ConversationCompressor`, `DefaultCompactionStrategy`.
- Context routing: `ContextAwareRouter`, `ContextInjectionMiddleware`.
- Bridge: `AgentIntegrationBridge`, `AdapterAsToolWrapper`, `RegistryExecutionPort`.
- Event bus bridge: `EventBusBridge`.

### http (`./http`)
- Handlers: `AdapterHttpHandler`, `SlidingWindowRateLimiter`.
- Request schemas: `RunRequestSchema`, `SupervisorRequestSchema`, `ParallelRequestSchema`, `BidRequestSchema`, `ApproveRequestSchema`.
- Types: `HttpRequest`, `HttpResponse`, `HttpStreamResponse`, `HttpResult`, `HealthResponse`, `TokenValidationResult`, plus `*RequestBody` and `*Request` variants.

### recovery (`./recovery`)
- Copilot: `AdapterRecoveryCopilot`, `ExecutionTraceCapture`.
- Policies: `RecoveryPolicySelector`, `RECOVERY_POLICIES`.
- Escalation: `EventBusEscalationHandler`, `WebhookEscalationHandler`, `CrossProviderHandoff`.
- Approval: `AdapterApprovalGate`, `InMemoryApprovalAuditStore`, `createPolicyCondition`, `compareBlastRadius`.
- Guardrails: `AdapterGuardrails`, `AdapterStuckDetector`.

### workflow (`./workflow`)
- DSL: `AdapterWorkflowBuilder`, `AdapterWorkflow`, `defineWorkflow`, `typedStep`.
- Tooling: `WorkflowStepResolver`, `WorkflowValidator`.

### learning (`./learning`)
- Learning loop: `AdapterLearningLoop`, `ExecutionAnalyzer`, `InMemoryLearningStore`, `FileLearningStore`.
- Routing: `LearningRouter`.
- Testing: `ABTestRunner`, `LengthScorer`, `ExactMatchScorer`, `ContainsKeywordsScorer`.
- Interaction policy: `InteractionResolver`, `classifyInteractionText`, `detectCliInteraction`.
- Enrichment: `EnrichmentPipeline`.

### persistence (`./persistence`)
- Checkpoint store: `FileCheckpointStore`.
- Run manager: `RunManager`.
- Run event store: `RunEventStore`, `runLogRoot`.

## Compatibility Window
`src/index.ts` continues to re-export every symbol listed above plus several
secondary surfaces (prompts, middleware, MCP, observability, plugins, skills,
policy, DzupAgent UCL, batched event emitter, structured output). These remain
exported from the root for backwards compatibility and will be gradually moved
to dedicated subpaths in follow-up audit waves.

## Dependency Boundary Notes
- Provider adapter modules under `./providers` are intentionally independent of
  orchestration, HTTP, recovery, learning, and workflow modules. They depend on
  `@dzupagent/core`, `@dzupagent/agent-types`, and `@dzupagent/adapter-types`
  only — keeping the optional SDKs (`@anthropic-ai/claude-agent-sdk`,
  `@openai/codex-sdk`) tree-shakeable.
- Higher-tier subpaths import from `./providers` for adapter contracts and from
  the package root for shared utilities. They do not introduce circular imports.

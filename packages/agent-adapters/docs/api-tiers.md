# @dzupagent/agent-adapters — API Tier Inventory

This document classifies every export from
`packages/agent-adapters/src/index.ts` into one of four review tiers. New
entries to the root facade MUST be added to this file in the same change
that introduces the export. See `docs/API_TIER_GOVERNANCE.md` at the repo
root for the governance rules.

The tiers are:

- **stable** — Public, documented, semver-protected. Breaking changes
  require a major bump and a documented migration path.
- **advanced** — Public power-user surface (orchestration, registry,
  middleware). Stable signature, but internal data shapes may evolve in
  minor releases with release notes.
- **experimental** — Provider-specific or runtime/learning surface that is
  iterating quickly. Expect breaking changes in any release.
- **internal** — Exported only because consumers currently import them; not
  part of the supported surface. Do not extend.

Compatibility window policy is identical to `@dzupagent/agent`. See
`packages/agent/docs/api-tiers.md` for the full statement.

---

## Tier: stable

| Export | Source | Notes |
|---|---|---|
| `AdapterProviderId`, `AdapterCapabilityProfile`, `AgentInput`, `AgentEvent`, `AgentStreamEvent`, `AgentStartedEvent`, `AgentMessageEvent`, `AgentToolCallEvent`, `AgentToolResultEvent`, `AgentCompletedEvent`, `AgentFailedEvent`, `AgentStreamDeltaEvent`, `AgentProgressEvent`, `GovernanceEvent`, `GovernanceEventKind`, `TokenUsage`, `HealthStatus`, `SessionInfo`, `EnvFilterConfig`, `AdapterConfig`, `AgentCLIAdapter`, `TaskDescriptor`, `RoutingDecision`, `TaskRoutingStrategy` | `types.ts` | Public adapter contract — these are the protocol. |
| `OrchestratorFacade`, `createOrchestrator`, `OrchestratorConfig` | `facade/orchestrator-facade.ts` | Top-level facade for adapter orchestration. |
| `ProviderAdapterRegistry`, `ProviderAdapterRegistryConfig`, `ProviderAdapterRegistryHealthStatus`, `ProviderAdapterHealthDetail` | `registry/adapter-registry.ts` | Public registry. |
| `AgentIntegrationBridge`, `AdapterAsToolWrapper`, `AdapterToolConfig`, `ToolInvocationResult`, `AdapterToolSchema`, `ToolInvocationArgs` | `integration/agent-bridge.ts` | Stable adapter ↔ agent bridge. |
| `RegistryExecutionPort` | `integration/index.ts` | Stable execution port. |
| `DzupError`, `DzupErrorOptions` | `utils/errors.ts` | Public error type. |

## Tier: advanced

| Group | Exports | Notes |
|---|---|---|
| Adapters | `ClaudeAgentAdapter`, `CodexAdapter`, `GeminiCLIAdapter`, `GeminiSDKAdapter`, `GeminiSDKAdapterConfig`, `QwenAdapter`, `CrushAdapter`, `GooseAdapter`, `OpenRouterAdapter`, `OpenRouterConfig`, `OpenAIAdapter`, `OpenAIConfig`, `OpenAIRunResult` | All concrete adapter classes — power-user surface; provider behaviour can shift with upstream SDKs. |
| Prompts | `SystemPromptBuilder`, `SystemPromptPayload`, `ClaudeAppendPayload`, `ClaudeReplacePayload`, `CodexPromptPayload`, `StringPromptPayload`, `SystemPromptBuilderOptions`, `PersonaTemplateContext`, `resolvePersonaTemplate` | Persona/system prompt synthesis. |
| Routers | `TagBasedRouter`, `CostOptimizedRouter`, `RoundRobinRouter`, `CompositeRouter`, `WeightedStrategy`, `LearningRouter`, `LearningRouterConfig`, `CapabilityRouter`, `ProviderCapability`, `ProviderCapabilityTag`, `CapabilityRouterConfig`, `ContextAwareRouter`, `ContextInjectionMiddleware`, `ContextEstimate`, `ContextAwareRouterConfig`, `ContextInjection`, `ContextInjectionConfig` | Router stack + context-aware routing. |
| Event bus bridge | `EventBusBridge` | Connects adapter events to core bus. |
| Middleware | `withMemoryEnrichment`, `withHierarchicalMemoryEnrichment`, `MemoryServiceLike`, `MemoryEnrichmentOptions`, `HierarchicalMemoryEnrichmentOptions`, `HierarchicalMemorySource`, `MemoryLevel`, `CostTrackingMiddleware`, `CostTrackingConfig`, `CostReport`, `MiddlewarePipeline`, `AdapterMiddleware`, `MiddlewareContext`, `createCostTrackingMiddleware`, `createGuardrailsMiddleware`, `sanitizeContent`, `createContentSanitizerMiddleware`, `ContentSanitizerConfig` | Adapter middleware stack. |
| Orchestration | `SupervisorOrchestrator`, `KeywordTaskDecomposer`, `SupervisorConfig`, `SupervisorOptions`, `SupervisorResult`, `SubTask`, `SubTaskResult`, `TaskDecomposer`, `ParallelExecutor`, `ParallelExecutorConfig`, `ParallelExecutionOptions`, `ParallelExecutionResult`, `ProviderResult`, `MergeStrategy`, `MapReduceOrchestrator`, `LineChunker`, `DirectoryChunker`, `MapReduceConfig`, `MapReduceOptions`, `MapReduceResult`, `MapChunkResult`, `Chunker`, `MapperFn`, `ReducerFn`, `ContractNetOrchestrator`, `StaticBidStrategy`, `ContractNetConfig`, `ContractNetOptions`, `ContractNetResult`, `Bid`, `BidStrategy`, `BidSelectionCriteria` | Orchestration patterns. |
| Sessions | `SessionRegistry`, `WorkflowSession`, `ProviderSession`, `ConversationEntry`, `SessionRegistryConfig`, `MultiTurnOptions`, `WorkflowCheckpointer`, `InMemoryCheckpointStore`, `ConversationCompressor`, `ConversationTurn`, `ConversationCompressorOptions`, `DefaultCompactionStrategy`, `CompactionStrategy`, `CompactionRequest`, `CompactionType`, `CompactionSessionInfo`, `DefaultCompactionConfig`, `WorkflowCheckpoint`, `StepDefinition`, `StepResult`, `SerializedProviderSession`, `CheckpointStore`, `CheckpointerConfig` | Session + checkpointing. |
| Cost models / optimization | `CostModelRegistry`, `TokenRates`, `CostEstimationInput`, `CostEstimate`, `CostCalculation`, `ProviderCostModel`, `CostOptimizationEngine`, `CostOptimizationConfig`, `ProviderPerformanceRecord`, `ProviderStats`, `OptimizationDecision` | Cost subsystem. |
| MCP | `MCPToolSharingBridge`, `MCPToolSharingConfig`, `SharedTool`, `ToolSharingStats`, `InMemoryMcpAdapterManager`, `AdapterMcpServer`, `AdapterMcpBinding`, `McpServerTestResult`, `EffectiveMcpConfig` | MCP adapter management + tool sharing. |
| Plugin SDK | `createAdapterPlugin`, `AdapterPluginConfig`, `AdapterPluginInstance`, `defineAdapterPlugin`, `isAdapterPlugin`, `AdapterPluginDefinition`, `AdapterPlugin`, `AdapterPluginLoader` | Adapter plugin SDK. |
| Guardrails | `AdapterGuardrails`, `AdapterStuckDetector`, `AdapterGuardrailsConfig`, `AdapterStuckDetectorConfig`, `GuardrailStatus`, `GuardrailViolation`, `GuardrailBudgetState`, `StuckStatus` | Adapter guardrail surface. |
| Streaming | `StreamingHandler`, `StreamFormat`, `StreamingConfig`, `StreamOutputEvent`, `StreamEventData`, `ProgressState` | Streaming handler. |
| Observability | `AdapterTracer`, `TraceSpan`, `SpanEvent`, `AdapterTracerConfig`, `TraceContext`, `createTracingMiddleware` | Tracing surface. |
| Approval | `AdapterApprovalGate`, `AdapterApprovalConfig`, `ApprovalContext`, `ApprovalRequest`, `ApprovalMode`, `ApprovalResult`, `InMemoryApprovalAuditStore`, `ApprovalAuditEntry`, `AuditQueryFilters`, `ApprovalAuditStore`, `createPolicyCondition`, `compareBlastRadius`, `PolicyConditionConfig` | HITL approval gates. |
| Persistence | `FileCheckpointStore`, `FileCheckpointStoreConfig`, `RunManager`, `AdapterRun`, `RunStatus`, `RunManagerConfig`, `RunStats` | Persistence layer. |
| Provider catalog / normalization | `PROVIDER_CATALOG`, `getMonitorableProviders`, `getProductProviders`, `getProviderCapabilities`, `ProviderCapabilities`, `MonitorTier`, `normalizeEvent`, `NormalizeProvider` | Provider metadata + event normalization. |
| Run event store | `RunEventStore`, `runLogRoot`, `RawAgentEvent`, `ProviderRawStreamEvent`, `AgentArtifactEvent`, `RunSummary` | Run event log facade. |
| HTTP | `SlidingWindowRateLimiter`, `RateLimitConfig`, `AdapterHttpHandler`, `AdapterHttpConfig`, `HttpRequest`, `HttpResponse`, `HttpStreamResponse`, `HttpResult`, `RunRequestBody`, `SupervisorRequestBody`, `ParallelRequestBody`, `BidRequestBody`, `HealthResponse`, `TokenValidationResult`, `RunRequestSchema`, `SupervisorRequestSchema`, `ParallelRequestSchema`, `BidRequestSchema`, `ApproveRequestSchema`, `RunRequest`, `SupervisorRequest`, `ParallelRequest`, `BidRequest`, `ApproveRequest` | HTTP adapter glue. |
| Structured output | `StructuredOutputAdapter`, `JsonOutputSchema`, `RegexOutputSchema`, `OutputSchema`, `StructuredOutputConfig`, `ParseResult`, `StructuredRunResult` | Structured output. |
| Skill projection | `SkillProjector`, `SkillProjection`, `ProjectionOptions`, `AdapterSkillBundle`, `CompiledAdapterSkill`, `AdapterSkillCompiler`, `ProjectionUsageRecord`, `AdapterSkillRegistry`, `createDefaultSkillRegistry`, `VersionedProjection`, `AdapterSkillVersionStore`, `InMemoryAdapterSkillVersionStore`, `FileAdapterSkillVersionStore`, `ProjectionTelemetryRecord`, `ProjectionUsageStats`, `AdapterSkillTelemetry`, `InMemoryAdapterSkillTelemetry`, `SkillCapabilityMatrixBuilder`, `SkillCapabilityMatrix`, `ProviderCapabilityRow`, `CapabilityStatus`, `CodexSkillCompiler`, `ClaudeSkillCompiler`, `CliSkillCompiler`, `isCliProviderId` | Skill projection + version store. |
| Policy compiler | `compilePolicyForProvider`, `compilePolicyForAll`, `AdapterPolicy`, `CompiledPolicyOverrides`, `CompiledGuardrailHints`, `PolicyConformanceChecker`, `PolicyViolation`, `PolicyViolationSeverity`, `PolicyConformanceResult` | Policy compilation. |
| Workflow DSL | `AdapterWorkflowBuilder`, `AdapterWorkflow`, `defineWorkflow`, `typedStep`, `AdapterWorkflowConfig`, `AdapterStepConfig`, `AdapterWorkflowResult`, `AdapterStepResult`, `AdapterWorkflowEvent`, `BranchCondition`, `LoopConfig`, `WorkflowStepResolver`, `TemplateContext`, `TemplateReference`, `WorkflowValidator`, `ValidationError`, `ValidationResult` | Adapter workflow DSL. |
| Utilities | `BatchedEventEmitter`, `BatchConfig`, `isBinaryAvailable`, `spawnAndStreamJsonl`, `filterSensitiveEnvVars`, `validateWebhookUrl`, `resolveFallbackProviderId`, `requireFallbackProviderId`, `UrlValidationOptions` | Utility surface. |

## Tier: experimental

| Group | Exports | Notes |
|---|---|---|
| A/B testing | `ABTestRunner`, `LengthScorer`, `ExactMatchScorer`, `ContainsKeywordsScorer`, `ABTestConfig`, `ABTestCase`, `ABTestVariant`, `ABTestScorer`, `ABTestPlan`, `VariantResult`, `ABTestReport`, `ABVariantSummary`, `ABComparison` | Adapter A/B testing surface — early. |
| Recovery copilot | `AdapterRecoveryCopilot`, `ExecutionTraceCapture`, `RecoveryStrategy`, `RecoveryConfig`, `TraceEvictionConfig`, `FailureContext`, `RecoverySuccessResult`, `RecoveryFailureResult`, `RecoveryCancelledResult`, `RecoveryResult`, `ExecutionTrace`, `TraceDecision`, `TracedEvent` | Adapter recovery — co-evolves with agent recovery. |
| Recovery policies / escalation | `RecoveryPolicySelector`, `RECOVERY_POLICIES`, `RecoveryPolicy`, `RecoveryStrategyConfig`, `PolicyContext`, `EventBusEscalationHandler`, `WebhookEscalationHandler`, `CrossProviderHandoff`, `HandoffItem`, `CrossProviderHandoffOptions`, `EscalationHandler`, `EscalationContext`, `EscalationResolution`, `RecoveryAttemptSummary` | Recovery policy + escalation handlers. |
| Learning loop | `AdapterLearningLoop`, `ExecutionAnalyzer`, `ExecutionRecord`, `ProviderProfile`, `FailurePattern`, `RecoverySuggestion`, `LearningConfig`, `PerformanceReport`, `ProviderComparison`, `InMemoryLearningStore`, `FileLearningStore`, `LearningStore`, `LearningSnapshot` | Learning loop is preview. |
| DzupAgent UCL loaders | `WorkspaceResolver`, `loadDzupAgentConfig`, `getCodexMemoryStrategy`, `getMaxMemoryTokens`, `parseMarkdownFile`, `DzupAgentFileLoader`, `DzupAgentMemoryLoader`, `DzupAgentImporter`, `DzupAgentAgentLoader`, `agentDefinitionsToSupervisorConfig`, `DzupAgentSyncer`, `DryRunReporter`, `DryRunReporterMode`, `DryRunReporterOptions`, `DryRunEntry`, `DryRunEntryType`, `ParsedFrontmatter`, `ParsedSection`, `ParsedMarkdownFile`, `FrontmatterValue`, `FileLoaderOptions`, `ParsedSkillFile`, `MemoryEntry`, `DzupAgentMemoryLoaderOptions`, `ImportPlan`, `ImportResult`, `ImportSource`, `DzupAgentImporterOptions`, `AgentDefinition`, `DzupAgentAgentLoaderOptions`, `SyncPlan`, `SyncPlanEntry`, `SyncDivergedEntry`, `SyncResult`, `SyncResultWritten`, `SyncResultSkipped`, `SyncResultDiverged`, `SyncTarget`, `DzupAgentSyncerOptions` | Unified Capability Layer loaders are evolving with the UCL spec. |
| Interaction policy | `InteractionResolver`, `classifyInteractionText`, `detectCliInteraction`, `InteractionKind`, `InteractionRequest`, `InteractionResult` | Interaction detection still experimental. |
| Enrichment pipeline | `EnrichmentPipeline`, `EnrichmentContext`, `EnrichmentResult` | Enrichment pipeline iterating with replay viewer. |

## Tier: internal

No internal exports currently; the adapter root has not yet collected
deprecated re-exports. New internal exports should not be added at the root.

---

## Adding a new export

Follow the same workflow documented in
`packages/agent/docs/api-tiers.md`:

1. Add the export to `src/index.ts`.
2. Add it to a tier table here.
3. Default new exports to `experimental` if their stability is not yet
   proven.
4. Promote between tiers via documented PR notes; demotions and removals
   require a `@deprecated` JSDoc and one minor of compatibility.

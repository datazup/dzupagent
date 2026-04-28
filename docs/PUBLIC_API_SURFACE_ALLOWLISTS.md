# Public API Surface Allowlists

Date: 2026-04-28

Generated from package root facades plus `config/public-api-allowlists.json` and `config/server-api-tiers.json`.

## Policy

- `stable` root exports are the semver-facing root package API.
- `deprecated-transitional` root exports remain available for compatibility during the 0.x migration window and should move to explicit subpaths in new code.
- `internal-only-candidate` root exports are accidental or implementation-oriented exposures that remain temporarily visible only for staged removal.
- New consumers should prefer the listed subpaths for domain-specific imports.
- Every current root export source must match exactly one allowlist rule; unreviewed sources fail `yarn check:server-api-surface`.

## @dzupagent/core

Root index: `packages/core/src/index.ts`

- Stable root sources: `42`
- Deprecated transitional root sources: `75`
- Internal-only root candidates: `0`
- Migration window: Root transitional exports remain available through 0.x and must move to subpaths before a future 1.0 root contraction.

### Stable Subpaths

| Subpath | Purpose |
| --- | --- |
| `@dzupagent/core/stable` | stable root facade |
| `@dzupagent/core/advanced` | transitional broad compatibility facade |
| `@dzupagent/core/quick-start` | stable quick-start facade |
| `@dzupagent/core/orchestration` | workflow and orchestration facade |
| `@dzupagent/core/security` | security facade |
| `@dzupagent/core/facades` | namespace facade index |

### Root Allowlist

| Root Class | Source Module | Export Count | Matched Rule | Sample Exports |
| --- | --- | ---: | --- | --- |
| `stable` | `./config/container.js` | 2 | `prefix:./config/` | `ForgeContainer`, `createContainer` |
| `stable` | `./errors/forge-error.js` | 2 | `prefix:./errors/` | `ForgeError`, `ForgeErrorOptions` |
| `stable` | `./errors/error-codes.js` | 1 | `prefix:./errors/` | `ForgeErrorCode` |
| `stable` | `./events/event-bus.js` | 2 | `prefix:./events/` | `createEventBus`, `DzupEventBus` |
| `stable` | `./events/event-types.js` | 4 | `prefix:./events/` | `DzupEvent`, `DzupEventOf`, `BudgetUsage`, `ToolStatSummary` |
| `stable` | `./events/degraded-operation.js` | 1 | `prefix:./events/` | `emitDegradedOperation` |
| `stable` | `./events/tool-event-correlation.js` | 3 | `prefix:./events/` | `requireTerminalToolExecutionRunId`, `TerminalToolExecutionRunIdOptions`, `TerminalToolEventType` |
| `stable` | `./events/agent-bus.js` | 3 | `prefix:./events/` | `AgentBus`, `AgentMessage`, `AgentMessageHandler` |
| `stable` | `./hooks/hook-types.js` | 2 | `prefix:./hooks/` | `AgentHooks`, `HookContext` |
| `stable` | `./hooks/hook-runner.js` | 3 | `prefix:./hooks/` | `runHooks`, `runModifierHook`, `mergeHooks` |
| `stable` | `./plugin/plugin-types.js` | 2 | `prefix:./plugin/` | `DzupPlugin`, `PluginContext` |
| `stable` | `./plugin/plugin-registry.js` | 1 | `prefix:./plugin/` | `PluginRegistry` |
| `stable` | `./plugin/plugin-discovery.js` | 6 | `prefix:./plugin/` | `discoverPlugins`, `validateManifest`, `resolvePluginOrder`, `PluginManifest` |
| `stable` | `./plugin/plugin-manifest.js` | 2 | `prefix:./plugin/` | `createManifest`, `serializeManifest` |
| `stable` | `./llm/model-registry.js` | 1 | `prefix:./llm/` | `ModelRegistry` |
| `stable` | `./llm/model-config.js` | 9 | `prefix:./llm/` | `KnownLLMProvider`, `LLMProviderConfig`, `LLMProviderName`, `ModelTier` |
| `stable` | `./llm/circuit-breaker.js` | 4 | `prefix:./llm/` | `CircuitBreaker`, `KeyedCircuitBreaker`, `CircuitBreakerConfig`, `CircuitState` |
| `stable` | `./llm/invoke.js` | 5 | `prefix:./llm/` | `invokeWithTimeout`, `extractTokenUsage`, `estimateTokens`, `TokenUsage` |
| `stable` | `./llm/retry.js` | 4 | `prefix:./llm/` | `isTransientError`, `isContextLengthError`, `DEFAULT_RETRY_CONFIG`, `RetryConfig` |
| `stable` | `./llm/registry-middleware.js` | 4 | `prefix:./llm/` | `RegistryMiddleware`, `MiddlewareContext`, `MiddlewareResult`, `MiddlewareTokenUsage` |
| `stable` | `./llm/embedding-registry.js` | 4 | `prefix:./llm/` | `EmbeddingRegistry`, `createDefaultEmbeddingRegistry`, `COMMON_EMBEDDING_MODELS`, `EmbeddingModelEntry` |
| `stable` | `./llm/structured-output-capabilities.js` | 5 | `prefix:./llm/` | `attachStructuredOutputCapabilities`, `getProviderStructuredOutputDefaults`, `getStructuredOutputDefaultsForProviderName`, `isKnownLLMProvider` |
| `stable` | `./prompt/prompt-fragments.js` | 11 | `prefix:./prompt/` | `FRAGMENT_CORE_PRINCIPLES`, `FRAGMENT_SECURITY_CHECKLIST`, `FRAGMENT_SIMPLICITY`, `FRAGMENT_READ_DISCIPLINE` |
| `stable` | `./prompt/fragment-composer.js` | 4 | `prefix:./prompt/` | `composeAdvancedFragments`, `validateFragments`, `ComposableFragment`, `ComposeResult` |
| `stable` | `./prompt/template-engine.js` | 4 | `prefix:./prompt/` | `resolveTemplate`, `extractVariables`, `validateTemplate`, `flattenContext` |
| `stable` | `./prompt/template-resolver.js` | 3 | `prefix:./prompt/` | `PromptResolver`, `PromptStore`, `ResolutionLevel` |
| `stable` | `./prompt/template-cache.js` | 1 | `prefix:./prompt/` | `PromptCache` |
| `stable` | `./prompt/template-types.js` | 6 | `prefix:./prompt/` | `TemplateVariable`, `TemplateContext`, `ResolvedPrompt`, `StoredTemplate` |
| `deprecated-transitional` | `./context/run-context-transfer.js` | 4 | `prefix:./context/` | `RunContextTransfer`, `INTENT_CONTEXT_CHAINS`, `RunContextTransferConfig`, `PersistedIntentContext` |
| `deprecated-transitional` | `./middleware/types.js` | 1 | `prefix:./middleware/` | `AgentMiddleware` |
| `deprecated-transitional` | `./middleware/cost-tracking.js` | 3 | `prefix:./middleware/` | `calculateCostCents`, `getModelCosts`, `CostTracker` |
| `deprecated-transitional` | `./middleware/langfuse.js` | 3 | `prefix:./middleware/` | `createLangfuseHandler`, `LangfuseConfig`, `LangfuseHandlerOptions` |
| `deprecated-transitional` | `./middleware/cost-attribution.js` | 5 | `prefix:./middleware/` | `CostAttributionCollector`, `CostAttribution`, `CostReport`, `CostBucket` |
| `deprecated-transitional` | `./persistence/checkpointer.js` | 2 | `prefix:./persistence/` | `createCheckpointer`, `CheckpointerConfig` |
| `deprecated-transitional` | `./persistence/session.js` | 1 | `prefix:./persistence/` | `SessionManager` |
| `deprecated-transitional` | `./persistence/working-memory.js` | 2 | `prefix:./persistence/` | `WorkingMemory`, `createWorkingMemory` |
| `deprecated-transitional` | `./persistence/working-memory-types.js` | 2 | `prefix:./persistence/` | `WorkingMemoryConfig`, `WorkingMemorySnapshot` |
| `deprecated-transitional` | `./persistence/in-memory-store.js` | 2 | `prefix:./persistence/` | `InMemoryRunStore`, `InMemoryAgentStore` |
| `deprecated-transitional` | `./persistence/store-interfaces.js` | 9 | `prefix:./persistence/` | `RunStore`, `Run`, `CreateRunInput`, `RunFilter` |
| `deprecated-transitional` | `./persistence/event-log.js` | 4 | `prefix:./persistence/` | `InMemoryEventLog`, `EventLogSink`, `RunEvent`, `EventLogStore` |
| `deprecated-transitional` | `./persistence/in-memory-run-journal.js` | 1 | `prefix:./persistence/` | `InMemoryRunJournal` |
| `deprecated-transitional` | `./persistence/run-journal-bridge.js` | 1 | `prefix:./persistence/` | `RunJournalBridgeRunStore` |
| `deprecated-transitional` | `./persistence/run-journal.js` | 3 | `prefix:./persistence/` | `createEntryBase`, `isTerminalEntry`, `deserializeEntry` |
| `deprecated-transitional` | `./persistence/run-journal-types.js` | 20 | `prefix:./persistence/` | `RunJournalEntryType`, `RunJournalEntryBase`, `RunJournalEntry`, `RunStartedEntry` |
| `deprecated-transitional` | `./persistence/in-memory-run-store.js` | 1 | `prefix:./persistence/` | `InMemoryRunRecordStore` |
| `deprecated-transitional` | `./persistence/run-store.js` | 5 | `prefix:./persistence/` | `RunRecordStore`, `RunRecord`, `StoredRunEvent`, `RunFilters` |
| `deprecated-transitional` | `./router/intent-router.js` | 3 | `prefix:./router/` | `IntentRouter`, `IntentRouterConfig`, `ClassificationResult` |
| `deprecated-transitional` | `./router/keyword-matcher.js` | 1 | `prefix:./router/` | `KeywordMatcher` |
| `deprecated-transitional` | `./router/llm-classifier.js` | 1 | `prefix:./router/` | `LLMClassifier` |
| `deprecated-transitional` | `./router/cost-aware-router.js` | 6 | `prefix:./router/` | `CostAwareRouter`, `isSimpleTurn`, `scoreComplexity`, `CostAwareResult` |
| `deprecated-transitional` | `./router/escalation-policy.js` | 3 | `prefix:./router/` | `ModelTierEscalationPolicy`, `EscalationPolicyConfig`, `EscalationResult` |
| `deprecated-transitional` | `./streaming/sse-transformer.js` | 1 | `prefix:./streaming/` | `SSETransformer` |
| `deprecated-transitional` | `./streaming/event-types.js` | 5 | `prefix:./streaming/` | `StandardSSEEvent`, `StandardEventType`, `FileStreamStartPayload`, `FileStreamChunkPayload` |
| `deprecated-transitional` | `./subagent/subagent-spawner.js` | 1 | `prefix:./subagent/` | `SubAgentSpawner` |
| `deprecated-transitional` | `./subagent/subagent-types.js` | 4 | `prefix:./subagent/` | `REACT_DEFAULTS`, `SubAgentConfig`, `SubAgentResult`, `SubAgentUsage` |
| `deprecated-transitional` | `./subagent/file-merge.js` | 2 | `prefix:./subagent/` | `mergeFileChanges`, `fileDataReducer` |
| `deprecated-transitional` | `./skills/skill-loader.js` | 1 | `prefix:./skills/` | `SkillLoader` |
| `deprecated-transitional` | `./skills/skill-injector.js` | 1 | `prefix:./skills/` | `injectSkills` |
| `deprecated-transitional` | `./skills/skill-types.js` | 4 | `prefix:./skills/` | `SkillDefinition`, `SkillRegistryEntry`, `LoadedSkill`, `SkillMatch` |
| `deprecated-transitional` | `./skills/skill-registry.js` | 1 | `prefix:./skills/` | `SkillRegistry` |
| `deprecated-transitional` | `./skills/skill-directory-loader.js` | 4 | `prefix:./skills/` | `SkillDirectoryLoader`, `parseMarkdownSkill`, `parseJsonSkill`, `SkillDirectoryLoaderOptions` |
| `deprecated-transitional` | `./skills/skill-manager.js` | 5 | `prefix:./skills/` | `SkillManager`, `SkillManagerConfig`, `CreateSkillInput`, `PatchSkillInput` |
| `deprecated-transitional` | `./skills/skill-learner.js` | 4 | `prefix:./skills/` | `SkillLearner`, `SkillMetrics`, `SkillExecutionResult`, `SkillLearnerConfig` |
| `deprecated-transitional` | `./skills/skill-model-v2.js` | 13 | `prefix:./skills/` | `SkillResolutionContext`, `FeatureBrief`, `WorkItem`, `PersonaProfile` |
| `deprecated-transitional` | `./skills/skill-chain.js` | 7 | `prefix:./skills/` | `createSkillChain`, `validateChain`, `SkillChainBuilder`, `SkillChainStep` |
| `deprecated-transitional` | `./skills/agents-md-parser.js` | 3 | `prefix:./skills/` | `parseAgentsMd`, `mergeAgentsMdConfigs`, `AgentsMdConfig` |
| `deprecated-transitional` | `./skills/hierarchical-walker.js` | 2 | `prefix:./skills/` | `discoverAgentConfigs`, `HierarchyLevel` |
| `deprecated-transitional` | `./skills/workflow-command-parser.js` | 11 | `prefix:./skills/` | `WorkflowCommandParser`, `WorkflowCommandParserConfig`, `WorkflowCommandParseResult`, `WorkflowCommandParseSuccess` |
| `deprecated-transitional` | `./skills/workflow-registry.js` | 7 | `prefix:./skills/` | `WorkflowRegistry`, `WorkflowRegistryEntry`, `WorkflowRegistrySnapshot`, `WorkflowRegistrationOptions` |
| `deprecated-transitional` | `./mcp/mcp-client.js` | 1 | `prefix:./mcp/` | `MCPClient` |
| `deprecated-transitional` | `./mcp/mcp-tool-bridge.js` | 3 | `prefix:./mcp/` | `mcpToolToLangChain`, `mcpToolsToLangChain`, `langChainToolToMcp` |
| `deprecated-transitional` | `./mcp/deferred-loader.js` | 2 | `prefix:./mcp/` | `DeferredToolLoader`, `DeferredLoaderConfig` |
| `deprecated-transitional` | `./mcp/mcp-server.js` | 11 | `prefix:./mcp/` | `DzupAgentMCPServer`, `isMCPRequest`, `MCPServerOptions`, `MCPExposedTool` |
| `deprecated-transitional` | `./mcp/mcp-types.js` | 7 | `prefix:./mcp/` | `MCPTransport`, `MCPServerConfig`, `MCPToolDescriptor`, `MCPToolParameter` |
| `deprecated-transitional` | `./mcp/mcp-reliability.js` | 3 | `prefix:./mcp/` | `McpReliabilityManager`, `McpServerHealth`, `McpReliabilityConfig` |
| `deprecated-transitional` | `./mcp/mcp-manager.js` | 3 | `prefix:./mcp/` | `InMemoryMcpManager`, `McpManager`, `InMemoryMcpManagerOptions` |
| `deprecated-transitional` | `./mcp/mcp-registry-types.js` | 7 | `prefix:./mcp/` | `McpServerDefinitionSchema`, `McpProfileSchema`, `McpServerDefinition`, `McpProfile` |
| `deprecated-transitional` | `./mcp/mcp-security.js` | 2 | `prefix:./mcp/` | `validateMcpExecutablePath`, `sanitizeMcpEnv` |
| `stable` | `./security/outbound-url-policy.js` | 8 | `prefix:./security/` | `fetchWithOutboundUrlPolicy`, `isPublicIpAddress`, `validateOutboundUrl`, `validateOutboundUrlSyntax` |
| `deprecated-transitional` | `./mcp/mcp-resources.js` | 2 | `prefix:./mcp/` | `MCPResourceClient`, `MCPResourceClientConfig` |
| `deprecated-transitional` | `./mcp/mcp-resource-types.js` | 5 | `prefix:./mcp/` | `MCPResource`, `MCPResourceTemplate`, `MCPResourceContent`, `ResourceSubscription` |
| `deprecated-transitional` | `./mcp/mcp-sampling.js` | 8 | `prefix:./mcp/` | `createSamplingHandler`, `registerSamplingHandler`, `MCPSamplingConfig`, `LLMInvokeMessage` |
| `deprecated-transitional` | `./mcp/mcp-sampling-types.js` | 6 | `prefix:./mcp/` | `MCPSamplingRequest`, `MCPSamplingResponse`, `MCPSamplingContent`, `MCPSamplingMessage` |
| `stable` | `./security/risk-classifier.js` | 5 | `prefix:./security/` | `createRiskClassifier`, `RiskTier`, `RiskClassification`, `RiskClassifierConfig` |
| `stable` | `./security/tool-permission-tiers.js` | 3 | `prefix:./security/` | `DEFAULT_AUTO_APPROVE_TOOLS`, `DEFAULT_LOG_TOOLS`, `DEFAULT_REQUIRE_APPROVAL_TOOLS` |
| `stable` | `./security/secrets-scanner.js` | 4 | `prefix:./security/` | `scanForSecrets`, `redactSecrets`, `SecretMatch`, `ScanResult` |
| `stable` | `./security/pii-detector.js` | 5 | `prefix:./security/` | `detectPII`, `redactPII`, `PIIType`, `PIIMatch` |
| `stable` | `./security/output-pipeline.js` | 5 | `prefix:./security/` | `OutputPipeline`, `createDefaultPipeline`, `SanitizationStage`, `OutputPipelineConfig` |
| `stable` | `./security/audit/index.js` | 11 | `prefix:./security/` | `InMemoryAuditStore`, `ComplianceAuditLogger`, `AuditActorType`, `AuditActor` |
| `stable` | `./security/policy/index.js` | 15 | `prefix:./security/` | `InMemoryPolicyStore`, `PolicyEvaluator`, `PolicyTranslator`, `PolicyEffect` |
| `stable` | `./security/monitor/index.js` | 9 | `prefix:./security/` | `createSafetyMonitor`, `getBuiltInRules`, `SafetyMonitor`, `SafetyMonitorConfig` |
| `stable` | `./security/memory/index.js` | 7 | `prefix:./security/` | `createMemoryDefense`, `MemoryDefense`, `MemoryDefenseConfig`, `MemoryDefenseResult` |
| `stable` | `./security/output/index.js` | 3 | `prefix:./security/` | `createHarmfulContentFilter`, `createClassificationAwareRedactor`, `HarmfulContentCategory` |
| `stable` | `./security/classification/index.js` | 6 | `prefix:./security/` | `DataClassifier`, `DEFAULT_CLASSIFICATION_PATTERNS`, `ClassificationLevel`, `DataClassificationTag` |
| `deprecated-transitional` | `./observability/metrics-collector.js` | 3 | `prefix:./observability/` | `MetricsCollector`, `globalMetrics`, `MetricType` |
| `deprecated-transitional` | `./observability/health-aggregator.js` | 5 | `prefix:./observability/` | `HealthAggregator`, `HealthStatus`, `HealthCheck`, `HealthReport` |
| `deprecated-transitional` | `./concurrency/semaphore.js` | 1 | `prefix:./concurrency/` | `Semaphore` |
| `deprecated-transitional` | `./concurrency/pool.js` | 3 | `prefix:./concurrency/` | `ConcurrencyPool`, `PoolConfig`, `PoolStats` |
| `deprecated-transitional` | `./output/format-adapter.js` | 6 | `prefix:./output/` | `OutputFormat`, `FormatAdapter`, `FormatValidationResult`, `FORMAT_ADAPTERS` |
| `deprecated-transitional` | `./i18n/locale-manager.js` | 5 | `prefix:./i18n/` | `Locale`, `LocaleConfig`, `LocaleStrings`, `EN_STRINGS` |
| `stable` | `./config/index.js` | 11 | `prefix:./config/` | `DEFAULT_CONFIG`, `loadEnvConfig`, `loadFileConfig`, `mergeConfigs` |
| `deprecated-transitional` | `./identity/index.js` | 58 | `prefix:./identity/` | `toIdentityRef`, `ForgeIdentity`, `ForgeCredential`, `ForgeCapability` |
| `deprecated-transitional` | `./protocol/index.js` | 62 | `prefix:./protocol/` | `ForgeMessageUriSchema`, `ForgeMessageMetadataSchema`, `ForgePayloadSchema`, `ForgeMessageSchema` |
| `deprecated-transitional` | `./registry/index.js` | 31 | `prefix:./registry/` | `InMemoryRegistry`, `CapabilityMatcher`, `compareSemver`, `STANDARD_CAPABILITIES` |
| `deprecated-transitional` | `./flow/index.js` | 10 | `prefix:./flow/` | `SkillHandle`, `McpToolHandle`, `WorkflowHandle`, `ResolvedAgentHandle` |
| `deprecated-transitional` | `./pipeline/index.js` | 44 | `prefix:./pipeline/` | `NodeRetryPolicy`, `PipelineNodeBase`, `AgentNode`, `ToolNode` |
| `deprecated-transitional` | `./formats/index.js` | 62 | `prefix:./formats/` | `// Agent Card V2
  AgentCardV2Schema`, `validateAgentCard`, `// Tool Format Adapters
  zodToJsonSchema`, `jsonSchemaToZod` |
| `deprecated-transitional` | `./vectordb/index.js` | 45 | `prefix:./vectordb/` | `DistanceMetric`, `CollectionConfig`, `VectorEntry`, `VectorQuery` |
| `deprecated-transitional` | `./tools/connector-contract.js` | 4 | `prefix:./tools/` | `BaseConnectorTool`, `isBaseConnectorTool`, `normalizeBaseConnectorTool`, `normalizeBaseConnectorTools` |
| `deprecated-transitional` | `./tools/create-tool.js` | 2 | `prefix:./tools/` | `createForgeTool`, `ForgeToolConfig` |
| `deprecated-transitional` | `./tools/tool-stats-tracker.js` | 5 | `prefix:./tools/` | `ToolStatsTracker`, `ToolCallRecord`, `ToolStats`, `ToolRanking` |
| `deprecated-transitional` | `./tools/tool-governance.js` | 7 | `prefix:./tools/` | `ToolGovernance`, `ToolGovernanceConfig`, `ToolValidationResult`, `ToolAuditHandler` |
| `deprecated-transitional` | `./tools/human-contact-types.js` | 17 | `prefix:./tools/` | `ContactType`, `ContactChannel`, `ApprovalRequest`, `ClarificationRequest` |
| `deprecated-transitional` | `./telemetry/trace-propagation.js` | 5 | `prefix:./telemetry/` | `injectTraceContext`, `extractTraceContext`, `formatTraceparent`, `parseTraceparent` |
| `deprecated-transitional` | `./utils/logger.js` | 3 | `prefix:./utils/` | `defaultLogger`, `noopLogger`, `FrameworkLogger` |
| `deprecated-transitional` | `./utils/backoff.js` | 2 | `prefix:./utils/` | `calculateBackoff`, `BackoffConfig` |
| `stable` | `<local>:dzupagent_CORE_VERSION` | 1 | `exact:<local>:dzupagent_CORE_VERSION` | `dzupagent_CORE_VERSION` |

## @dzupagent/agent

Root index: `packages/agent/src/index.ts`

- Stable root sources: `12`
- Deprecated transitional root sources: `108`
- Internal-only root candidates: `0`
- Migration window: Root transitional exports remain available through 0.x with migration to runtime/workflow/tools/compat before a future 1.0 root contraction.

### Stable Subpaths

| Subpath | Purpose |
| --- | --- |
| `@dzupagent/agent/runtime` | agent runtime, run handles, pipeline runtime, and observability |
| `@dzupagent/agent/workflow` | workflow, orchestration, delegation, and skill-chain execution |
| `@dzupagent/agent/tools` | tools, approval, guardrails, and tool schema registry |
| `@dzupagent/agent/compat` | legacy and fast-moving compatibility surface |

### Root Allowlist

| Root Class | Source Module | Export Count | Matched Rule | Sample Exports |
| --- | --- | ---: | --- | --- |
| `stable` | `./agent/dzip-agent.js` | 1 | `exact:./agent/dzip-agent.js` | `DzupAgent` |
| `stable` | `./agent/agent-factory.js` | 1 | `exact:./agent/agent-factory.js` | `createAgentWithMemory` |
| `stable` | `./agent/agent-types.js` | 11 | `exact:./agent/agent-types.js` | `DzupAgentConfig`, `AgentMailboxConfig`, `ArrowMemoryConfig`, `GenerateOptions` |
| `deprecated-transitional` | `./agent/memory-profiles.js` | 4 | `prefix:./agent/` | `getMemoryProfilePreset`, `resolveArrowMemoryConfig`, `MemoryProfile`, `MemoryProfilePreset` |
| `deprecated-transitional` | `./agent/tool-loop.js` | 5 | `prefix:./agent/` | `runToolLoop`, `ToolLoopConfig`, `ToolLoopResult`, `ToolStat` |
| `deprecated-transitional` | `./agent/tool-timeout-error.js` | 3 | `prefix:./agent/` | `TOOL_TIMEOUT_ERROR_CODE`, `ToolTimeoutError`, `isToolTimeoutError` |
| `stable` | `./agent/run-handle-types.js` | 9 | `exact:./agent/run-handle-types.js` | `RunHandle`, `RunResult`, `LaunchOptions`, `Unsubscribe` |
| `deprecated-transitional` | `./agent/run-handle.js` | 1 | `prefix:./agent/` | `ConcreteRunHandle` |
| `deprecated-transitional` | `./agent/parallel-executor.js` | 5 | `prefix:./agent/` | `executeToolsParallel`, `ParallelToolCall`, `ToolExecutionResult`, `ToolLookup` |
| `deprecated-transitional` | `./agent/tool-arg-validator.js` | 4 | `prefix:./agent/` | `validateAndRepairToolArgs`, `formatSchemaHint`, `ValidationResult`, `ToolArgValidatorConfig` |
| `stable` | `./guardrails/iteration-budget.js` | 1 | `exact:./guardrails/iteration-budget.js` | `IterationBudget` |
| `deprecated-transitional` | `./guardrails/stuck-detector.js` | 3 | `prefix:./guardrails/` | `StuckDetector`, `StuckDetectorConfig`, `StuckStatus` |
| `deprecated-transitional` | `./agent/stuck-error.js` | 3 | `prefix:./agent/` | `StuckError`, `EscalationLevel`, `RecoveryAction` |
| `deprecated-transitional` | `./guardrails/cascading-timeout.js` | 2 | `prefix:./guardrails/` | `CascadingTimeout`, `CascadingTimeoutConfig` |
| `stable` | `./guardrails/guardrail-types.js` | 3 | `exact:./guardrails/guardrail-types.js` | `GuardrailConfig`, `BudgetState`, `BudgetWarning` |
| `stable` | `./workflow/workflow-builder.js` | 4 | `prefix:./workflow/` | `WorkflowBuilder`, `CompiledWorkflow`, `createWorkflow`, `WorkflowConfig` |
| `stable` | `./workflow/workflow-types.js` | 4 | `prefix:./workflow/` | `WorkflowStep`, `WorkflowContext`, `WorkflowEvent`, `MergeStrategy` |
| `deprecated-transitional` | `./orchestration/orchestrator.js` | 4 | `prefix:./orchestration/` | `AgentOrchestrator`, `MergeFn`, `SupervisorConfig`, `SupervisorResult` |
| `deprecated-transitional` | `./orchestration/orchestration-error.js` | 2 | `prefix:./orchestration/` | `OrchestrationError`, `OrchestrationPattern` |
| `deprecated-transitional` | `./orchestration/map-reduce.js` | 5 | `prefix:./orchestration/` | `mapReduce`, `mapReduceMulti`, `MapReduceConfig`, `MapReduceResult` |
| `deprecated-transitional` | `./orchestration/merge-strategies.js` | 6 | `prefix:./orchestration/` | `concatMerge`, `voteMerge`, `numberedMerge`, `jsonArrayMerge` |
| `deprecated-transitional` | `./orchestration/contract-net/contract-net-manager.js` | 1 | `prefix:./orchestration/` | `ContractNetManager` |
| `deprecated-transitional` | `./orchestration/contract-net/bid-strategies.js` | 4 | `prefix:./orchestration/` | `lowestCostStrategy`, `fastestStrategy`, `highestQualityStrategy`, `createWeightedStrategy` |
| `deprecated-transitional` | `./orchestration/contract-net/contract-net-types.js` | 8 | `prefix:./orchestration/` | `ContractNetPhase`, `CallForProposals`, `ContractBid`, `ContractAward` |
| `deprecated-transitional` | `./orchestration/delegating-supervisor.js` | 5 | `prefix:./orchestration/` | `DelegatingSupervisor`, `DelegatingSupervisorConfig`, `TaskAssignment`, `AggregatedDelegationResult` |
| `deprecated-transitional` | `./orchestration/planning-agent.js` | 11 | `prefix:./orchestration/` | `PlanningAgent`, `buildExecutionLevels`, `validatePlanStructure`, `PlanNodeSchema` |
| `deprecated-transitional` | `./orchestration/delegation.js` | 10 | `prefix:./orchestration/` | `SimpleDelegationTracker`, `DelegationRequest`, `DelegationResult`, `DelegationContext` |
| `deprecated-transitional` | `./orchestration/topology/topology-analyzer.js` | 1 | `prefix:./orchestration/` | `TopologyAnalyzer` |
| `deprecated-transitional` | `./orchestration/topology/topology-executor.js` | 4 | `prefix:./orchestration/` | `TopologyExecutor`, `MeshResult`, `RingResult`, `ExecuteResult` |
| `deprecated-transitional` | `./orchestration/topology/topology-types.js` | 5 | `prefix:./orchestration/` | `TopologyType`, `TaskCharacteristics`, `TopologyRecommendation`, `TopologyMetrics` |
| `deprecated-transitional` | `./orchestration/routing-policy-types.js` | 6 | `prefix:./orchestration/` | `AgentSpec`, `AgentTask`, `RoutingDecision`, `RoutingPolicy` |
| `deprecated-transitional` | `./orchestration/orchestration-merge-strategy-types.js` | 4 | `prefix:./orchestration/` | `AgentResult`, `MergedResult`, `OrchestrationMergeStrategy`, `BuiltInMergeStrategyName` |
| `deprecated-transitional` | `./orchestration/routing/rule-based-routing.js` | 1 | `prefix:./orchestration/` | `RuleBasedRouting` |
| `deprecated-transitional` | `./orchestration/routing/hash-routing.js` | 1 | `prefix:./orchestration/` | `HashRouting` |
| `deprecated-transitional` | `./orchestration/routing/llm-routing.js` | 1 | `prefix:./orchestration/` | `LLMRouting` |
| `deprecated-transitional` | `./orchestration/routing/round-robin-routing.js` | 1 | `prefix:./orchestration/` | `RoundRobinRouting` |
| `deprecated-transitional` | `./orchestration/merge/all-required.js` | 1 | `prefix:./orchestration/` | `AllRequiredMergeStrategy` |
| `deprecated-transitional` | `./orchestration/merge/use-partial.js` | 1 | `prefix:./orchestration/` | `UsePartialMergeStrategy` |
| `deprecated-transitional` | `./orchestration/merge/first-wins.js` | 1 | `prefix:./orchestration/` | `FirstWinsMergeStrategy` |
| `deprecated-transitional` | `./orchestration/circuit-breaker.js` | 3 | `prefix:./orchestration/` | `AgentCircuitBreaker`, `CircuitState`, `CircuitBreakerConfig` |
| `deprecated-transitional` | `./orchestration/provider-adapter/index.js` | 2 | `prefix:./orchestration/` | `ProviderExecutionPort`, `ProviderExecutionResult` |
| `deprecated-transitional` | `./context/auto-compress.js` | 4 | `prefix:./context/` | `autoCompress`, `FrozenSnapshot`, `AutoCompressConfig`, `CompressResult` |
| `deprecated-transitional` | `./context/token-lifecycle-integration.js` | 4 | `prefix:./context/` | `withTokenLifecycle`, `TokenLifecycleHooks`, `TokenLifecyclePhase`, `TokenPressureListener` |
| `stable` | `./approval/approval-gate.js` | 1 | `prefix:./approval/` | `ApprovalGate` |
| `stable` | `./approval/approval-types.js` | 3 | `prefix:./approval/` | `ApprovalConfig`, `ApprovalMode`, `ApprovalResult` |
| `deprecated-transitional` | `./agent/tool-registry.js` | 2 | `prefix:./agent/` | `DynamicToolRegistry`, `ToolRegistryEvent` |
| `stable` | `./tools/create-tool.js` | 2 | `exact:./tools/create-tool.js` | `createForgeTool`, `ForgeToolConfig` |
| `deprecated-transitional` | `./tools/human-contact-tool.js` | 5 | `prefix:./tools/` | `createHumanContactTool`, `InMemoryPendingContactStore`, `HumanContactInput`, `HumanContactToolConfig` |
| `deprecated-transitional` | `./agent/agent-state.js` | 4 | `prefix:./agent/` | `serializeMessages`, `deserializeMessages`, `AgentStateSnapshot`, `SerializedMessage` |
| `deprecated-transitional` | `./snapshot/agent-snapshot.js` | 6 | `prefix:./snapshot/` | `createSnapshot`, `verifySnapshot`, `compressSnapshot`, `decompressSnapshot` |
| `deprecated-transitional` | `./snapshot/serialized-message.js` | 4 | `prefix:./snapshot/` | `serializeMessage`, `migrateMessages`, `SerializedMessage`, `MultimodalContent` |
| `deprecated-transitional` | `./structured/index.js` | 8 | `prefix:./structured/` | `generateStructured`, `detectStrategy`, `StructuredOutputStrategy`, `StructuredOutputCapabilities` |
| `deprecated-transitional` | `./tools/tool-schema-registry.js` | 3 | `prefix:./tools/` | `ToolSchemaRegistry`, `ToolSchemaEntry`, `CompatCheckResult` |
| `deprecated-transitional` | `./streaming/stream-action-parser.js` | 4 | `prefix:./streaming/` | `StreamActionParser`, `StreamedToolCall`, `StreamActionEvent`, `StreamActionParserConfig` |
| `deprecated-transitional` | `./streaming/streaming-types.js` | 6 | `prefix:./streaming/` | `StreamEvent`, `TextDeltaEvent`, `ToolCallStartEvent`, `ToolCallEndEvent` |
| `deprecated-transitional` | `./streaming/text-delta-buffer.js` | 1 | `prefix:./streaming/` | `TextDeltaBuffer` |
| `deprecated-transitional` | `./streaming/streaming-run-handle.js` | 3 | `prefix:./streaming/` | `StreamingRunHandle`, `StreamingStatus`, `StreamingRunHandleOptions` |
| `deprecated-transitional` | `./templates/agent-templates.js` | 6 | `prefix:./templates/` | `AGENT_TEMPLATES`, `ALL_AGENT_TEMPLATES`, `getAgentTemplate`, `listAgentTemplates` |
| `deprecated-transitional` | `./templates/template-composer.js` | 1 | `prefix:./templates/` | `composeTemplates` |
| `deprecated-transitional` | `./templates/template-registry.js` | 1 | `prefix:./templates/` | `TemplateRegistry` |
| `deprecated-transitional` | `./pipeline/pipeline-validator.js` | 1 | `prefix:./pipeline/` | `validatePipeline` |
| `deprecated-transitional` | `./pipeline/in-memory-checkpoint-store.js` | 1 | `prefix:./pipeline/` | `InMemoryPipelineCheckpointStore` |
| `deprecated-transitional` | `./pipeline/pipeline-runtime.js` | 1 | `prefix:./pipeline/` | `PipelineRuntime` |
| `deprecated-transitional` | `./pipeline/loop-executor.js` | 4 | `prefix:./pipeline/` | `executeLoop`, `stateFieldTruthy`, `qualityBelow`, `hasErrors` |
| `deprecated-transitional` | `./pipeline/pipeline-runtime-types.js` | 11 | `prefix:./pipeline/` | `PipelineState`, `NodeResult`, `PipelineRunResult`, `NodeExecutor` |
| `deprecated-transitional` | `./pipeline/step-type-registry.js` | 4 | `prefix:./pipeline/` | `StepTypeRegistry`, `defaultStepTypeRegistry`, `StepContext`, `StepTypeDescriptor` |
| `deprecated-transitional` | `./pipeline/retry-policy.js` | 4 | `prefix:./pipeline/` | `DEFAULT_RETRY_POLICY`, `calculateBackoff`, `isRetryable`, `resolveRetryPolicy` |
| `deprecated-transitional` | `./pipeline/pipeline-templates.js` | 8 | `prefix:./pipeline/` | `createCodeReviewPipeline`, `createFeatureGenerationPipeline`, `createTestGenerationPipeline`, `createRefactoringPipeline` |
| `deprecated-transitional` | `./security/agent-auth.js` | 4 | `prefix:./security/` | `AgentAuth`, `AgentCredential`, `SignedAgentMessage`, `AgentAuthConfig` |
| `deprecated-transitional` | `./pipeline/pipeline-analytics.js` | 6 | `prefix:./pipeline/` | `PipelineAnalytics`, `NodeMetrics`, `BottleneckEntry`, `PipelineAnalyticsReport` |
| `deprecated-transitional` | `./playground/playground.js` | 2 | `prefix:./playground/` | `AgentPlayground`, `PlaygroundConfig` |
| `deprecated-transitional` | `./orchestration/team/team-workspace.js` | 6 | `prefix:./orchestration/` | `SharedWorkspace`, `WorkspaceSubscriber`, `TeamAgentRole`, `TeamAgentStatus` |
| `deprecated-transitional` | `./playground/team-coordinator.js` | 1 | `prefix:./playground/` | `TeamCoordinator` |
| `deprecated-transitional` | `./playground/types.js` | 8 | `prefix:./playground/` | `AgentRole`, `AgentSpawnConfig`, `CoordinationPattern`, `TeamConfig` |
| `deprecated-transitional` | `./orchestration/team/team-runtime.js` | 10 | `prefix:./orchestration/` | `TeamRuntime`, `DEFAULT_ROUTER_MODEL`, `DEFAULT_PARTICIPANT_MODEL`, `DEFAULT_GOVERNANCE_MODEL` |
| `deprecated-transitional` | `./orchestration/team/team-definition.js` | 3 | `prefix:./orchestration/` | `CoordinatorPattern`, `ParticipantDefinition`, `TeamDefinition` |
| `deprecated-transitional` | `./orchestration/team/team-policy.js` | 7 | `prefix:./orchestration/` | `ExecutionPolicy`, `GovernancePolicy`, `MemoryPolicy`, `IsolationPolicy` |
| `deprecated-transitional` | `./orchestration/team/team-phase.js` | 2 | `prefix:./orchestration/` | `TeamPhase`, `TeamPhaseModel` |
| `deprecated-transitional` | `./orchestration/team/team-checkpoint.js` | 2 | `prefix:./orchestration/` | `TeamCheckpoint`, `ResumeContract` |
| `deprecated-transitional` | `./orchestration/team/supervision-policy.js` | 2 | `prefix:./orchestration/` | `SupervisionPolicy`, `AgentBreakerState` |
| `deprecated-transitional` | `./reflection/run-reflector.js` | 5 | `prefix:./reflection/` | `RunReflector`, `ReflectionScore`, `ReflectionDimensions`, `ReflectionInput` |
| `deprecated-transitional` | `./reflection/reflection-analyzer.js` | 2 | `prefix:./reflection/` | `ReflectionAnalyzer`, `ReflectionAnalyzerConfig` |
| `deprecated-transitional` | `./reflection/in-memory-reflection-store.js` | 1 | `prefix:./reflection/` | `InMemoryReflectionStore` |
| `deprecated-transitional` | `./reflection/reflection-types.js` | 3 | `prefix:./reflection/` | `ReflectionPattern`, `ReflectionSummary`, `RunReflectionStore` |
| `deprecated-transitional` | `./reflection/learning-bridge.js` | 3 | `prefix:./reflection/` | `createReflectionLearningBridge`, `buildWorkflowEventsFromToolStats`, `ReflectionLearningBridgeConfig` |
| `deprecated-transitional` | `./recovery/recovery-copilot.js` | 2 | `prefix:./recovery/` | `RecoveryCopilot`, `StrategyGenerator` |
| `deprecated-transitional` | `./recovery/failure-analyzer.js` | 3 | `prefix:./recovery/` | `FailureAnalyzer`, `FailureHistoryEntry`, `FailureAnalysis` |
| `deprecated-transitional` | `./recovery/strategy-ranker.js` | 2 | `prefix:./recovery/` | `StrategyRanker`, `RankingWeights` |
| `deprecated-transitional` | `./recovery/recovery-executor.js` | 3 | `prefix:./recovery/` | `RecoveryExecutor`, `ActionHandler`, `RecoveryExecutorConfig` |
| `deprecated-transitional` | `./recovery/recovery-types.js` | 10 | `prefix:./recovery/` | `FailureType`, `FailureContext`, `RecoveryActionType`, `RecoveryAction` |
| `deprecated-transitional` | `./replay/index.js` | 21 | `prefix:./replay/` | `TraceCapture`, `ReplayEngine`, `ReplayController`, `ReplayInspector` |
| `deprecated-transitional` | `./instructions/agents-md-parser.js` | 4 | `prefix:./instructions/` | `parseAgentsMd`, `mergeAgentsMd`, `discoverAgentsMdHierarchy`, `AgentsMdSection` |
| `deprecated-transitional` | `./instructions/instruction-merger.js` | 2 | `prefix:./instructions/` | `mergeInstructions`, `MergedInstructions` |
| `deprecated-transitional` | `./instructions/instruction-loader.js` | 3 | `prefix:./instructions/` | `loadAgentsFiles`, `LoadedAgentsFile`, `LoadAgentsOptions` |
| `deprecated-transitional` | `./self-correction/reflection-loop.js` | 6 | `prefix:./self-correction/` | `ReflectionLoop`, `parseCriticResponse`, `ReflectionConfig`, `ReflectionIteration` |
| `deprecated-transitional` | `./self-correction/iteration-controller.js` | 3 | `prefix:./self-correction/` | `AdaptiveIterationController`, `IterationDecision`, `IterationControllerConfig` |
| `deprecated-transitional` | `./self-correction/self-correcting-node.js` | 3 | `prefix:./self-correction/` | `createSelfCorrectingExecutor`, `SelfCorrectingConfig`, `SelfCorrectingResult` |
| `deprecated-transitional` | `./self-correction/error-detector.js` | 5 | `prefix:./self-correction/` | `ErrorDetectionOrchestrator`, `ErrorSource`, `ErrorSeverity`, `DetectedError` |
| `deprecated-transitional` | `./self-correction/root-cause-analyzer.js` | 5 | `prefix:./self-correction/` | `RootCauseAnalyzer`, `RootCauseReport`, `RootCauseAnalyzerConfig`, `AnalyzeParams` |
| `deprecated-transitional` | `./self-correction/verification-protocol.js` | 5 | `prefix:./self-correction/` | `VerificationProtocol`, `jaccardSimilarity`, `VerificationStrategy`, `VerificationResult` |
| `deprecated-transitional` | `./self-correction/self-learning-runtime.js` | 3 | `prefix:./self-correction/` | `SelfLearningRuntime`, `SelfLearningConfig`, `SelfLearningRunResult` |
| `deprecated-transitional` | `./self-correction/self-learning-hook.js` | 3 | `prefix:./self-correction/` | `SelfLearningPipelineHook`, `SelfLearningHookConfig`, `HookMetrics` |
| `deprecated-transitional` | `./self-correction/post-run-analyzer.js` | 5 | `prefix:./self-correction/` | `PostRunAnalyzer`, `RunAnalysis`, `AnalysisResult`, `PostRunAnalyzerConfig` |
| `deprecated-transitional` | `./self-correction/adaptive-prompt-enricher.js` | 5 | `prefix:./self-correction/` | `AdaptivePromptEnricher`, `PromptEnrichment`, `EnricherConfig`, `EnrichParams` |
| `deprecated-transitional` | `./self-correction/pipeline-stuck-detector.js` | 5 | `prefix:./self-correction/` | `PipelineStuckDetector`, `PipelineStuckConfig`, `PipelineStuckStatus`, `PipelineStuckSummary` |
| `deprecated-transitional` | `./self-correction/trajectory-calibrator.js` | 5 | `prefix:./self-correction/` | `TrajectoryCalibrator`, `StepReward`, `TrajectoryRecord`, `SuboptimalResult` |
| `deprecated-transitional` | `./self-correction/observability-bridge.js` | 6 | `prefix:./self-correction/` | `ObservabilityCorrectionBridge`, `CorrectionSignal`, `CorrectionSignalType`, `SignalSeverity` |
| `deprecated-transitional` | `./self-correction/strategy-selector.js` | 5 | `prefix:./self-correction/` | `StrategySelector`, `FixStrategy`, `StrategyRate`, `StrategyRecommendation` |
| `deprecated-transitional` | `./self-correction/recovery-feedback.js` | 3 | `prefix:./self-correction/` | `RecoveryFeedback`, `RecoveryLesson`, `RecoveryFeedbackConfig` |
| `deprecated-transitional` | `./self-correction/performance-optimizer.js` | 4 | `prefix:./self-correction/` | `AgentPerformanceOptimizer`, `OptimizationDecision`, `PerformanceHistory`, `PerformanceOptimizerConfig` |
| `deprecated-transitional` | `./self-correction/langgraph-middleware.js` | 4 | `prefix:./self-correction/` | `LangGraphLearningMiddleware`, `LangGraphLearningConfig`, `LearningRunMetrics`, `WrapNodeOptions` |
| `deprecated-transitional` | `./self-correction/feedback-collector.js` | 6 | `prefix:./self-correction/` | `FeedbackCollector`, `FeedbackType`, `FeedbackOutcome`, `FeedbackRecord` |
| `deprecated-transitional` | `./self-correction/learning-dashboard.js` | 7 | `prefix:./self-correction/` | `LearningDashboardService`, `LearningOverview`, `QualityTrend`, `CostTrend` |
| `deprecated-transitional` | `./presets/index.js` | 11 | `prefix:./presets/` | `AgentPreset`, `PresetRuntimeDeps`, `PresetConfig`, `buildConfigFromPreset` |
| `deprecated-transitional` | `./skill-chain-executor/index.js` | 21 | `prefix:./skill-chain-executor/` | `executeTextualWorkflow`, `streamTextualWorkflow`, `createSkillChainWorkflow`, `TextualWorkflowOptions` |
| `deprecated-transitional` | `./cluster/index.js` | 4 | `prefix:./cluster/` | `ClusterRole`, `AgentCluster`, `InMemoryAgentCluster`, `InMemoryAgentClusterConfig` |
| `deprecated-transitional` | `./mailbox/index.js` | 18 | `prefix:./mailbox/` | `MailMessage`, `MailboxQuery`, `MailboxStore`, `AgentMailbox` |
| `deprecated-transitional` | `./token-lifecycle-wiring.js` | 4 | `exact:./token-lifecycle-wiring.js` | `createTokenLifecyclePlugin`, `AgentLoopPlugin`, `TokenLifecyclePluginOptions`, `CompressionHintListener` |
| `deprecated-transitional` | `./observability/index.js` | 7 | `prefix:./observability/` | `RunMetricsAggregator`, `attachRunMetricsBridge`, `RunSummaryMetrics`, `RunTokenUsage` |
| `stable` | `<local>:dzupagent_AGENT_VERSION` | 1 | `exact:<local>:dzupagent_AGENT_VERSION` | `dzupagent_AGENT_VERSION` |

## @dzupagent/codegen

Root index: `packages/codegen/src/index.ts`

- Stable root sources: `21`
- Deprecated transitional root sources: `71`
- Internal-only root candidates: `0`
- Migration window: Root transitional exports remain available through 0.x with migration to vfs/tools/runtime/compat before a future 1.0 root contraction.

### Stable Subpaths

| Subpath | Purpose |
| --- | --- |
| `@dzupagent/codegen/vfs` | virtual filesystem, snapshots, patches, and workspace filesystem |
| `@dzupagent/codegen/tools` | code editing tools, git helpers, and workspace adapters |
| `@dzupagent/codegen/runtime` | generation, sandbox, pipeline, guardrails, and quality runtime |
| `@dzupagent/codegen/compat` | preview and transitional subsystems |

### Root Allowlist

| Root Class | Source Module | Export Count | Matched Rule | Sample Exports |
| --- | --- | ---: | --- | --- |
| `stable` | `./vfs/virtual-fs.js` | 2 | `prefix:./vfs/` | `VirtualFS`, `FileDiff` |
| `stable` | `./vfs/vfs-snapshot.js` | 5 | `prefix:./vfs/` | `saveSnapshot`, `loadSnapshot`, `SnapshotStore`, `SnapshotSaveResult` |
| `stable` | `./vfs/checkpoint-manager.js` | 5 | `prefix:./vfs/` | `CheckpointManager`, `CheckpointManagerConfig`, `CheckpointEntry`, `CheckpointDiff` |
| `stable` | `./vfs/cow-vfs.js` | 1 | `prefix:./vfs/` | `CopyOnWriteVFS` |
| `stable` | `./vfs/vfs-types.js` | 5 | `prefix:./vfs/` | `MergeStrategy`, `MergeConflict`, `MergeResult`, `VFSDiff` |
| `stable` | `./vfs/parallel-sampling.js` | 4 | `prefix:./vfs/` | `sample`, `selectBest`, `commitBest`, `sampleAndCommitBest` |
| `stable` | `./vfs/patch-engine.js` | 11 | `prefix:./vfs/` | `parseUnifiedDiff`, `applyPatch`, `applyPatchSet`, `PatchParseError` |
| `stable` | `./vfs/workspace-runner.js` | 3 | `prefix:./vfs/` | `WorkspaceRunner`, `WorkspaceRunResult`, `WorkspaceRunOptions` |
| `stable` | `./vfs/workspace-fs.js` | 6 | `prefix:./vfs/` | `InMemoryWorkspaceFS`, `DiskWorkspaceFS`, `GitWorktreeWorkspaceFS`, `WorkspaceFS` |
| `stable` | `./generation/code-gen-service.js` | 3 | `prefix:./generation/` | `CodeGenService`, `GenerateFileParams`, `GenerateFileResult` |
| `stable` | `./generation/codegen-run-engine.js` | 2 | `prefix:./generation/` | `CodegenRunEngine`, `CodegenRunEngineConfig` |
| `stable` | `./generation/code-block-parser.js` | 4 | `prefix:./generation/` | `parseCodeBlocks`, `extractLargestCodeBlock`, `detectLanguage`, `CodeBlock` |
| `stable` | `./generation/incremental-gen.js` | 7 | `prefix:./generation/` | `splitIntoSections`, `detectAffectedSections`, `applyIncrementalChanges`, `buildIncrementalPrompt` |
| `stable` | `./generation/test-generator.js` | 11 | `prefix:./generation/` | `determineTestStrategy`, `extractExports`, `generateTestSpecs`, `buildTestPath` |
| `deprecated-transitional` | `./sandbox/sandbox-protocol.js` | 3 | `prefix:./sandbox/` | `SandboxProtocol`, `ExecOptions`, `ExecResult` |
| `deprecated-transitional` | `./sandbox/sandbox-protocol-v2.js` | 3 | `prefix:./sandbox/` | `SandboxProtocolV2`, `SessionOptions`, `ExecEvent` |
| `deprecated-transitional` | `./sandbox/docker-sandbox.js` | 2 | `prefix:./sandbox/` | `DockerSandbox`, `DockerSandboxConfig` |
| `deprecated-transitional` | `./sandbox/mock-sandbox.js` | 1 | `prefix:./sandbox/` | `MockSandbox` |
| `deprecated-transitional` | `./sandbox/mock-sandbox-v2.js` | 1 | `prefix:./sandbox/` | `MockSandboxV2` |
| `deprecated-transitional` | `./sandbox/e2b-sandbox.js` | 2 | `prefix:./sandbox/` | `E2BSandbox`, `E2BSandboxConfig` |
| `deprecated-transitional` | `./sandbox/fly-sandbox.js` | 2 | `prefix:./sandbox/` | `FlySandbox`, `FlySandboxConfig` |
| `deprecated-transitional` | `./sandbox/sandbox-factory.js` | 3 | `prefix:./sandbox/` | `createSandbox`, `SandboxProvider`, `SandboxFactoryConfig` |
| `deprecated-transitional` | `./sandbox/permission-tiers.js` | 13 | `prefix:./sandbox/` | `TIER_DEFAULTS`, `MIN_MEMORY_MB`, `MIN_CPUS`, `MIN_TIMEOUT_MS` |
| `deprecated-transitional` | `./sandbox/security-profile.js` | 10 | `prefix:./sandbox/` | `SECURITY_PROFILES`, `getSecurityProfile`, `customizeProfile`, `toDockerFlags` |
| `deprecated-transitional` | `./sandbox/pool/index.js` | 9 | `prefix:./sandbox/` | `SandboxPool`, `PoolExhaustedError`, `PooledSandbox`, `SandboxPoolConfig` |
| `deprecated-transitional` | `./sandbox/volumes/index.js` | 6 | `prefix:./sandbox/` | `InMemoryVolumeManager`, `VolumeType`, `VolumeDescriptor`, `VolumeInfo` |
| `deprecated-transitional` | `./sandbox/audit/index.js` | 7 | `prefix:./sandbox/` | `InMemoryAuditStore`, `AuditedSandbox`, `redactSecrets`, `AuditAction` |
| `deprecated-transitional` | `./sandbox/sandbox-hardening.js` | 7 | `prefix:./sandbox/` | `toDockerSecurityFlags`, `detectEscapeAttempt`, `SeccompProfile`, `FilesystemACL` |
| `deprecated-transitional` | `./sandbox/wasm/index.js` | 15 | `prefix:./sandbox/` | `WasiFilesystem`, `WasiFileEntry`, `WasiStatResult`, `CapabilityGuard` |
| `deprecated-transitional` | `./sandbox/k8s/index.js` | 17 | `prefix:./sandbox/` | `K8sClient`, `K8sPodSandbox`, `createAgentSandboxResource`, `AgentSandboxPhase` |
| `deprecated-transitional` | `./validation/import-validator.js` | 3 | `prefix:./validation/` | `validateImports`, `ImportValidationResult`, `ImportError` |
| `deprecated-transitional` | `./quality/quality-types.js` | 4 | `prefix:./quality/` | `QualityDimension`, `DimensionResult`, `QualityResult`, `QualityContext` |
| `deprecated-transitional` | `./quality/quality-scorer.js` | 1 | `prefix:./quality/` | `QualityScorer` |
| `deprecated-transitional` | `./quality/convention-gate.js` | 6 | `prefix:./quality/` | `ConventionGate`, `ConventionViolation`, `ConventionCategory`, `LearnedConvention` |
| `deprecated-transitional` | `./quality/quality-dimensions.js` | 6 | `prefix:./quality/` | `typeStrictness`, `eslintClean`, `hasTests`, `codeCompleteness` |
| `deprecated-transitional` | `./quality/coverage-analyzer.js` | 4 | `prefix:./quality/` | `analyzeCoverage`, `findUncoveredFiles`, `CoverageReport`, `CoverageConfig` |
| `deprecated-transitional` | `./quality/import-validator.js` | 3 | `prefix:./quality/` | `validateImports`, `ImportIssue`, `ImportValidationResult` |
| `deprecated-transitional` | `./quality/contract-validator.js` | 7 | `prefix:./quality/` | `extractEndpoints`, `extractAPICalls`, `validateContracts`, `APIEndpoint` |
| `deprecated-transitional` | `./adaptation/path-mapper.js` | 1 | `prefix:./adaptation/` | `PathMapper` |
| `deprecated-transitional` | `./adaptation/framework-adapter.js` | 1 | `prefix:./adaptation/` | `FrameworkAdapter` |
| `deprecated-transitional` | `./adaptation/languages/index.js` | 5 | `prefix:./adaptation/` | `SupportedLanguage`, `LanguageConfig`, `LANGUAGE_CONFIGS`, `detectLanguageFromFiles` |
| `deprecated-transitional` | `./contract/contract-types.js` | 2 | `prefix:./contract/` | `ApiEndpoint`, `ApiContract` |
| `deprecated-transitional` | `./contract/api-extractor.js` | 1 | `prefix:./contract/` | `ApiExtractor` |
| `deprecated-transitional` | `./context/token-budget.js` | 9 | `prefix:./context/` | `FileRoleDetector`, `PhasePriorityMatrix`, `FileEntry`, `TokenBudgetOptions` |
| `deprecated-transitional` | `./pipeline/gen-pipeline-builder.js` | 2 | `prefix:./pipeline/` | `GenPipelineBuilder`, `PipelinePhase` |
| `deprecated-transitional` | `./pipeline/fix-escalation.js` | 4 | `prefix:./pipeline/` | `DEFAULT_ESCALATION`, `getEscalationStrategy`, `EscalationConfig`, `EscalationStrategy` |
| `deprecated-transitional` | `./pipeline/phase-types.js` | 6 | `prefix:./pipeline/` | `BaseGenState`, `PhaseConfig`, `SubAgentPhaseConfig`, `ValidationPhaseConfig` |
| `deprecated-transitional` | `./pipeline/pipeline-executor.js` | 5 | `prefix:./pipeline/` | `PipelineExecutor`, `ExecutorConfig`, `PhaseConfig`, `PhaseResult` |
| `deprecated-transitional` | `./pipeline/guardrail-gate.js` | 4 | `prefix:./pipeline/` | `runGuardrailGate`, `summarizeGateResult`, `GuardrailGateConfig`, `GuardrailGateResult` |
| `deprecated-transitional` | `./pipeline/budget-gate.js` | 3 | `prefix:./pipeline/` | `runBudgetGate`, `BudgetGateConfig`, `BudgetGateResult` |
| `deprecated-transitional` | `./pipeline/phase-conditions.js` | 6 | `prefix:./pipeline/` | `hasKey`, `previousSucceeded`, `stateEquals`, `hasFilesMatching` |
| `deprecated-transitional` | `./tools/tool-context.js` | 1 | `prefix:./tools/` | `CodegenToolContext` |
| `deprecated-transitional` | `./tools/write-file.tool.js` | 1 | `prefix:./tools/` | `createWriteFileTool` |
| `deprecated-transitional` | `./tools/edit-file.tool.js` | 1 | `prefix:./tools/` | `createEditFileTool` |
| `deprecated-transitional` | `./tools/multi-edit.tool.js` | 1 | `prefix:./tools/` | `createMultiEditTool` |
| `deprecated-transitional` | `./tools/generate-file.tool.js` | 1 | `prefix:./tools/` | `createGenerateFileTool` |
| `deprecated-transitional` | `./tools/run-tests.tool.js` | 1 | `prefix:./tools/` | `createRunTestsTool` |
| `deprecated-transitional` | `./tools/validate.tool.js` | 1 | `prefix:./tools/` | `createValidateTool` |
| `deprecated-transitional` | `./tools/lint-validator.js` | 4 | `prefix:./tools/` | `quickSyntaxCheck`, `sandboxLintCheck`, `LintError`, `LintResult` |
| `deprecated-transitional` | `./tools/preview-app.tool.js` | 2 | `prefix:./tools/` | `createPreviewAppTool`, `PreviewAppResult` |
| `stable` | `./git/git-executor.js` | 1 | `prefix:./git/` | `GitExecutor` |
| `stable` | `./git/git-tools.js` | 6 | `prefix:./git/` | `createGitTools`, `createGitStatusTool`, `createGitDiffTool`, `createGitCommitTool` |
| `stable` | `./git/commit-message.js` | 1 | `prefix:./git/` | `generateCommitMessage` |
| `stable` | `./git/git-middleware.js` | 4 | `prefix:./git/` | `gatherGitContext`, `formatGitContext`, `GitContextConfig`, `GitContext` |
| `stable` | `./git/git-worktree.js` | 3 | `prefix:./git/` | `GitWorktreeManager`, `WorktreeInfo`, `WorktreeManagerConfig` |
| `stable` | `./git/git-types.js` | 8 | `prefix:./git/` | `GitFileStatus`, `GitFileEntry`, `GitStatusResult`, `GitDiffResult` |
| `deprecated-transitional` | `./repomap/symbol-extractor.js` | 2 | `prefix:./repomap/` | `extractSymbols`, `ExtractedSymbol` |
| `deprecated-transitional` | `./repomap/tree-sitter-extractor.js` | 6 | `prefix:./repomap/` | `extractSymbolsAST`, `isTreeSitterAvailable`, `detectLanguage`, `EXTENSION_MAP` |
| `deprecated-transitional` | `./repomap/import-graph.js` | 3 | `prefix:./repomap/` | `buildImportGraph`, `ImportEdge`, `ImportGraph` |
| `deprecated-transitional` | `./repomap/repo-map-builder.js` | 3 | `prefix:./repomap/` | `buildRepoMap`, `RepoMapConfig`, `RepoMap` |
| `deprecated-transitional` | `./chunking/ast-chunker.js` | 3 | `prefix:./chunking/` | `chunkByAST`, `CodeChunk`, `ASTChunkerConfig` |
| `deprecated-transitional` | `./search/code-search-service.js` | 1 | `prefix:./search/` | `CodeSearchService` |
| `deprecated-transitional` | `./search/code-search-types.js` | 6 | `prefix:./search/` | `CodeSearchOptions`, `CodeSearchResult`, `CodeSearchServiceConfig`, `IndexResult` |
| `deprecated-transitional` | `./pr/pr-manager.js` | 9 | `prefix:./pr/` | `getNextAction`, `buildPRDescription`, `transitionState`, `PRState` |
| `deprecated-transitional` | `./pr/review-handler.js` | 5 | `prefix:./pr/` | `consolidateReviews`, `buildReviewFixPrompt`, `classifyCommentSeverity`, `ReviewFeedback` |
| `deprecated-transitional` | `./ci/ci-monitor.js` | 7 | `prefix:./ci/` | `categorizeFailure`, `parseGitHubActionsStatus`, `parseCIWebhook`, `CIProvider` |
| `deprecated-transitional` | `./ci/failure-router.js` | 3 | `prefix:./ci/` | `routeFailure`, `DEFAULT_FIX_STRATEGIES`, `FixStrategy` |
| `deprecated-transitional` | `./ci/fix-loop.js` | 5 | `prefix:./ci/` | `generateFixAttempts`, `buildFixPrompt`, `FixLoopConfig`, `FixAttempt` |
| `deprecated-transitional` | `./review/review-rules.js` | 4 | `prefix:./review/` | `ReviewSeverity`, `ReviewCategory`, `ReviewRule`, `BUILTIN_RULES` |
| `deprecated-transitional` | `./review/code-reviewer.js` | 7 | `prefix:./review/` | `ReviewComment`, `ReviewSummary`, `ReviewResult`, `CodeReviewConfig` |
| `deprecated-transitional` | `./conventions/convention-detector.js` | 3 | `prefix:./conventions/` | `detectConventions`, `DetectedConvention`, `ConventionReport` |
| `deprecated-transitional` | `./conventions/convention-enforcer.js` | 4 | `prefix:./conventions/` | `enforceConventions`, `conventionsToPrompt`, `ConventionViolation`, `EnforcementResult` |
| `deprecated-transitional` | `./correction/index.js` | 24 | `prefix:./correction/` | `SelfCorrectionLoop`, `CorrectionEventListeners`, `SelfCorrectionDeps`, `ReflectionNode` |
| `deprecated-transitional` | `./migration/migration-planner.js` | 6 | `prefix:./migration/` | `getMigrationPlan`, `analyzeMigrationScope`, `buildMigrationPrompt`, `MigrationTarget` |
| `deprecated-transitional` | `./guardrails/guardrail-engine.js` | 2 | `prefix:./guardrails/` | `GuardrailEngine`, `GuardrailEngineConfig` |
| `deprecated-transitional` | `./guardrails/convention-learner.js` | 2 | `prefix:./guardrails/` | `ConventionLearner`, `ConventionLearnerConfig` |
| `deprecated-transitional` | `./guardrails/guardrail-reporter.js` | 3 | `prefix:./guardrails/` | `GuardrailReporter`, `ReportFormat`, `ReporterConfig` |
| `deprecated-transitional` | `./guardrails/rules/index.js` | 8 | `prefix:./guardrails/` | `createBuiltinRules`, `createLayeringRule`, `createImportRestrictionRule`, `createNamingConventionRule` |
| `deprecated-transitional` | `./guardrails/guardrail-types.js` | 15 | `prefix:./guardrails/` | `GuardrailCategory`, `GuardrailSeverity`, `GeneratedFile`, `ProjectStructure` |
| `deprecated-transitional` | `./streaming/index.js` | 2 | `prefix:./streaming/` | `CodegenStreamEvent`, `mergeCodegenStreams` |
| `deprecated-transitional` | `./workspace/index.js` | 8 | `prefix:./workspace/` | `SearchResult`, `CommandResult`, `WorkspaceOptions`, `Workspace` |
| `stable` | `<local>:dzupagent_CODEGEN_VERSION` | 1 | `exact:<local>:dzupagent_CODEGEN_VERSION` | `dzupagent_CODEGEN_VERSION` |

## @dzupagent/server

Root index: `packages/server/src/index.ts`

- Stable root sources: `30`
- Deprecated transitional root sources: `78`
- Internal-only root candidates: `18`
- Migration window: Root transitional exports remain available through 0.x with migration to ops/runtime/compat before a future 1.0 root contraction.

### Stable Subpaths

| Subpath | Purpose |
| --- | --- |
| `@dzupagent/server/ops` | operational diagnostics and scorecards |
| `@dzupagent/server/runtime` | run workers, executors, trace stores, and control-plane helpers |
| `@dzupagent/server/compat` | OpenAI-compatible HTTP surface |

### Root Allowlist

| Root Class | Source Module | Export Count | Matched Rule | Sample Exports |
| --- | --- | ---: | --- | --- |
| `stable` | `./app.js` | 11 | `stable/app/keep-root` | `createForgeApp`, `ForgeServerConfig`, `ForgeRouteFamiliesConfig`, `ForgeMemoryRouteFamilyConfig` |
| `stable` | `./route-plugin.js` | 2 | `stable/extensibility/keep-root` | `ServerRoutePlugin`, `ServerRoutePluginContext` |
| `stable` | `./routes/runs.js` | 1 | `stable/routes-core/keep-root` | `createRunRoutes` |
| `deprecated-transitional` | `./routes/run-context.js` | 3 | `secondary/trace-context/candidate-subpath` | `createRunContextRoutes`, `TokenLifecycleLike`, `TokenLifecycleRegistry` |
| `stable` | `./routes/agents.js` | 2 | `stable/routes-core/keep-root` | `createAgentDefinitionRoutes`, `createAgentRoutes` |
| `stable` | `./routes/approval.js` | 1 | `stable/routes-core/keep-root` | `createApprovalRoutes` |
| `deprecated-transitional` | `./routes/human-contact.js` | 1 | `secondary/routes-core/candidate-subpath` | `createHumanContactRoutes` |
| `stable` | `./routes/health.js` | 1 | `stable/routes-core/keep-root` | `createHealthRoutes` |
| `deprecated-transitional` | `./routes/memory.js` | 2 | `experimental/memory/candidate-subpath` | `createMemoryRoutes`, `MemoryRouteConfig` |
| `deprecated-transitional` | `./routes/memory-browse.js` | 2 | `experimental/memory/candidate-subpath` | `createMemoryBrowseRoutes`, `MemoryBrowseRouteConfig` |
| `deprecated-transitional` | `./routes/learning.js` | 2 | `experimental/learning/candidate-subpath` | `createLearningRoutes`, `LearningRouteConfig` |
| `deprecated-transitional` | `./routes/benchmarks.js` | 3 | `experimental/benchmarks/candidate-subpath` | `createBenchmarkRoutes`, `BenchmarkRouteConfig`, `BenchmarkOrchestratorFactory` |
| `deprecated-transitional` | `./routes/evals.js` | 3 | `experimental/evals/candidate-subpath` | `createEvalRoutes`, `EvalRouteConfig`, `EvalOrchestratorFactory` |
| `deprecated-transitional` | `./routes/memory-health.js` | 3 | `experimental/memory/candidate-subpath` | `createMemoryHealthRoutes`, `MemoryHealthRouteConfig`, `HealthProvider` |
| `deprecated-transitional` | `./routes/routing-stats.js` | 2 | `experimental/observability/candidate-subpath` | `createRoutingStatsRoutes`, `RoutingStatsConfig` |
| `deprecated-transitional` | `./routes/playground.js` | 2 | `experimental/playground/candidate-subpath` | `createPlaygroundRoutes`, `PlaygroundRouteConfig` |
| `stable` | `./routes/events.js` | 2 | `stable/realtime/keep-root` | `createEventRoutes`, `EventRouteConfig` |
| `deprecated-transitional` | `./routes/workflows.js` | 2 | `secondary/workflow-routes/candidate-subpath` | `createWorkflowRoutes`, `WorkflowRouteConfig` |
| `deprecated-transitional` | `./routes/metrics.js` | 3 | `secondary/metrics/candidate-subpath` | `createMetricsRoute`, `MetricsAccessControl`, `MetricsRouteConfig` |
| `deprecated-transitional` | `./metrics/prometheus-collector.js` | 1 | `secondary/metrics/candidate-subpath` | `PrometheusMetricsCollector` |
| `deprecated-transitional` | `./persistence/postgres-stores.js` | 7 | `secondary/persistence/candidate-subpath` | `PostgresRunStore`, `PostgresAgentStore`, `DrizzleVectorStore`, `VectorDistanceMetric` |
| `internal-only-candidate` | `./persistence/drizzle-schema.js` | 17 | `internal/persistence/remove-root` | `dzipAgents`, `forgeRuns`, `forgeRunLogs`, `forgeVectors` |
| `deprecated-transitional` | `./persistence/api-key-store.js` | 5 | `secondary/persistence/candidate-subpath` | `PostgresApiKeyStore`, `hashApiKey`, `generateRawApiKey`, `ApiKeyRecord` |
| `deprecated-transitional` | `./routes/api-keys.js` | 2 | `secondary/security-routes/candidate-subpath` | `createApiKeyRoutes`, `ApiKeyRoutesConfig` |
| `deprecated-transitional` | `./persistence/vector-column.js` | 1 | `secondary/persistence/candidate-subpath` | `vectorColumn` |
| `deprecated-transitional` | `./persistence/vector-ops.js` | 4 | `secondary/persistence/candidate-subpath` | `cosineDistance`, `l2Distance`, `innerProduct`, `toVector` |
| `deprecated-transitional` | `./persistence/run-trace-store.js` | 7 | `secondary/persistence/candidate-subpath` | `InMemoryRunTraceStore`, `computeStepDistribution`, `TraceStep`, `RunTrace` |
| `deprecated-transitional` | `./persistence/drizzle-run-trace-store.js` | 1 | `secondary/persistence/candidate-subpath` | `DrizzleRunTraceStore` |
| `deprecated-transitional` | `./persistence/benchmark-run-store.js` | 5 | `secondary/persistence/candidate-subpath` | `InMemoryBenchmarkRunStore`, `BenchmarkRunRecord`, `BenchmarkBaselineRecord`, `BenchmarkCompareRecord` |
| `deprecated-transitional` | `./persistence/eval-run-store.js` | 8 | `secondary/persistence/candidate-subpath` | `InMemoryEvalRunStore`, `EvalRunErrorRecord`, `EvalRunAttemptRecord`, `EvalRunRecord` |
| `deprecated-transitional` | `./routes/run-trace.js` | 2 | `secondary/trace-routes/candidate-subpath` | `createRunTraceRoutes`, `RunTraceRouteConfig` |
| `stable` | `./middleware/auth.js` | 2 | `stable/middleware/keep-root` | `authMiddleware`, `AuthConfig` |
| `stable` | `./middleware/rate-limiter.js` | 3 | `stable/middleware/keep-root` | `rateLimiterMiddleware`, `TokenBucketLimiter`, `RateLimiterConfig` |
| `stable` | `./middleware/identity.js` | 4 | `stable/middleware/keep-root` | `identityMiddleware`, `getForgeIdentity`, `getForgeCapabilities`, `IdentityMiddlewareConfig` |
| `stable` | `./middleware/capability-guard.js` | 1 | `stable/middleware/keep-root` | `capabilityGuard` |
| `stable` | `./middleware/rbac.js` | 14 | `stable/middleware/keep-root` | `rbacMiddleware`, `rbacGuard`, `hasPermission`, `resolveRoutePermission` |
| `stable` | `./middleware/tenant-scope.js` | 3 | `stable/middleware/keep-root` | `tenantScopeMiddleware`, `getTenantId`, `TenantScopeConfig` |
| `stable` | `./queue/run-queue.js` | 7 | `stable/queue/keep-root` | `InMemoryRunQueue`, `RunQueue`, `RunJob`, `RunQueueConfig` |
| `stable` | `./queue/bullmq-run-queue.js` | 2 | `stable/queue/keep-root` | `BullMQRunQueue`, `BullMQRunQueueConfig` |
| `stable` | `./lifecycle/graceful-shutdown.js` | 3 | `stable/lifecycle/keep-root` | `GracefulShutdown`, `ShutdownConfig`, `ShutdownState` |
| `deprecated-transitional` | `./lifecycle/human-contact-timeout.js` | 2 | `secondary/lifecycle/candidate-subpath` | `HumanContactTimeoutScheduler`, `HumanContactTimeoutConfig` |
| `deprecated-transitional` | `@dzupagent/eval-contracts` | 7 | `secondary/evals/candidate-subpath` | `EvalOrchestratorLike`, `BenchmarkOrchestratorLike`, `EvalExecutionTarget`, `EvalExecutionContext` |
| `deprecated-transitional` | `./services/agent-control-plane-service.js` | 2 | `secondary/control-plane/candidate-subpath` | `AgentControlPlaneService`, `AgentControlPlaneServiceConfig` |
| `deprecated-transitional` | `./services/executable-agent-resolver.js` | 3 | `secondary/control-plane/candidate-subpath` | `ControlPlaneExecutableAgentResolver`, `AgentStoreExecutableAgentResolver`, `ExecutableAgentResolver` |
| `stable` | `./ws/event-bridge.js` | 4 | `stable/realtime/keep-root` | `EventBridge`, `WSClient`, `ClientFilter`, `EventBridgeConfig` |
| `stable` | `./ws/control-protocol.js` | 6 | `stable/realtime/keep-root` | `createWsControlHandler`, `WSControlClientMessage`, `WSControlServerMessage`, `WSControlHandlerOptions` |
| `stable` | `./ws/authorization.js` | 3 | `stable/realtime/keep-root` | `createScopedAuthorizeFilter`, `WSClientScope`, `ScopedAuthorizeFilterOptions` |
| `stable` | `./ws/scope-registry.js` | 1 | `stable/realtime/keep-root` | `WSClientScopeRegistry` |
| `stable` | `./ws/scoped-control-handler.js` | 2 | `stable/realtime/keep-root` | `createScopedWsControlHandler`, `ScopedWsControlHandlerOptions` |
| `stable` | `./ws/session-manager.js` | 2 | `stable/realtime/keep-root` | `WSSessionManager`, `WSSessionManagerOptions` |
| `stable` | `./ws/node-adapter.js` | 3 | `stable/realtime/keep-root` | `attachNodeWsSession`, `NodeWSLike`, `AttachNodeWsSessionOptions` |
| `stable` | `./ws/node-upgrade-handler.js` | 4 | `stable/realtime/keep-root` | `createNodeWsUpgradeHandler`, `createPathUpgradeGuard`, `NodeWebSocketServerLike`, `NodeWsUpgradeHandlerOptions` |
| `stable` | `./events/event-gateway.js` | 8 | `stable/realtime/keep-root` | `InMemoryEventGateway`, `EventGateway`, `EventEnvelope`, `EventSubscription` |
| `deprecated-transitional` | `./notifications/notifier.js` | 7 | `experimental/notifications/candidate-subpath` | `Notifier`, `classifyEvent`, `Notification`, `NotificationChannel` |
| `deprecated-transitional` | `./notifications/channels/webhook-channel.js` | 2 | `experimental/notifications/candidate-subpath` | `WebhookChannel`, `WebhookChannelConfig` |
| `deprecated-transitional` | `./notifications/channels/console-channel.js` | 1 | `experimental/notifications/candidate-subpath` | `ConsoleChannel` |
| `deprecated-transitional` | `./notifications/channels/slack-channel.js` | 2 | `experimental/notifications/candidate-subpath` | `SlackNotificationChannel`, `SlackNotificationChannelConfig` |
| `deprecated-transitional` | `./notifications/channels/email-webhook-channel.js` | 2 | `experimental/notifications/candidate-subpath` | `EmailWebhookNotificationChannel`, `EmailWebhookNotificationChannelConfig` |
| `deprecated-transitional` | `./notifications/mail-rate-limiter.js` | 5 | `experimental/notifications/candidate-subpath` | `MailRateLimiter`, `MailRateLimitError`, `DEFAULT_CAPACITY`, `DEFAULT_REFILL_PER_MINUTE` |
| `deprecated-transitional` | `./notifications/mail-dlq-worker.js` | 4 | `experimental/notifications/candidate-subpath` | `MailDlqWorker`, `DEFAULT_DLQ_WORKER_INTERVAL_MS`, `DEFAULT_DLQ_WORKER_BATCH_SIZE`, `MailDlqWorkerConfig` |
| `internal-only-candidate` | `./persistence/drizzle-dlq-store.js` | 6 | `internal/persistence/remove-root` | `DrizzleDlqStore`, `DLQ_INITIAL_BACKOFF_MS`, `MAX_DLQ_ATTEMPTS`, `computeNextRetryDelayMs` |
| `internal-only-candidate` | `./persistence/drizzle-mailbox-store.js` | 2 | `internal/persistence/remove-root` | `DrizzleMailboxStoreOptions`, `DrizzleMailboxStore` |
| `deprecated-transitional` | `./a2a/index.js` | 15 | `experimental/a2a/candidate-subpath` | `buildAgentCard`, `InMemoryA2ATaskStore`, `DrizzleA2ATaskStore`, `createA2ARoutes` |
| `deprecated-transitional` | `./routes/marketplace.js` | 2 | `experimental/marketplace/candidate-subpath` | `createMarketplaceRoutes`, `MarketplaceRouteConfig` |
| `deprecated-transitional` | `./marketplace/index.js` | 10 | `experimental/marketplace/candidate-subpath` | `InMemoryCatalogStore`, `DrizzleCatalogStore`, `CatalogNotFoundError`, `CatalogSlugConflictError` |
| `deprecated-transitional` | `./routes/memory-sync.js` | 5 | `experimental/memory/candidate-subpath` | `createMemorySyncRoutes`, `createMemorySyncHandler`, `MemorySyncRouteConfig`, `SyncWebSocket` |
| `deprecated-transitional` | `./triggers/index.js` | 6 | `experimental/triggers/candidate-subpath` | `TriggerManager`, `TriggerType`, `TriggerConfig`, `CronTriggerConfig` |
| `deprecated-transitional` | `./triggers/trigger-store.js` | 4 | `experimental/triggers/candidate-subpath` | `InMemoryTriggerStore`, `DrizzleTriggerStore`, `TriggerStore`, `TriggerConfigRecord` |
| `deprecated-transitional` | `./routes/triggers.js` | 2 | `experimental/triggers/candidate-subpath` | `createTriggerRoutes`, `TriggerRouteConfig` |
| `deprecated-transitional` | `./routes/schedules.js` | 2 | `experimental/triggers/candidate-subpath` | `createScheduleRoutes`, `ScheduleRouteConfig` |
| `deprecated-transitional` | `./schedules/schedule-store.js` | 4 | `experimental/triggers/candidate-subpath` | `InMemoryScheduleStore`, `DrizzleScheduleStore`, `ScheduleStore`, `ScheduleRecord` |
| `deprecated-transitional` | `./routes/personas.js` | 2 | `experimental/personas/candidate-subpath` | `createPersonaRoutes`, `PersonaRouteConfig` |
| `deprecated-transitional` | `./routes/prompts.js` | 2 | `experimental/prompts/candidate-subpath` | `createPromptRoutes`, `PromptRouteConfig` |
| `deprecated-transitional` | `./prompts/prompt-store.js` | 4 | `experimental/prompts/candidate-subpath` | `InMemoryPromptStore`, `PromptStore`, `PromptVersionRecord`, `PromptStatus` |
| `deprecated-transitional` | `./personas/persona-store.js` | 3 | `experimental/personas/candidate-subpath` | `InMemoryPersonaStore`, `PersonaStore`, `PersonaRecord` |
| `deprecated-transitional` | `./personas/persona-resolver.js` | 2 | `experimental/personas/candidate-subpath` | `createPersonaStoreResolver`, `PersonaStoreResolver` |
| `deprecated-transitional` | `./routes/presets.js` | 2 | `experimental/presets/candidate-subpath` | `createPresetRoutes`, `PresetRouteConfig` |
| `deprecated-transitional` | `./routes/reflections.js` | 2 | `experimental/reflections/candidate-subpath` | `createReflectionRoutes`, `ReflectionRouteConfig` |
| `internal-only-candidate` | `./persistence/drizzle-reflection-store.js` | 1 | `internal/persistence/remove-root` | `DrizzleReflectionStore` |
| `deprecated-transitional` | `./routes/mailbox.js` | 2 | `experimental/notifications/candidate-subpath` | `createMailboxRoutes`, `MailboxRouteConfig` |
| `internal-only-candidate` | `./persistence/drizzle-cluster-store.js` | 5 | `internal/persistence/remove-root` | `InMemoryClusterStore`, `DrizzleClusterStore`, `ClusterStore`, `ClusterRecord` |
| `deprecated-transitional` | `./routes/clusters.js` | 2 | `experimental/clusters/candidate-subpath` | `createClusterRoutes`, `ClusterRouteConfig` |
| `deprecated-transitional` | `./routes/openai-compat/index.js` | 26 | `secondary/compat/candidate-subpath` | `OpenAICompletionMapper`, `createOpenAICompatCompletionsRoute`, `createModelsRoute`, `openaiAuthMiddleware` |
| `stable` | `./platforms/lambda.js` | 1 | `stable/platforms/keep-root` | `toLambdaHandler` |
| `stable` | `./platforms/vercel.js` | 1 | `stable/platforms/keep-root` | `toVercelHandler` |
| `stable` | `./platforms/cloudflare.js` | 1 | `stable/platforms/keep-root` | `toCloudflareHandler` |
| `internal-only-candidate` | `./cli/plugins-command.js` | 4 | `internal/cli/remove-root` | `listPlugins`, `addPlugin`, `removePlugin`, `PluginInfo` |
| `internal-only-candidate` | `./cli/dev-command.js` | 3 | `internal/cli/remove-root` | `createDevCommand`, `DevCommandConfig`, `DevCommandHandle` |
| `internal-only-candidate` | `./cli/trace-printer.js` | 1 | `internal/cli/remove-root` | `TracePrinter` |
| `internal-only-candidate` | `./cli/config-command.js` | 2 | `internal/cli/remove-root` | `configValidate`, `configShow` |
| `internal-only-candidate` | `./cli/memory-command.js` | 5 | `internal/cli/remove-root` | `memoryBrowse`, `memorySearch`, `MemoryBrowseOptions`, `MemoryBrowseEntry` |
| `internal-only-candidate` | `./cli/vectordb-command.js` | 3 | `internal/cli/remove-root` | `vectordbStatus`, `formatVectorDBStatus`, `VectorDBStatusResult` |
| `deprecated-transitional` | `./cli/doctor.js` | 9 | `secondary/ops/candidate-subpath` | `runDoctor`, `formatDoctorReport`, `formatDoctorReportJSON`, `CheckStatus` |
| `internal-only-candidate` | `./cli/marketplace-command.js` | 6 | `internal/cli/remove-root` | `searchMarketplace`, `filterByCategory`, `formatPluginTable`, `createSampleRegistry` |
| `internal-only-candidate` | `./cli/scorecard-command.js` | 4 | `internal/cli/remove-root` | `runScorecard`, `parseScorecardArgs`, `ScorecardCommandOptions`, `ScorecardCommandResult` |
| `deprecated-transitional` | `./scorecard/index.js` | 14 | `secondary/ops/candidate-subpath` | `IntegrationScorecard`, `ScorecardReport`, `ScorecardCategory`, `ScorecardCheck` |
| `deprecated-transitional` | `./runtime/consolidation-scheduler.js` | 4 | `secondary/runtime/candidate-subpath` | `ConsolidationScheduler`, `ConsolidationTask`, `ConsolidationReport`, `ConsolidationSchedulerConfig` |
| `deprecated-transitional` | `./runtime/sleep-consolidation-task.js` | 4 | `experimental/runtime/candidate-subpath` | `createSleepConsolidationTask`, `SleepConsolidationTaskConfig`, `SleepConsolidatorLike`, `SleepConsolidationReportLike` |
| `deprecated-transitional` | `./runtime/memory-quota-manager.js` | 1 | `experimental/runtime/candidate-subpath` | `InMemoryQuotaManager` |
| `deprecated-transitional` | `./runtime/run-worker.js` | 9 | `secondary/runtime/candidate-subpath` | `startRunWorker`, `RunExecutionContext`, `RunExecutor`, `StartRunWorkerOptions` |
| `deprecated-transitional` | `./runtime/default-run-executor.js` | 1 | `secondary/runtime/candidate-subpath` | `createDefaultRunExecutor` |
| `deprecated-transitional` | `./runtime/dzip-agent-run-executor.js` | 2 | `secondary/runtime/candidate-subpath` | `createDzupAgentRunExecutor`, `DzupAgentRunExecutorOptions` |
| `deprecated-transitional` | `./runtime/resource-quota.js` | 6 | `secondary/runtime/candidate-subpath` | `QuotaExceededError`, `ResourceDimensions`, `ResourceQuota`, `ResourceReservation` |
| `deprecated-transitional` | `./runtime/retrieval-feedback-hook.js` | 4 | `secondary/runtime/candidate-subpath` | `reportRetrievalFeedback`, `mapScoreToQuality`, `RetrievalFeedbackSink`, `RetrievalFeedbackHookConfig` |
| `deprecated-transitional` | `./runtime/tool-resolver.js` | 13 | `secondary/runtime/candidate-subpath` | `resolveAgentTools`, `ToolResolutionError`, `getToolProfileConfig`, `ToolResolverContext` |
| `deprecated-transitional` | `./runtime/utils.js` | 1 | `secondary/runtime/candidate-subpath` | `isStructuredResult` |
| `deprecated-transitional` | `./deploy/docker-generator.js` | 4 | `experimental/deploy/candidate-subpath` | `generateDockerfile`, `generateDockerCompose`, `generateDockerignore`, `DockerConfig` |
| `deprecated-transitional` | `./deploy/health-checker.js` | 2 | `experimental/deploy/candidate-subpath` | `checkHealth`, `HealthCheckResult` |
| `deprecated-transitional` | `./deploy/confidence-calculator.js` | 1 | `experimental/deploy/candidate-subpath` | `DeployConfidenceCalculator` |
| `deprecated-transitional` | `./deploy/deploy-gate.js` | 1 | `experimental/deploy/candidate-subpath` | `DeployGate` |
| `deprecated-transitional` | `./deploy/deployment-history.js` | 3 | `experimental/deploy/candidate-subpath` | `DeploymentHistory`, `generateDeploymentId`, `resetIdCounter` |
| `deprecated-transitional` | `./deploy/confidence-types.js` | 6 | `experimental/deploy/candidate-subpath` | `GateDecision`, `ConfidenceSignal`, `DeployConfidence`, `ConfidenceThresholds` |
| `deprecated-transitional` | `./deploy/deployment-history-store.js` | 7 | `experimental/deploy/candidate-subpath` | `PostgresDeploymentHistoryStore`, `InMemoryDeploymentHistoryStore`, `DeploymentHistoryStoreInterface`, `DeploymentHistoryRecord` |
| `deprecated-transitional` | `./deploy/signal-checkers.js` | 8 | `experimental/deploy/candidate-subpath` | `checkRecoveryCopilotConfigured`, `checkRollbackAvailable`, `computeAllSignals`, `AgentConfigLike` |
| `deprecated-transitional` | `./routes/deploy.js` | 2 | `experimental/deploy/candidate-subpath` | `createDeployRoutes`, `DeployRouteConfig` |
| `stable` | `./security/input-guard.js` | 5 | `stable/security/keep-root` | `createInputGuard`, `DEFAULT_MAX_INPUT_LENGTH`, `InputGuard`, `InputGuardConfig` |
| `deprecated-transitional` | `./security/incident-response.js` | 12 | `experimental/security/candidate-subpath` | `IncidentResponseEngine`, `clearIncidentFlags`, `isAgentKilled`, `isToolDisabled` |
| `internal-only-candidate` | `./docs/doc-generator.js` | 3 | `internal/docs/remove-root` | `DocGenerator`, `DocGeneratorConfig`, `DocGeneratorContext` |
| `internal-only-candidate` | `./docs/agent-doc.js` | 2 | `internal/docs/remove-root` | `renderAgentDoc`, `AgentDocInput` |
| `internal-only-candidate` | `./docs/tool-doc.js` | 2 | `internal/docs/remove-root` | `renderToolDoc`, `ToolDocInput` |
| `internal-only-candidate` | `./docs/pipeline-doc.js` | 4 | `internal/docs/remove-root` | `renderPipelineDoc`, `PipelineDocInput`, `PipelineDocNode`, `PipelineDocEdge` |
| `deprecated-transitional` | `./persistence/postgres-registry.js` | 5 | `experimental/registry/candidate-subpath` | `PostgresRegistry`, `InMemoryRegistryStore`, `PostgresRegistryConfig`, `RegistryStore` |
| `deprecated-transitional` | `./registry/health-monitor.js` | 3 | `experimental/registry/candidate-subpath` | `HealthMonitor`, `HealthMonitorConfig`, `ProbeResult` |
| `deprecated-transitional` | `./routes/registry.js` | 2 | `experimental/registry/candidate-subpath` | `createRegistryRoutes`, `RegistryRouteConfig` |
| `stable` | `./streaming/sse-streaming-adapter.js` | 3 | `stable/realtime/keep-root` | `streamRunHandleToSSE`, `SSEStreamLike`, `StreamRunHandleToSSEOptions` |
| `internal-only-candidate` | `<local>:dzupagent_SERVER_VERSION` | 1 | `internal/versioning/remove-root` | `dzupagent_SERVER_VERSION` |


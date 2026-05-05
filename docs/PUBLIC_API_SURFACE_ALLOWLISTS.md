# Public API Surface Allowlists

Date: 2026-05-05

Generated from package root facades plus `config/public-api-allowlists.json` and `config/server-api-tiers.json`.

## Policy

- `stable` root exports are the semver-facing root package API.
- `deprecated-transitional` root exports remain available for compatibility during the 0.x migration window and should move to explicit subpaths in new code.
- `internal-only-candidate` root exports are accidental or implementation-oriented exposures that remain temporarily visible only for staged removal.
- New consumers should prefer the listed subpaths for domain-specific imports.
- Every current root export source must match exactly one allowlist rule; unreviewed sources fail `yarn check:server-api-surface`.

## @dzupagent/security

Root index: `packages/security/src/index.ts`

- Stable root sources: `3`
- Deprecated transitional root sources: `0`
- Internal-only root candidates: `0`
- Migration window: Security package root exports are the primary consumption surface; all exports are stable from initial release.

### Stable Subpaths

No stable subpaths configured.

### Root Allowlist

| Root Class | Source Module | Export Count | Matched Rule | Sample Exports |
| --- | --- | ---: | --- | --- |
| `stable` | `./prompt-injection/index.js` | 7 | `exact:./prompt-injection/index.js` | `INJECTION_PATTERNS`, `INJECTION_REDACTION`, `PromptInjectionDetector`, `PromptInjectionBlockedError` |
| `stable` | `./pii/index.js` | 3 | `exact:./pii/index.js` | `PII_PATTERNS`, `PiiDetector`, `PiiScanResult` |
| `stable` | `./content-scanner.js` | 6 | `exact:./content-scanner.js` | `ContentScanner`, `ContentScannerConfig`, `ContentScanResult`, `ContentScanVerdict` |

## @dzupagent/core

Root index: `packages/core/src/index.ts`

- Stable root sources: `42`
- Deprecated transitional root sources: `82`
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
| `stable` | `./events/event-bus.js` | 3 | `prefix:./events/` | `createEventBus`, `typedEmit`, `DzupEventBus` |
| `stable` | `./events/event-types.js` | 8 | `prefix:./events/` | `AdapterProgressDzupEvent`, `AdapterRuntimeDzupEvent`, `DzupEvent`, `DzupEventOf` |
| `stable` | `./events/degraded-operation.js` | 1 | `prefix:./events/` | `emitDegradedOperation` |
| `stable` | `./events/tool-event-correlation.js` | 3 | `prefix:./events/` | `requireTerminalToolExecutionRunId`, `TerminalToolExecutionRunIdOptions`, `TerminalToolEventType` |
| `stable` | `./events/agent-bus.js` | 3 | `prefix:./events/` | `AgentBus`, `AgentMessage`, `AgentMessageHandler` |
| `stable` | `./hooks/hook-types.js` | 2 | `prefix:./hooks/` | `AgentHooks`, `HookContext` |
| `stable` | `./hooks/hook-runner.js` | 3 | `prefix:./hooks/` | `runHooks`, `runModifierHook`, `mergeHooks` |
| `stable` | `./plugin/plugin-types.js` | 2 | `prefix:./plugin/` | `DzupPlugin`, `PluginContext` |
| `stable` | `./plugin/plugin-registry.js` | 1 | `prefix:./plugin/` | `PluginRegistry` |
| `stable` | `./plugin/plugin-discovery.js` | 6 | `prefix:./plugin/` | `discoverPlugins`, `validateManifest`, `resolvePluginOrder`, `PluginManifest` |
| `stable` | `./plugin/plugin-manifest.js` | 2 | `prefix:./plugin/` | `createManifest`, `serializeManifest` |
| `stable` | `./llm/model-registry.js` | 2 | `prefix:./llm/` | `ModelRegistry`, `ModelFallbackCandidate` |
| `stable` | `./llm/model-config.js` | 9 | `prefix:./llm/` | `KnownLLMProvider`, `LLMProviderConfig`, `LLMProviderName`, `ModelTier` |
| `stable` | `./llm/circuit-breaker.js` | 4 | `prefix:./llm/` | `CircuitBreaker`, `KeyedCircuitBreaker`, `CircuitBreakerConfig`, `CircuitState` |
| `deprecated-transitional` | `./rate-limit/token-bucket.js` | 2 | `exact:./rate-limit/token-bucket.js` | `TokenBucket`, `TokenBucketConfig` |
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
| `deprecated-transitional` | `./mcp/mcp-server.js` | 12 | `prefix:./mcp/` | `DzupAgentMCPServer`, `isMCPRequest`, `MCPServerOptions`, `MCPExposedTool` |
| `deprecated-transitional` | `./mcp/mcp-types.js` | 7 | `prefix:./mcp/` | `MCPTransport`, `MCPServerConfig`, `MCPToolDescriptor`, `MCPToolParameter` |
| `deprecated-transitional` | `./mcp/mcp-reliability.js` | 3 | `prefix:./mcp/` | `McpReliabilityManager`, `McpServerHealth`, `McpReliabilityConfig` |
| `deprecated-transitional` | `./mcp/mcp-manager.js` | 3 | `prefix:./mcp/` | `InMemoryMcpManager`, `McpManager`, `InMemoryMcpManagerOptions` |
| `deprecated-transitional` | `./mcp/mcp-registry-types.js` | 7 | `prefix:./mcp/` | `McpServerDefinitionSchema`, `McpProfileSchema`, `McpServerDefinition`, `McpProfile` |
| `deprecated-transitional` | `./mcp/mcp-security.js` | 2 | `prefix:./mcp/` | `validateMcpExecutablePath`, `sanitizeMcpEnv` |
| `stable` | `./security/outbound-url-policy.js` | 8 | `prefix:./security/` | `fetchWithOutboundUrlPolicy`, `isPublicIpAddress`, `validateOutboundUrl`, `validateOutboundUrlSyntax` |
| `deprecated-transitional` | `./mcp/mcp-resources.js` | 2 | `prefix:./mcp/` | `MCPResourceClient`, `MCPResourceClientConfig` |
| `deprecated-transitional` | `./mcp/mcp-resource-types.js` | 5 | `prefix:./mcp/` | `MCPResource`, `MCPResourceTemplate`, `MCPResourceContent`, `ResourceSubscription` |
| `deprecated-transitional` | `./mcp/mcp-prompt-types.js` | 9 | `prefix:./mcp/` | `MCPPromptArgument`, `MCPPromptDescriptor`, `MCPPromptGetResult`, `MCPPromptHandler` |
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
| `deprecated-transitional` | `./structured/index.js` | 7 | `prefix:./structured/` | `JsonOutputSchema`, `RegexOutputSchema`, `extractJsonFromMarkdown`, `toSchemaRef` |
| `deprecated-transitional` | `./vectordb/index.js` | 45 | `prefix:./vectordb/` | `DistanceMetric`, `CollectionConfig`, `VectorEntry`, `VectorQuery` |
| `deprecated-transitional` | `./tools/connector-contract.js` | 5 | `prefix:./tools/` | `BaseConnectorTool`, `BaseConnectorToolLike`, `isBaseConnectorTool`, `normalizeBaseConnectorTool` |
| `deprecated-transitional` | `./tools/create-tool.js` | 2 | `prefix:./tools/` | `createForgeTool`, `ForgeToolConfig` |
| `deprecated-transitional` | `./tools/tool-stats-tracker.js` | 5 | `prefix:./tools/` | `ToolStatsTracker`, `ToolCallRecord`, `ToolStats`, `ToolRanking` |
| `deprecated-transitional` | `./tools/tool-governance.js` | 9 | `prefix:./tools/` | `ToolGovernance`, `ToolGovernanceConfig`, `ToolValidationResult`, `ToolAuditHandler` |
| `deprecated-transitional` | `./tools/human-contact-types.js` | 17 | `prefix:./tools/` | `ContactType`, `ContactChannel`, `ApprovalRequest`, `ClarificationRequest` |
| `deprecated-transitional` | `./telemetry/trace-propagation.js` | 5 | `prefix:./telemetry/` | `injectTraceContext`, `extractTraceContext`, `formatTraceparent`, `parseTraceparent` |
| `deprecated-transitional` | `./utils/logger.js` | 3 | `prefix:./utils/` | `defaultLogger`, `noopLogger`, `FrameworkLogger` |
| `deprecated-transitional` | `./utils/backoff.js` | 2 | `prefix:./utils/` | `calculateBackoff`, `BackoffConfig` |
| `deprecated-transitional` | `./utils/hash.js` | 1 | `prefix:./utils/` | `hashToolInput` |
| `deprecated-transitional` | `./utils/exact-optional.js` | 2 | `prefix:./utils/` | `omitUndefined`, `OmitUndefined` |
| `deprecated-transitional` | `./utils/event-record.js` | 4 | `prefix:./utils/` | `getString`, `getNumber`, `getObject`, `toJsonString` |
| `deprecated-transitional` | `./guardrails/stuck-detector.js` | 3 | `prefix:./guardrails/` | `StuckDetector`, `StuckStatus`, `StuckDetectorConfig` |
| `stable` | `<local>:dzupagent_CORE_VERSION` | 1 | `exact:<local>:dzupagent_CORE_VERSION` | `dzupagent_CORE_VERSION` |

## @dzupagent/agent

Root index: `packages/agent/src/index.ts`

- Stable root sources: `13`
- Deprecated transitional root sources: `110`
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
| `deprecated-transitional` | `./agent/production-tool-governance-preset.js` | 6 | `prefix:./agent/` | `createAllowlistPermissionPolicy`, `createProductionToolGovernancePreset`, `withProductionToolGovernancePreset`, `ProductionToolGovernancePreset` |
| `deprecated-transitional` | `./agent/tool-loop.js` | 5 | `prefix:./agent/` | `runToolLoop`, `ToolLoopConfig`, `ToolLoopResult`, `ToolStat` |
| `deprecated-transitional` | `./agent/tool-loop/output-validator.js` | 3 | `prefix:./agent/` | `ToolOutputValidator`, `ToolOutputSchema`, `ToolOutputValidationResult` |
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
| `stable` | `./workflow/workflow-builder.js` | 5 | `prefix:./workflow/` | `WorkflowBuilder`, `CompiledWorkflow`, `createWorkflow`, `WorkflowConfig` |
| `stable` | `./workflow/workflow-types.js` | 4 | `prefix:./workflow/` | `WorkflowStep`, `WorkflowContext`, `WorkflowEvent`, `MergeStrategy` |
| `deprecated-transitional` | `./orchestration/orchestrator.js` | 4 | `prefix:./orchestration/` | `AgentOrchestrator`, `MergeFn`, `SupervisorConfig`, `SupervisorResult` |
| `deprecated-transitional` | `./orchestration/orchestration-error.js` | 2 | `prefix:./orchestration/` | `OrchestrationError`, `OrchestrationPattern` |
| `deprecated-transitional` | `./orchestration/map-reduce.js` | 5 | `prefix:./orchestration/` | `mapReduce`, `mapReduceMulti`, `MapReduceConfig`, `MapReduceResult` |
| `deprecated-transitional` | `./orchestration/merge-strategies.js` | 7 | `prefix:./orchestration/` | `concatMerge`, `voteMerge`, `numberedMerge`, `jsonArrayMerge` |
| `deprecated-transitional` | `./orchestration/contract-net/contract-net-manager.js` | 1 | `prefix:./orchestration/` | `ContractNetManager` |
| `deprecated-transitional` | `./orchestration/contract-net/bid-strategies.js` | 4 | `prefix:./orchestration/` | `lowestCostStrategy`, `fastestStrategy`, `highestQualityStrategy`, `createWeightedStrategy` |
| `deprecated-transitional` | `./orchestration/contract-net/contract-net-types.js` | 8 | `prefix:./orchestration/` | `ContractNetPhase`, `CallForProposals`, `ContractBid`, `ContractAward` |
| `deprecated-transitional` | `./orchestration/delegating-supervisor.js` | 6 | `prefix:./orchestration/` | `DelegatingSupervisor`, `DelegatingSupervisorConfig`, `TaskAssignment`, `AggregatedDelegationResult` |
| `deprecated-transitional` | `./orchestration/planning-agent.js` | 14 | `prefix:./orchestration/` | `PlanningAgent`, `buildExecutionLevels`, `validatePlanStructure`, `PlanNodeSchema` |
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
| `stable` | `./approval/approval-types.js` | 10 | `prefix:./approval/` | `APPROVAL_PENDING_KEY`, `DEFAULT_APPROVAL_TIMEOUT_MS`, `ApprovalCheckpointStore`, `ApprovalConfig` |
| `stable` | `./approval/approval-errors.js` | 1 | `prefix:./approval/` | `ApprovalSuspendedError` |
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
| `deprecated-transitional` | `./observability/index.js` | 10 | `prefix:./observability/` | `RunMetricsAggregator`, `attachRunMetricsBridge`, `InMemoryAuditStore`, `RunSummaryMetrics` |
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
| `deprecated-transitional` | `./workspace/index.js` | 9 | `prefix:./workspace/` | `SearchResult`, `CommandResult`, `WorkspaceOptions`, `Workspace` |
| `stable` | `<local>:dzupagent_CODEGEN_VERSION` | 1 | `exact:<local>:dzupagent_CODEGEN_VERSION` | `dzupagent_CODEGEN_VERSION` |

## @dzupagent/memory

Root index: `packages/memory/src/index.ts`

- Stable root sources: `25`
- Deprecated transitional root sources: `40`
- Internal-only root candidates: `0`
- Migration window: Root transitional exports remain available through 0.x; new consumers should prefer future memory/retrieval/store subpaths as they are introduced.

### Stable Subpaths

No stable subpaths configured.

### Root Allowlist

| Root Class | Source Module | Export Count | Matched Rule | Sample Exports |
| --- | --- | ---: | --- | --- |
| `stable` | `./store-factory.js` | 3 | `exact:./store-factory.js` | `createStore`, `StoreConfig`, `StoreIndexConfig` |
| `stable` | `./store-capabilities.js` | 1 | `exact:./store-capabilities.js` | `MemoryStoreCapabilities` |
| `stable` | `./memory-service.js` | 1 | `exact:./memory-service.js` | `MemoryService` |
| `deprecated-transitional` | `./in-memory-client.js` | 1 | `exact:./in-memory-client.js` | `InMemoryMemoryClient` |
| `deprecated-transitional` | `./http-client.js` | 3 | `exact:./http-client.js` | `HttpMemoryClient`, `NotImplementedError`, `HttpMemoryClientConfig` |
| `deprecated-transitional` | `./memory-service-adapter.js` | 2 | `exact:./memory-service-adapter.js` | `memoryServiceToClient`, `MemoryServiceLike` |
| `stable` | `./memory-types.js` | 4 | `exact:./memory-types.js` | `NamespaceConfig`, `FormatOptions`, `DecayConfig`, `SemanticStoreAdapter` |
| `deprecated-transitional` | `./decay-engine.js` | 6 | `exact:./decay-engine.js` | `calculateStrength`, `reinforceMemory`, `createDecayMetadata`, `scoreWithDecay` |
| `stable` | `./memory-sanitizer.js` | 3 | `exact:./memory-sanitizer.js` | `sanitizeMemoryContent`, `stripInvisibleUnicode`, `SanitizeResult` |
| `deprecated-transitional` | `./memory-consolidation.js` | 4 | `exact:./memory-consolidation.js` | `consolidateNamespace`, `consolidateAll`, `ConsolidationConfig`, `ConsolidationResult` |
| `deprecated-transitional` | `./semantic-consolidation.js` | 6 | `exact:./semantic-consolidation.js` | `SemanticConsolidator`, `consolidateWithLLM`, `SemanticConsolidationConfig`, `SemanticConsolidationResult` |
| `deprecated-transitional` | `./memory-healer.js` | 7 | `exact:./memory-healer.js` | `findDuplicates`, `findContradictions`, `findStaleRecords`, `healMemory` |
| `stable` | `./working-memory.js` | 2 | `exact:./working-memory.js` | `WorkingMemory`, `WorkingMemoryConfig` |
| `deprecated-transitional` | `./versioned-working-memory.js` | 3 | `exact:./versioned-working-memory.js` | `VersionedWorkingMemory`, `VersionedWorkingMemoryConfig`, `WorkingMemoryDiff` |
| `deprecated-transitional` | `./observation-extractor.js` | 4 | `exact:./observation-extractor.js` | `ObservationExtractor`, `ObservationExtractorConfig`, `Observation`, `ObservationCategory` |
| `deprecated-transitional` | `./memory-aware-extractor.js` | 3 | `exact:./memory-aware-extractor.js` | `MemoryAwareExtractor`, `MemoryAwareExtractorConfig`, `ExtractionResult` |
| `deprecated-transitional` | `./frozen-snapshot.js` | 1 | `exact:./frozen-snapshot.js` | `FrozenMemorySnapshot` |
| `stable` | `./session-search.js` | 5 | `exact:./session-search.js` | `SessionSearch`, `SearchQuery`, `SearchResult`, `SessionSearchConfig` |
| `deprecated-transitional` | `./staged-writer.js` | 4 | `exact:./staged-writer.js` | `StagedWriter`, `StagedRecord`, `MemoryStage`, `StagedWriterConfig` |
| `deprecated-transitional` | `./policy-aware-staged-writer.js` | 2 | `exact:./policy-aware-staged-writer.js` | `PolicyAwareStagedWriter`, `PolicyAwareStagedWriterConfig` |
| `deprecated-transitional` | `./write-policy.js` | 4 | `exact:./write-policy.js` | `defaultWritePolicy`, `composePolicies`, `WritePolicy`, `WriteAction` |
| `stable` | `./retrieval/vector-search.js` | 3 | `prefix:./retrieval/` | `StoreVectorSearch`, `VectorSearchResult`, `VectorSearchProvider` |
| `stable` | `./retrieval/vector-store-search.js` | 1 | `prefix:./retrieval/` | `VectorStoreSearch` |
| `stable` | `./retrieval/fts-search.js` | 2 | `prefix:./retrieval/` | `KeywordFTSSearch`, `FTSSearchResult` |
| `stable` | `./retrieval/graph-search.js` | 2 | `prefix:./retrieval/` | `EntityGraphSearch`, `GraphSearchResult` |
| `stable` | `./retrieval/persistent-graph.js` | 3 | `prefix:./retrieval/` | `PersistentEntityGraph`, `EntityNode`, `GraphTraversalResult` |
| `stable` | `./retrieval/rrf-fusion.js` | 2 | `prefix:./retrieval/` | `fusionSearch`, `FusedResult` |
| `stable` | `./retrieval/adaptive-retriever.js` | 15 | `prefix:./retrieval/` | `AdaptiveRetriever`, `WeightLearner`, `DEFAULT_STRATEGIES`, `classifyIntent` |
| `stable` | `./temporal.js` | 9 | `exact:./temporal.js` | `TemporalMemoryService`, `createTemporalMeta`, `isActive`, `wasActiveAsOf` |
| `stable` | `./scoped-memory.js` | 6 | `exact:./scoped-memory.js` | `ScopedMemoryService`, `createAgentMemories`, `PolicyTemplates`, `MemoryAccessPolicy` |
| `stable` | `./retrieval/void-filter.js` | 4 | `prefix:./retrieval/` | `voidFilter`, `MemoryState`, `VoidFilterConfig`, `VoidFilterResult` |
| `stable` | `./retrieval/hub-dampening.js` | 4 | `prefix:./retrieval/` | `applyHubDampening`, `getAccessCount`, `HubDampenedResult`, `HubDampeningConfig` |
| `stable` | `./retrieval/pagerank.js` | 4 | `prefix:./retrieval/` | `computePPR`, `queryPPR`, `PPRConfig`, `PPRResult` |
| `stable` | `./retrieval/cross-encoder-rerank.js` | 5 | `prefix:./retrieval/` | `rerank`, `createLLMReranker`, `CrossEncoderProvider`, `RerankerConfig` |
| `deprecated-transitional` | `./dual-stream-writer.js` | 4 | `exact:./dual-stream-writer.js` | `DualStreamWriter`, `DualStreamConfig`, `PendingRecord`, `IngestResult` |
| `deprecated-transitional` | `./sleep-consolidator.js` | 5 | `exact:./sleep-consolidator.js` | `SleepConsolidator`, `runSleepConsolidation`, `SleepConsolidationConfig`, `SleepConsolidationReport` |
| `stable` | `./retrieval/community-detector.js` | 4 | `prefix:./retrieval/` | `CommunityDetector`, `MemoryCommunity`, `CommunityDetectorConfig`, `CommunityDetectionResult` |
| `deprecated-transitional` | `./observational-memory.js` | 5 | `exact:./observational-memory.js` | `ObservationalMemory`, `ObservationalMemoryConfig`, `ObservationalMemoryStats`, `ObserverResult` |
| `stable` | `./retrieval/relationship-store.js` | 5 | `prefix:./retrieval/` | `RelationshipStore`, `RelationshipType`, `RelationshipEdge`, `EdgeMetadata` |
| `deprecated-transitional` | `./multi-network-memory.js` | 8 | `exact:./multi-network-memory.js` | `MultiNetworkMemory`, `DEFAULT_NETWORK_CONFIGS`, `MemoryNetwork`, `NetworkConfig` |
| `stable` | `./provenance/index.js` | 8 | `prefix:./provenance/` | `ProvenanceWriter`, `createProvenance`, `extractProvenance`, `createContentHash` |
| `deprecated-transitional` | `./convention/index.js` | 10 | `prefix:./convention/` | `ConventionExtractor`, `ALL_CONVENTION_CATEGORIES`, `ConventionCategory`, `DetectedConvention` |
| `deprecated-transitional` | `./causal/index.js` | 5 | `prefix:./causal/` | `CausalGraph`, `CausalRelation`, `CausalNode`, `CausalTraversalOptions` |
| `deprecated-transitional` | `./mcp-memory-server.js` | 5 | `exact:./mcp-memory-server.js` | `MCPMemoryHandler`, `MCP_MEMORY_TOOLS`, `MCPToolDefinition`, `MCPToolResult` |
| `deprecated-transitional` | `./encryption/index.js` | 6 | `prefix:./encryption/` | `EnvKeyProvider`, `EncryptedMemoryService`, `EncryptedEnvelope`, `EncryptionKeyDescriptor` |
| `stable` | `./agent-file/index.js` | 14 | `prefix:./agent-file/` | `AgentFileExporter`, `AgentFileExporterConfig`, `ExportOptions`, `AgentFileImporter` |
| `deprecated-transitional` | `./crdt/index.js` | 8 | `prefix:./crdt/` | `HLC`, `CRDTResolver`, `HLCTimestamp`, `LWWRegister` |
| `deprecated-transitional` | `./sharing/index.js` | 13 | `prefix:./sharing/` | `MemorySpaceManager`, `MemorySpaceManagerConfig`, `SpacePermission`, `ConflictStrategy` |
| `deprecated-transitional` | `./multi-modal/index.js` | 7 | `prefix:./multi-modal/` | `MultiModalMemoryService`, `InMemoryAttachmentStorage`, `inferAttachmentType`, `AttachmentType` |
| `deprecated-transitional` | `./consolidation-types.js` | 7 | `exact:./consolidation-types.js` | `parseMemoryEntry`, `MemoryEntry`, `LessonDedupResult`, `DedupLesson` |
| `deprecated-transitional` | `./lesson-dedup.js` | 1 | `exact:./lesson-dedup.js` | `dedupLessons` |
| `deprecated-transitional` | `./convention/convention-extractor-m4.js` | 1 | `prefix:./convention/` | `extractConventions` |
| `deprecated-transitional` | `./staleness-pruner.js` | 7 | `exact:./staleness-pruner.js` | `pruneStaleMemories`, `pruneStaleMemoriesWithGraph`, `computeStaleness`, `StalenessPruner` |
| `deprecated-transitional` | `./shared-namespace.js` | 7 | `exact:./shared-namespace.js` | `SharedMemoryNamespace`, `SharedEntry`, `SharedNamespaceConfig`, `AuditEntry` |
| `deprecated-transitional` | `./vector-clock.js` | 2 | `exact:./vector-clock.js` | `VectorClock`, `VectorClockComparison` |
| `deprecated-transitional` | `./sync/index.js` | 24 | `prefix:./sync/` | `MerkleDigest`, `SyncProtocol`, `SyncSession`, `WebSocketSyncTransport` |
| `deprecated-transitional` | `./rule-engine.js` | 7 | `exact:./rule-engine.js` | `DynamicRuleEngine`, `Rule`, `RuleSource`, `RuleEngineConfig` |
| `deprecated-transitional` | `./lesson-pipeline.js` | 8 | `exact:./lesson-pipeline.js` | `LessonPipeline`, `Lesson`, `LessonType`, `LessonEvidence` |
| `deprecated-transitional` | `./skill-acquisition.js` | 9 | `exact:./skill-acquisition.js` | `SkillAcquisitionEngine`, `AcquiredSkill`, `SkillApplicationType`, `SkillEvidence` |
| `deprecated-transitional` | `./skill-packs.js` | 4 | `exact:./skill-packs.js` | `SkillPackLoader`, `BUILT_IN_PACKS`, `SkillPack`, `SkillPackEntry` |
| `deprecated-transitional` | `./memory-integrator.js` | 3 | `exact:./memory-integrator.js` | `MemoryIntegrator`, `MemoryContext`, `MemoryIntegratorConfig` |
| `deprecated-transitional` | `./tenant-scoped-store.js` | 3 | `exact:./tenant-scoped-store.js` | `TenantScopedStore`, `TenantScopedStoreConfig`, `TenantSearchResult` |
| `deprecated-transitional` | `./shared/reference-tracker.js` | 2 | `prefix:./shared/` | `InMemoryReferenceTracker`, `ReferenceCountEntry` |
| `stable` | `./provenance/redis-reference-tracker.js` | 7 | `prefix:./provenance/` | `RedisReferenceTracker`, `createReferenceTracker`, `RedisReferenceTrackerOptions`, `RedisClientLike` |
| `deprecated-transitional` | `./graph/index.js` | 14 | `prefix:./graph/` | `TeamMemoryGraph`, `TrustScorer`, `ConflictResolver`, `GraphQuery` |

## @dzupagent/context

Root index: `packages/context/src/index.ts`

- Stable root sources: `15`
- Deprecated transitional root sources: `0`
- Internal-only root candidates: `0`
- Migration window: Context root exports are currently the contracted package surface; add allowlist rules before exposing new root modules.

### Stable Subpaths

No stable subpaths configured.

### Root Allowlist

| Root Class | Source Module | Export Count | Matched Rule | Sample Exports |
| --- | --- | ---: | --- | --- |
| `stable` | `./message-manager.js` | 6 | `exact:./message-manager.js` | `shouldSummarize`, `summarizeAndTrim`, `formatSummaryContext`, `pruneToolResults` |
| `stable` | `./auto-compress.js` | 4 | `exact:./auto-compress.js` | `autoCompress`, `FrozenSnapshot`, `AutoCompressConfig`, `CompressResult` |
| `stable` | `./snapshot-builder.js` | 3 | `exact:./snapshot-builder.js` | `buildFrozenSnapshot`, `MemoryServiceLike`, `BuildFrozenSnapshotOptions` |
| `stable` | `./extraction-bridge.js` | 2 | `exact:./extraction-bridge.js` | `createExtractionHook`, `MessageExtractionFn` |
| `stable` | `./completeness-scorer.js` | 3 | `exact:./completeness-scorer.js` | `scoreCompleteness`, `CompletenessResult`, `DescriptionInput` |
| `stable` | `./context-eviction.js` | 3 | `exact:./context-eviction.js` | `evictIfNeeded`, `EvictionConfig`, `EvictionResult` |
| `stable` | `./system-reminder.js` | 3 | `exact:./system-reminder.js` | `SystemReminderInjector`, `SystemReminderConfig`, `ReminderContent` |
| `stable` | `./phase-window.js` | 7 | `exact:./phase-window.js` | `PhaseAwareWindowManager`, `DEFAULT_PHASES`, `ConversationPhase`, `PhaseConfig` |
| `stable` | `./progressive-compress.js` | 6 | `exact:./progressive-compress.js` | `compressToLevel`, `compressToBudget`, `selectCompressionLevel`, `CompressionLevel` |
| `stable` | `./prompt-cache.js` | 4 | `exact:./prompt-cache.js` | `applyAnthropicCacheControl`, `applyCacheBreakpoints`, `CacheStrategy`, `CacheBreakpointOptions` |
| `stable` | `./prompt-cache-injector.js` | 1 | `exact:./prompt-cache-injector.js` | `injectPromptCacheMarkers` |
| `stable` | `./context-transfer.js` | 6 | `exact:./context-transfer.js` | `ContextTransferService`, `IntentContext`, `IntentType`, `ContextTransferConfig` |
| `stable` | `./token-lifecycle.js` | 8 | `exact:./token-lifecycle.js` | `TokenLifecycleManager`, `createTokenBudget`, `TokenBudget`, `TokenPhaseUsage` |
| `stable` | `./char-estimate-counter.js` | 1 | `exact:./char-estimate-counter.js` | `CharEstimateCounter` |
| `stable` | `./tiktoken-counter.js` | 1 | `exact:./tiktoken-counter.js` | `TiktokenCounter` |

## @dzupagent/rag

Root index: `packages/rag/src/index.ts`

- Stable root sources: `9`
- Deprecated transitional root sources: `3`
- Internal-only root candidates: `0`
- Migration window: Root transitional exports remain available through 0.x; provider-specific RAG wiring should move to explicit provider subpaths before a future 1.0 root contraction.

### Stable Subpaths

No stable subpaths configured.

### Root Allowlist

| Root Class | Source Module | Export Count | Matched Rule | Sample Exports |
| --- | --- | ---: | --- | --- |
| `stable` | `./chunker.js` | 2 | `exact:./chunker.js` | `SmartChunker`, `DEFAULT_CHUNKING_CONFIG` |
| `stable` | `./retriever.js` | 3 | `exact:./retriever.js` | `HybridRetriever`, `DEFAULT_RETRIEVAL_CONFIG`, `HybridRetrieverConfig` |
| `stable` | `./assembler.js` | 1 | `exact:./assembler.js` | `ContextAssembler` |
| `stable` | `./pipeline.js` | 3 | `exact:./pipeline.js` | `RagPipeline`, `DEFAULT_PIPELINE_CONFIG`, `RagPipelineDeps` |
| `stable` | `./quality-retriever.js` | 3 | `exact:./quality-retriever.js` | `QualityBoostedRetriever`, `SourceQualityMap`, `QualityBoostConfig` |
| `stable` | `./citation-tracker.js` | 2 | `exact:./citation-tracker.js` | `CitationTracker`, `CitationSourceMeta` |
| `stable` | `./memory-namespace.js` | 3 | `exact:./memory-namespace.js` | `RagMemoryNamespace`, `RagMemoryConfig`, `MemoryServiceLike` |
| `stable` | `./corpus-manager.js` | 2 | `exact:./corpus-manager.js` | `CorpusManager`, `CorpusManagerConfig` |
| `stable` | `./corpus-types.js` | 8 | `exact:./corpus-types.js` | `Corpus`, `CorpusConfig`, `CorpusSource`, `IngestJobResult` |
| `deprecated-transitional` | `./qdrant-factory.js` | 3 | `exact:./qdrant-factory.js` | `createQdrantRagPipeline`, `ensureTenantCollection`, `QdrantRagConfig` |
| `deprecated-transitional` | `./folder-context-generator.js` | 5 | `exact:./folder-context-generator.js` | `FolderContextGenerator`, `FolderContextConfig`, `FileScore`, `ContextSnapshot` |
| `deprecated-transitional` | `./providers/qdrant.js` | 11 | `prefix:./providers/` | `QdrantVectorStore`, `QdrantCorpusStore`, `createQdrantRetriever`, `loadQdrantClient` |

## @dzupagent/connectors

Root index: `packages/connectors/src/index.ts`

- Stable root sources: `8`
- Deprecated transitional root sources: `0`
- Internal-only root candidates: `0`
- Migration window: Connector root exports are currently the contracted compatibility surface; new connector families should prefer explicit subpaths before root promotion.

### Stable Subpaths

No stable subpaths configured.

### Root Allowlist

| Root Class | Source Module | Export Count | Matched Rule | Sample Exports |
| --- | --- | ---: | --- | --- |
| `stable` | `./connector-types.js` | 3 | `exact:./connector-types.js` | `Connector`, `ConnectorConfig`, `filterTools` |
| `stable` | `./connector-contract.js` | 7 | `exact:./connector-contract.js` | `ConnectorTool`, `ConnectorToolLike`, `ConnectorToolkit`, `ConnectorFactory` |
| `stable` | `./github/index.js` | 20 | `prefix:./github/` | `createGitHubConnector`, `createGitHubConnectorToolkit`, `GitHubClient`, `GitHubApiError` |
| `stable` | `./http/index.js` | 3 | `prefix:./http/` | `createHTTPConnector`, `createHttpConnectorToolkit`, `HTTPConnectorConfig` |
| `stable` | `./slack/index.js` | 3 | `prefix:./slack/` | `createSlackConnector`, `createSlackConnectorToolkit`, `SlackConnectorConfig` |
| `stable` | `./database/index.js` | 8 | `prefix:./database/` | `createDatabaseConnector`, `createDatabaseOperations`, `createDatabaseConnectorToolkit`, `DatabaseConnectorConfig` |
| `stable` | `./sql/index.js` | 25 | `prefix:./sql/` | `createSQLConnector`, `createSQLTools`, `BaseSQLConnector`, `generateDDL` |
| `stable` | `<local>:dzupagent_CONNECTORS_VERSION` | 1 | `exact:<local>:dzupagent_CONNECTORS_VERSION` | `dzupagent_CONNECTORS_VERSION` |

## @dzupagent/agent-adapters

Root index: `packages/agent-adapters/src/index.ts`

- Stable root sources: `14`
- Deprecated transitional root sources: `79`
- Internal-only root candidates: `0`
- Migration window: Root transitional exports remain available through 0.x with new code expected to use providers/orchestration/workflow/http/persistence/rules/learning/recovery subpaths before a future 1.0 root contraction.

### Stable Subpaths

| Subpath | Purpose |
| --- | --- |
| `@dzupagent/agent-adapters/providers` | provider adapter contracts, concrete provider adapters, registry primitives, and provider helpers |
| `@dzupagent/agent-adapters/orchestration` | multi-agent orchestration, sessions, context routing, and integration bridge |
| `@dzupagent/agent-adapters/workflow` | workflow DSL builder, resolver, and validator |
| `@dzupagent/agent-adapters/http` | HTTP handler, request schemas, and rate limiting |
| `@dzupagent/agent-adapters/persistence` | checkpoint, run manager, run log, and run event store helpers |
| `@dzupagent/agent-adapters/rules` | adapter-rule RuntimePlan preparation, governance diagnostics, and watcher-path projection bridge |
| `@dzupagent/agent-adapters/learning` | learning loop, A/B testing, interaction policy, and enrichment pipeline |
| `@dzupagent/agent-adapters/recovery` | recovery copilot, policies, escalation, cross-provider handoff, and approval gates |

### Root Allowlist

| Root Class | Source Module | Export Count | Matched Rule | Sample Exports |
| --- | --- | ---: | --- | --- |
| `stable` | `./types.js` | 28 | `exact:./types.js` | `AdapterProviderId`, `AdapterCapabilityProfile`, `AgentInput`, `AgentEvent` |
| `deprecated-transitional` | `./claude/claude-adapter.js` | 2 | `prefix:./claude/` | `ClaudeAgentAdapter`, `createClaudeAdapter` |
| `deprecated-transitional` | `./codex/codex-adapter.js` | 2 | `prefix:./codex/` | `CodexAdapter`, `createCodexAdapter` |
| `deprecated-transitional` | `./gemini/gemini-adapter.js` | 1 | `prefix:./gemini/` | `GeminiCLIAdapter` |
| `deprecated-transitional` | `./gemini/gemini-sdk-adapter.js` | 2 | `prefix:./gemini/` | `GeminiSDKAdapter`, `GeminiSDKAdapterConfig` |
| `deprecated-transitional` | `./qwen/qwen-adapter.js` | 1 | `prefix:./qwen/` | `QwenAdapter` |
| `deprecated-transitional` | `./crush/crush-adapter.js` | 1 | `prefix:./crush/` | `CrushAdapter` |
| `deprecated-transitional` | `./goose/goose-adapter.js` | 1 | `prefix:./goose/` | `GooseAdapter` |
| `deprecated-transitional` | `./openrouter/openrouter-adapter.js` | 2 | `prefix:./openrouter/` | `OpenRouterAdapter`, `OpenRouterConfig` |
| `deprecated-transitional` | `./openai/openai-adapter.js` | 3 | `prefix:./openai/` | `OpenAIAdapter`, `OpenAIConfig`, `OpenAIRunResult` |
| `deprecated-transitional` | `./prompts/system-prompt-builder.js` | 9 | `prefix:./prompts/` | `SystemPromptBuilder`, `SystemPromptPayload`, `ClaudeAppendPayload`, `ClaudeReplacePayload` |
| `stable` | `./registry/adapter-registry.js` | 4 | `prefix:./registry/` | `ProviderAdapterRegistry`, `ProviderAdapterRegistryConfig`, `ProviderAdapterRegistryHealthStatus`, `ProviderAdapterHealthDetail` |
| `stable` | `./registry/task-router.js` | 5 | `prefix:./registry/` | `TagBasedRouter`, `CostOptimizedRouter`, `RoundRobinRouter`, `CompositeRouter` |
| `stable` | `./registry/learning-router.js` | 2 | `prefix:./registry/` | `LearningRouter`, `LearningRouterConfig` |
| `stable` | `./registry/event-bus-bridge.js` | 1 | `prefix:./registry/` | `EventBusBridge` |
| `deprecated-transitional` | `./middleware/memory-enrichment.js` | 7 | `prefix:./middleware/` | `withMemoryEnrichment`, `withHierarchicalMemoryEnrichment`, `MemoryServiceLike`, `MemoryEnrichmentOptions` |
| `deprecated-transitional` | `./middleware/cost-tracking.js` | 3 | `prefix:./middleware/` | `CostTrackingMiddleware`, `CostTrackingConfig`, `CostReport` |
| `deprecated-transitional` | `./middleware/middleware-pipeline.js` | 3 | `prefix:./middleware/` | `MiddlewarePipeline`, `AdapterMiddleware`, `MiddlewareContext` |
| `deprecated-transitional` | `./middleware/middleware-factories.js` | 2 | `prefix:./middleware/` | `createCostTrackingMiddleware`, `createGuardrailsMiddleware` |
| `deprecated-transitional` | `./middleware/content-sanitizer.js` | 3 | `prefix:./middleware/` | `sanitizeContent`, `createContentSanitizerMiddleware`, `ContentSanitizerConfig` |
| `deprecated-transitional` | `./orchestration/supervisor.js` | 8 | `prefix:./orchestration/` | `SupervisorOrchestrator`, `KeywordTaskDecomposer`, `SupervisorConfig`, `SupervisorOptions` |
| `deprecated-transitional` | `./orchestration/parallel-executor.js` | 6 | `prefix:./orchestration/` | `ParallelExecutor`, `ParallelExecutorConfig`, `ParallelExecutionOptions`, `ParallelExecutionResult` |
| `deprecated-transitional` | `./orchestration/map-reduce.js` | 10 | `prefix:./orchestration/` | `MapReduceOrchestrator`, `LineChunker`, `DirectoryChunker`, `MapReduceConfig` |
| `deprecated-transitional` | `./orchestration/contract-net.js` | 8 | `prefix:./orchestration/` | `ContractNetOrchestrator`, `StaticBidStrategy`, `ContractNetConfig`, `ContractNetOptions` |
| `deprecated-transitional` | `./session/session-registry.js` | 6 | `prefix:./session/` | `SessionRegistry`, `WorkflowSession`, `ProviderSession`, `ConversationEntry` |
| `deprecated-transitional` | `./session/workflow-checkpointer.js` | 8 | `prefix:./session/` | `WorkflowCheckpointer`, `InMemoryCheckpointStore`, `WorkflowCheckpoint`, `StepDefinition` |
| `deprecated-transitional` | `./session/conversation-compressor.js` | 3 | `prefix:./session/` | `ConversationCompressor`, `ConversationTurn`, `ConversationCompressorOptions` |
| `deprecated-transitional` | `./session/compaction-strategy.js` | 6 | `prefix:./session/` | `DefaultCompactionStrategy`, `CompactionStrategy`, `CompactionRequest`, `CompactionType` |
| `deprecated-transitional` | `./testing/ab-test-runner.js` | 13 | `prefix:./testing/` | `ABTestRunner`, `LengthScorer`, `ExactMatchScorer`, `ContainsKeywordsScorer` |
| `deprecated-transitional` | `./middleware/cost-models.js` | 6 | `prefix:./middleware/` | `CostModelRegistry`, `TokenRates`, `CostEstimationInput`, `CostEstimate` |
| `deprecated-transitional` | `./middleware/cost-optimization.js` | 5 | `prefix:./middleware/` | `CostOptimizationEngine`, `CostOptimizationConfig`, `ProviderPerformanceRecord`, `ProviderStats` |
| `deprecated-transitional` | `./mcp/mcp-tool-sharing.js` | 4 | `prefix:./mcp/` | `MCPToolSharingBridge`, `MCPToolSharingConfig`, `SharedTool`, `ToolSharingStats` |
| `deprecated-transitional` | `./mcp/mcp-adapter-manager.js` | 1 | `prefix:./mcp/` | `InMemoryMcpAdapterManager` |
| `deprecated-transitional` | `./mcp/mcp-adapter-types.js` | 4 | `prefix:./mcp/` | `AdapterMcpServer`, `AdapterMcpBinding`, `McpServerTestResult`, `EffectiveMcpConfig` |
| `stable` | `./registry/capability-router.js` | 4 | `prefix:./registry/` | `CapabilityRouter`, `ProviderCapability`, `ProviderCapabilityTag`, `CapabilityRouterConfig` |
| `deprecated-transitional` | `./plugin/adapter-plugin.js` | 3 | `prefix:./plugin/` | `createAdapterPlugin`, `AdapterPluginConfig`, `AdapterPluginInstance` |
| `deprecated-transitional` | `./plugin/adapter-plugin-sdk.js` | 4 | `prefix:./plugin/` | `defineAdapterPlugin`, `isAdapterPlugin`, `AdapterPluginDefinition`, `AdapterPlugin` |
| `deprecated-transitional` | `./plugin/adapter-plugin-loader.js` | 1 | `prefix:./plugin/` | `AdapterPluginLoader` |
| `stable` | `./facade/orchestrator-facade.js` | 3 | `prefix:./facade/` | `OrchestratorFacade`, `createOrchestrator`, `OrchestratorConfig` |
| `deprecated-transitional` | `./pipeline/index.js` | 8 | `prefix:./pipeline/` | `AdapterPipeline`, `ApprovalPipelineStep`, `GuardrailsPipelineStep`, `PolicyEnforcementPipeline` |
| `stable` | `./integration/agent-bridge.js` | 6 | `prefix:./integration/` | `AgentIntegrationBridge`, `AdapterAsToolWrapper`, `AdapterToolConfig`, `ToolInvocationResult` |
| `stable` | `./integration/index.js` | 1 | `prefix:./integration/` | `RegistryExecutionPort` |
| `deprecated-transitional` | `./guardrails/adapter-guardrails.js` | 8 | `prefix:./guardrails/` | `AdapterGuardrails`, `AdapterStuckDetector`, `AdapterGuardrailsConfig`, `StuckDetectorConfig` |
| `deprecated-transitional` | `./workflow/adapter-workflow.js` | 12 | `prefix:./workflow/` | `ADAPTER_WORKFLOW_OWNERSHIP`, `AdapterWorkflowBuilder`, `AdapterWorkflow`, `defineWorkflow` |
| `deprecated-transitional` | `./workflow/template-resolver.js` | 3 | `prefix:./workflow/` | `WorkflowStepResolver`, `TemplateContext`, `TemplateReference` |
| `deprecated-transitional` | `./workflow/workflow-validator.js` | 3 | `prefix:./workflow/` | `WorkflowValidator`, `ValidationError`, `ValidationResult` |
| `deprecated-transitional` | `./streaming/streaming-handler.js` | 6 | `prefix:./streaming/` | `StreamingHandler`, `StreamFormat`, `StreamingConfig`, `StreamOutputEvent` |
| `deprecated-transitional` | `./observability/adapter-tracer.js` | 5 | `prefix:./observability/` | `AdapterTracer`, `TraceSpan`, `SpanEvent`, `AdapterTracerConfig` |
| `deprecated-transitional` | `./observability/tracing-middleware.js` | 1 | `prefix:./observability/` | `createTracingMiddleware` |
| `deprecated-transitional` | `./approval/adapter-approval.js` | 6 | `prefix:./approval/` | `AdapterApprovalGate`, `AdapterApprovalConfig`, `ApprovalContext`, `ApprovalRequest` |
| `deprecated-transitional` | `./approval/approval-audit.js` | 4 | `prefix:./approval/` | `InMemoryApprovalAuditStore`, `ApprovalAuditEntry`, `AuditQueryFilters`, `ApprovalAuditStore` |
| `deprecated-transitional` | `./approval/policy-driven-approval.js` | 3 | `prefix:./approval/` | `createPolicyCondition`, `compareBlastRadius`, `PolicyConditionConfig` |
| `deprecated-transitional` | `./recovery/adapter-recovery.js` | 13 | `prefix:./recovery/` | `AdapterRecoveryCopilot`, `ExecutionTraceCapture`, `RecoveryStrategy`, `RecoveryConfig` |
| `deprecated-transitional` | `./recovery/recovery-policies.js` | 5 | `prefix:./recovery/` | `RecoveryPolicySelector`, `RECOVERY_POLICIES`, `RecoveryPolicy`, `RecoveryStrategyConfig` |
| `deprecated-transitional` | `./recovery/escalation-handler.js` | 6 | `prefix:./recovery/` | `EventBusEscalationHandler`, `WebhookEscalationHandler`, `EscalationHandler`, `EscalationContext` |
| `deprecated-transitional` | `./recovery/cross-provider-handoff.js` | 3 | `prefix:./recovery/` | `CrossProviderHandoff`, `HandoffItem`, `CrossProviderHandoffOptions` |
| `deprecated-transitional` | `./http/rate-limiter.js` | 2 | `prefix:./http/` | `SlidingWindowRateLimiter`, `RateLimitConfig` |
| `deprecated-transitional` | `./http/adapter-http-handler.js` | 12 | `prefix:./http/` | `AdapterHttpHandler`, `AdapterHttpConfig`, `HttpRequest`, `HttpResponse` |
| `deprecated-transitional` | `./http/request-schemas.js` | 10 | `prefix:./http/` | `RunRequestSchema`, `SupervisorRequestSchema`, `ParallelRequestSchema`, `BidRequestSchema` |
| `deprecated-transitional` | `./context/context-aware-router.js` | 6 | `prefix:./context/` | `ContextAwareRouter`, `ContextInjectionMiddleware`, `ContextEstimate`, `ContextAwareRouterConfig` |
| `deprecated-transitional` | `./output/structured-output.js` | 7 | `prefix:./output/` | `StructuredOutputAdapter`, `JsonOutputSchema`, `RegexOutputSchema`, `OutputSchema` |
| `deprecated-transitional` | `./persistence/persistent-checkpoint-store.js` | 2 | `prefix:./persistence/` | `FileCheckpointStore`, `FileCheckpointStoreConfig` |
| `deprecated-transitional` | `./persistence/run-manager.js` | 5 | `prefix:./persistence/` | `RunManager`, `AdapterRun`, `RunStatus`, `RunManagerConfig` |
| `deprecated-transitional` | `./learning/adapter-learning-loop.js` | 9 | `prefix:./learning/` | `AdapterLearningLoop`, `ExecutionAnalyzer`, `ExecutionRecord`, `ProviderProfile` |
| `deprecated-transitional` | `./learning/in-memory-learning-store.js` | 1 | `prefix:./learning/` | `InMemoryLearningStore` |
| `deprecated-transitional` | `./learning/file-learning-store.js` | 1 | `prefix:./learning/` | `FileLearningStore` |
| `deprecated-transitional` | `./learning/learning-store.js` | 2 | `prefix:./learning/` | `LearningStore`, `LearningSnapshot` |
| `deprecated-transitional` | `./utils/errors.js` | 2 | `prefix:./utils/` | `DzupError`, `DzupErrorOptions` |
| `deprecated-transitional` | `./utils/process-helpers.js` | 2 | `prefix:./utils/` | `isBinaryAvailable`, `spawnAndStreamJsonl` |
| `deprecated-transitional` | `./base/base-cli-adapter.js` | 1 | `prefix:./base/` | `filterSensitiveEnvVars` |
| `deprecated-transitional` | `./utils/url-validator.js` | 2 | `prefix:./utils/` | `validateWebhookUrl`, `UrlValidationOptions` |
| `deprecated-transitional` | `./utils/provider-helpers.js` | 2 | `prefix:./utils/` | `resolveFallbackProviderId`, `requireFallbackProviderId` |
| `deprecated-transitional` | `./skills/skill-projector.js` | 3 | `prefix:./skills/` | `SkillProjector`, `SkillProjection`, `ProjectionOptions` |
| `deprecated-transitional` | `./skills/adapter-skill-types.js` | 4 | `prefix:./skills/` | `AdapterSkillBundle`, `CompiledAdapterSkill`, `AdapterSkillCompiler`, `ProjectionUsageRecord` |
| `deprecated-transitional` | `./skills/adapter-skill-registry.js` | 2 | `prefix:./skills/` | `AdapterSkillRegistry`, `createDefaultSkillRegistry` |
| `deprecated-transitional` | `./skills/adapter-skill-version-store.js` | 4 | `prefix:./skills/` | `VersionedProjection`, `AdapterSkillVersionStore`, `InMemoryAdapterSkillVersionStore`, `FileAdapterSkillVersionStore` |
| `deprecated-transitional` | `./skills/adapter-skill-telemetry.js` | 4 | `prefix:./skills/` | `ProjectionTelemetryRecord`, `ProjectionUsageStats`, `AdapterSkillTelemetry`, `InMemoryAdapterSkillTelemetry` |
| `deprecated-transitional` | `./skills/skill-capability-matrix.js` | 1 | `prefix:./skills/` | `SkillCapabilityMatrixBuilder` |
| `deprecated-transitional` | `@dzupagent/adapter-types` | 7 | `exact:@dzupagent/adapter-types` | `SkillCapabilityMatrix`, `ProviderCapabilityRow`, `CapabilityStatus`, `RawAgentEvent` |
| `deprecated-transitional` | `./skills/compilers/codex-skill-compiler.js` | 1 | `prefix:./skills/` | `CodexSkillCompiler` |
| `deprecated-transitional` | `./skills/compilers/claude-skill-compiler.js` | 1 | `prefix:./skills/` | `ClaudeSkillCompiler` |
| `deprecated-transitional` | `./skills/compilers/cli-skill-compiler.js` | 2 | `prefix:./skills/` | `CliSkillCompiler`, `isCliProviderId` |
| `deprecated-transitional` | `./policy/index.js` | 9 | `prefix:./policy/` | `compilePolicyForProvider`, `compilePolicyForAll`, `AdapterPolicy`, `CompiledPolicyOverrides` |
| `deprecated-transitional` | `./utils/batched-event-emitter.js` | 2 | `prefix:./utils/` | `BatchedEventEmitter`, `BatchConfig` |
| `deprecated-transitional` | `./dzupagent/index.js` | 39 | `prefix:./dzupagent/` | `WorkspaceResolver`, `loadDzupAgentConfig`, `getCodexMemoryStrategy`, `getMaxMemoryTokens` |
| `deprecated-transitional` | `./interaction/interaction-resolver.js` | 3 | `prefix:./interaction/` | `InteractionResolver`, `InteractionRequest`, `InteractionResult` |
| `deprecated-transitional` | `./interaction/interaction-detector.js` | 3 | `prefix:./interaction/` | `classifyInteractionText`, `detectCliInteraction`, `InteractionKind` |
| `stable` | `./runs/run-event-store.js` | 1 | `prefix:./runs/` | `RunEventStore` |
| `stable` | `./runs/script-run-event-store.js` | 22 | `prefix:./runs/` | `ScriptRunEventStore`, `AppendManagedArtifactInput`, `AppendManagedRunEventInput`, `ManagedRunSummaryInput` |
| `stable` | `./runs/run-log-root.js` | 1 | `prefix:./runs/` | `runLogRoot` |
| `stable` | `./provider-catalog.js` | 8 | `exact:./provider-catalog.js` | `PROVIDER_CATALOG`, `HTTP_ROUTABLE_PROVIDER_IDS`, `getDefaultMonitorStatus`, `getMonitorableProviders` |
| `stable` | `./normalize.js` | 2 | `exact:./normalize.js` | `normalizeEvent`, `Provider` |
| `deprecated-transitional` | `./enrichment/enrichment-pipeline.js` | 3 | `prefix:./enrichment/` | `EnrichmentPipeline`, `EnrichmentContext`, `EnrichmentResult` |

## @dzupagent/otel

Root index: `packages/otel/src/index.ts`

- Stable root sources: `13`
- Deprecated transitional root sources: `0`
- Internal-only root candidates: `0`
- Migration window: OTel root exports are currently the contracted package surface; add allowlist rules before exposing new root modules.

### Stable Subpaths

No stable subpaths configured.

### Root Allowlist

| Root Class | Source Module | Export Count | Matched Rule | Sample Exports |
| --- | --- | ---: | --- | --- |
| `stable` | `./span-attributes.js` | 2 | `exact:./span-attributes.js` | `ForgeSpanAttr`, `ForgeSpanAttrKey` |
| `stable` | `./otel-types.js` | 6 | `exact:./otel-types.js` | `OTelSpan`, `OTelTracer`, `OTelSpanOptions`, `OTelContext` |
| `stable` | `./noop.js` | 2 | `exact:./noop.js` | `NoopSpan`, `NoopTracer` |
| `stable` | `./trace-context-store.js` | 4 | `exact:./trace-context-store.js` | `forgeContextStore`, `withForgeContext`, `currentForgeContext`, `ForgeTraceContext` |
| `stable` | `./tracer.js` | 3 | `exact:./tracer.js` | `DzupTracer`, `DzupTracerConfig`, `ForgeTraceSnapshot` |
| `stable` | `./event-metric-map.js` | 3 | `exact:./event-metric-map.js` | `EVENT_METRIC_MAP`, `getAllMetricNames`, `MetricMapping` |
| `stable` | `./vector-metrics.js` | 3 | `exact:./vector-metrics.js` | `VectorMetricsCollector`, `VectorMetrics`, `VectorMetricsReport` |
| `stable` | `./otel-bridge.js` | 4 | `exact:./otel-bridge.js` | `OTelBridge`, `InMemoryMetricSink`, `OTelBridgeConfig`, `MetricSink` |
| `stable` | `./cost-attribution.js` | 5 | `exact:./cost-attribution.js` | `CostAttributor`, `CostEntry`, `CostReport`, `CostAlertThreshold` |
| `stable` | `./safety-monitor.js` | 6 | `exact:./safety-monitor.js` | `SafetyMonitor`, `SafetyCategory`, `SafetySeverity`, `SafetyEvent` |
| `stable` | `./audit-trail.js` | 6 | `exact:./audit-trail.js` | `AuditTrail`, `InMemoryAuditStore`, `AuditCategory`, `AuditEntry` |
| `stable` | `./otel-plugin.js` | 2 | `exact:./otel-plugin.js` | `createOTelPlugin`, `OTelPluginConfig` |
| `stable` | `<local>:dzupagent_OTEL_VERSION` | 1 | `exact:<local>:dzupagent_OTEL_VERSION` | `dzupagent_OTEL_VERSION` |

## @dzupagent/runtime-contracts

Root index: `packages/runtime-contracts/src/index.ts`

- Stable root sources: `0`
- Deprecated transitional root sources: `0`
- Internal-only root candidates: `0`
- Migration window: Runtime contract root exports are stable neutral contracts; add allowlist rules before exposing new contract modules.

### Stable Subpaths

No stable subpaths configured.

### Root Allowlist

| Root Class | Source Module | Export Count | Matched Rule | Sample Exports |
| --- | --- | ---: | --- | --- |

## @dzupagent/agent-types

Root index: `packages/agent-types/src/index.ts`

- Stable root sources: `5`
- Deprecated transitional root sources: `0`
- Internal-only root candidates: `0`
- Migration window: Agent type root exports are stable Layer 0 contracts; add allowlist rules before exposing new type modules.

### Stable Subpaths

No stable subpaths configured.

### Root Allowlist

| Root Class | Source Module | Export Count | Matched Rule | Sample Exports |
| --- | --- | ---: | --- | --- |
| `stable` | `./guardrails.js` | 1 | `exact:./guardrails.js` | `StuckDetectorConfig` |
| `stable` | `./retry.js` | 1 | `exact:./retry.js` | `RetryPolicy` |
| `stable` | `./tool-permission.js` | 3 | `exact:./tool-permission.js` | `ToolScope`, `ToolPermissionEntry`, `ToolPermissionPolicy` |
| `stable` | `./orchestration-contracts.js` | 4 | `exact:./orchestration-contracts.js` | `BaseSupervisorContract`, `BaseMapReduceContract`, `BaseContractNetContract`, `BaseTeamCoordinationContract` |
| `stable` | `./memory-client.js` | 9 | `exact:./memory-client.js` | `MemoryClient`, `MemoryScope`, `MemoryQuery`, `MemoryRecord` |

## @dzupagent/eval-contracts

Root index: `packages/eval-contracts/src/index.ts`

- Stable root sources: `0`
- Deprecated transitional root sources: `0`
- Internal-only root candidates: `0`
- Migration window: Eval contract root exports are stable neutral contracts; add allowlist rules before exposing new contract modules.

### Stable Subpaths

No stable subpaths configured.

### Root Allowlist

| Root Class | Source Module | Export Count | Matched Rule | Sample Exports |
| --- | --- | ---: | --- | --- |

## @dzupagent/cache

Root index: `packages/cache/src/index.ts`

- Stable root sources: `5`
- Deprecated transitional root sources: `0`
- Internal-only root candidates: `0`
- Migration window: Cache root exports are currently the contracted package surface; add allowlist rules before exposing new root modules.

### Stable Subpaths

No stable subpaths configured.

### Root Allowlist

| Root Class | Source Module | Export Count | Matched Rule | Sample Exports |
| --- | --- | ---: | --- | --- |
| `stable` | `./types.js` | 6 | `exact:./types.js` | `CacheBackend`, `CachePolicy`, `CacheableRequest`, `CacheStats` |
| `stable` | `./key-generator.js` | 1 | `exact:./key-generator.js` | `generateCacheKey` |
| `stable` | `./backends/in-memory.js` | 1 | `exact:./backends/in-memory.js` | `InMemoryCacheBackend` |
| `stable` | `./backends/redis.js` | 1 | `exact:./backends/redis.js` | `RedisCacheBackend` |
| `stable` | `./middleware.js` | 1 | `exact:./middleware.js` | `CacheMiddleware` |

## @dzupagent/server

Root index: `packages/server/src/index.ts`

- Stable root sources: `30`
- Deprecated transitional root sources: `0`
- Internal-only root candidates: `0`
- Migration window: The server root is contracted to keep-root sources; advanced and feature-specific imports must use ops/runtime/compat/features subpaths.

### Stable Subpaths

| Subpath | Purpose |
| --- | --- |
| `@dzupagent/server/ops` | operational diagnostics and scorecards |
| `@dzupagent/server/runtime` | run workers, executors, trace stores, and control-plane helpers |
| `@dzupagent/server/compat` | OpenAI-compatible HTTP surface |
| `@dzupagent/server/features` | opt-in feature-plane routes, stores, and helpers |

### Root Allowlist

| Root Class | Source Module | Export Count | Matched Rule | Sample Exports |
| --- | --- | ---: | --- | --- |
| `stable` | `./app.js` | 12 | `stable/app/keep-root` | `createForgeApp`, `ForgeServerConfig`, `ForgeHostRuntimeConfig`, `ForgeRouteFamiliesConfig` |
| `stable` | `./route-plugin.js` | 2 | `stable/extensibility/keep-root` | `ServerRoutePlugin`, `ServerRoutePluginContext` |
| `stable` | `./routes/runs.js` | 1 | `stable/routes-core/keep-root` | `createRunRoutes` |
| `stable` | `./routes/agents.js` | 2 | `stable/routes-core/keep-root` | `createAgentDefinitionRoutes`, `createAgentRoutes` |
| `stable` | `./routes/approval.js` | 1 | `stable/routes-core/keep-root` | `createApprovalRoutes` |
| `stable` | `./routes/health.js` | 1 | `stable/routes-core/keep-root` | `createHealthRoutes` |
| `stable` | `./routes/events.js` | 2 | `stable/realtime/keep-root` | `createEventRoutes`, `EventRouteConfig` |
| `stable` | `./middleware/auth.js` | 2 | `stable/middleware/keep-root` | `authMiddleware`, `AuthConfig` |
| `stable` | `./middleware/rate-limiter.js` | 3 | `stable/middleware/keep-root` | `rateLimiterMiddleware`, `TokenBucketLimiter`, `RateLimiterConfig` |
| `stable` | `./middleware/identity.js` | 4 | `stable/middleware/keep-root` | `identityMiddleware`, `getForgeIdentity`, `getForgeCapabilities`, `IdentityMiddlewareConfig` |
| `stable` | `./middleware/capability-guard.js` | 1 | `stable/middleware/keep-root` | `capabilityGuard` |
| `stable` | `./middleware/rbac.js` | 14 | `stable/middleware/keep-root` | `rbacMiddleware`, `rbacGuard`, `hasPermission`, `resolveRoutePermission` |
| `stable` | `./middleware/tenant-scope.js` | 3 | `stable/middleware/keep-root` | `tenantScopeMiddleware`, `getTenantId`, `TenantScopeConfig` |
| `stable` | `./queue/run-queue.js` | 7 | `stable/queue/keep-root` | `InMemoryRunQueue`, `RunQueue`, `RunJob`, `RunQueueConfig` |
| `stable` | `./queue/bullmq-run-queue.js` | 2 | `stable/queue/keep-root` | `BullMQRunQueue`, `BullMQRunQueueConfig` |
| `stable` | `./lifecycle/graceful-shutdown.js` | 3 | `stable/lifecycle/keep-root` | `GracefulShutdown`, `ShutdownConfig`, `ShutdownState` |
| `stable` | `./ws/event-bridge.js` | 4 | `stable/realtime/keep-root` | `EventBridge`, `WSClient`, `ClientFilter`, `EventBridgeConfig` |
| `stable` | `./ws/control-protocol.js` | 6 | `stable/realtime/keep-root` | `createWsControlHandler`, `WSControlClientMessage`, `WSControlServerMessage`, `WSControlHandlerOptions` |
| `stable` | `./ws/authorization.js` | 3 | `stable/realtime/keep-root` | `createScopedAuthorizeFilter`, `WSClientScope`, `ScopedAuthorizeFilterOptions` |
| `stable` | `./ws/scope-registry.js` | 1 | `stable/realtime/keep-root` | `WSClientScopeRegistry` |
| `stable` | `./ws/scoped-control-handler.js` | 2 | `stable/realtime/keep-root` | `createScopedWsControlHandler`, `ScopedWsControlHandlerOptions` |
| `stable` | `./ws/session-manager.js` | 2 | `stable/realtime/keep-root` | `WSSessionManager`, `WSSessionManagerOptions` |
| `stable` | `./ws/node-adapter.js` | 3 | `stable/realtime/keep-root` | `attachNodeWsSession`, `NodeWSLike`, `AttachNodeWsSessionOptions` |
| `stable` | `./ws/node-upgrade-handler.js` | 4 | `stable/realtime/keep-root` | `createNodeWsUpgradeHandler`, `createPathUpgradeGuard`, `NodeWebSocketServerLike`, `NodeWsUpgradeHandlerOptions` |
| `stable` | `./events/event-gateway.js` | 8 | `stable/realtime/keep-root` | `InMemoryEventGateway`, `EventGateway`, `EventEnvelope`, `EventSubscription` |
| `stable` | `./streaming/sse-streaming-adapter.js` | 3 | `stable/realtime/keep-root` | `streamRunHandleToSSE`, `SSEStreamLike`, `StreamRunHandleToSSEOptions` |
| `stable` | `./platforms/lambda.js` | 1 | `stable/platforms/keep-root` | `toLambdaHandler` |
| `stable` | `./platforms/vercel.js` | 1 | `stable/platforms/keep-root` | `toVercelHandler` |
| `stable` | `./platforms/cloudflare.js` | 1 | `stable/platforms/keep-root` | `toCloudflareHandler` |
| `stable` | `./security/input-guard.js` | 5 | `stable/security/keep-root` | `createInputGuard`, `DEFAULT_MAX_INPUT_LENGTH`, `InputGuard`, `InputGuardConfig` |


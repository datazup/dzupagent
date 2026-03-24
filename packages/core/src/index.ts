/**
 * @forgeagent/core — Base agent infrastructure
 *
 * Reusable LLM agent engine: model registry, prompt management,
 * memory, context engineering, middleware, persistence, routing,
 * streaming, sub-agents, and skills.
 */

// --- Config / DI ---
export { ForgeContainer, createContainer } from './config/container.js'

// --- Errors ---
export { ForgeError } from './errors/forge-error.js'
export type { ForgeErrorOptions } from './errors/forge-error.js'
export type { ForgeErrorCode } from './errors/error-codes.js'

// --- Events ---
export { createEventBus } from './events/event-bus.js'
export type { ForgeEventBus } from './events/event-bus.js'
export type { ForgeEvent, ForgeEventOf, BudgetUsage } from './events/event-types.js'
export { AgentBus } from './events/agent-bus.js'
export type { AgentMessage, AgentMessageHandler } from './events/agent-bus.js'

// --- Hooks ---
export type { AgentHooks, HookContext } from './hooks/hook-types.js'
export { runHooks, runModifierHook, mergeHooks } from './hooks/hook-runner.js'

// --- Plugin ---
export type { ForgePlugin, PluginContext } from './plugin/plugin-types.js'
export { PluginRegistry } from './plugin/plugin-registry.js'
export { discoverPlugins, validateManifest, resolvePluginOrder } from './plugin/plugin-discovery.js'
export type { PluginManifest, DiscoveredPlugin, PluginDiscoveryConfig } from './plugin/plugin-discovery.js'
export { createManifest, serializeManifest } from './plugin/plugin-manifest.js'

// --- LLM ---
export { ModelRegistry } from './llm/model-registry.js'
export type { LLMProviderConfig, ModelTier, ModelSpec, ModelOverrides, ModelFactory } from './llm/model-config.js'
export { CircuitBreaker } from './llm/circuit-breaker.js'
export type { CircuitBreakerConfig, CircuitState } from './llm/circuit-breaker.js'
export { invokeWithTimeout, extractTokenUsage } from './llm/invoke.js'
export type { TokenUsage, InvokeOptions } from './llm/invoke.js'
export { isTransientError, DEFAULT_RETRY_CONFIG } from './llm/retry.js'
export type { RetryConfig } from './llm/retry.js'

// --- Prompt ---
export {
  FRAGMENT_CORE_PRINCIPLES,
  FRAGMENT_SECURITY_CHECKLIST,
  FRAGMENT_SIMPLICITY,
  FRAGMENT_READ_DISCIPLINE,
  FRAGMENT_SCOPE_BOUNDARY,
  FRAGMENT_VERIFICATION_MINDSET,
  FRAGMENT_BLOCKED_HANDLING,
  FRAGMENT_OUTPUT_EFFICIENCY,
  FRAGMENT_WORKER_REPORT,
  PROMPT_FRAGMENTS,
  composeFragments,
} from './prompt/prompt-fragments.js'
export { composeAdvancedFragments, validateFragments } from './prompt/fragment-composer.js'
export type { ComposableFragment, ComposeResult } from './prompt/fragment-composer.js'
export { resolveTemplate, extractVariables, validateTemplate, flattenContext } from './prompt/template-engine.js'
export { PromptResolver } from './prompt/template-resolver.js'
export type { PromptStore, ResolutionLevel } from './prompt/template-resolver.js'
export { PromptCache } from './prompt/template-cache.js'
export type {
  TemplateVariable,
  TemplateContext,
  ResolvedPrompt,
  StoredTemplate,
  PromptResolveQuery,
  BulkPromptQuery,
} from './prompt/template-types.js'

// --- Memory (re-exported from @forgeagent/memory) ---
export {
  createStore,
  MemoryService,
  calculateStrength, reinforceMemory, createDecayMetadata, scoreWithDecay, findWeakMemories,
  sanitizeMemoryContent, stripInvisibleUnicode,
  consolidateNamespace, consolidateAll,
  findDuplicates, findContradictions, findStaleRecords, healMemory,
  WorkingMemory,
  ObservationExtractor,
  FrozenMemorySnapshot,
  StagedWriter,
  defaultWritePolicy, composePolicies,
  StoreVectorSearch,
  KeywordFTSSearch,
  EntityGraphSearch,
  fusionSearch,
} from '@forgeagent/memory'
export type {
  StoreConfig,
  NamespaceConfig, FormatOptions, DecayConfig,
  DecayMetadata,
  SanitizeResult,
  ConsolidationConfig, ConsolidationResult,
  HealingIssue, HealingReport, MemoryHealerConfig,
  WorkingMemoryConfig,
  ObservationExtractorConfig, Observation, ObservationCategory,
  StagedRecord, MemoryStage, StagedWriterConfig,
  WritePolicy, WriteAction,
  VectorSearchResult, VectorSearchProvider,
  FTSSearchResult,
  GraphSearchResult,
  FusedResult,
} from '@forgeagent/memory'

// --- Context (re-exported from @forgeagent/context) ---
export {
  shouldSummarize,
  summarizeAndTrim,
  formatSummaryContext,
  pruneToolResults,
  repairOrphanedToolPairs,
  scoreCompleteness,
  evictIfNeeded,
  SystemReminderInjector,
  applyAnthropicCacheControl,
  applyCacheBreakpoints,
} from '@forgeagent/context'
export type {
  MessageManagerConfig,
  CompletenessResult, DescriptionInput,
  EvictionConfig, EvictionResult,
  SystemReminderConfig, ReminderContent,
} from '@forgeagent/context'

// --- Middleware ---
export type { AgentMiddleware } from './middleware/types.js'
export { calculateCostCents, getModelCosts } from './middleware/cost-tracking.js'
export type { CostTracker } from './middleware/cost-tracking.js'
export { createLangfuseHandler } from './middleware/langfuse.js'
export type { LangfuseConfig, LangfuseHandlerOptions } from './middleware/langfuse.js'

// --- Persistence ---
export { createCheckpointer } from './persistence/checkpointer.js'
export type { CheckpointerConfig } from './persistence/checkpointer.js'
export { SessionManager } from './persistence/session.js'
export { InMemoryRunStore, InMemoryAgentStore } from './persistence/in-memory-store.js'
export type {
  RunStore, Run, CreateRunInput, RunFilter, RunStatus, LogEntry,
  AgentStore, AgentDefinition, AgentFilter,
} from './persistence/store-interfaces.js'
export { InMemoryEventLog, EventLogSink } from './persistence/event-log.js'
export type { RunEvent, EventLogStore } from './persistence/event-log.js'

// --- Router ---
export { IntentRouter } from './router/intent-router.js'
export type { IntentRouterConfig, ClassificationResult } from './router/intent-router.js'
export { KeywordMatcher } from './router/keyword-matcher.js'
export { LLMClassifier } from './router/llm-classifier.js'
export { CostAwareRouter, isSimpleTurn } from './router/cost-aware-router.js'
export type { CostAwareResult, CostAwareRouterConfig } from './router/cost-aware-router.js'

// --- Streaming ---
export { SSETransformer } from './streaming/sse-transformer.js'
export type { StandardSSEEvent, StandardEventType } from './streaming/event-types.js'

// --- Sub-agents ---
export { SubAgentSpawner } from './subagent/subagent-spawner.js'
export { REACT_DEFAULTS } from './subagent/subagent-types.js'
export type { SubAgentConfig, SubAgentResult, SubAgentUsage } from './subagent/subagent-types.js'
export { mergeFileChanges, fileDataReducer } from './subagent/file-merge.js'

// --- Skills ---
export { SkillLoader } from './skills/skill-loader.js'
export { injectSkills } from './skills/skill-injector.js'
export type { SkillDefinition } from './skills/skill-types.js'
export { SkillManager } from './skills/skill-manager.js'
export type { SkillManagerConfig, CreateSkillInput, PatchSkillInput, SkillWriteResult } from './skills/skill-manager.js'
export { SkillLearner } from './skills/skill-learner.js'
export type { SkillMetrics, SkillExecutionResult, SkillLearnerConfig } from './skills/skill-learner.js'
export { createSkillChain, validateChain } from './skills/skill-chain.js'
export type { SkillChainStep, SkillChain, ChainValidationResult } from './skills/skill-chain.js'
export { parseAgentsMd, mergeAgentsMdConfigs } from './skills/agents-md-parser.js'
export type { AgentsMdConfig } from './skills/agents-md-parser.js'
export { discoverAgentConfigs } from './skills/hierarchical-walker.js'
export type { HierarchyLevel } from './skills/hierarchical-walker.js'

// --- MCP ---
export { MCPClient } from './mcp/mcp-client.js'
export { mcpToolToLangChain, mcpToolsToLangChain, langChainToolToMcp } from './mcp/mcp-tool-bridge.js'
export { DeferredToolLoader } from './mcp/deferred-loader.js'
export { ForgeAgentMCPServer } from './mcp/mcp-server.js'
export type { MCPServerOptions, MCPExposedTool, MCPRequest, MCPResponse } from './mcp/mcp-server.js'
export type {
  MCPTransport,
  MCPServerConfig,
  MCPToolDescriptor,
  MCPToolParameter,
  MCPToolResult,
  MCPConnectionState,
  MCPServerStatus,
} from './mcp/mcp-types.js'
export type { DeferredLoaderConfig } from './mcp/deferred-loader.js'

// --- Security ---
export { createRiskClassifier } from './security/risk-classifier.js'
export type { RiskTier, RiskClassification, RiskClassifierConfig, RiskClassifier } from './security/risk-classifier.js'
export {
  DEFAULT_AUTO_APPROVE_TOOLS,
  DEFAULT_LOG_TOOLS,
  DEFAULT_REQUIRE_APPROVAL_TOOLS,
} from './security/tool-permission-tiers.js'
export { scanForSecrets, redactSecrets } from './security/secrets-scanner.js'
export type { SecretMatch, ScanResult } from './security/secrets-scanner.js'
export { detectPII, redactPII } from './security/pii-detector.js'
export type { PIIType, PIIMatch, PIIDetectionResult } from './security/pii-detector.js'
export { OutputPipeline, createDefaultPipeline } from './security/output-pipeline.js'
export type { SanitizationStage, OutputPipelineConfig, PipelineResult } from './security/output-pipeline.js'

// --- Observability ---
export { MetricsCollector, globalMetrics } from './observability/metrics-collector.js'
export type { MetricType } from './observability/metrics-collector.js'
export { HealthAggregator } from './observability/health-aggregator.js'
export type { HealthStatus, HealthCheck, HealthReport, HealthCheckFn } from './observability/health-aggregator.js'

// --- Concurrency ---
export { Semaphore } from './concurrency/semaphore.js'
export { ConcurrencyPool } from './concurrency/pool.js'
export type { PoolConfig, PoolStats } from './concurrency/pool.js'

// --- Output ---
export type { OutputFormat, FormatAdapter, FormatValidationResult } from './output/format-adapter.js'
export { FORMAT_ADAPTERS, validateFormat, detectFormat } from './output/format-adapter.js'

// --- i18n ---
export type { Locale, LocaleConfig, LocaleStrings } from './i18n/locale-manager.js'
export { EN_STRINGS, LocaleManager } from './i18n/locale-manager.js'

// --- Config ---
export {
  DEFAULT_CONFIG,
  loadEnvConfig,
  loadFileConfig,
  mergeConfigs,
  resolveConfig,
  validateConfig,
  getConfigValue,
} from './config/index.js'
export type {
  ForgeConfig,
  ProviderConfig,
  RateLimitConfig,
  ConfigLayer,
} from './config/index.js'

// --- Version ---
export const FORGEAGENT_CORE_VERSION = '0.1.0'

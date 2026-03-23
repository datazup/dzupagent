/**
 * @forgeagent/core — Base agent infrastructure
 *
 * Reusable LLM agent engine: model registry, prompt management,
 * memory, context engineering, middleware, persistence, routing,
 * streaming, sub-agents, and skills.
 */

// --- LLM ---
export { ModelRegistry } from './llm/model-registry.js'
export type { LLMProviderConfig, ModelTier, ModelSpec, ModelOverrides, ModelFactory } from './llm/model-config.js'
export { invokeWithTimeout, extractTokenUsage } from './llm/invoke.js'
export type { TokenUsage, InvokeOptions } from './llm/invoke.js'
export { isTransientError, DEFAULT_RETRY_CONFIG } from './llm/retry.js'
export type { RetryConfig } from './llm/retry.js'
export { applyAnthropicCacheControl, applyCacheBreakpoints } from './llm/prompt-cache.js'

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

// --- Memory ---
export { createStore } from './memory/store-factory.js'
export type { StoreConfig } from './memory/store-factory.js'
export { MemoryService } from './memory/memory-service.js'
export type { NamespaceConfig, FormatOptions } from './memory/memory-types.js'
export { sanitizeMemoryContent, stripInvisibleUnicode } from './memory/memory-sanitizer.js'
export type { SanitizeResult } from './memory/memory-sanitizer.js'
export { consolidateNamespace, consolidateAll } from './memory/memory-consolidation.js'
export type { ConsolidationConfig, ConsolidationResult } from './memory/memory-consolidation.js'

// --- Context ---
export {
  shouldSummarize,
  summarizeAndTrim,
  formatSummaryContext,
  pruneToolResults,
  repairOrphanedToolPairs,
} from './context/message-manager.js'
export type { MessageManagerConfig } from './context/message-manager.js'
export { scoreCompleteness } from './context/completeness-scorer.js'
export type { CompletenessResult, DescriptionInput } from './context/completeness-scorer.js'
export { evictIfNeeded } from './context/context-eviction.js'
export type { EvictionConfig, EvictionResult } from './context/context-eviction.js'

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
export type { SubAgentConfig, SubAgentResult } from './subagent/subagent-types.js'
export { mergeFileChanges, fileDataReducer } from './subagent/file-merge.js'

// --- Skills ---
export { SkillLoader } from './skills/skill-loader.js'
export { injectSkills } from './skills/skill-injector.js'
export type { SkillDefinition } from './skills/skill-types.js'
export { SkillManager } from './skills/skill-manager.js'
export type { SkillManagerConfig, CreateSkillInput, PatchSkillInput, SkillWriteResult } from './skills/skill-manager.js'

// --- Version ---
export const FORGEAGENT_CORE_VERSION = '0.1.0'

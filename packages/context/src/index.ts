/**
 * @dzupagent/context — Context window engineering for LLM conversations.
 *
 * Provides message compression, tool result pruning, structured summarization,
 * context eviction, system reminders, completeness scoring, auto-compression
 * pipeline, and Anthropic prompt cache optimization.
 */

// --- Message Management ---
export {
  shouldSummarize,
  summarizeAndTrim,
  formatSummaryContext,
  pruneToolResults,
  repairOrphanedToolPairs,
} from './message-manager.js'
export type { MessageManagerConfig } from './message-manager.js'

// --- Auto-Compression Pipeline ---
export { autoCompress, FrozenSnapshot } from './auto-compress.js'
export type { AutoCompressConfig, CompressResult } from './auto-compress.js'

// --- Snapshot Builder ---
export { buildFrozenSnapshot } from './snapshot-builder.js'
export type {
  MemoryServiceLike,
  BuildFrozenSnapshotOptions,
} from './snapshot-builder.js'

// --- Extraction Bridge ---
export { createExtractionHook } from './extraction-bridge.js'
export type { MessageExtractionFn } from './extraction-bridge.js'

// --- Completeness Scoring ---
export { scoreCompleteness } from './completeness-scorer.js'
export type { CompletenessResult, DescriptionInput } from './completeness-scorer.js'

// --- Context Eviction ---
export { evictIfNeeded } from './context-eviction.js'
export type { EvictionConfig, EvictionResult } from './context-eviction.js'

// --- System Reminders ---
export { SystemReminderInjector } from './system-reminder.js'
export type { SystemReminderConfig, ReminderContent } from './system-reminder.js'

// --- Phase-Aware Windowing ---
export { PhaseAwareWindowManager, DEFAULT_PHASES } from './phase-window.js'
export type {
  ConversationPhase,
  PhaseConfig,
  MessageRetention,
  PhaseDetection,
  PhaseWindowConfig,
} from './phase-window.js'

// --- Progressive Compression ---
export { compressToLevel, compressToBudget, selectCompressionLevel } from './progressive-compress.js'
export type { CompressionLevel, ProgressiveCompressConfig, ProgressiveCompressResult } from './progressive-compress.js'

// --- Prompt Cache ---
export { applyAnthropicCacheControl, applyCacheBreakpoints } from './prompt-cache.js'

// --- Context Transfer ---
export { ContextTransferService } from './context-transfer.js'
export type {
  IntentContext,
  IntentType,
  ContextTransferConfig,
  IntentRelevanceRule,
  TransferScope,
} from './context-transfer.js'

// --- Token Lifecycle ---
export { TokenLifecycleManager, createTokenBudget } from './token-lifecycle.js'
export type {
  TokenBudget,
  TokenPhaseUsage,
  TokenLifecycleConfig,
  TokenLifecycleStatus,
  TokenLifecycleReport,
} from './token-lifecycle.js'

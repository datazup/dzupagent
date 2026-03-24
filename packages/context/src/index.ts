/**
 * @forgeagent/context — Context window engineering for LLM conversations.
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

// --- Completeness Scoring ---
export { scoreCompleteness } from './completeness-scorer.js'
export type { CompletenessResult, DescriptionInput } from './completeness-scorer.js'

// --- Context Eviction ---
export { evictIfNeeded } from './context-eviction.js'
export type { EvictionConfig, EvictionResult } from './context-eviction.js'

// --- System Reminders ---
export { SystemReminderInjector } from './system-reminder.js'
export type { SystemReminderConfig, ReminderContent } from './system-reminder.js'

// --- Prompt Cache ---
export { applyAnthropicCacheControl, applyCacheBreakpoints } from './prompt-cache.js'

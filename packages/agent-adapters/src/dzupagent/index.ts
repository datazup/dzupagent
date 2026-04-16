/**
 * @dzupagent/agent-adapters — Unified Capability Layer
 *
 * File-based knowledge portability for agent adapters.
 * Reads .dzupagent/ skill/memory/agent definitions and injects them
 * into any adapter at runtime via system prompt compilation.
 */

export { WorkspaceResolver } from './workspace-resolver.js'
export { loadDzupAgentConfig, getCodexMemoryStrategy, getMaxMemoryTokens } from './config.js'
export { parseMarkdownFile } from './md-frontmatter-parser.js'
export type { ParsedFrontmatter, ParsedSection, ParsedMarkdownFile, FrontmatterValue } from './md-frontmatter-parser.js'
export { DzupAgentFileLoader } from './file-loader.js'
export type { FileLoaderOptions, ParsedSkillFile } from './file-loader.js'
export { DzupAgentMemoryLoader } from './memory-loader.js'
export type { MemoryEntry, DzupAgentMemoryLoaderOptions, MemoryLevel } from './memory-loader.js'
export { DzupAgentImporter } from './importer.js'
export type { ImportPlan, ImportResult, ImportSource, DzupAgentImporterOptions } from './importer.js'
export { DzupAgentAgentLoader, agentDefinitionsToSupervisorConfig } from './agent-loader.js'
export type { AgentDefinition, DzupAgentAgentLoaderOptions } from './agent-loader.js'
export { DzupAgentSyncer } from './syncer.js'
export type {
  SyncPlan,
  SyncPlanEntry,
  SyncDivergedEntry,
  SyncResult,
  SyncResultWritten,
  SyncResultSkipped,
  SyncResultDiverged,
  SyncTarget,
  DzupAgentSyncerOptions,
} from './syncer.js'

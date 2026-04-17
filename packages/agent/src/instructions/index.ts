/**
 * AGENTS.md instructions module.
 *
 * Provides parsing, loading, and merging of AGENTS.md files
 * for hierarchical agent configuration.
 */

export { parseAgentsMd, mergeAgentsMd, discoverAgentsMdHierarchy } from './agents-md-parser.js'
export type { AgentsMdSection } from './agents-md-parser.js'

export { mergeInstructions } from './instruction-merger.js'
export type { MergedInstructions } from './instruction-merger.js'

export { loadAgentsFiles } from './instruction-loader.js'
export type { LoadedAgentsFile, LoadAgentsOptions } from './instruction-loader.js'

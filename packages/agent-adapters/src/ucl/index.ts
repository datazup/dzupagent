/**
 * Unified Capability Layer (UCL) — public barrel export.
 *
 * This module provides lightweight, dependency-free loaders for the
 * `.dzupagent/` canonical store. They can be used standalone or composed
 * with the existing `AdapterSkillRegistry`, `withMemoryEnrichment`
 * middleware, and `SupervisorOrchestrator`.
 */

export type {
  UclSkillFrontmatter,
  UclAgentFrontmatter,
  UclMemoryFrontmatter,
  UclStateFile,
} from './types.js'

export { parseFrontmatter } from './frontmatter-parser.js'
export type {
  ParsedMarkdown,
  FrontmatterScalar,
  FrontmatterValue,
} from './frontmatter-parser.js'

export { DzupAgentSkillLoader } from './skill-loader.js'

export { DzupAgentMemoryLoader } from './memory-loader.js'
export type { MemoryLoadLevels, MemoryLoadOptions } from './memory-loader.js'

export { DzupAgentAgentLoader } from './agent-loader.js'
export type { LoadedAgentDefinition } from './agent-loader.js'

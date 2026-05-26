/**
 * @dzupagent/agent-adapters/skills — adapter skill registry, capability matrix,
 * and related bundle/compiled-skill contracts.
 *
 * Use this subpath when introspecting or registering skills against a
 * provider matrix without pulling in the full agent-adapters root surface.
 */

export {
  AdapterSkillRegistry,
  createDefaultSkillRegistry,
} from './skills/adapter-skill-registry.js'
export {
  SkillCapabilityMatrixBuilder,
} from './skills/skill-capability-matrix.js'
export { ClaudeSkillCompiler } from './skills/compilers/claude-skill-compiler.js'
export type {
  CapabilityStatus,
  ProviderCapabilityRow,
  SkillCapabilityMatrix,
} from './skills/skill-capability-matrix.js'
export type {
  AdapterSkillBundle,
  CompiledAdapterSkill,
  AdapterSkillCompiler,
  ProjectionUsageRecord,
} from './skills/adapter-skill-types.js'
// AdapterProviderId is reused across skill/runtime surfaces — re-exported
// from the canonical types module to make this subpath self-sufficient.
export type { AdapterProviderId } from './types.js'

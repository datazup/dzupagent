/**
 * SkillPacks — pre-built skill configurations for common feature types.
 *
 * Provides bootstrap data so a brand-new system starts with curated skills,
 * conventions, and rules rather than zero learned knowledge. Entries are
 * stored in the same namespaces that LessonPipeline, DynamicRuleEngine,
 * and SkillAcquisitionEngine read from, so they integrate seamlessly.
 *
 * Usage:
 *   const loader = new SkillPackLoader(store)
 *   await loader.loadAllBuiltIn()
 *   // Skills, rules, and conventions are now available for retrieval
 *
 * This file is a thin re-export barrel. Implementations live in:
 *  - skill-packs-types.ts        (types, namespace constants, record builders)
 *  - skill-packs-definitions.ts  (BUILT_IN_PACKS array)
 *  - skill-packs-loader.ts       (SkillPackLoader class)
 */

export type { SkillPack, SkillPackEntry } from './skill-packs-types.js'
export { BUILT_IN_PACKS } from './skill-packs-definitions.js'
export { SkillPackLoader } from './skill-packs-loader.js'

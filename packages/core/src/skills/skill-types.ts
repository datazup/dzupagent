export interface SkillDefinition {
  name: string
  description: string
  path: string
  compatibility?: string | undefined
  allowedTools?: string[] | undefined
  metadata?: Record<string, unknown> | undefined
}

// ---------------------------------------------------------------------------
// Registry types (SKILLS-1)
// ---------------------------------------------------------------------------

/** A skill definition for the registry — a specialized capability with instructions and tool access */
export interface SkillRegistryEntry {
  /** Unique identifier (kebab-case) */
  id: string
  /** Human-readable name */
  name: string
  /** Short description of the skill's purpose */
  description: string
  /** Category for grouping (e.g., 'database', 'frontend', 'security') */
  category?: string | undefined
  /** Version (semver) */
  version?: string | undefined
  /** Instructions injected into system prompt when skill is active */
  instructions: string
  /** Tools this skill needs access to */
  requiredTools?: string[] | undefined
  /** Tags for matching to tasks */
  tags?: string[] | undefined
  /** Priority when multiple skills match (higher = preferred) */
  priority?: number | undefined
}

/** A loaded skill with metadata, tracked by the SkillRegistry */
export interface LoadedSkill extends SkillRegistryEntry {
  /** Source path where this skill was loaded from */
  sourcePath?: string | undefined
  /** Epoch ms when the skill was loaded */
  loadedAt: number
}

/** Skill match result from registry search */
export interface SkillMatch {
  skill: LoadedSkill
  /** Match confidence 0-1 */
  confidence: number
  /** Why this skill matched */
  reason: string
}

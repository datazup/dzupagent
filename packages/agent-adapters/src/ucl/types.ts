/**
 * Unified Capability Layer (UCL) — core type definitions.
 *
 * These types describe the schema of `.dzupagent/` files:
 *   - skills/*.md    → `UclSkillFrontmatter`
 *   - agents/*.md    → `UclAgentFrontmatter`
 *   - memory/*.md    → `UclMemoryFrontmatter`
 *   - state.json     → `UclStateFile`
 *
 * Conforms to requirements FR-1..FR-5 in
 * `docs/dzupagent/adapters/UNIFIED_CAPABILITY_LAYER_REQUIREMENTS.md`.
 */

/** Frontmatter schema for `.dzupagent/skills/*.md` files (FR-1). */
export interface UclSkillFrontmatter {
  name: string
  description: string
  version: number
  owner?: string
  constraints?: {
    maxBudgetUsd?: number
    approvalMode?: 'auto' | 'required' | 'conditional'
    networkPolicy?: 'off' | 'restricted' | 'on'
    toolPolicy?: 'strict' | 'balanced' | 'open'
  }
  tools?: {
    required?: string[]
    optional?: string[]
    blocked?: string[]
  }
}

/** Frontmatter schema for `.dzupagent/agents/*.md` files (FR-3). */
export interface UclAgentFrontmatter {
  name: string
  description: string
  version: number
  preferredProvider?: string
  skills?: string[]
  memoryScope?: 'global' | 'workspace' | 'project'
  constraints?: Record<string, unknown>
}

/** Frontmatter schema for `.dzupagent/memory/*.md` files (FR-2). */
export interface UclMemoryFrontmatter {
  name: string
  description: string
  type: 'global' | 'workspace' | 'project'
  tags?: string[]
  createdAt?: string
  importedFrom?: string
}

/** Schema of `.dzupagent/state.json` (FR-5). */
export interface UclStateFile {
  version: number
  lastSync: string
  files: Record<
    string,
    {
      hash: string
      generatedNative?: Record<string, { hash: string; syncedAt: string }>
    }
  >
}

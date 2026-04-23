export type PersonaRoleType =
  | 'architect'
  | 'backend_dev'
  | 'frontend_dev'
  | 'tester'
  | 'designer'
  | 'data_modeler'
  | 'devops'
  | 'security'
  | 'analyst'
  | 'custom'

/**
 * High-level description of a feature to be built.
 * Produced by the brainstorming / decomposition phase.
 */
export interface FeatureBrief {
  id: string
  title: string
  /** Problem statement this feature solves */
  problem: string
  /** Constraints (technical, business, time) */
  constraints: string[]
  /** Measurable acceptance criteria */
  acceptanceCriteria: string[]
  /** Priority level */
  priority: 'critical' | 'high' | 'medium' | 'low'
  /** Who created this brief */
  createdBy: string
  createdAt: number
  updatedAt: number
}

/**
 * A single unit of work derived from a FeatureBrief.
 * Assigned to a PersonaProfile for execution.
 */
export interface WorkItem {
  id: string
  /** Parent feature */
  featureId: string
  title: string
  description: string
  /** IDs of WorkItems that must complete before this one */
  dependsOn: string[]
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled'
  /** Rough story-point estimate */
  estimate?: number | undefined
  /** Assigned persona ID */
  assignedPersonaId?: string | undefined
  createdAt: number
  updatedAt: number
}

/**
 * A reusable role definition that can be assigned to WorkItems.
 * Maps to a set of Skills and a set of guardrails.
 */
export interface PersonaProfile {
  id: string
  name: string
  roleType: PersonaRoleType
  description: string
  /** High-level capability tags (e.g., 'sql', 'react', 'testing') */
  capabilities: string[]
  /** Skill tags this persona prefers */
  preferredTags: string[]
  /** Hard guardrails: things this persona must/must not do */
  guardrails: string[]
  createdAt: number
  updatedAt: number
}

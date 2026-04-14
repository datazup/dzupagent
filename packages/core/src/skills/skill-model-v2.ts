/**
 * Canonical domain model for skill/persona lifecycle management (V2).
 *
 * Defines the shared entities used across codegen, agent, and adapter layers:
 *   FeatureBrief → WorkItem → PersonaProfile → SkillDefinitionV2
 *
 * Also defines tracking entities:
 *   SkillUsageRecord — per-execution telemetry
 *   SkillReviewRecord — quality gate outcomes
 *
 * And the lifecycle state machine:
 *   draft → proposed → approved → active → deprecated → archived
 */

// ---------------------------------------------------------------------------
// Lifecycle state machine
// ---------------------------------------------------------------------------

/**
 * Skill lifecycle status following the state machine:
 *   draft → proposed → approved → active → deprecated → archived
 *
 * Allowed transitions:
 *   add:       create as `draft`
 *   propose:   `draft` → `proposed`
 *   approve:   `proposed` → `approved`
 *   reject:    `proposed` → `draft`
 *   activate:  `approved` → `active`
 *   deprecate: `active` → `deprecated`
 *   archive:   `deprecated` → `archived`
 */
export type SkillLifecycleStatus =
  | 'draft'
  | 'proposed'
  | 'approved'
  | 'active'
  | 'deprecated'
  | 'archived'

/** Valid lifecycle transitions map */
export const SKILL_LIFECYCLE_TRANSITIONS: Record<SkillLifecycleStatus, SkillLifecycleStatus[]> = {
  draft: ['proposed'],
  proposed: ['approved', 'draft'],
  approved: ['active', 'draft'],
  active: ['deprecated'],
  deprecated: ['archived'],
  archived: [],
}

/** Check if a transition is allowed. */
export function isValidSkillTransition(
  from: SkillLifecycleStatus,
  to: SkillLifecycleStatus,
): boolean {
  return SKILL_LIFECYCLE_TRANSITIONS[from].includes(to)
}

// ---------------------------------------------------------------------------
// Scope of a skill
// ---------------------------------------------------------------------------

/**
 * Where a skill is applied at runtime.
 *
 * - `prompt_injection`  — instructions appended to the system prompt
 * - `tool_config`       — additional tool permissions/configuration
 * - `pipeline_config`   — phase-level codegen pipeline configuration
 * - `adapter_projection`— provider-specific adapter config overlay
 */
export type SkillScope =
  | 'prompt_injection'
  | 'tool_config'
  | 'pipeline_config'
  | 'adapter_projection'

// ---------------------------------------------------------------------------
// Persona role types & feature/work-item domain model
// Moved to @dzupagent/runtime-contracts — re-exported here for backwards compat
// ---------------------------------------------------------------------------

export type {
  PersonaRoleType,
  FeatureBrief,
  WorkItem,
  PersonaProfile,
} from '@dzupagent/runtime-contracts'

// ---------------------------------------------------------------------------
// Canonical skill definition V2
// ---------------------------------------------------------------------------

/**
 * Review policy controlling when automatic review is triggered.
 */
export interface SkillReviewPolicy {
  /** Trigger review when success rate falls below this threshold (0-1) */
  minSuccessRate?: number | undefined
  /** Trigger review after this many executions */
  reviewAfterExecutions?: number | undefined
  /** Whether a human reviewer must approve activation */
  requireHumanApproval?: boolean | undefined
}

/**
 * Full canonical skill definition — used for lifecycle management,
 * versioning, and cross-package sharing.
 *
 * Extends the lighter `SkillRegistryEntry` with ownership, lifecycle state,
 * version history, and policy metadata.
 */
export interface SkillDefinitionV2 {
  id: string
  name: string
  description: string
  /** Persona this skill was created for (optional) */
  personaId?: string | undefined
  /** Where/how this skill is applied at runtime */
  scope: SkillScope
  /** The actual skill content (prompt text, config JSON, etc.) */
  content: string
  /** Semver string */
  version: string
  /** Lifecycle status */
  status: SkillLifecycleStatus
  /** Who owns this skill */
  owner: string
  /** Review policy for this skill */
  reviewPolicy?: SkillReviewPolicy | undefined
  /** Category for grouping */
  category?: string | undefined
  /** Tags for matching */
  tags?: string[] | undefined
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Tracking entities
// ---------------------------------------------------------------------------

/**
 * Per-execution telemetry record for a skill.
 * Enables usage analytics and quality monitoring.
 */
export interface SkillUsageRecord {
  skillId: string
  /** Skill version at time of use */
  version: string
  runId: string
  workflowId?: string | undefined
  taskId?: string | undefined
  featureId?: string | undefined
  personaId?: string | undefined
  providerId?: string | undefined
  /** Whether the execution succeeded */
  success: boolean
  /** Token cost for this execution */
  cost?: number | undefined
  /** Duration in ms */
  latencyMs: number
  /** Quality score 0-1 if available */
  quality?: number | undefined
  timestamp: number
}

/**
 * Record of a skill quality review (manual or automated).
 */
export interface SkillReviewRecord {
  skillId: string
  /** Skill version under review */
  version: string
  /** Who triggered the review */
  reviewType: 'manual' | 'auto'
  /** List of findings / issues found */
  findings: string[]
  /** Review outcome */
  decision: 'approved' | 'rejected' | 'needs_changes'
  /** Reviewer identity (user ID or system) */
  reviewer: string
  timestamp: number
}

// ---------------------------------------------------------------------------
// Skill resolution context
// ---------------------------------------------------------------------------

/**
 * Context used during codegen pipeline execution to resolve which
 * skills to inject into a phase.
 */
export interface SkillResolutionContext {
  featureId?: string | undefined
  taskId?: string | undefined
  /** Codegen pipeline phase name */
  phase: string
  personaId?: string | undefined
  /** Risk classification of the work item */
  riskClass?: 'low' | 'medium' | 'high' | 'critical' | undefined
}

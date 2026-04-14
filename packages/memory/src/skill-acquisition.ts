/**
 * SkillAcquisitionEngine — crystallize high-confidence patterns into reusable skills.
 *
 * Monitors LessonPipeline and DynamicRuleEngine for high-confidence, frequently
 * applied patterns and crystallizes them into structured "acquired skills" that
 * can be injected into future generations via prompt injection.
 *
 * No LLM calls — pure filtering, dedup, and formatting.
 *
 * Usage:
 *   const engine = new SkillAcquisitionEngine({ store })
 *   const newSkills = await engine.scan({ lessons, rules })
 *   const applicable = await engine.getApplicableSkills({ nodeId: 'gen_backend' })
 *   const prompt = engine.formatForPrompt(applicable)
 */
import type { BaseStore } from '@langchain/langgraph'
import { tokenizeText, jaccardSimilarity } from './shared/text-similarity.js'
import { createTimestampedId } from './shared/id-factory.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How a skill should be applied */
export type SkillApplicationType = 'prompt_injection' | 'tool_config' | 'pipeline_config'

/** Evidence supporting an acquired skill */
export interface SkillEvidence {
  lessonIds: string[]
  ruleIds: string[]
  successRate: number
  usageCount: number
}

/** A crystallized skill derived from lessons and rules */
export interface AcquiredSkill {
  id: string
  name: string
  description: string
  /** When this skill should auto-activate */
  applicableWhen: string
  /** How to apply: prompt injection, tool config, or pipeline config */
  applicationType: SkillApplicationType
  /** The actual skill content (prompt text, config JSON, etc.) */
  content: string
  /** Evidence: how this skill was derived */
  evidence: SkillEvidence
  /** Confidence in this skill (0-1) */
  confidence: number
  createdAt: Date
  lastUsedAt?: Date | undefined
}

export interface SkillAcquisitionConfig {
  store: BaseStore
  namespace?: string[] | undefined
  /** Min lesson/rule confidence to consider for crystallization (default: 0.8) */
  minConfidence?: number | undefined
  /** Min usage count before crystallizing (default: 3) */
  minUsageCount?: number | undefined
  /** Min success rate to crystallize (default: 0.75) */
  minSuccessRate?: number | undefined
  /** Max skills to keep (default: 50) */
  maxSkills?: number | undefined
}

/** Input lesson shape for scan() */
export interface ScanLesson {
  id: string
  summary: string
  confidence: number
  applyCount: number
  type: string
}

/** Input rule shape for scan() */
export interface ScanRule {
  id: string
  content: string
  confidence: number
  applyCount: number
  successRate: number
  scope: string[]
}

export interface ScanParams {
  lessons: ScanLesson[]
  rules: ScanRule[]
}

export interface GetApplicableParams {
  nodeId?: string | undefined
  taskType?: string | undefined
}

/** Extract a short name from the first 5 words of a description */
function nameFromDescription(description: string): string {
  return description
    .split(/\s+/)
    .slice(0, 5)
    .join(' ')
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/** Convert an AcquiredSkill to a plain record for BaseStore */
function skillToRecord(skill: AcquiredSkill): Record<string, unknown> {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    applicableWhen: skill.applicableWhen,
    applicationType: skill.applicationType,
    content: skill.content,
    evidence: skill.evidence,
    confidence: skill.confidence,
    createdAt: skill.createdAt.toISOString(),
    lastUsedAt: skill.lastUsedAt?.toISOString() ?? null,
    // text field for searchability
    text: `${skill.name} ${skill.description} ${skill.content}`,
  }
}

/** Reconstruct an AcquiredSkill from a plain store record */
function recordToSkill(value: Record<string, unknown>): AcquiredSkill | null {
  if (typeof value['id'] !== 'string' || typeof value['content'] !== 'string') {
    return null
  }
  const evidence = value['evidence'] as SkillEvidence | undefined
  return {
    id: value['id'] as string,
    name: (value['name'] as string) ?? '',
    description: (value['description'] as string) ?? '',
    applicableWhen: (value['applicableWhen'] as string) ?? '',
    applicationType: (value['applicationType'] as SkillApplicationType) ?? 'prompt_injection',
    content: value['content'] as string,
    evidence: evidence ?? { lessonIds: [], ruleIds: [], successRate: 0, usageCount: 0 },
    confidence: typeof value['confidence'] === 'number' ? value['confidence'] : 0.5,
    createdAt: typeof value['createdAt'] === 'string' ? new Date(value['createdAt']) : new Date(),
    lastUsedAt: typeof value['lastUsedAt'] === 'string' ? new Date(value['lastUsedAt']) : undefined,
  }
}

// ---------------------------------------------------------------------------
// SkillAcquisitionEngine
// ---------------------------------------------------------------------------

export class SkillAcquisitionEngine {
  private readonly store: BaseStore
  private readonly namespace: string[]
  private readonly minConfidence: number
  private readonly minUsageCount: number
  private readonly minSuccessRate: number
  private readonly maxSkills: number

  constructor(config: SkillAcquisitionConfig) {
    this.store = config.store
    this.namespace = config.namespace ?? ['acquired_skills']
    this.minConfidence = config.minConfidence ?? 0.8
    this.minUsageCount = config.minUsageCount ?? 3
    this.minSuccessRate = config.minSuccessRate ?? 0.75
    this.maxSkills = config.maxSkills ?? 50
  }

  // ---------- scan -----------------------------------------------------------

  /**
   * Scan lessons and rules for crystallization candidates.
   * Call periodically (e.g., after PostRunAnalyzer).
   *
   * Returns newly created skills from this scan.
   */
  async scan(params: ScanParams): Promise<AcquiredSkill[]> {
    const { lessons, rules } = params
    const newSkills: AcquiredSkill[] = []

    // Filter qualifying lessons
    const qualifyingLessons = lessons.filter(
      l => l.confidence >= this.minConfidence && l.applyCount >= this.minUsageCount,
    )

    // Filter qualifying rules
    const qualifyingRules = rules.filter(
      r =>
        r.confidence >= this.minConfidence &&
        r.successRate >= this.minSuccessRate &&
        r.applyCount >= this.minUsageCount,
    )

    // Load existing skills for dedup
    const existing = await this.loadAllSkills()

    // Crystallize from lessons
    for (const lesson of qualifyingLessons) {
      const description = lesson.summary
      const content = lesson.summary
      const applicableWhen = lesson.type

      // Check dedup against existing skills
      if (this.isDuplicate(content, existing)) continue

      const skill: AcquiredSkill = {
        id: createTimestampedId('skill'),
        name: nameFromDescription(description),
        description,
        applicableWhen,
        applicationType: 'prompt_injection',
        content,
        evidence: {
          lessonIds: [lesson.id],
          ruleIds: [],
          successRate: lesson.confidence,
          usageCount: lesson.applyCount,
        },
        confidence: lesson.confidence,
        createdAt: new Date(),
      }

      existing.push(skill)
      newSkills.push(skill)
    }

    // Crystallize from rules
    for (const rule of qualifyingRules) {
      const description = rule.content
      const content = rule.content
      const applicableWhen = rule.scope.join(', ')

      // Check dedup against existing + newly created skills
      if (this.isDuplicate(content, existing)) continue

      const skill: AcquiredSkill = {
        id: createTimestampedId('skill'),
        name: nameFromDescription(description),
        description,
        applicableWhen,
        applicationType: 'prompt_injection',
        content,
        evidence: {
          lessonIds: [],
          ruleIds: [rule.id],
          successRate: rule.successRate,
          usageCount: rule.applyCount,
        },
        confidence: rule.confidence,
        createdAt: new Date(),
      }

      existing.push(skill)
      newSkills.push(skill)
    }

    // Store new skills
    for (const skill of newSkills) {
      try {
        await this.store.put(this.namespace, skill.id, skillToRecord(skill))
      } catch {
        // Non-fatal — skill storage failures should not break pipelines
      }
    }

    // Prune if exceeding maxSkills
    await this.pruneIfNeeded()

    return newSkills
  }

  // ---------- getSkills ------------------------------------------------------

  /**
   * Get all acquired skills.
   */
  async getSkills(): Promise<AcquiredSkill[]> {
    return this.loadAllSkills()
  }

  // ---------- getApplicableSkills --------------------------------------------

  /**
   * Get skills applicable to a given context.
   * Matches nodeId or taskType against the skill's applicableWhen field.
   */
  async getApplicableSkills(params: GetApplicableParams): Promise<AcquiredSkill[]> {
    const { nodeId, taskType } = params
    const allSkills = await this.loadAllSkills()

    if (!nodeId && !taskType) return allSkills

    return allSkills.filter(skill => {
      const when = skill.applicableWhen.toLowerCase()
      if (nodeId && when.includes(nodeId.toLowerCase())) return true
      if (taskType && when.includes(taskType.toLowerCase())) return true
      return false
    })
  }

  // ---------- formatForPrompt ------------------------------------------------

  /**
   * Format applicable skills as a markdown prompt section.
   */
  formatForPrompt(skills: AcquiredSkill[]): string {
    if (skills.length === 0) return ''

    const lines = skills.map(skill => `- [${skill.name}]: ${skill.content}`)

    return `## Acquired Skills\n\n${lines.join('\n')}`
  }

  // ---------- markUsed -------------------------------------------------------

  /**
   * Record that a skill was used. Updates lastUsedAt.
   */
  async markUsed(skillId: string): Promise<void> {
    try {
      const item = await this.store.get(this.namespace, skillId)
      if (!item) return

      const value = item.value as Record<string, unknown>
      const skill = recordToSkill(value)
      if (!skill) return

      skill.lastUsedAt = new Date()
      await this.store.put(this.namespace, skillId, skillToRecord(skill))
    } catch {
      // Non-fatal — marking used is best-effort
    }
  }

  // ---------- removeSkill ----------------------------------------------------

  /**
   * Remove a skill (e.g., if it causes regressions).
   */
  async removeSkill(skillId: string): Promise<void> {
    try {
      await this.store.delete(this.namespace, skillId)
    } catch {
      // Non-fatal
    }
  }

  // ---------- count ----------------------------------------------------------

  /**
   * Count total acquired skills.
   */
  async count(): Promise<number> {
    try {
      const items = await this.store.search(this.namespace, { limit: 1000 })
      return items.length
    } catch {
      return 0
    }
  }

  // ---------- Internal -------------------------------------------------------

  /**
   * Load all skills from the store.
   */
  private async loadAllSkills(): Promise<AcquiredSkill[]> {
    try {
      const items = await this.store.search(this.namespace, { limit: 1000 })
      const skills: AcquiredSkill[] = []
      for (const item of items) {
        const skill = recordToSkill(item.value as Record<string, unknown>)
        if (skill) skills.push(skill)
      }
      return skills
    } catch {
      return []
    }
  }

  /**
   * Check whether content is a duplicate of any existing skill (Jaccard > 0.7).
   */
  private isDuplicate(content: string, existing: AcquiredSkill[]): boolean {
    const newTokens = tokenizeText(content)
    for (const skill of existing) {
      const existingTokens = tokenizeText(skill.content)
      if (jaccardSimilarity(newTokens, existingTokens) > 0.7) {
        return true
      }
    }
    return false
  }

  /**
   * Prune skills if total exceeds maxSkills. Removes lowest-confidence first.
   */
  private async pruneIfNeeded(): Promise<void> {
    try {
      const allSkills = await this.loadAllSkills()
      if (allSkills.length <= this.maxSkills) return

      // Sort ascending by confidence so we can remove from the front
      allSkills.sort((a, b) => a.confidence - b.confidence)

      const toRemove = allSkills.length - this.maxSkills
      for (let i = 0; i < toRemove; i++) {
        const skill = allSkills[i]
        if (skill) await this.store.delete(this.namespace, skill.id)
      }
    } catch {
      // Non-fatal
    }
  }
}

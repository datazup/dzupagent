/**
 * SkillPack types and namespace constants used by the loader and definitions.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillPackEntry {
  type: 'skill' | 'convention' | 'rule'
  content: string
  category?: string | undefined
  scope?: string[] | undefined
  confidence: number
}

export interface SkillPack {
  id: string
  name: string
  description: string
  featureCategory: string
  version: string
  entries: SkillPackEntry[]
}

// ---------------------------------------------------------------------------
// Namespace constants — match the default namespaces used by the engines
// ---------------------------------------------------------------------------

export const SKILLS_NAMESPACE = ['acquired_skills']
export const RULES_NAMESPACE = ['rules']
export const CONVENTIONS_NAMESPACE = ['conventions']
export const PACKS_META_NAMESPACE = ['skill_packs_meta']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a deterministic entry key from pack ID, type, and index */
export function entryKey(packId: string, type: string, index: number): string {
  return `${packId}_${type}_${index}`
}

/** Get the target namespace for an entry type */
export function namespaceForType(type: 'skill' | 'convention' | 'rule'): string[] {
  switch (type) {
    case 'skill': return SKILLS_NAMESPACE
    case 'rule': return RULES_NAMESPACE
    case 'convention': return CONVENTIONS_NAMESPACE
  }
}

/** Build a skill record compatible with SkillAcquisitionEngine */
export function buildSkillRecord(
  key: string,
  entry: SkillPackEntry,
  packId: string,
): Record<string, unknown> {
  return {
    id: key,
    name: entry.content.split(/\s+/).slice(0, 5).join(' '),
    description: entry.content,
    applicableWhen: (entry.scope ?? []).join(', '),
    applicationType: 'prompt_injection',
    content: entry.content,
    evidence: {
      lessonIds: [],
      ruleIds: [],
      successRate: entry.confidence,
      usageCount: 0,
    },
    confidence: entry.confidence,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    source: 'skill_pack',
    packId,
    category: entry.category ?? null,
    text: entry.content,
  }
}

/** Build a rule record compatible with DynamicRuleEngine */
export function buildRuleRecord(
  key: string,
  entry: SkillPackEntry,
  packId: string,
): Record<string, unknown> {
  return {
    id: key,
    source: 'convention',
    content: entry.content,
    scope: entry.scope ?? [],
    confidence: entry.confidence,
    applyCount: 0,
    successRate: 1,
    createdAt: new Date().toISOString(),
    lastAppliedAt: null,
    packId,
    category: entry.category ?? null,
    text: entry.content,
  }
}

/** Build a convention record compatible with MemoryIntegrator */
export function buildConventionRecord(
  key: string,
  entry: SkillPackEntry,
  packId: string,
): Record<string, unknown> {
  return {
    id: key,
    content: entry.content,
    scope: entry.scope ?? [],
    confidence: entry.confidence,
    createdAt: new Date().toISOString(),
    packId,
    category: entry.category ?? null,
    text: entry.content,
  }
}

/** Build a store record for an entry based on its type */
export function buildRecord(
  key: string,
  entry: SkillPackEntry,
  packId: string,
): Record<string, unknown> {
  switch (entry.type) {
    case 'skill': return buildSkillRecord(key, entry, packId)
    case 'rule': return buildRuleRecord(key, entry, packId)
    case 'convention': return buildConventionRecord(key, entry, packId)
  }
}

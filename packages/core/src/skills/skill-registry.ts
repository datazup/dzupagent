/**
 * In-memory skill registry — register, search, and retrieve skill definitions.
 *
 * Skills are specialized capabilities (e.g., "Prisma Migrations", "Vue Components")
 * that agents can use. They include instructions, allowed tools, and context.
 *
 * The registry supports:
 * - Programmatic registration / unregistration
 * - Lookup by ID, category, or tags
 * - Priority-aware sorting for multi-match scenarios
 * - Prompt formatting for system-prompt injection
 */
import type { SkillRegistryEntry, LoadedSkill, SkillMatch } from './skill-types.js'

export class SkillRegistry {
  private readonly skills = new Map<string, LoadedSkill>()

  /** Register a skill definition. Overwrites any existing skill with the same id. */
  register(skill: SkillRegistryEntry, sourcePath?: string): void {
    if (!skill.id || !skill.name) {
      throw new Error(`SkillRegistry.register: skill must have both 'id' and 'name'`)
    }
    this.skills.set(skill.id, {
      ...skill,
      sourcePath,
      loadedAt: Date.now(),
    })
  }

  /** Unregister a skill by ID. Returns true if the skill existed. */
  unregister(id: string): boolean {
    return this.skills.delete(id)
  }

  /** Get a skill by ID, or undefined if not found. */
  get(id: string): LoadedSkill | undefined {
    return this.skills.get(id)
  }

  /** Check if a skill with this ID is registered. */
  has(id: string): boolean {
    return this.skills.has(id)
  }

  /** List all registered skills, ordered by priority descending then name ascending. */
  list(): LoadedSkill[] {
    return [...this.skills.values()].sort((a, b) => {
      const pDiff = (b.priority ?? 0) - (a.priority ?? 0)
      if (pDiff !== 0) return pDiff
      return a.name.localeCompare(b.name)
    })
  }

  /** List skills that belong to a specific category. */
  listByCategory(category: string): LoadedSkill[] {
    return this.list().filter(s => s.category === category)
  }

  /**
   * Find skills that match any of the provided tags.
   *
   * Returns SkillMatch[] sorted by priority (descending), then confidence (descending).
   * Confidence is calculated as: matchingTags / max(skillTags, queryTags).
   */
  findByTags(tags: string[]): SkillMatch[] {
    if (tags.length === 0) return []

    const tagSet = new Set(tags.map(t => t.toLowerCase()))
    const matches: SkillMatch[] = []

    for (const skill of this.skills.values()) {
      const skillTags = (skill.tags ?? []).map(t => t.toLowerCase())
      const matchingTags = skillTags.filter(t => tagSet.has(t))
      if (matchingTags.length > 0) {
        const confidence = matchingTags.length / Math.max(skillTags.length, tags.length)
        matches.push({
          skill,
          confidence,
          reason: `Matched tags: ${matchingTags.join(', ')}`,
        })
      }
    }

    return matches.sort((a, b) => {
      const pDiff = (b.skill.priority ?? 0) - (a.skill.priority ?? 0)
      if (pDiff !== 0) return pDiff
      return b.confidence - a.confidence
    })
  }

  /**
   * Find skills whose name or description contains the query string (case-insensitive).
   */
  search(query: string): SkillMatch[] {
    if (!query) return []

    const q = query.toLowerCase()
    const matches: SkillMatch[] = []

    for (const skill of this.skills.values()) {
      const nameMatch = skill.name.toLowerCase().includes(q)
      const descMatch = skill.description.toLowerCase().includes(q)
      const tagMatch = (skill.tags ?? []).some(t => t.toLowerCase().includes(q))

      if (nameMatch || descMatch || tagMatch) {
        // Name matches get highest confidence, then tags, then description
        const confidence = nameMatch ? 1.0 : tagMatch ? 0.7 : 0.4
        const reason = nameMatch
          ? `Name contains "${query}"`
          : tagMatch
            ? `Tag contains "${query}"`
            : `Description contains "${query}"`
        matches.push({ skill, confidence, reason })
      }
    }

    return matches.sort((a, b) => {
      const pDiff = (b.skill.priority ?? 0) - (a.skill.priority ?? 0)
      if (pDiff !== 0) return pDiff
      return b.confidence - a.confidence
    })
  }

  /**
   * Format selected skills as a system prompt section.
   * Returns an empty string if the skills array is empty.
   */
  formatForPrompt(skills: LoadedSkill[]): string {
    if (skills.length === 0) return ''

    const sections = skills.map(s => {
      const header = `## Skill: ${s.name}`
      const desc = s.description
      const tools = s.requiredTools?.length
        ? `\nRequired tools: ${s.requiredTools.join(', ')}`
        : ''
      return `${header}\n${desc}${tools}\n\n${s.instructions}`
    })

    return `# Available Skills\n\n${sections.join('\n\n---\n\n')}`
  }

  /** Get count of registered skills. */
  get size(): number {
    return this.skills.size
  }

  /** Remove all registered skills. */
  clear(): void {
    this.skills.clear()
  }

  /** Get all unique categories across registered skills. */
  categories(): string[] {
    const cats = new Set<string>()
    for (const skill of this.skills.values()) {
      if (skill.category) cats.add(skill.category)
    }
    return [...cats].sort()
  }

  /** Get all unique tags across registered skills. */
  allTags(): string[] {
    const tags = new Set<string>()
    for (const skill of this.skills.values()) {
      for (const tag of skill.tags ?? []) {
        tags.add(tag)
      }
    }
    return [...tags].sort()
  }
}

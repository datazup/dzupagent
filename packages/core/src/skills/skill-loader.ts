import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillDefinition } from './skill-types.js'

/**
 * Discovers and loads skill definitions from the filesystem.
 *
 * A skill is a directory containing a `SKILL.md` file with YAML-style
 * frontmatter (`---` delimited) that declares at minimum `name` and
 * `description` fields.
 *
 * ```
 * skills/
 *   prisma-migration/
 *     SKILL.md          ← frontmatter + instructions
 *   vue-component/
 *     SKILL.md
 * ```
 */
export class SkillLoader {
  constructor(private readonly sourcePaths: string[]) {}

  /**
   * Scans all source paths for directories containing a valid SKILL.md.
   * Directories without SKILL.md or with unparseable frontmatter are
   * silently skipped.
   */
  async discoverSkills(): Promise<SkillDefinition[]> {
    const skills: SkillDefinition[] = []

    for (const basePath of this.sourcePaths) {
      try {
        const entries = await readdir(basePath, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const skillPath = join(basePath, entry.name, 'SKILL.md')
          try {
            const content = await readFile(skillPath, 'utf-8')
            const parsed = this.parseFrontmatter(content, skillPath)
            if (parsed) skills.push(parsed)
          } catch {
            // Skill directory without SKILL.md — skip
          }
        }
      } catch {
        // Source path doesn't exist — skip
      }
    }

    return skills
  }

  /**
   * Loads the body content (everything after frontmatter) of a named skill.
   * Searches all source paths and returns the first match.
   */
  async loadSkillContent(skillName: string): Promise<string | null> {
    for (const basePath of this.sourcePaths) {
      const skillPath = join(basePath, skillName, 'SKILL.md')
      try {
        const content = await readFile(skillPath, 'utf-8')
        // Return content after frontmatter
        const firstFence = content.indexOf('---')
        if (firstFence === -1) return content

        const endOfFrontmatter = content.indexOf('---', firstFence + 3)
        if (endOfFrontmatter !== -1) {
          return content.slice(endOfFrontmatter + 3).trim()
        }
        return content
      } catch {
        continue
      }
    }
    return null
  }

  /** Formats a list of skills as a human-readable Markdown section. */
  formatSkillList(skills: SkillDefinition[]): string {
    if (skills.length === 0) return ''

    const lines = skills.map(
      (s) =>
        `- **${s.name}**: ${s.description}${s.compatibility ? ` (${s.compatibility})` : ''} [${s.path}]`,
    )

    return [
      '## Available Skills',
      '',
      'The following skills provide specialized instructions. Read the full content when you need them:',
      '',
      ...lines,
    ].join('\n')
  }

  /** Parses YAML-like frontmatter from a SKILL.md file. */
  private parseFrontmatter(
    content: string,
    path: string,
  ): SkillDefinition | null {
    if (!content.startsWith('---')) return null
    const endIdx = content.indexOf('---', 3)
    if (endIdx === -1) return null

    const frontmatter = content.slice(3, endIdx).trim()
    const fields: Record<string, string> = {}
    for (const line of frontmatter.split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim()
      fields[key] = value
    }

    const name = fields['name']
    const description = fields['description']
    if (!name || !description) return null

    return {
      name,
      description,
      path,
      compatibility: fields['compatibility'],
      allowedTools: fields['allowedTools']
        ?.split(/\s+/)
        .filter(Boolean),
      metadata: {},
    }
  }
}

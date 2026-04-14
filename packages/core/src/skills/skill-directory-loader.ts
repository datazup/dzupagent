/**
 * Loads skill definitions from the filesystem into a SkillRegistry.
 *
 * Supports two file formats:
 * - **SKILL.md**: Markdown with YAML-like frontmatter (--- delimited)
 * - **\*.skill.json**: JSON files with SkillRegistryEntry shape
 *
 * The loader recursively scans directories and registers discovered skills.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillRegistryEntry } from './skill-types.js'
import type { SkillRegistry } from './skill-registry.js'

// ---------------------------------------------------------------------------
// Markdown parser
// ---------------------------------------------------------------------------

/**
 * Parse a SKILL.md string into a SkillRegistryEntry.
 *
 * The file format is:
 * ```
 * ---
 * id: my-skill
 * name: My Skill
 * description: Does things
 * category: tools
 * tags: tag1, tag2
 * requiredTools: tool_a tool_b
 * priority: 10
 * version: 1.0.0
 * ---
 * Instructions body here...
 * ```
 *
 * If `id` is omitted it is derived from `name`. If `name` is omitted the
 * first `# Heading` in the body is used.
 */
export function parseMarkdownSkill(
  content: string,
  _sourcePath?: string,
): SkillRegistryEntry | undefined {
  const lines = content.split('\n')

  let id = ''
  let name = ''
  let description = ''
  let category = ''
  let version = ''
  let priority: number | undefined
  const tags: string[] = []
  const requiredTools: string[] = []
  const instructionLines: string[] = []

  let inFrontmatter = false
  let pastFrontmatter = false

  for (const line of lines) {
    const trimmed = line.trim()

    // Frontmatter fences
    if (trimmed === '---' && !pastFrontmatter) {
      if (inFrontmatter) {
        pastFrontmatter = true
        inFrontmatter = false
        continue
      }
      inFrontmatter = true
      continue
    }

    if (inFrontmatter) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim()

      switch (key) {
        case 'id':
          id = value
          break
        case 'name':
          name = value
          break
        case 'description':
          description = value
          break
        case 'category':
          category = value
          break
        case 'version':
          version = value
          break
        case 'priority': {
          const parsed = Number(value)
          if (!Number.isNaN(parsed)) priority = parsed
          break
        }
        case 'tags':
          tags.push(
            ...value
              .split(',')
              .map(t => t.trim())
              .filter(Boolean),
          )
          break
        case 'requiredTools':
          requiredTools.push(
            ...value
              .split(/[\s,]+/)
              .map(t => t.trim())
              .filter(Boolean),
          )
          break
      }
      continue
    }

    // Everything after frontmatter (or all content if no frontmatter)
    if (pastFrontmatter || !inFrontmatter) {
      instructionLines.push(line)
    }
  }

  // Fallback: extract name from first # heading in body
  if (!name) {
    const heading = instructionLines.find(l => l.startsWith('# '))
    if (heading) name = heading.slice(2).trim()
  }

  // Derive id from name if not provided
  if (!id) {
    id = name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
  }

  // Name is required
  if (!name) return undefined

  return {
    id,
    name,
    description: description || name,
    category: category || undefined,
    version: version || undefined,
    tags: tags.length > 0 ? tags : undefined,
    requiredTools: requiredTools.length > 0 ? requiredTools : undefined,
    priority,
    instructions: instructionLines.join('\n').trim(),
  }
}

// ---------------------------------------------------------------------------
// JSON parser
// ---------------------------------------------------------------------------

/**
 * Parse a .skill.json file content into a SkillRegistryEntry.
 * Returns undefined if the content is invalid or missing required fields.
 */
export function parseJsonSkill(content: string): SkillRegistryEntry | undefined {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    const id = parsed['id']
    const name = parsed['name']
    const instructions = parsed['instructions']

    if (typeof id !== 'string' || typeof name !== 'string' || typeof instructions !== 'string') {
      return undefined
    }

    const entry: SkillRegistryEntry = {
      id,
      name,
      instructions,
      description: typeof parsed['description'] === 'string' ? parsed['description'] : name,
    }

    if (typeof parsed['category'] === 'string') entry.category = parsed['category']
    if (typeof parsed['version'] === 'string') entry.version = parsed['version']
    if (typeof parsed['priority'] === 'number') entry.priority = parsed['priority']
    if (Array.isArray(parsed['tags'])) {
      entry.tags = (parsed['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
    }
    if (Array.isArray(parsed['requiredTools'])) {
      entry.requiredTools = (parsed['requiredTools'] as unknown[]).filter(
        (t): t is string => typeof t === 'string',
      )
    }

    return entry
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Directory loader
// ---------------------------------------------------------------------------

export interface SkillDirectoryLoaderOptions {
  /** Maximum directory depth to recurse (default: 10) */
  maxDepth?: number
}

/**
 * Loads skill definitions from the filesystem into a SkillRegistry.
 *
 * Recursively scans directories for:
 * - `SKILL.md` files (parsed with frontmatter extraction)
 * - `*.skill.json` files (parsed as JSON)
 *
 * All discovered skills are registered in the provided SkillRegistry.
 */
export class SkillDirectoryLoader {
  private readonly maxDepth: number

  constructor(
    private readonly registry: SkillRegistry,
    options?: SkillDirectoryLoaderOptions,
  ) {
    this.maxDepth = options?.maxDepth ?? 10
  }

  /**
   * Load skills from a directory path.
   * Returns the number of skills successfully loaded.
   */
  loadFromDirectory(dirPath: string): number {
    if (!existsSync(dirPath)) return 0

    try {
      const stat = statSync(dirPath)
      if (!stat.isDirectory()) return 0
    } catch {
      return 0
    }

    return this.scanDirectory(dirPath, 0)
  }

  /**
   * Load skills from multiple directories.
   * Returns the total number of skills loaded across all directories.
   */
  loadFromDirectories(dirPaths: string[]): number {
    let total = 0
    for (const dir of dirPaths) {
      total += this.loadFromDirectory(dir)
    }
    return total
  }

  /**
   * Load a single SKILL.md file into the registry.
   * Returns true if the file was successfully parsed and registered.
   */
  loadMarkdownFile(filePath: string): boolean {
    try {
      const content = readFileSync(filePath, 'utf-8')
      const skill = parseMarkdownSkill(content, filePath)
      if (skill) {
        this.registry.register(skill, filePath)
        return true
      }
      return false
    } catch {
      return false
    }
  }

  /**
   * Load a single .skill.json file into the registry.
   * Returns true if the file was successfully parsed and registered.
   */
  loadJsonFile(filePath: string): boolean {
    try {
      const content = readFileSync(filePath, 'utf-8')
      const skill = parseJsonSkill(content)
      if (skill) {
        this.registry.register(skill, filePath)
        return true
      }
      return false
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private scanDirectory(dirPath: string, depth: number): number {
    if (depth > this.maxDepth) return 0

    let count = 0

    try {
      const entries = readdirSync(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = join(dirPath, entry.name)

        if (entry.isDirectory()) {
          count += this.scanDirectory(fullPath, depth + 1)
        } else if (entry.name === 'SKILL.md') {
          if (this.loadMarkdownFile(fullPath)) count++
        } else if (entry.name.endsWith('.skill.json')) {
          if (this.loadJsonFile(fullPath)) count++
        }
      }
    } catch {
      // Directory not readable — skip silently
    }

    return count
  }
}

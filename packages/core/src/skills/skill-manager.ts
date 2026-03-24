/**
 * Skill lifecycle manager — create, patch, and edit skills.
 *
 * Complements SkillLoader (read-only discovery) with write operations.
 * All writes are atomic (write-to-temp + rename) and security-scanned
 * before persistence. Inspired by Hermes Agent's skill management system.
 */
import { writeFile, rename, mkdir, readFile, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { SkillDefinition } from './skill-types.js'
import { sanitizeMemoryContent } from '../memory/memory-sanitizer.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillManagerConfig {
  /** Directory where skills are stored (e.g. ~/.forgeagent/skills) */
  skillsDir: string
  /** Maximum SKILL.md file size in characters (default 50 000) */
  maxContentLength?: number
}

export interface CreateSkillInput {
  name: string
  description: string
  compatibility?: string
  allowedTools?: string[]
  /** Markdown body (instructions, procedures, verification steps) */
  body: string
}

export interface PatchSkillInput {
  /** Unique substring to find in the existing body */
  find: string
  /** Replacement text */
  replace: string
}

export interface SkillWriteResult {
  ok: boolean
  path?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const MAX_NAME_LENGTH = 64
const DEFAULT_MAX_CONTENT = 50_000

function validateName(name: string): string | null {
  if (!name || name.length > MAX_NAME_LENGTH) {
    return `Skill name must be 1-${MAX_NAME_LENGTH} characters`
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    return 'Skill name must match [a-z0-9][a-z0-9._-]* (lowercase, no spaces)'
  }
  return null
}

function buildFrontmatter(input: CreateSkillInput): string {
  const lines = [
    '---',
    `name: ${input.name}`,
    `description: ${input.description}`,
  ]
  if (input.compatibility) {
    lines.push(`compatibility: ${input.compatibility}`)
  }
  if (input.allowedTools?.length) {
    lines.push(`allowedTools: ${input.allowedTools.join(' ')}`)
  }
  lines.push('---')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class SkillManager {
  private readonly skillsDir: string
  private readonly maxContent: number

  constructor(config: SkillManagerConfig) {
    this.skillsDir = config.skillsDir
    this.maxContent = config.maxContentLength ?? DEFAULT_MAX_CONTENT
  }

  /**
   * Create a new skill. Fails if one with the same name already exists.
   * The write is atomic: content goes to a temp file, then renames into place.
   */
  async create(input: CreateSkillInput): Promise<SkillWriteResult> {
    const nameError = validateName(input.name)
    if (nameError) return { ok: false, error: nameError }

    const content = `${buildFrontmatter(input)}\n\n${input.body}`

    if (content.length > this.maxContent) {
      return { ok: false, error: `Content exceeds ${this.maxContent} character limit` }
    }

    const scanResult = sanitizeMemoryContent(content)
    if (!scanResult.safe) {
      return { ok: false, error: `Security scan failed: ${scanResult.threats.join(', ')}` }
    }

    const skillDir = join(this.skillsDir, input.name)
    const skillPath = join(skillDir, 'SKILL.md')

    // Check for collision
    try {
      await readFile(skillPath, 'utf-8')
      return { ok: false, error: `Skill "${input.name}" already exists` }
    } catch {
      // Expected — skill doesn't exist yet
    }

    return this.atomicWrite(skillDir, skillPath, content)
  }

  /**
   * Full rewrite of a skill's SKILL.md. The frontmatter is rebuilt from
   * the input; only the body is replaced.
   */
  async edit(input: CreateSkillInput): Promise<SkillWriteResult> {
    const nameError = validateName(input.name)
    if (nameError) return { ok: false, error: nameError }

    const skillDir = join(this.skillsDir, input.name)
    const skillPath = join(skillDir, 'SKILL.md')

    // Verify skill exists
    try {
      await readFile(skillPath, 'utf-8')
    } catch {
      return { ok: false, error: `Skill "${input.name}" does not exist` }
    }

    const content = `${buildFrontmatter(input)}\n\n${input.body}`

    if (content.length > this.maxContent) {
      return { ok: false, error: `Content exceeds ${this.maxContent} character limit` }
    }

    const scanResult = sanitizeMemoryContent(content)
    if (!scanResult.safe) {
      return { ok: false, error: `Security scan failed: ${scanResult.threats.join(', ')}` }
    }

    return this.atomicWrite(skillDir, skillPath, content)
  }

  /**
   * Targeted find-and-replace within an existing skill's body.
   * Preferred over `edit()` for small fixes — preserves unchanged content.
   * Fails if the find string doesn't match exactly once.
   */
  async patch(skillName: string, patch: PatchSkillInput): Promise<SkillWriteResult> {
    const nameError = validateName(skillName)
    if (nameError) return { ok: false, error: nameError }

    const skillPath = join(this.skillsDir, skillName, 'SKILL.md')

    let existing: string
    try {
      existing = await readFile(skillPath, 'utf-8')
    } catch {
      return { ok: false, error: `Skill "${skillName}" does not exist` }
    }

    const matchCount = existing.split(patch.find).length - 1
    if (matchCount === 0) {
      return { ok: false, error: 'Patch find string not found in skill' }
    }
    if (matchCount > 1) {
      return { ok: false, error: `Patch find string matched ${matchCount} times — must be unique` }
    }

    const updated = existing.replace(patch.find, patch.replace)

    if (updated.length > this.maxContent) {
      return { ok: false, error: `Patched content exceeds ${this.maxContent} character limit` }
    }

    const scanResult = sanitizeMemoryContent(updated)
    if (!scanResult.safe) {
      return { ok: false, error: `Security scan failed: ${scanResult.threats.join(', ')}` }
    }

    const skillDir = join(this.skillsDir, skillName)
    return this.atomicWrite(skillDir, skillPath, updated)
  }

  /**
   * Heuristic: should the agent create a skill after completing a task?
   *
   * Returns true when the task was complex enough to warrant reusable
   * procedural knowledge. Callers provide lightweight metrics from the
   * completed pipeline run.
   */
  shouldCreateSkill(metrics: {
    /** Number of pipeline phases executed */
    phasesExecuted: number
    /** Number of fix-loop iterations */
    fixIterations: number
    /** Total LLM calls made */
    llmCalls: number
    /** Whether the task involved a novel pattern (not covered by existing skills) */
    novelPattern?: boolean
  }): boolean {
    // A task is "complex enough" when it exercised multiple phases
    // and required meaningful iteration
    if (metrics.novelPattern) return true
    if (metrics.phasesExecuted >= 4 && metrics.fixIterations >= 1) return true
    if (metrics.llmCalls >= 8) return true
    return false
  }

  /**
   * Parse an existing SKILL.md into a SkillDefinition.
   * Returns null if the file doesn't exist or has invalid frontmatter.
   */
  async readSkill(skillName: string): Promise<SkillDefinition | null> {
    const skillPath = join(this.skillsDir, skillName, 'SKILL.md')
    let content: string
    try {
      content = await readFile(skillPath, 'utf-8')
    } catch {
      return null
    }

    if (!content.startsWith('---')) return null
    const endIdx = content.indexOf('---', 3)
    if (endIdx === -1) return null

    const frontmatter = content.slice(3, endIdx).trim()
    const fields: Record<string, string> = {}
    for (const line of frontmatter.split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx === -1) continue
      fields[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 1).trim()
    }

    const name = fields['name']
    const description = fields['description']
    if (!name || !description) return null

    return {
      name,
      description,
      path: skillPath,
      compatibility: fields['compatibility'],
      allowedTools: fields['allowedTools']?.split(/\s+/).filter(Boolean),
      metadata: {},
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async atomicWrite(
    dir: string,
    finalPath: string,
    content: string,
  ): Promise<SkillWriteResult> {
    try {
      await mkdir(dir, { recursive: true })
      const tmpPath = join(dirname(finalPath), `.tmp-${randomBytes(8).toString('hex')}`)
      await writeFile(tmpPath, content, 'utf-8')
      try {
        await rename(tmpPath, finalPath)
      } catch {
        // Clean up temp file if rename fails
        await unlink(tmpPath).catch(() => {})
        return { ok: false, error: 'Atomic rename failed' }
      }
      return { ok: true, path: finalPath }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Write failed: ${message}` }
    }
  }
}

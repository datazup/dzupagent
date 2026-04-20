/**
 * `DzupAgentSkillLoader` — reads `.dzupagent/skills/*.md` files from global
 * and/or project directories and produces canonical `AdapterSkillBundle[]`
 * ready to feed into `AdapterSkillRegistry` and the per-provider compilers.
 *
 * Implements FR-1 (File-Based Skill Loader) from
 * `docs/dzupagent/adapters/UNIFIED_CAPABILITY_LAYER_REQUIREMENTS.md`.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { AdapterSkillBundle } from '../skills/adapter-skill-types.js'

import { parseFrontmatter, type FrontmatterValue } from './frontmatter-parser.js'
import type { UclSkillFrontmatter } from './types.js'

/**
 * Map of heading → purpose/priority per FR-1.
 */
const HEADING_PRIORITY: ReadonlyArray<{
  heading: string
  purpose: AdapterSkillBundle['promptSections'][number]['purpose']
  priority: number
}> = [
  { heading: 'persona', purpose: 'persona', priority: 1 },
  { heading: 'style', purpose: 'style', priority: 2 },
  { heading: 'safety', purpose: 'safety', priority: 3 },
  { heading: 'task', purpose: 'task', priority: 4 },
  { heading: 'review', purpose: 'review', priority: 5 },
  { heading: 'output', purpose: 'output', priority: 6 },
]

const UNLABELED_PRIORITY = 99

interface BodySection {
  heading: string | null
  content: string
}

export class DzupAgentSkillLoader {
  /**
   * Load all skill bundles from a single directory.
   * Silently returns `[]` if the directory does not exist.
   */
  async loadFromDir(dir: string): Promise<AdapterSkillBundle[]> {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch (err) {
      if (isNotFound(err)) return []
      throw err
    }
    const mdFiles = entries.filter((f) => f.toLowerCase().endsWith('.md'))
    const bundles: AdapterSkillBundle[] = []
    for (const file of mdFiles.sort()) {
      const absolute = path.join(dir, file)
      const bundle = await this.loadFile(absolute)
      if (bundle) bundles.push(bundle)
    }
    return bundles
  }

  /**
   * Load bundles from global then project directories; project entries
   * override global entries with the same `name` (FR-1 loading order).
   */
  async load(projectDir?: string, globalDir?: string): Promise<AdapterSkillBundle[]> {
    const byName = new Map<string, AdapterSkillBundle>()
    if (globalDir) {
      const globals = await this.loadFromDir(globalDir)
      for (const bundle of globals) byName.set(bundle.skillSetId, bundle)
    }
    if (projectDir) {
      const projects = await this.loadFromDir(projectDir)
      for (const bundle of projects) byName.set(bundle.skillSetId, bundle)
    }
    return Array.from(byName.values())
  }

  /** Parse a single `.md` file into an `AdapterSkillBundle`, or `null` if invalid. */
  private async loadFile(absolutePath: string): Promise<AdapterSkillBundle | null> {
    const raw = await fs.readFile(absolutePath, 'utf8')
    const { frontmatter, body } = parseFrontmatter(raw)
    const fm = coerceSkillFrontmatter(frontmatter)
    if (!fm) return null

    const sections = extractSections(body)
    const promptSections = sectionsToPromptSections(sections)

    const toolBindings: AdapterSkillBundle['toolBindings'] = []
    const tools = fm.tools ?? {}
    for (const name of tools.required ?? []) {
      toolBindings.push({ toolName: name, mode: 'required' })
    }
    for (const name of tools.optional ?? []) {
      toolBindings.push({ toolName: name, mode: 'optional' })
    }
    for (const name of tools.blocked ?? []) {
      toolBindings.push({ toolName: name, mode: 'blocked' })
    }

    const now = new Date().toISOString()
    const bundle: AdapterSkillBundle = {
      bundleId: `ucl:${fm.name}:v${fm.version}`,
      skillSetId: fm.name,
      skillSetVersion: String(fm.version),
      constraints: fm.constraints ?? {},
      promptSections,
      toolBindings,
      metadata: {
        owner: fm.owner ?? 'unknown',
        createdAt: now,
        updatedAt: now,
      },
    }
    return bundle
  }
}

/** Split body into top-level `## Heading` blocks plus any pre-heading prose. */
function extractSections(body: string): BodySection[] {
  const lines = body.split(/\r?\n/)
  const sections: BodySection[] = []
  let current: BodySection = { heading: null, content: '' }
  for (const line of lines) {
    const headingMatch = /^##\s+(.+?)\s*$/.exec(line)
    if (headingMatch) {
      if (current.content.trim().length > 0 || current.heading !== null) {
        sections.push({ heading: current.heading, content: current.content.trim() })
      }
      current = { heading: headingMatch[1]!.trim(), content: '' }
      continue
    }
    current.content += `${line}\n`
  }
  if (current.content.trim().length > 0 || current.heading !== null) {
    sections.push({ heading: current.heading, content: current.content.trim() })
  }
  return sections.filter((s) => s.content.length > 0 || s.heading !== null)
}

function sectionsToPromptSections(
  sections: BodySection[],
): AdapterSkillBundle['promptSections'] {
  const result: AdapterSkillBundle['promptSections'] = []
  let unlabeledCount = 0
  for (const [index, section] of sections.entries()) {
    const headingLower = section.heading?.toLowerCase() ?? null
    const mapping = headingLower
      ? HEADING_PRIORITY.find((m) => m.heading === headingLower)
      : undefined
    if (mapping) {
      result.push({
        id: `${mapping.purpose}-${index}`,
        purpose: mapping.purpose,
        content: section.content,
        priority: mapping.priority,
      })
    } else {
      unlabeledCount += 1
      result.push({
        id: `task-unlabeled-${unlabeledCount}`,
        purpose: 'task',
        content: section.content,
        priority: UNLABELED_PRIORITY,
      })
    }
  }
  return result
}

/** Validate + narrow the parsed frontmatter to `UclSkillFrontmatter`. */
function coerceSkillFrontmatter(
  raw: Record<string, FrontmatterValue>,
): UclSkillFrontmatter | null {
  const name = raw['name']
  const description = raw['description']
  const version = raw['version']
  if (typeof name !== 'string' || name.length === 0) return null
  if (typeof description !== 'string') return null
  if (typeof version !== 'number') return null

  const result: UclSkillFrontmatter = {
    name,
    description,
    version,
  }
  const owner = raw['owner']
  if (typeof owner === 'string') result.owner = owner

  const constraints = raw['constraints']
  if (isRecord(constraints)) {
    const c: UclSkillFrontmatter['constraints'] = {}
    const maxBudgetUsd = constraints['maxBudgetUsd']
    if (typeof maxBudgetUsd === 'number') c.maxBudgetUsd = maxBudgetUsd
    const approvalMode = constraints['approvalMode']
    if (approvalMode === 'auto' || approvalMode === 'required' || approvalMode === 'conditional') {
      c.approvalMode = approvalMode
    }
    const networkPolicy = constraints['networkPolicy']
    if (networkPolicy === 'off' || networkPolicy === 'restricted' || networkPolicy === 'on') {
      c.networkPolicy = networkPolicy
    }
    const toolPolicy = constraints['toolPolicy']
    if (toolPolicy === 'strict' || toolPolicy === 'balanced' || toolPolicy === 'open') {
      c.toolPolicy = toolPolicy
    }
    if (Object.keys(c).length > 0) result.constraints = c
  }

  const tools = raw['tools']
  if (isRecord(tools)) {
    const t: UclSkillFrontmatter['tools'] = {}
    const required = toStringArray(tools['required'])
    if (required) t.required = required
    const optional = toStringArray(tools['optional'])
    if (optional) t.optional = optional
    const blocked = toStringArray(tools['blocked'])
    if (blocked) t.blocked = blocked
    if (Object.keys(t).length > 0) result.tools = t
  }

  return result
}

function toStringArray(value: FrontmatterValue | undefined): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const v of value) {
    if (typeof v === 'string') out.push(v)
  }
  return out
}

function isRecord(value: unknown): value is Record<string, FrontmatterValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'ENOENT'
}

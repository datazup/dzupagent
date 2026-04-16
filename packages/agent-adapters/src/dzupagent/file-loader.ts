/**
 * DzupAgentFileLoader — loads AdapterSkillBundle definitions from .dzupagent/skills/*.md files.
 *
 * Reads from up to three locations (in order):
 *   1. ~/.dzupagent/skills/           (global — shared across all projects)
 *   2. <workspace>/.dzupagent/skills/ (workspace — git root, when it differs from project)
 *   3. <project>/.dzupagent/skills/   (project-level — overrides global & workspace by name)
 *
 * Results are cached by file mtime to keep subsequent calls under 1ms.
 */

import { readdir, readFile, stat, watch as fsWatch } from 'node:fs/promises'
import { join, basename, extname } from 'node:path'
import type { AdapterSkillBundle } from '../skills/adapter-skill-types.js'
import type { DzupAgentPaths } from '../types.js'
import {
  parseMarkdownFile,
  type ParsedFrontmatter,
  type ParsedSection,
} from './md-frontmatter-parser.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileLoaderOptions {
  paths: DzupAgentPaths
}

/** Result of parsing a single skill .md file */
export interface ParsedSkillFile {
  filePath: string
  bundle: AdapterSkillBundle
  /** Whether this came from the global, workspace, or project directory */
  source: 'global' | 'workspace' | 'project'
  /** File mtime (ms since epoch) at parse time */
  mtime: number
}

// ---------------------------------------------------------------------------
// Heading → promptSection mapping
// ---------------------------------------------------------------------------

type PromptPurpose = AdapterSkillBundle['promptSections'][number]['purpose']

const HEADING_PURPOSE: Record<string, PromptPurpose> = {
  persona: 'persona',
  style: 'style',
  safety: 'safety',
  task: 'task',
  review: 'review',
  output: 'output',
}

const HEADING_PRIORITY: Record<string, number> = {
  persona: 1,
  style: 2,
  safety: 3,
  task: 4,
  review: 5,
  output: 6,
}

// ---------------------------------------------------------------------------
// File parsing
// ---------------------------------------------------------------------------

function safeString(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

function safeStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

function safeNumber(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

function parseConstraints(fm: ParsedFrontmatter): AdapterSkillBundle['constraints'] {
  const raw = fm['constraints']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}

  const c = raw as Record<string, unknown>
  const result: AdapterSkillBundle['constraints'] = {}

  const budget = safeNumber(c['maxBudgetUsd'])
  if (budget !== undefined) result.maxBudgetUsd = budget

  const approval = c['approvalMode']
  if (approval === 'auto' || approval === 'required' || approval === 'conditional') {
    result.approvalMode = approval
  }

  const network = c['networkPolicy']
  if (network === 'off' || network === 'restricted' || network === 'on') {
    result.networkPolicy = network
  }

  const tool = c['toolPolicy']
  if (tool === 'strict' || tool === 'balanced' || tool === 'open') {
    result.toolPolicy = tool
  }

  return result
}

function parseToolBindings(fm: ParsedFrontmatter): AdapterSkillBundle['toolBindings'] {
  const raw = fm['tools']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return []

  const tools = raw as Record<string, unknown>
  const bindings: AdapterSkillBundle['toolBindings'] = []

  for (const name of safeStringArray(tools['required'])) {
    bindings.push({ toolName: name, mode: 'required' })
  }
  for (const name of safeStringArray(tools['optional'])) {
    bindings.push({ toolName: name, mode: 'optional' })
  }
  for (const name of safeStringArray(tools['blocked'])) {
    bindings.push({ toolName: name, mode: 'blocked' })
  }

  return bindings
}

function sectionsToPromptSections(
  sections: ParsedSection[],
): AdapterSkillBundle['promptSections'] {
  const result: AdapterSkillBundle['promptSections'] = []

  for (const section of sections) {
    const key = section.heading.toLowerCase()
    const purpose = HEADING_PURPOSE[key] ?? 'task'
    const priority = HEADING_PRIORITY[key] ?? 99

    if (section.content.trim()) {
      result.push({
        id: key,
        purpose,
        content: section.content,
        priority,
      })
    }
  }

  // If no sections parsed but there is raw content, treat it as a single task section
  return result
}

function fileNameWithoutExt(filePath: string): string {
  const base = basename(filePath)
  const ext = extname(base)
  return ext ? base.slice(0, -ext.length) : base
}

function buildBundleFromParsed(
  filePath: string,
  content: string,
): AdapterSkillBundle {
  const parsed = parseMarkdownFile(content)
  const fm = parsed.frontmatter
  const now = new Date().toISOString()

  const nameFromFile = fileNameWithoutExt(filePath)
  const name = safeString(fm['name'], nameFromFile)

  const promptSections = sectionsToPromptSections(parsed.sections)

  // If no heading sections but raw body exists, create a single task section
  if (promptSections.length === 0 && parsed.rawBody.trim()) {
    promptSections.push({
      id: 'task',
      purpose: 'task',
      content: parsed.rawBody.trim(),
      priority: 4,
    })
  }

  return {
    bundleId: name,
    skillSetId: name,
    skillSetVersion: String(fm['version'] ?? '1'),
    constraints: parseConstraints(fm),
    promptSections,
    toolBindings: parseToolBindings(fm),
    metadata: {
      owner: safeString(fm['owner'], 'unknown'),
      createdAt: now,
      updatedAt: now,
    },
  }
}

// ---------------------------------------------------------------------------
// Cache entry
// ---------------------------------------------------------------------------

interface CacheEntry {
  mtime: number
  result: ParsedSkillFile
}

// ---------------------------------------------------------------------------
// DzupAgentFileLoader
// ---------------------------------------------------------------------------

export class DzupAgentFileLoader {
  private readonly paths: DzupAgentPaths
  private cache = new Map<string, CacheEntry>()

  constructor(options: FileLoaderOptions) {
    this.paths = options.paths
  }

  /**
   * Load all skills from global + workspace + project directories.
   * Later tiers override earlier ones with the same bundle name:
   *   global < workspace < project
   * Results are cached until file mtime changes.
   */
  async loadSkills(): Promise<AdapterSkillBundle[]> {
    const globalFiles = await this.loadFromDir(this.paths.globalDir, 'global')

    // Workspace tier: only when workspaceDir is defined and differs from projectDir
    const wsDir = this.paths.workspaceDir
    const workspaceFiles =
      wsDir !== undefined && wsDir !== this.paths.projectDir
        ? await this.loadFromDir(wsDir, 'workspace')
        : []

    const projectFiles = await this.loadFromDir(this.paths.projectDir, 'project')

    // Merge: workspace overrides global, project overrides workspace (by bundleId)
    const byId = new Map<string, AdapterSkillBundle>()
    for (const f of globalFiles) byId.set(f.bundle.bundleId, f.bundle)
    for (const f of workspaceFiles) byId.set(f.bundle.bundleId, f.bundle)
    for (const f of projectFiles) byId.set(f.bundle.bundleId, f.bundle)

    return [...byId.values()]
  }

  /**
   * Load a single skill by name (bundleId).
   * Returns undefined if not found in either location.
   */
  async loadSkill(name: string): Promise<AdapterSkillBundle | undefined> {
    const all = await this.loadSkills()
    return all.find((b) => b.bundleId === name)
  }

  /**
   * Force-invalidate the in-memory mtime cache.
   * Call after writing files programmatically (e.g. after DzupAgentImporter).
   */
  invalidateCache(): void {
    this.cache.clear()
  }

  /**
   * Watch .dzupagent/ for changes and invoke callback with updated bundles.
   * Returns a dispose function.
   */
  watch(onChange: (bundles: AdapterSkillBundle[]) => void): () => void {
    let aborted = false
    const ac = new AbortController()

    const watchDir = async (dir: string): Promise<void> => {
      try {
        const watcher = fsWatch(dir, { signal: ac.signal, recursive: false })
        for await (const _ of watcher) {
          if (aborted) break
          this.invalidateCache()
          const bundles = await this.loadSkills()
          onChange(bundles)
        }
      } catch {
        // Directory may not exist or watch was aborted — ignore
      }
    }

    void watchDir(join(this.paths.globalDir, 'skills'))
    if (this.paths.workspaceDir !== undefined && this.paths.workspaceDir !== this.paths.projectDir) {
      void watchDir(join(this.paths.workspaceDir, 'skills'))
    }
    void watchDir(join(this.paths.projectDir, 'skills'))

    return () => {
      aborted = true
      ac.abort()
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async loadFromDir(
    baseDir: string,
    source: ParsedSkillFile['source'],
  ): Promise<ParsedSkillFile[]> {
    const skillsDir = join(baseDir, 'skills')
    let entries: string[]

    try {
      entries = await readdir(skillsDir)
    } catch {
      return [] // directory does not exist — not an error
    }

    const mdFiles = entries.filter((e) => e.endsWith('.md'))
    const results: ParsedSkillFile[] = []

    await Promise.all(
      mdFiles.map(async (filename) => {
        const filePath = join(skillsDir, filename)
        const parsed = await this.loadFileCached(filePath, source)
        if (parsed !== undefined) results.push(parsed)
      }),
    )

    // Sort alphabetically by filename for deterministic ordering
    results.sort((a, b) => basename(a.filePath).localeCompare(basename(b.filePath)))
    return results
  }

  private async loadFileCached(
    filePath: string,
    source: ParsedSkillFile['source'],
  ): Promise<ParsedSkillFile | undefined> {
    try {
      const stats = await stat(filePath)
      const mtime = stats.mtimeMs

      const cached = this.cache.get(filePath)
      if (cached !== undefined && cached.mtime === mtime) {
        return cached.result
      }

      const content = await readFile(filePath, 'utf-8')
      const bundle = buildBundleFromParsed(filePath, content)
      const result: ParsedSkillFile = { filePath, bundle, source, mtime }
      this.cache.set(filePath, { mtime, result })
      return result
    } catch {
      return undefined // file disappeared or unreadable — skip silently
    }
  }
}

/**
 * DzupAgentMemoryLoader — loads memory entries from .dzupagent/memory/*.md files.
 *
 * Reads from up to four locations (in priority order, lowest first):
 *   1. ~/.dzupagent/memory/              (global — shared across all projects)
 *   2. <workspace>/.dzupagent/memory/    (workspace — git root, when it differs from project)
 *   3. <project>/.dzupagent/memory/      (project-level)
 *   4. <project>/../.claude/memory/      (agent-specific — Claude native memory)
 *
 * Results are cached by file mtime to keep subsequent calls under 1ms.
 * Token budget enforcement drops entries from the end (agent-specific first).
 *
 * Implements MemoryServiceLike so it can be used with withMemoryEnrichment.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, dirname, basename, extname } from 'node:path'
import type { AdapterProviderId, CodexMemoryStrategy, DzupAgentPaths } from '../types.js'
import type { MemoryServiceLike } from '../middleware/memory-enrichment.js'
import type { AgentMemoryRecalledEvent } from '../types.js'
import { parseMarkdownFile } from './md-frontmatter-parser.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryLevel = 'global' | 'workspace' | 'project' | 'agent'

export interface MemoryEntry {
  name: string
  description: string
  type: MemoryLevel
  tags: string[]
  content: string
  /** Math.ceil(content.length / 4) */
  tokenEstimate: number
  filePath: string
}

export interface DzupAgentMemoryLoaderOptions {
  paths: DzupAgentPaths
  providerId: AdapterProviderId
  /**
   * Maximum total tokens to inject across all memory levels.
   * Default: 2000.
   * Note: token estimates use the chars/4 heuristic (±20% accuracy for English text).
   */
  maxTotalTokens?: number
  codexMemoryStrategy?: CodexMemoryStrategy
  onRecalled?: (entries: AgentMemoryRecalledEvent['entries'], totalTokens: number) => void
}

// ---------------------------------------------------------------------------
// Cache entry
// ---------------------------------------------------------------------------

interface CacheEntry {
  mtime: number
  entry: MemoryEntry
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileNameWithoutExt(filePath: string): string {
  const base = basename(filePath)
  const ext = extname(base)
  return ext ? base.slice(0, -ext.length) : base
}

function safeString(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback
}

function safeStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

/**
 * Rough token estimate using the chars/4 heuristic.
 * Accuracy: ±20% for English prose, may under-estimate CJK text by 2x.
 * For precise counting, use an actual tokenizer (e.g. @anthropic-ai/sdk token counter).
 */
function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4)
}

// ---------------------------------------------------------------------------
// DzupAgentMemoryLoader
// ---------------------------------------------------------------------------

export class DzupAgentMemoryLoader implements MemoryServiceLike {
  private readonly paths: DzupAgentPaths
  private readonly providerId: AdapterProviderId
  private readonly maxTotalTokens: number
  private readonly codexMemoryStrategy: CodexMemoryStrategy
  private readonly onRecalled?: (entries: AgentMemoryRecalledEvent['entries'], totalTokens: number) => void
  private cache = new Map<string, CacheEntry>()

  constructor(options: DzupAgentMemoryLoaderOptions) {
    this.paths = options.paths
    this.providerId = options.providerId
    this.maxTotalTokens = options.maxTotalTokens ?? 2000
    this.codexMemoryStrategy = options.codexMemoryStrategy ?? 'inject-on-new-thread'
    this.onRecalled = options.onRecalled
  }

  // -------------------------------------------------------------------------
  // MemoryServiceLike implementation
  // -------------------------------------------------------------------------

  async search(
    _namespace: string,
    _scope: Record<string, string>,
    _query: string,
    limit?: number,
  ): Promise<Record<string, unknown>[]> {
    const entries = await this.loadEntries()
    const slice = limit !== undefined && limit > 0 ? entries.slice(0, limit) : entries

    return slice.map((e) => ({
      name: e.name,
      description: e.description,
      type: e.type,
      content: e.content,
      tags: e.tags,
      tokenEstimate: e.tokenEstimate,
    }))
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Load all memory entries within the token budget.
   *
   * Loading order: global -> workspace -> project -> agent.
   * Within each level, sorted alphabetically by filename.
   * Entries are dropped from the end (agent first) when budget is exceeded.
   * A single entry exceeding the entire budget is included with truncated content.
   */
  async loadEntries(): Promise<MemoryEntry[]> {
    const globalEntries = await this.loadFromDir(this.paths.globalDir, 'global')

    const wsDir = this.paths.workspaceDir
    const workspaceEntries =
      wsDir !== undefined && wsDir !== this.paths.projectDir
        ? await this.loadFromDir(wsDir, 'workspace')
        : []

    const projectEntries = await this.loadFromDir(this.paths.projectDir, 'project')
    const agentEntries = await this.loadAgentDir()

    // Concatenate in priority order (global first, agent last)
    const allEntries = [
      ...globalEntries,
      ...workspaceEntries,
      ...projectEntries,
      ...agentEntries,
    ]

    // Apply token budget — drop from the end (agent-specific first)
    const result = this.applyTokenBudget(allEntries)

    // Fire callback
    if (this.onRecalled !== undefined) {
      const callbackEntries = result.map((e) => ({
        level: e.type,
        name: e.name,
        tokenEstimate: e.tokenEstimate,
      }))
      const totalTokens = result.reduce((sum, e) => sum + e.tokenEstimate, 0)
      this.onRecalled(callbackEntries, totalTokens)
    }

    return result
  }

  /**
   * Determines whether to inject memory for this run based on provider and strategy.
   */
  shouldInject(isResume: boolean): boolean {
    if (this.providerId !== 'codex') return true

    switch (this.codexMemoryStrategy) {
      case 'trust-thread-history':
        return false
      case 'inject-always':
        return true
      case 'inject-on-new-thread':
        return !isResume
      default:
        return !isResume
    }
  }

  /**
   * Force-invalidate the in-memory mtime cache.
   */
  invalidateCache(): void {
    this.cache.clear()
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private applyTokenBudget(entries: MemoryEntry[]): MemoryEntry[] {
    const budget = this.maxTotalTokens
    const result: MemoryEntry[] = []
    let used = 0

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!
      if (used + entry.tokenEstimate <= budget) {
        result.push(entry)
        used += entry.tokenEstimate
      } else {
        // Remaining budget
        const remaining = budget - used
        if (remaining > 0 && result.length === 0) {
          // Edge case: single entry exceeds entire budget — truncate content to fit
          const maxChars = budget * 4
          const truncated: MemoryEntry = {
            ...entry,
            content: entry.content.slice(0, maxChars),
            tokenEstimate: budget,
          }
          result.push(truncated)
          used = budget
        }
        // Drop all remaining entries — budget exhausted
        break
      }
    }

    return result
  }

  /**
   * Load agent-specific memory from .claude/memory/ in the project root.
   * Derives project root by going up one level from paths.projectDir
   * (projectDir is typically <root>/.dzupagent/).
   */
  private async loadAgentDir(): Promise<MemoryEntry[]> {
    const projectRoot = dirname(this.paths.projectDir)
    const agentMemoryDir = join(projectRoot, '.claude', 'memory')
    return this.loadMdFiles(agentMemoryDir, 'agent')
  }

  private async loadFromDir(baseDir: string, level: MemoryLevel): Promise<MemoryEntry[]> {
    const memoryDir = join(baseDir, 'memory')
    return this.loadMdFiles(memoryDir, level)
  }

  private async loadMdFiles(dir: string, level: MemoryLevel): Promise<MemoryEntry[]> {
    let fileNames: string[]

    try {
      fileNames = await readdir(dir)
    } catch {
      return [] // directory does not exist — not an error
    }

    const mdFiles = fileNames.filter((f) => f.endsWith('.md')).sort()
    const results: MemoryEntry[] = []

    await Promise.all(
      mdFiles.map(async (filename) => {
        const filePath = join(dir, filename)
        const entry = await this.loadFileCached(filePath, level)
        if (entry !== undefined) results.push(entry)
      }),
    )

    // Re-sort after parallel load (Promise.all does not guarantee order)
    results.sort((a, b) => basename(a.filePath).localeCompare(basename(b.filePath)))

    return results
  }

  private async loadFileCached(
    filePath: string,
    level: MemoryLevel,
  ): Promise<MemoryEntry | undefined> {
    try {
      const stats = await stat(filePath)
      const mtime = stats.mtimeMs

      const cached = this.cache.get(filePath)
      if (cached !== undefined && cached.mtime === mtime) {
        return cached.entry
      }

      const rawContent = await readFile(filePath, 'utf-8')
      const entry = this.buildEntryFromParsed(filePath, rawContent, level)
      if (entry === undefined) {
        return undefined
      }
      this.cache.set(filePath, { mtime, entry })
      return entry
    } catch {
      return undefined // file disappeared or unreadable — skip silently
    }
  }

  private buildEntryFromParsed(
    filePath: string,
    rawContent: string,
    level: MemoryLevel,
  ): MemoryEntry | undefined {
    const parsed = parseMarkdownFile(rawContent)
    const fm = parsed.frontmatter

    const nameFromFile = fileNameWithoutExt(filePath)
    const name = safeString(fm['name'] as string | undefined, nameFromFile)
    const description = safeString(fm['description'] as string | undefined, '')

    // type from frontmatter, fallback to inferred level
    const fmType = fm['type']
    const type: MemoryLevel =
      typeof fmType === 'string' && isMemoryLevel(fmType) ? fmType : level

    const tags = safeStringArray(fm['tags'])

    // Body content = everything after frontmatter
    const content = parsed.rawBody.trim()

    if (content.length === 0) {
      return undefined
    }

    return {
      name,
      description,
      type,
      tags,
      content,
      tokenEstimate: estimateTokens(content),
      filePath,
    }
  }
}

function isMemoryLevel(value: string): value is MemoryLevel {
  return value === 'global' || value === 'workspace' || value === 'project' || value === 'agent'
}

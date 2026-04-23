/**
 * FolderContextGenerator — Walk a directory tree, score files by relevance,
 * and build a compact context snapshot with TTL caching.
 *
 * Scoring heuristics:
 * - Extension: .ts/.py = 1.0, .md = 0.8, .json = 0.6, others = 0.3
 * - Recency: <1h = 1.0, <1d = 0.7, <1w = 0.4, older = 0.1
 * - Depth:   0 = 1.0, 1 = 0.8, 2 = 0.6, deeper = 0.3
 * - Name:    index/main = 1.0, config = 0.7, test = 0.5, other = 0.5
 *
 * Final score = 0.3*ext + 0.3*recency + 0.2*depth + 0.2*name
 *
 * Snapshots are cached in-memory keyed by the generator instance for a TTL
 * window. Callers can force regeneration via `regenerate()` or invalidate
 * the cache on file change via `invalidateCache()`.
 */

import { readdir, stat } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FolderContextConfig {
  /** Root directory to scan. */
  rootDir: string
  /** Max depth to recurse. Default: 3. */
  maxDepth?: number
  /** File extensions to include. Default: ['.ts', '.js', '.py', '.md', '.json']. */
  extensions?: string[]
  /** Cache TTL in ms. Default: 60_000 (1 minute). */
  cacheTtlMs?: number
  /** Max files to include in snapshot. Default: 50. */
  maxFiles?: number
}

export interface FileScore {
  /** Path relative to rootDir (forward-slash normalized). */
  path: string
  /** Absolute filesystem path. */
  absolutePath: string
  /** Weighted score in [0, 1]. */
  score: number
  /** Human-readable score-breakdown reasons. */
  reasons: string[]
}

export interface ContextSnapshot {
  /** Root directory the snapshot was built from. */
  rootDir: string
  /** Top-ranked files (length <= maxFiles). */
  files: FileScore[]
  /** Human-readable summary string. */
  summary: string
  /** Epoch ms when the snapshot was generated. */
  generatedAt: number
  /** Cache TTL in ms associated with this snapshot. */
  ttlMs: number
}

/**
 * Minimal interface used to consume an optional ContextTransferService.
 * Kept structural so `@dzupagent/rag` does not have to depend on
 * `@dzupagent/context`. If the injected service exposes `serialize(items)`
 * it will be used to build the snapshot summary.
 */
export interface ContextTransferLike {
  serialize?: (items: readonly FileScore[]) => string
}

interface CachedSnapshot {
  snapshot: ContextSnapshot
  generatedAt: number
  ttl: number
}

interface FileInfo {
  absolutePath: string
  relativePath: string
  depth: number
  mtimeMs: number
  ext: string
  base: string
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DEPTH = 3
const DEFAULT_EXTENSIONS = ['.ts', '.js', '.py', '.md', '.json']
const DEFAULT_CACHE_TTL_MS = 60_000
const DEFAULT_MAX_FILES = 50

const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_DAY = 24 * MS_PER_HOUR
const MS_PER_WEEK = 7 * MS_PER_DAY

const EXT_WEIGHT = 0.3
const RECENCY_WEIGHT = 0.3
const DEPTH_WEIGHT = 0.2
const NAME_WEIGHT = 0.2

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  '.cache',
])

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

function scoreExtension(ext: string): { score: number; reason: string } {
  const e = ext.toLowerCase()
  if (e === '.ts' || e === '.py') return { score: 1.0, reason: `source file (${e})` }
  if (e === '.md') return { score: 0.8, reason: 'markdown doc' }
  if (e === '.json') return { score: 0.6, reason: 'json data' }
  return { score: 0.3, reason: `extension ${e || 'none'}` }
}

function scoreRecency(mtimeMs: number, now: number): { score: number; reason: string } {
  const age = now - mtimeMs
  if (age < MS_PER_HOUR) return { score: 1.0, reason: 'modified within the last hour' }
  if (age < MS_PER_DAY) return { score: 0.7, reason: 'modified within the last day' }
  if (age < MS_PER_WEEK) return { score: 0.4, reason: 'modified within the last week' }
  return { score: 0.1, reason: 'modified more than a week ago' }
}

function scoreDepth(depth: number): { score: number; reason: string } {
  if (depth === 0) return { score: 1.0, reason: 'top-level file' }
  if (depth === 1) return { score: 0.8, reason: 'depth 1' }
  if (depth === 2) return { score: 0.6, reason: 'depth 2' }
  return { score: 0.3, reason: `depth ${depth}` }
}

function scoreName(baseName: string): { score: number; reason: string } {
  const lower = baseName.toLowerCase()
  const stem = lower.replace(/\.[^.]+$/, '')

  if (stem === 'index' || stem === 'main') {
    return { score: 1.0, reason: 'entry-point file' }
  }
  if (
    stem.endsWith('.test') ||
    stem.endsWith('.spec') ||
    stem.startsWith('test-') ||
    stem.startsWith('spec-')
  ) {
    return { score: 0.5, reason: 'test file' }
  }
  if (
    stem.endsWith('.config') ||
    stem === 'config' ||
    stem === 'package' ||
    stem === 'tsconfig' ||
    stem === 'vitest' ||
    stem === 'eslint' ||
    stem === 'tsup'
  ) {
    return { score: 0.7, reason: 'config file' }
  }
  return { score: 0.5, reason: 'regular file' }
}

// ---------------------------------------------------------------------------
// FolderContextGenerator
// ---------------------------------------------------------------------------

export class FolderContextGenerator {
  private readonly rootDir: string
  private readonly maxDepth: number
  private readonly extensions: Set<string>
  private readonly cacheTtlMs: number
  private readonly maxFiles: number
  private readonly contextTransfer: ContextTransferLike | undefined
  private cache: CachedSnapshot | undefined

  constructor(config: FolderContextConfig, contextTransfer?: ContextTransferLike) {
    this.rootDir = config.rootDir
    this.maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH
    this.extensions = new Set(
      (config.extensions ?? DEFAULT_EXTENSIONS).map((e) => e.toLowerCase()),
    )
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.maxFiles = config.maxFiles ?? DEFAULT_MAX_FILES
    this.contextTransfer = contextTransfer
  }

  /** Generate a context snapshot for the folder. Uses cache if valid. */
  async generate(): Promise<ContextSnapshot> {
    const cached = this.cache
    if (cached && Date.now() - cached.generatedAt < cached.ttl) {
      return cached.snapshot
    }
    return this.regenerate()
  }

  /** Force regeneration, bypassing cache. */
  async regenerate(): Promise<ContextSnapshot> {
    const scored = await this.scoreFiles()
    const top = scored.slice(0, this.maxFiles)
    const generatedAt = Date.now()

    const snapshot: ContextSnapshot = {
      rootDir: this.rootDir,
      files: top,
      summary: this.buildSummary(top, scored.length),
      generatedAt,
      ttlMs: this.cacheTtlMs,
    }

    this.cache = {
      snapshot,
      generatedAt,
      ttl: this.cacheTtlMs,
    }

    return snapshot
  }

  /** Score files by relevance. Returns sorted list (highest score first). */
  async scoreFiles(): Promise<FileScore[]> {
    const files = await this.walk()
    const now = Date.now()
    const results: FileScore[] = []

    for (const info of files) {
      const ext = scoreExtension(info.ext)
      const recency = scoreRecency(info.mtimeMs, now)
      const depth = scoreDepth(info.depth)
      const name = scoreName(info.base)

      const score =
        ext.score * EXT_WEIGHT +
        recency.score * RECENCY_WEIGHT +
        depth.score * DEPTH_WEIGHT +
        name.score * NAME_WEIGHT

      results.push({
        path: info.relativePath,
        absolutePath: info.absolutePath,
        score: Number(score.toFixed(4)),
        reasons: [ext.reason, recency.reason, depth.reason, name.reason],
      })
    }

    results.sort((a, b) => b.score - a.score)
    return results
  }

  /** Invalidate the cache (e.g., on file change). */
  invalidateCache(): void {
    if (this.cache) {
      this.cache = {
        ...this.cache,
        generatedAt: 0,
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Recursively walk the directory tree up to maxDepth. */
  private async walk(): Promise<FileInfo[]> {
    const collected: FileInfo[] = []
    await this.walkDir(this.rootDir, 0, collected)
    return collected
  }

  private async walkDir(
    dir: string,
    depth: number,
    collected: FileInfo[],
  ): Promise<void> {
    if (depth > this.maxDepth) return

    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // Unreadable directory — skip
      return
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') {
        // Skip dotfiles / hidden dirs other than the root
        if (entry.isDirectory() || entry.name.length > 1) continue
      }
      const full = join(dir, entry.name)

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await this.walkDir(full, depth + 1, collected)
        continue
      }

      if (!entry.isFile()) continue

      const ext = extname(entry.name).toLowerCase()
      if (!this.extensions.has(ext)) continue

      let mtimeMs = 0
      try {
        const st = await stat(full)
        mtimeMs = st.mtimeMs
      } catch {
        continue
      }

      const rel = relative(this.rootDir, full) || entry.name
      collected.push({
        absolutePath: full,
        relativePath: rel.split(sep).join('/'),
        depth,
        mtimeMs,
        ext,
        base: basename(entry.name),
      })
    }
  }

  private buildSummary(topFiles: FileScore[], totalCount: number): string {
    if (totalCount === 0) {
      return `No matching files found under ${this.rootDir} (depth <= ${this.maxDepth}).`
    }

    // Prefer ContextTransferService.serialize() when provided.
    if (this.contextTransfer && typeof this.contextTransfer.serialize === 'function') {
      try {
        const serialized = this.contextTransfer.serialize(topFiles)
        if (typeof serialized === 'string' && serialized.length > 0) {
          return serialized
        }
      } catch {
        // Fall through to the default summary builder.
      }
    }

    const shown = topFiles.length
    const lines = [
      `Folder context for ${this.rootDir} (showing ${shown} of ${totalCount} files, depth <= ${this.maxDepth}).`,
      '',
      'Top files by relevance:',
      ...topFiles.slice(0, 10).map(
        (f, i) => `${i + 1}. ${f.path} (score=${f.score.toFixed(2)})`,
      ),
    ]
    return lines.join('\n')
  }
}

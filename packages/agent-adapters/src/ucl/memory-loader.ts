/**
 * `DzupAgentMemoryLoader` — reads `.dzupagent/memory/*.md` files from the
 * 4 canonical levels (global → workspace → project → agent) and produces
 * a combined `## Project Context` string suitable for injection into a
 * system prompt.
 *
 * Implements FR-2 (Memory Loader + Hierarchy) from
 * `docs/dzupagent/adapters/UNIFIED_CAPABILITY_LAYER_REQUIREMENTS.md`.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { parseFrontmatter } from './frontmatter-parser.js'

export interface MemoryLoadLevels {
  global?: string
  workspace?: string
  project?: string
}

export interface MemoryLoadOptions {
  /** Max tokens for the combined injection (default 2000). */
  maxTokens?: number
}

const DEFAULT_MAX_TOKENS = 2000
const WORDS_PER_TOKEN = 0.75 // ~1.33 tokens per word

interface MemoryEntry {
  level: 'global' | 'workspace' | 'project'
  name: string
  body: string
  wordCount: number
}

export class DzupAgentMemoryLoader {
  async load(levels: MemoryLoadLevels, options: MemoryLoadOptions = {}): Promise<string> {
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS
    const maxWords = Math.floor(maxTokens * WORDS_PER_TOKEN)

    const order: Array<{ level: MemoryEntry['level']; dir: string }> = []
    if (levels.global) order.push({ level: 'global', dir: levels.global })
    if (levels.workspace) order.push({ level: 'workspace', dir: levels.workspace })
    if (levels.project) order.push({ level: 'project', dir: levels.project })

    const entries: MemoryEntry[] = []
    for (const { level, dir } of order) {
      const dirEntries = await readMemoryDir(dir, level)
      entries.push(...dirEntries)
    }

    if (entries.length === 0) return ''

    const accepted: MemoryEntry[] = []
    let runningWords = 0
    for (const entry of entries) {
      if (runningWords + entry.wordCount > maxWords) {
        // Truncate whole entries, not mid-entry (FR-2 requirement).
        continue
      }
      accepted.push(entry)
      runningWords += entry.wordCount
    }

    if (accepted.length === 0) return ''

    const lines: string[] = ['## Project Context', '']
    for (const entry of accepted) {
      lines.push(`### ${entry.name}`)
      lines.push('')
      lines.push(entry.body)
      lines.push('')
    }
    return lines.join('\n').trimEnd()
  }
}

async function readMemoryDir(dir: string, level: MemoryEntry['level']): Promise<MemoryEntry[]> {
  let files: string[]
  try {
    files = await fs.readdir(dir)
  } catch (err) {
    if (isNotFound(err)) return []
    throw err
  }
  const mds = files.filter((f) => f.toLowerCase().endsWith('.md')).sort()
  const out: MemoryEntry[] = []
  for (const f of mds) {
    const abs = path.join(dir, f)
    const raw = await fs.readFile(abs, 'utf8')
    const { frontmatter, body } = parseFrontmatter(raw)
    const name = typeof frontmatter['name'] === 'string' ? frontmatter['name'] : path.basename(f, '.md')
    const trimmed = body.trim()
    if (trimmed.length === 0) continue
    out.push({
      level,
      name,
      body: trimmed,
      wordCount: countWords(trimmed),
    })
  }
  return out
}

function countWords(text: string): number {
  const matches = text.match(/\S+/g)
  return matches ? matches.length : 0
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'ENOENT'
}

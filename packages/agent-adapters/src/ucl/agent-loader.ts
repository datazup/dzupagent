/**
 * `DzupAgentAgentLoader` — reads `.dzupagent/agents/*.md` files and
 * produces agent definitions (name + description + systemPrompt + skills +
 * optional preferredProvider).
 *
 * Implements FR-3 (File-Based Agent Loader) from
 * `docs/dzupagent/adapters/UNIFIED_CAPABILITY_LAYER_REQUIREMENTS.md`.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { parseFrontmatter, type FrontmatterValue } from './frontmatter-parser.js'
import type { UclAgentFrontmatter } from './types.js'

export interface LoadedAgentDefinition {
  name: string
  description: string
  systemPrompt: string
  skills: string[]
  preferredProvider?: string
}

export class DzupAgentAgentLoader {
  async loadFromDir(dir: string): Promise<LoadedAgentDefinition[]> {
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch (err) {
      if (isNotFound(err)) return []
      throw err
    }
    const mds = files.filter((f) => f.toLowerCase().endsWith('.md')).sort()
    const out: LoadedAgentDefinition[] = []
    for (const f of mds) {
      const abs = path.join(dir, f)
      const raw = await fs.readFile(abs, 'utf8')
      const { frontmatter, body } = parseFrontmatter(raw)
      const fm = coerceAgentFrontmatter(frontmatter)
      if (!fm) continue
      const def: LoadedAgentDefinition = {
        name: fm.name,
        description: fm.description,
        systemPrompt: body.trim(),
        skills: fm.skills ?? [],
      }
      if (fm.preferredProvider) def.preferredProvider = fm.preferredProvider
      out.push(def)
    }
    return out
  }
}

function coerceAgentFrontmatter(raw: Record<string, FrontmatterValue>): UclAgentFrontmatter | null {
  const name = raw['name']
  const description = raw['description']
  const version = raw['version']
  if (typeof name !== 'string' || name.length === 0) return null
  if (typeof description !== 'string') return null
  if (typeof version !== 'number') return null

  const result: UclAgentFrontmatter = { name, description, version }
  const preferredProvider = raw['preferredProvider']
  if (typeof preferredProvider === 'string') result.preferredProvider = preferredProvider

  const skills = raw['skills']
  if (Array.isArray(skills)) {
    const list: string[] = []
    for (const s of skills) {
      if (typeof s === 'string') list.push(s)
    }
    result.skills = list
  }

  const memoryScope = raw['memoryScope']
  if (memoryScope === 'global' || memoryScope === 'workspace' || memoryScope === 'project') {
    result.memoryScope = memoryScope
  }

  const constraints = raw['constraints']
  if (typeof constraints === 'object' && constraints !== null && !Array.isArray(constraints)) {
    result.constraints = constraints as Record<string, unknown>
  }

  return result
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'ENOENT'
}

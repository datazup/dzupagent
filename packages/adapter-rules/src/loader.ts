/**
 * RuleLoader — loads canonical AdapterRule definitions from the filesystem.
 *
 * Phase 1 supports JSON only (`*.json`). Each file may contain either a single
 * AdapterRule object or an array of AdapterRule objects. Files that fail to
 * parse or contain objects missing required fields are skipped with a warning
 * so that one bad rule file never blocks an entire run.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { AdapterRule, RuleEffect } from './types.js'

const REQUIRED_FIELDS = ['id', 'name', 'scope', 'appliesToProviders', 'effects'] as const

export class RuleLoader {
  /**
   * Load all `*.json` rule files from a directory.
   * Silently skips files that fail to parse or validate.
   * Returns an empty array if the directory does not exist.
   */
  async loadFromDirectory(dirPath: string): Promise<AdapterRule[]> {
    let entries: string[]
    try {
      const st = await stat(dirPath)
      if (!st.isDirectory()) return []
      entries = await readdir(dirPath)
    } catch {
      return []
    }

    const rules: AdapterRule[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const filePath = join(dirPath, entry)
      const loaded = await this.loadFile(filePath)
      rules.push(...loaded)
    }
    return rules
  }

  /**
   * Load a single rule file. Returns all valid rules in the file (one or many).
   * Returns an empty array on parse errors, I/O errors, or validation failures.
   */
  async loadFile(filePath: string): Promise<AdapterRule[]> {
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (err) {
      console.warn(
        `[adapter-rules] failed to read rule file ${filePath}: ${(err as Error).message}`,
      )
      return []
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      console.warn(
        `[adapter-rules] failed to parse rule file ${filePath}: ${(err as Error).message}`,
      )
      return []
    }

    const candidates = Array.isArray(parsed) ? parsed : [parsed]
    const valid: AdapterRule[] = []
    for (const candidate of candidates) {
      if (this.isValidRule(candidate)) {
        valid.push(candidate)
      } else {
        console.warn(
          `[adapter-rules] skipping invalid rule in ${filePath}: missing required fields`,
        )
      }
    }
    return valid
  }

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  private isValidRule(value: unknown): value is AdapterRule {
    if (!value || typeof value !== 'object') return false
    const obj = value as Record<string, unknown>

    for (const field of REQUIRED_FIELDS) {
      if (!(field in obj)) return false
    }

    if (typeof obj['id'] !== 'string') return false
    if (typeof obj['name'] !== 'string') return false
    if (typeof obj['scope'] !== 'string') return false
    if (!Array.isArray(obj['appliesToProviders'])) return false
    if (!obj['appliesToProviders'].every((p) => typeof p === 'string')) return false
    if (!Array.isArray(obj['effects'])) return false
    if (!obj['effects'].every((e) => this.isValidEffect(e))) return false

    return true
  }

  private isValidEffect(value: unknown): value is RuleEffect {
    if (!value || typeof value !== 'object') return false
    const obj = value as Record<string, unknown>
    return typeof obj['kind'] === 'string'
  }
}

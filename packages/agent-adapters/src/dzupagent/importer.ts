/**
 * DzupAgentImporter — first-time migration from native agent files
 * (CLAUDE.md, .claude/commands/, .claude/agents/, .claude/memory/, AGENTS.md)
 * into the .dzupagent/ directory.
 *
 * Never overwrites existing .dzupagent/ files.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DzupAgentPaths } from '@dzupagent/adapter-types'
import { sha256 } from './hash-utils.js'
import {
  discoverImportCandidates,
  fileExists,
  inferSourceType,
} from './importer-discovery.js'
import { transformImportContent } from './importer-transformer.js'
import type {
  DzupAgentImporterOptions,
  ImportPlan,
  ImportResult,
  ImportSource,
  ImportedFileEntry,
  StateJson,
} from './importer-types.js'

export type {
  DzupAgentImporterOptions,
  ImportPlan,
  ImportResult,
  ImportSource,
} from './importer-types.js'

// ---------------------------------------------------------------------------
// DzupAgentImporter
// ---------------------------------------------------------------------------

export class DzupAgentImporter {
  private readonly paths: DzupAgentPaths
  private readonly projectRoot: string

  constructor(options: DzupAgentImporterOptions) {
    this.paths = options.paths
    this.projectRoot = options.projectRoot
  }

  // -------------------------------------------------------------------------
  // planImport
  // -------------------------------------------------------------------------

  /** Scan for all importable native files. Does NOT write anything. */
  async planImport(): Promise<ImportPlan> {
    const toImport: ImportPlan['toImport'] = []
    const toSkip: ImportPlan['toSkip'] = []

    const candidates = await discoverImportCandidates(this.projectRoot, this.paths)

    for (const { source, targetPath } of candidates) {
      const exists = await fileExists(targetPath)
      if (exists) {
        toSkip.push({ source, targetPath, reason: 'target already exists' })
      } else {
        toImport.push({ source, targetPath })
      }
    }

    return { toImport, toSkip }
  }

  // -------------------------------------------------------------------------
  // executeImport
  // -------------------------------------------------------------------------

  /** Execute plan: write target files (skip existing). Updates state.json. */
  async executeImport(plan: ImportPlan): Promise<ImportResult[]> {
    const results: ImportResult[] = []

    // Load existing state.json (preserving projections and other keys)
    const state = await this.loadState()

    for (const entry of plan.toImport) {
      const { source, targetPath } = entry

      const rawContent = await readFile(source.sourcePath, 'utf-8')
      const transformed = transformImportContent(source, rawContent)

      // Ensure target directory exists
      const targetDir = join(targetPath, '..')
      await mkdir(targetDir, { recursive: true })

      await writeFile(targetPath, transformed, 'utf-8')

      // Hash source content and store in state
      const hash = sha256(rawContent)
      state.files[source.sourcePath] = {
        hash,
        importedAt: new Date().toISOString(),
      }

      results.push({
        source,
        targetPath,
        written: true,
        skipped: false,
        summary: `Imported ${source.sourcePath} -> ${targetPath}`,
      })
    }

    // Also record skipped items in results
    for (const entry of plan.toSkip) {
      results.push({
        source: entry.source,
        targetPath: entry.targetPath,
        written: false,
        skipped: true,
        summary: `Skipped ${entry.source.sourcePath}: ${entry.reason}`,
      })
    }

    // Persist state.json
    await this.saveState(state)

    // Best-effort: ensure .dzupagent/state.json is in .gitignore
    await this.ensureGitignore()

    return results
  }

  // -------------------------------------------------------------------------
  // detectDivergence
  // -------------------------------------------------------------------------

  /** Check if any previously-imported source files have changed. */
  async detectDivergence(): Promise<Array<{ source: ImportSource; diverged: boolean }>> {
    const state = await this.loadState()
    const results: Array<{ source: ImportSource; diverged: boolean }> = []

    for (const [sourcePath, entry] of Object.entries(state.files)) {
      const source = inferSourceType(sourcePath)
      if (!source) continue

      try {
        const currentContent = await readFile(sourcePath, 'utf-8')
        const currentHash = sha256(currentContent)
        results.push({
          source,
          diverged: currentHash !== entry.hash,
        })
      } catch {
        // Source file was deleted — treat as diverged
        results.push({
          source,
          diverged: true,
        })
      }
    }

    return results
  }

  // -------------------------------------------------------------------------
  // Private: .gitignore
  // -------------------------------------------------------------------------

  private async ensureGitignore(): Promise<void> {
    const gitignorePath = join(this.projectRoot, '.gitignore')
    const entry = '.dzupagent/state.json'
    try {
      let content = ''
      try {
        content = await readFile(gitignorePath, 'utf-8')
      } catch {
        // file doesn't exist yet
      }
      if (!content.includes(entry)) {
        const newContent = content
          ? `${content.trimEnd()}\n${entry}\n`
          : `${entry}\n`
        await writeFile(gitignorePath, newContent, 'utf-8')
      }
    } catch {
      // best-effort — gitignore update failure must not block import
    }
  }

  // -------------------------------------------------------------------------
  // Private: state.json
  // -------------------------------------------------------------------------

  private async loadState(): Promise<StateJson> {
    try {
      const raw = await readFile(this.paths.stateFile, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<StateJson>
      return {
        version: 1,
        projections: parsed.projections ?? {},
        files: (parsed.files ?? {}) as Record<string, ImportedFileEntry>,
      }
    } catch {
      return { version: 1, projections: {}, files: {} }
    }
  }

  private async saveState(state: StateJson): Promise<void> {
    const dir = join(this.paths.stateFile, '..')
    await mkdir(dir, { recursive: true })
    await writeFile(this.paths.stateFile, JSON.stringify(state, null, 2), 'utf-8')
  }
}

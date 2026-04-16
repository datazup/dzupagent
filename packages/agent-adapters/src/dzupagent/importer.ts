/**
 * DzupAgentImporter — first-time migration from native agent files
 * (CLAUDE.md, .claude/commands/, .claude/agents/, .claude/memory/, AGENTS.md)
 * into the .dzupagent/ directory.
 *
 * Never overwrites existing .dzupagent/ files.
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import type { DzupAgentPaths } from '@dzupagent/adapter-types'
import { parseMarkdownFile } from './md-frontmatter-parser.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ImportSource {
  type: 'claude-md' | 'claude-commands' | 'claude-agents' | 'claude-memory' | 'codex-agents-md'
  sourcePath: string
}

export interface ImportResult {
  source: ImportSource
  targetPath: string
  /** true = file was written */
  written: boolean
  /** true = target already existed, file was skipped */
  skipped: boolean
  summary: string
}

export interface ImportPlan {
  /** Files that will be imported (target does not exist) */
  toImport: Array<{ source: ImportSource; targetPath: string }>
  /** Files that will be skipped (target already exists) */
  toSkip: Array<{ source: ImportSource; targetPath: string; reason: string }>
}

export interface DzupAgentImporterOptions {
  paths: DzupAgentPaths
  /** Project root directory (where CLAUDE.md, .claude/, AGENTS.md live) */
  projectRoot: string
}

/** Hash entry stored in state.json under the `files` key */
interface ImportedFileEntry {
  hash: string
  importedAt: string
}

/** Shape of state.json (shared with FileAdapterSkillVersionStore) */
interface StateJson {
  version: 1
  projections: Record<string, unknown>
  files: Record<string, ImportedFileEntry>
}

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

    const candidates = await this.discoverCandidates()

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
      const transformed = this.transformContent(source, rawContent)

      // Ensure target directory exists
      const targetDir = join(targetPath, '..')
      await mkdir(targetDir, { recursive: true })

      await writeFile(targetPath, transformed, 'utf-8')

      // Hash source content and store in state
      const hash = createHash('sha256').update(rawContent).digest('hex')
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
      const source = this.inferSourceType(sourcePath)
      if (!source) continue

      try {
        const currentContent = await readFile(sourcePath, 'utf-8')
        const currentHash = createHash('sha256').update(currentContent).digest('hex')
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
  // Private: discovery
  // -------------------------------------------------------------------------

  private async discoverCandidates(): Promise<Array<{ source: ImportSource; targetPath: string }>> {
    const candidates: Array<{ source: ImportSource; targetPath: string }> = []
    const projectDir = this.paths.projectDir

    // CLAUDE.md
    const claudeMd = join(this.projectRoot, 'CLAUDE.md')
    if (await fileExists(claudeMd)) {
      candidates.push({
        source: { type: 'claude-md', sourcePath: claudeMd },
        targetPath: join(projectDir, 'memory', 'claude-project-context.md'),
      })
    }

    // AGENTS.md
    const agentsMd = join(this.projectRoot, 'AGENTS.md')
    if (await fileExists(agentsMd)) {
      candidates.push({
        source: { type: 'codex-agents-md', sourcePath: agentsMd },
        targetPath: join(projectDir, 'memory', 'codex-project-context.md'),
      })
    }

    // .claude/commands/*.md
    const commandsDir = join(this.projectRoot, '.claude', 'commands')
    const commandFiles = await globMdFiles(commandsDir)
    for (const file of commandFiles) {
      const name = basename(file, '.md')
      candidates.push({
        source: { type: 'claude-commands', sourcePath: join(commandsDir, file) },
        targetPath: join(projectDir, 'skills', `${name}.md`),
      })
    }

    // .claude/agents/*.md
    const agentsDir = join(this.projectRoot, '.claude', 'agents')
    const agentFiles = await globMdFiles(agentsDir)
    for (const file of agentFiles) {
      const name = basename(file, '.md')
      candidates.push({
        source: { type: 'claude-agents', sourcePath: join(agentsDir, file) },
        targetPath: join(projectDir, 'agents', `${name}.md`),
      })
    }

    // .claude/memory/*.md
    const memoryDir = join(this.projectRoot, '.claude', 'memory')
    const memoryFiles = await globMdFiles(memoryDir)
    for (const file of memoryFiles) {
      const name = basename(file, '.md')
      candidates.push({
        source: { type: 'claude-memory', sourcePath: join(memoryDir, file) },
        targetPath: join(projectDir, 'memory', `${name}.md`),
      })
    }

    return candidates
  }

  // -------------------------------------------------------------------------
  // Private: transformations
  // -------------------------------------------------------------------------

  private transformContent(source: ImportSource, rawContent: string): string {
    switch (source.type) {
      case 'claude-md':
        return this.wrapWithFrontmatter(rawContent, {
          name: 'claude-project-context',
          description: 'Claude project context imported from CLAUDE.md',
          type: 'project',
          importedFrom: 'CLAUDE.md',
        })

      case 'codex-agents-md':
        return this.wrapWithFrontmatter(rawContent, {
          name: 'codex-project-context',
          description: 'Codex project context imported from AGENTS.md',
          type: 'project',
          importedFrom: 'AGENTS.md',
        })

      case 'claude-commands': {
        const name = basename(source.sourcePath, '.md')
        const relativePath = `.claude/commands/${basename(source.sourcePath)}`
        return this.addOrCreateFrontmatter(rawContent, {
          name,
          description: `Imported from ${relativePath}`,
          importedFrom: relativePath,
        })
      }

      case 'claude-agents': {
        const name = basename(source.sourcePath, '.md')
        const relativePath = `.claude/agents/${basename(source.sourcePath)}`
        return this.addOrCreateFrontmatter(rawContent, {
          name,
          description: `Imported from ${relativePath}`,
          importedFrom: relativePath,
        })
      }

      case 'claude-memory': {
        const name = basename(source.sourcePath, '.md')
        const relativePath = `.claude/memory/${basename(source.sourcePath)}`
        return this.addOrCreateFrontmatter(rawContent, {
          name,
          description: 'Claude agent-specific memory',
          type: 'agent',
          importedFrom: relativePath,
        })
      }
    }
  }

  /**
   * Wrap raw content with a full frontmatter block (no existing frontmatter expected).
   */
  private wrapWithFrontmatter(
    content: string,
    fields: Record<string, string>,
  ): string {
    const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`)
    return `---\n${lines.join('\n')}\n---\n\n${content}`
  }

  /**
   * If file already has frontmatter, add `importedFrom` (and other missing fields).
   * If no frontmatter, create a new frontmatter block.
   */
  private addOrCreateFrontmatter(
    content: string,
    fields: Record<string, string>,
  ): string {
    const parsed = parseMarkdownFile(content)
    const hasFrontmatter = Object.keys(parsed.frontmatter).length > 0

    if (hasFrontmatter) {
      // Insert importedFrom into existing frontmatter
      return this.insertIntoExistingFrontmatter(content, fields)
    }

    // No frontmatter — wrap with new block
    const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`)
    return `---\n${lines.join('\n')}\n---\n\n${content}`
  }

  /**
   * Insert new fields into existing YAML frontmatter.
   * Only adds fields that are not already present.
   */
  private insertIntoExistingFrontmatter(
    content: string,
    fields: Record<string, string>,
  ): string {
    const lines = content.split('\n')

    // Find the opening and closing ---
    let openIdx = -1
    let closeIdx = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trim() === '---') {
        if (openIdx === -1) {
          openIdx = i
        } else {
          closeIdx = i
          break
        }
      }
    }

    if (openIdx === -1 || closeIdx === -1) {
      // Shouldn't happen if hasFrontmatter is true, but be safe
      return content
    }

    // Extract existing frontmatter lines
    const fmLines = lines.slice(openIdx + 1, closeIdx)

    // Check which fields already exist
    const existingKeys = new Set<string>()
    for (const line of fmLines) {
      const match = /^([a-zA-Z_][\w-]*):\s*/.exec(line)
      if (match) existingKeys.add(match[1]!)
    }

    // Add missing fields
    const newLines: string[] = []
    for (const [key, value] of Object.entries(fields)) {
      if (!existingKeys.has(key)) {
        newLines.push(`${key}: ${value}`)
      }
    }

    if (newLines.length === 0) return content

    // Insert new lines before the closing ---
    const result = [
      ...lines.slice(0, closeIdx),
      ...newLines,
      ...lines.slice(closeIdx),
    ]

    return result.join('\n')
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

  // -------------------------------------------------------------------------
  // Private: helpers
  // -------------------------------------------------------------------------

  private inferSourceType(sourcePath: string): ImportSource | undefined {
    if (sourcePath.endsWith('CLAUDE.md') && !sourcePath.includes('.claude')) {
      return { type: 'claude-md', sourcePath }
    }
    if (sourcePath.endsWith('AGENTS.md')) {
      return { type: 'codex-agents-md', sourcePath }
    }
    if (sourcePath.includes('.claude/commands/')) {
      return { type: 'claude-commands', sourcePath }
    }
    if (sourcePath.includes('.claude/agents/')) {
      return { type: 'claude-agents', sourcePath }
    }
    if (sourcePath.includes('.claude/memory/')) {
      return { type: 'claude-memory', sourcePath }
    }
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** List *.md files in a directory. Returns empty array if dir doesn't exist. */
async function globMdFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath)
    return entries.filter((f) => f.endsWith('.md')).sort()
  } catch {
    return []
  }
}

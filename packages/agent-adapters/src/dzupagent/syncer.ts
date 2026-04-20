/**
 * DzupAgentSyncer -- generates native agent files from .dzupagent/ definitions.
 *
 * Implements write-back sync across all 6 supported providers:
 *   - Claude  (full: commands + agents + skills + instructions)
 *   - Codex   (instructions)
 *   - Gemini  (instructions)
 *   - Goose   (instructions)
 *   - Qwen    (instructions + skills + agents)
 *   - Crush   (skills)
 *
 * Writes provider-native files (e.g. `.claude/commands/<name>.md`,
 * `.claude/agents/<name>.md`) from skill bundles and agent definitions.
 * Detects divergence (user-edited native files) and skips those to avoid
 * data loss.
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { DzupAgentPaths } from '../types.js'
import type { AdapterSkillBundle } from '../skills/adapter-skill-types.js'
import type { DzupAgentFileLoader } from './file-loader.js'
import type { DzupAgentAgentLoader, AgentDefinition } from './agent-loader.js'
import { DryRunReporter, type DryRunReporterMode } from './dry-run-reporter.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SyncTarget = 'claude' | 'codex' | 'gemini' | 'qwen' | 'goose' | 'crush'

// ---------------------------------------------------------------------------
// Provider capability map
// ---------------------------------------------------------------------------

/** Which providers support native write-back for which target types */
const PROVIDER_SYNC_CAPABILITIES: Record<
  SyncTarget,
  { instructions: boolean; skills: boolean; agents: boolean }
> = {
  claude:  { instructions: true,  skills: true,  agents: true  },
  codex:   { instructions: true,  skills: false, agents: false },
  gemini:  { instructions: true,  skills: false, agents: false },
  qwen:    { instructions: true,  skills: true,  agents: true  },
  goose:   { instructions: true,  skills: false, agents: false },
  crush:   { instructions: false, skills: true,  agents: false },
}

export interface SyncPlanEntry {
  sourcePath: string
  targetPath: string
  content: string
}

export interface SyncDivergedEntry {
  targetPath: string
  lastSyncHash: string
  currentHash: string
  /** New content that would be written if --force is used. */
  newContent?: string
  /** Source identifier for the new content. */
  sourcePath?: string
}

export interface SyncPlan {
  target: SyncTarget
  toWrite: SyncPlanEntry[]
  diverged: SyncDivergedEntry[]
  warnings?: string[]
}

export interface SyncResultWritten {
  targetPath: string
  sourcePath: string
}

export interface SyncResultSkipped {
  targetPath: string
  reason: string
}

export interface SyncResultDiverged {
  targetPath: string
  divergenceType: 'content' | 'deleted'
}

export interface SyncResult {
  target: SyncTarget
  written: SyncResultWritten[]
  skipped: SyncResultSkipped[]
  diverged: SyncResultDiverged[]
  warnings?: string[]
}

export interface DzupAgentSyncerOptions {
  paths: DzupAgentPaths
  projectRoot: string
  fileLoader: DzupAgentFileLoader
  agentLoader: DzupAgentAgentLoader
}

// ---------------------------------------------------------------------------
// state.json sync section
// ---------------------------------------------------------------------------

interface SyncStateEntry {
  lastSyncHash: string
  syncedAt: string
}

interface StateJson {
  version: 1
  projections: Record<string, unknown>
  files: Record<string, unknown>
  sync: Record<string, SyncStateEntry>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

async function readFileSafe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return undefined
  }
}

function buildUnifiedDiff(oldText: string, newText: string, filePath: string): string {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const header = `--- ${filePath} (current)\n+++ ${filePath} (source)\n`

  // Simple Myers-like LCS diff — produces unified hunks
  const m = oldLines.length
  const n = newLines.length

  // Build edit script via DP
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i]![j] = (dp[i + 1]?.[j + 1] ?? 0) + 1
      } else {
        dp[i]![j] = Math.max(dp[i + 1]?.[j] ?? 0, dp[i]?.[j + 1] ?? 0)
      }
    }
  }

  // Collect raw diff ops: ' ' keep, '-' remove, '+' add
  const ops: Array<{ op: ' ' | '-' | '+'; line: string }> = []
  let i = 0
  let j = 0
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      ops.push({ op: ' ', line: oldLines[i] ?? '' })
      i++
      j++
    } else if (j < n && (i >= m || (dp[i + 1]?.[j] ?? 0) <= (dp[i]?.[j + 1] ?? 0))) {
      ops.push({ op: '+', line: newLines[j] ?? '' })
      j++
    } else {
      ops.push({ op: '-', line: oldLines[i] ?? '' })
      i++
    }
  }

  // Group into hunks (context = 3)
  const CONTEXT = 3
  const changedIdx = ops.reduce<number[]>((acc, o, idx) => {
    if (o.op !== ' ') acc.push(idx)
    return acc
  }, [])

  if (changedIdx.length === 0) return ''

  const hunks: string[] = []
  let k = 0
  while (k < changedIdx.length) {
    const start = Math.max(0, (changedIdx[k] ?? 0) - CONTEXT)
    let end = changedIdx[k] ?? 0
    while (k < changedIdx.length && (changedIdx[k] ?? 0) <= end + CONTEXT * 2) {
      end = changedIdx[k] ?? end
      k++
    }
    end = Math.min(ops.length - 1, end + CONTEXT)

    const slice = ops.slice(start, end + 1)
    const oldStart = slice.filter((o) => o.op !== '+').length > 0 ? start + 1 : start + 1
    const newStart = start + 1
    const oldCount = slice.filter((o) => o.op !== '+').length
    const newCount = slice.filter((o) => o.op !== '-').length
    const hunkHeader = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`
    const lines = slice.map((o) => `${o.op}${o.line}`)
    hunks.push([hunkHeader, ...lines].join('\n'))
  }

  return header + hunks.join('\n')
}

async function readStateJson(stateFile: string): Promise<StateJson> {
  const raw = await readFileSafe(stateFile)
  if (raw === undefined) {
    return { version: 1, projections: {}, files: {}, sync: {} }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StateJson>
    return {
      version: 1,
      projections: (parsed.projections && typeof parsed.projections === 'object') ? parsed.projections : {},
      files: (parsed.files && typeof parsed.files === 'object') ? parsed.files : {},
      sync: (parsed.sync && typeof parsed.sync === 'object') ? parsed.sync as Record<string, SyncStateEntry> : {},
    }
  } catch {
    return { version: 1, projections: {}, files: {}, sync: {} }
  }
}

async function writeStateJson(stateFile: string, state: StateJson): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true })
  await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8')
}

// ---------------------------------------------------------------------------
// Candidate: intermediate type before divergence classification
// ---------------------------------------------------------------------------

interface SyncCandidate {
  sourcePath: string
  targetPath: string
  content: string
}

// ---------------------------------------------------------------------------
// DzupAgentSyncer
// ---------------------------------------------------------------------------

export class DzupAgentSyncer {
  private readonly paths: DzupAgentPaths
  private readonly projectRoot: string
  private readonly fileLoader: DzupAgentFileLoader
  private readonly agentLoader: DzupAgentAgentLoader

  constructor(options: DzupAgentSyncerOptions) {
    this.paths = options.paths
    this.projectRoot = options.projectRoot
    this.fileLoader = options.fileLoader
    this.agentLoader = options.agentLoader
  }

  // -------------------------------------------------------------------------
  // Plan
  // -------------------------------------------------------------------------

  async planSync(target: SyncTarget): Promise<SyncPlan> {
    const caps = PROVIDER_SYNC_CAPABILITIES[target]
    const warnings: string[] = []

    // Codex: instructions → AGENTS.md
    if (target === 'codex') {
      const memoryEntries = await this.loadMemoryFiles(this.paths.projectDir)
      const globalEntries =
        this.paths.globalDir !== this.paths.projectDir
          ? await this.loadMemoryFiles(this.paths.globalDir)
          : []
      const allEntries = [...globalEntries, ...memoryEntries]
      const targetPath = join(this.projectRoot, 'AGENTS.md')
      const state = await readStateJson(this.paths.stateFile)

      if (allEntries.length === 0) {
        return { target: 'codex', toWrite: [], diverged: [] }
      }

      const content = this.renderInstructionsFile(allEntries, 'DzupAgent Instructions')
      const stored = state.sync[targetPath]
      const existingContent = await readFileSafe(targetPath)

      if (existingContent === undefined || stored === undefined) {
        return { target: 'codex', toWrite: [{ sourcePath: '.dzupagent/memory', targetPath, content }], diverged: [] }
      }

      const currentHash = sha256(existingContent)
      if (stored.lastSyncHash === currentHash) {
        return { target: 'codex', toWrite: [{ sourcePath: '.dzupagent/memory', targetPath, content }], diverged: [] }
      }

      return { target: 'codex', toWrite: [], diverged: [{ targetPath, lastSyncHash: stored.lastSyncHash, currentHash, newContent: content, sourcePath: '.dzupagent/memory' }] }
    }

    // Gemini: instructions → GEMINI.md
    if (target === 'gemini') {
      const memoryEntries = await this.loadMemoryFiles(this.paths.projectDir)
      const globalEntries =
        this.paths.globalDir !== this.paths.projectDir
          ? await this.loadMemoryFiles(this.paths.globalDir)
          : []
      const allEntries = [...globalEntries, ...memoryEntries]
      const targetPath = join(this.projectRoot, 'GEMINI.md')
      const state = await readStateJson(this.paths.stateFile)

      if (allEntries.length === 0) {
        return { target: 'gemini', toWrite: [], diverged: [] }
      }

      const content = this.renderInstructionsFile(allEntries, 'DzupAgent Gemini Instructions')
      const stored = state.sync[targetPath]
      const existingContent = await readFileSafe(targetPath)

      if (existingContent === undefined || stored === undefined) {
        return { target: 'gemini', toWrite: [{ sourcePath: '.dzupagent/memory', targetPath, content }], diverged: [] }
      }

      const currentHash = sha256(existingContent)
      if (stored.lastSyncHash === currentHash) {
        return { target: 'gemini', toWrite: [{ sourcePath: '.dzupagent/memory', targetPath, content }], diverged: [] }
      }

      return { target: 'gemini', toWrite: [], diverged: [{ targetPath, lastSyncHash: stored.lastSyncHash, currentHash, newContent: content, sourcePath: '.dzupagent/memory' }] }
    }

    // Goose: instructions → .goosehints
    if (target === 'goose') {
      const memoryEntries = await this.loadMemoryFiles(this.paths.projectDir)
      const globalEntries =
        this.paths.globalDir !== this.paths.projectDir
          ? await this.loadMemoryFiles(this.paths.globalDir)
          : []
      const allEntries = [...globalEntries, ...memoryEntries]
      const targetPath = join(this.projectRoot, '.goosehints')
      const state = await readStateJson(this.paths.stateFile)

      if (allEntries.length === 0) {
        return { target: 'goose', toWrite: [], diverged: [] }
      }

      const content = this.renderGooseHints(allEntries)
      const stored = state.sync[targetPath]
      const existingContent = await readFileSafe(targetPath)

      if (existingContent === undefined || stored === undefined) {
        return { target: 'goose', toWrite: [{ sourcePath: '.dzupagent/memory', targetPath, content }], diverged: [] }
      }

      const currentHash = sha256(existingContent)
      if (stored.lastSyncHash === currentHash) {
        return { target: 'goose', toWrite: [{ sourcePath: '.dzupagent/memory', targetPath, content }], diverged: [] }
      }

      return { target: 'goose', toWrite: [], diverged: [{ targetPath, lastSyncHash: stored.lastSyncHash, currentHash, newContent: content, sourcePath: '.dzupagent/memory' }] }
    }

    // Crush: skills → .crush/skills/<bundleId>.md
    if (target === 'crush') {
      const skills = await this.fileLoader.loadSkills()
      const state = await readStateJson(this.paths.stateFile)
      const syncState = state.sync
      const candidates: SyncCandidate[] = []

      for (const bundle of skills) {
        const content = this.renderClaudeCommand(bundle)
        const targetPath = join(this.projectRoot, '.crush', 'skills', `${bundle.bundleId}.md`)
        candidates.push({ sourcePath: bundle.bundleId, targetPath, content })
      }

      const toWrite: SyncPlanEntry[] = []
      const diverged: SyncDivergedEntry[] = []

      for (const candidate of candidates) {
        const stored = syncState[candidate.targetPath]
        const existingContent = await readFileSafe(candidate.targetPath)

        if (existingContent === undefined || stored === undefined) {
          toWrite.push(candidate)
        } else {
          const currentHash = sha256(existingContent)
          if (stored.lastSyncHash === currentHash) {
            toWrite.push(candidate)
          } else {
            diverged.push({ targetPath: candidate.targetPath, lastSyncHash: stored.lastSyncHash, currentHash, newContent: candidate.content, sourcePath: candidate.sourcePath })
          }
        }
      }

      return { target: 'crush', toWrite, diverged }
    }

    // Qwen: full sync — skills to .qwen/skills/, agents to .qwen/agents/
    if (target === 'qwen') {
      const skills = await this.fileLoader.loadSkills()
      const agents = await this.agentLoader.loadAgents()
      const state = await readStateJson(this.paths.stateFile)
      const syncState = state.sync

      const candidates: SyncCandidate[] = []

      // Skills -> .qwen/skills/<bundleId>.md
      if (caps.skills) {
        for (const bundle of skills) {
          const content = this.renderQwenCommand(bundle)
          const targetPath = join(this.projectRoot, '.qwen', 'skills', `${bundle.bundleId}.md`)
          candidates.push({ sourcePath: bundle.bundleId, targetPath, content })
        }
      } else {
        warnings.push(`${target}: skills write-back is not supported — skipping skills.`)
      }

      // Agents -> .qwen/agents/<name>.md
      if (caps.agents) {
        for (const agent of agents) {
          const content = this.renderQwenAgent(agent)
          const targetPath = join(this.projectRoot, '.qwen', 'agents', `${agent.name}.md`)
          candidates.push({ sourcePath: agent.filePath, targetPath, content })
        }
      } else {
        warnings.push(`${target}: agents write-back is not supported — skipping agents.`)
      }

      // Classify each candidate
      const toWrite: SyncPlanEntry[] = []
      const diverged: SyncDivergedEntry[] = []

      for (const candidate of candidates) {
        const stored = syncState[candidate.targetPath]
        const existingContent = await readFileSafe(candidate.targetPath)

        if (existingContent === undefined) {
          // File doesn't exist -- always write
          toWrite.push(candidate)
        } else if (stored === undefined) {
          // First sync -- no stored hash yet -- write
          toWrite.push(candidate)
        } else {
          const currentHash = sha256(existingContent)
          if (stored.lastSyncHash === currentHash) {
            // No divergence -- safe to overwrite
            toWrite.push(candidate)
          } else {
            // User edited the native file -- diverged
            diverged.push({
              targetPath: candidate.targetPath,
              lastSyncHash: stored.lastSyncHash,
              currentHash,
              newContent: candidate.content,
              sourcePath: candidate.sourcePath,
            })
          }
        }
      }

      return { target: 'qwen', toWrite, diverged, ...(warnings.length > 0 ? { warnings } : {}) }
    }

    // Claude: full sync
    const skills = await this.fileLoader.loadSkills()
    const agents = await this.agentLoader.loadAgents()
    const state = await readStateJson(this.paths.stateFile)
    const syncState = state.sync

    const candidates: SyncCandidate[] = []

    // Skills -> .claude/commands/<bundleId>.md
    if (caps.skills) {
      for (const bundle of skills) {
        const content = this.renderClaudeCommand(bundle)
        const targetPath = join(this.projectRoot, '.claude', 'commands', `${bundle.bundleId}.md`)
        candidates.push({ sourcePath: bundle.bundleId, targetPath, content })
      }
    } else {
      warnings.push(`${target}: skills write-back is not supported — skipping skills.`)
    }

    // Agents -> .claude/agents/<name>.md
    if (caps.agents) {
      for (const agent of agents) {
        const content = this.renderClaudeAgent(agent)
        const targetPath = join(this.projectRoot, '.claude', 'agents', `${agent.name}.md`)
        candidates.push({ sourcePath: agent.filePath, targetPath, content })
      }
    } else {
      warnings.push(`${target}: agents write-back is not supported — skipping agents.`)
    }

    // Classify each candidate
    const toWrite: SyncPlanEntry[] = []
    const diverged: SyncDivergedEntry[] = []

    for (const candidate of candidates) {
      const stored = syncState[candidate.targetPath]
      const existingContent = await readFileSafe(candidate.targetPath)

      if (existingContent === undefined) {
        // File doesn't exist -- always write
        toWrite.push(candidate)
      } else if (stored === undefined) {
        // First sync -- no stored hash yet -- write
        toWrite.push(candidate)
      } else {
        const currentHash = sha256(existingContent)
        if (stored.lastSyncHash === currentHash) {
          // No divergence -- safe to overwrite
          toWrite.push(candidate)
        } else {
          // User edited the native file -- diverged
          diverged.push({
            targetPath: candidate.targetPath,
            lastSyncHash: stored.lastSyncHash,
            currentHash,
            newContent: candidate.content,
            sourcePath: candidate.sourcePath,
          })
        }
      }
    }

    return { target: 'claude', toWrite, diverged, ...(warnings.length > 0 ? { warnings } : {}) }
  }

  // -------------------------------------------------------------------------
  // Execute
  // -------------------------------------------------------------------------

  async executeSync(
    plan: SyncPlan,
    opts: { force?: boolean; dryRun?: boolean; dryRunFormat?: DryRunReporterMode } = {},
  ): Promise<SyncResult> {
    const force = opts.force === true
    const dryRun = opts.dryRun === true
    const dryRunFormat: DryRunReporterMode = opts.dryRunFormat ?? 'console'
    const reporter = new DryRunReporter({ format: dryRunFormat })
    const written: SyncResultWritten[] = []
    const skipped: SyncResultSkipped[] = []
    const resultDiverged: SyncResultDiverged[] = []

    // Log any warnings from the plan
    if (plan.warnings !== undefined) {
      for (const warning of plan.warnings) {
        console.warn(warning)
      }
    }

    if (dryRun && dryRunFormat === 'console') {
      console.log('\n[dry-run] No files will be written. Showing planned changes:')
    }

    const state = await readStateJson(this.paths.stateFile)

    // Handle diverged entries
    for (const d of plan.diverged) {
      if (!force) {
        resultDiverged.push({ targetPath: d.targetPath, divergenceType: 'content' })
        continue
      }

      const currentContent = await readFileSafe(d.targetPath)
      if (currentContent === undefined) {
        resultDiverged.push({ targetPath: d.targetPath, divergenceType: 'deleted' })
        continue
      }

      if (d.newContent === undefined) {
        console.warn(`WARNING: Cannot force-overwrite ${d.targetPath} — new content unavailable in plan.`)
        resultDiverged.push({ targetPath: d.targetPath, divergenceType: 'content' })
        continue
      }

      const diff = buildUnifiedDiff(currentContent, d.newContent, d.targetPath)
      if (diff.length > 0) {
        reporter.reportDiff(d.targetPath, diff)
      }
      if (dryRun) {
        reporter.reportWouldOverwrite(d.targetPath)
      } else {
        console.warn(`WARNING: Overwriting diverged file: ${d.targetPath}`)
        await mkdir(dirname(d.targetPath), { recursive: true })
        await writeFile(d.targetPath, d.newContent, 'utf-8')

        const hash = sha256(d.newContent)
        state.sync[d.targetPath] = {
          lastSyncHash: hash,
          syncedAt: new Date().toISOString(),
        }
      }

      written.push({ targetPath: d.targetPath, sourcePath: d.sourcePath ?? d.targetPath })
    }

    // Write non-diverged entries
    for (const entry of plan.toWrite) {
      if (dryRun) {
        const existing = await readFileSafe(entry.targetPath)
        if (existing !== undefined) {
          const diff = buildUnifiedDiff(existing, entry.content, entry.targetPath)
          if (diff.length > 0) {
            reporter.reportDiff(entry.targetPath, diff)
          }
        } else {
          reporter.reportNewFile(entry.targetPath)
        }
        reporter.reportWouldWrite(entry.targetPath)
      } else {
        await mkdir(dirname(entry.targetPath), { recursive: true })
        await writeFile(entry.targetPath, entry.content, 'utf-8')

        const hash = sha256(entry.content)
        state.sync[entry.targetPath] = {
          lastSyncHash: hash,
          syncedAt: new Date().toISOString(),
        }
      }

      written.push({ targetPath: entry.targetPath, sourcePath: entry.sourcePath })
    }

    // Persist state.json preserving projections and files (skip when dry-run)
    if (dryRun) {
      reporter.flush()
    } else {
      await writeStateJson(this.paths.stateFile, state)
    }

    return {
      target: plan.target,
      written,
      skipped,
      diverged: resultDiverged,
      ...(plan.warnings !== undefined ? { warnings: plan.warnings } : {}),
    }
  }

  // -------------------------------------------------------------------------
  // Renderers
  // -------------------------------------------------------------------------

  renderQwenCommand(bundle: AdapterSkillBundle): string {
    return this.renderClaudeCommand(bundle)
  }

  renderQwenAgent(agent: AgentDefinition): string {
    return this.renderClaudeAgent(agent)
  }

  renderClaudeCommand(bundle: AdapterSkillBundle): string {
    const description = bundle.metadata.owner !== 'unknown'
      ? `${bundle.bundleId} (by ${bundle.metadata.owner})`
      : bundle.bundleId

    const sorted = [...bundle.promptSections].sort((a, b) => a.priority - b.priority)
    const body = sorted.map((s) => s.content).join('\n\n')

    return `---\ndescription: ${description}\n---\n\n${body}\n`
  }

  renderClaudeAgent(agent: AgentDefinition): string {
    const description = agent.description || agent.name

    return `---\ndescription: ${description}\n---\n\n${agent.personaPrompt}\n`
  }

  renderInstructionsFile(entries: Array<{ name: string; content: string }>, title: string): string {
    const body = entries.map((e) => e.content).join('\n\n---\n\n')
    return `# ${title}\n\n${body}\n`
  }

  renderGooseHints(entries: Array<{ name: string; content: string }>): string {
    return entries.map((e) => e.content).join('\n\n---\n\n') + '\n'
  }

  // -------------------------------------------------------------------------
  // Private: memory file loader
  // -------------------------------------------------------------------------

  private async loadMemoryFiles(baseDir: string): Promise<Array<{ name: string; content: string }>> {
    const memoryDir = join(baseDir, 'memory')
    let fileNames: string[]

    try {
      fileNames = await readdir(memoryDir)
    } catch {
      return []
    }

    const mdFiles = fileNames.filter((f) => f.endsWith('.md')).sort()
    const results: Array<{ name: string; content: string }> = []

    await Promise.all(
      mdFiles.map(async (filename) => {
        const filePath = join(memoryDir, filename)
        const raw = await readFileSafe(filePath)
        if (raw === undefined) return

        // Strip YAML frontmatter: ---\n...\n---\n
        const stripped = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
        if (stripped.length === 0) return

        const name = basename(filename, extname(filename))
        results.push({ name, content: stripped })
      }),
    )

    results.sort((a, b) => a.name.localeCompare(b.name))
    return results
  }
}

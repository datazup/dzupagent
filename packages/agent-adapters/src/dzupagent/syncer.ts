/**
 * DzupAgentSyncer -- generates native agent files from .dzupagent/ definitions.
 *
 * Writes `.claude/commands/<name>.md` and `.claude/agents/<name>.md` from
 * skill bundles and agent definitions.  Detects divergence (user-edited
 * native files) and skips those to avoid data loss.
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DzupAgentPaths } from '../types.js'
import type { AdapterSkillBundle } from '../skills/adapter-skill-types.js'
import type { DzupAgentFileLoader } from './file-loader.js'
import type { DzupAgentAgentLoader, AgentDefinition } from './agent-loader.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SyncTarget = 'claude' | 'codex'

export interface SyncPlanEntry {
  sourcePath: string
  targetPath: string
  content: string
}

export interface SyncDivergedEntry {
  targetPath: string
  lastSyncHash: string
  currentHash: string
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
    if (target === 'codex') {
      return {
        target: 'codex',
        toWrite: [],
        diverged: [],
        warnings: ['Codex sync is not yet implemented. Use AGENTS.md for Codex project context.'],
      }
    }

    const skills = await this.fileLoader.loadSkills()
    const agents = await this.agentLoader.loadAgents()
    const state = await readStateJson(this.paths.stateFile)
    const syncState = state.sync

    const candidates: SyncCandidate[] = []

    // Skills -> .claude/commands/<bundleId>.md
    for (const bundle of skills) {
      const content = this.renderClaudeCommand(bundle)
      const targetPath = join(this.projectRoot, '.claude', 'commands', `${bundle.bundleId}.md`)
      candidates.push({ sourcePath: bundle.bundleId, targetPath, content })
    }

    // Agents -> .claude/agents/<name>.md
    for (const agent of agents) {
      const content = this.renderClaudeAgent(agent)
      const targetPath = join(this.projectRoot, '.claude', 'agents', `${agent.name}.md`)
      candidates.push({ sourcePath: agent.filePath, targetPath, content })
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
          })
        }
      }
    }

    return { target: 'claude', toWrite, diverged }
  }

  // -------------------------------------------------------------------------
  // Execute
  // -------------------------------------------------------------------------

  async executeSync(plan: SyncPlan): Promise<SyncResult> {
    const written: SyncResultWritten[] = []
    const skipped: SyncResultSkipped[] = []
    const resultDiverged: SyncResultDiverged[] = []

    // Log any warnings from the plan
    if (plan.warnings !== undefined) {
      for (const warning of plan.warnings) {
        console.warn(warning)
      }
    }

    // Map diverged entries from plan
    for (const d of plan.diverged) {
      resultDiverged.push({ targetPath: d.targetPath, divergenceType: 'content' })
    }

    // Write non-diverged entries
    const state = await readStateJson(this.paths.stateFile)

    for (const entry of plan.toWrite) {
      await mkdir(dirname(entry.targetPath), { recursive: true })
      await writeFile(entry.targetPath, entry.content, 'utf-8')

      const hash = sha256(entry.content)
      state.sync[entry.targetPath] = {
        lastSyncHash: hash,
        syncedAt: new Date().toISOString(),
      }

      written.push({ targetPath: entry.targetPath, sourcePath: entry.sourcePath })
    }

    // Persist state.json preserving projections and files
    await writeStateJson(this.paths.stateFile, state)

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
}

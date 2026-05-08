/**
 * Per-target sync planners for DzupAgentSyncer.
 *
 * Split out of `syncer.ts` (MC-017). Each function builds a `SyncPlan`
 * for its provider by comparing rendered source content against existing
 * native files using the hash stored in `.dzupagent/state.json`.
 */

import { join } from 'node:path'
import type { DzupAgentPaths } from '../types.js'
import type { DzupAgentFileLoader } from './file-loader.js'
import type { DzupAgentAgentLoader } from './agent-loader.js'
import { sha256 } from './hash-utils.js'
import { readFileSafe, readStateJson } from './syncer-state.js'
import {
  loadMemoryFiles,
  renderClaudeAgent,
  renderClaudeCommand,
  renderGooseHints,
  renderInstructionsFile,
  renderQwenAgent,
  renderQwenCommand,
} from './syncer-renderers.js'
import {
  PROVIDER_SYNC_CAPABILITIES,
  type SyncCandidate,
  type SyncDivergedEntry,
  type SyncPlan,
  type SyncPlanEntry,
  type SyncTarget,
} from './syncer-types.js'

export interface PlannerContext {
  paths: DzupAgentPaths
  projectRoot: string
  fileLoader: DzupAgentFileLoader
  agentLoader: DzupAgentAgentLoader
}

async function loadAllMemoryEntries(
  ctx: PlannerContext,
): Promise<Array<{ name: string; content: string }>> {
  const memoryEntries = await loadMemoryFiles(ctx.paths.projectDir)
  const globalEntries =
    ctx.paths.globalDir !== ctx.paths.projectDir
      ? await loadMemoryFiles(ctx.paths.globalDir)
      : []
  return [...globalEntries, ...memoryEntries]
}

/**
 * Classify a single candidate against known sync state. Either appends to
 * `toWrite` (no divergence / fresh file) or to `diverged`.
 */
function classifyCandidate(
  candidate: SyncCandidate,
  existingContent: string | undefined,
  storedHash: string | undefined,
  toWrite: SyncPlanEntry[],
  diverged: SyncDivergedEntry[],
): void {
  if (existingContent === undefined || storedHash === undefined) {
    toWrite.push(candidate)
    return
  }
  const currentHash = sha256(existingContent)
  if (storedHash === currentHash) {
    toWrite.push(candidate)
  } else {
    diverged.push({
      targetPath: candidate.targetPath,
      lastSyncHash: storedHash,
      currentHash,
      newContent: candidate.content,
      sourcePath: candidate.sourcePath,
    })
  }
}

export async function planCodexSync(ctx: PlannerContext): Promise<SyncPlan> {
  const caps = PROVIDER_SYNC_CAPABILITIES.codex
  const allEntries = await loadAllMemoryEntries(ctx)
  const state = await readStateJson(ctx.paths.stateFile)
  const syncState = state.sync

  const toWrite: SyncPlanEntry[] = []
  const diverged: SyncDivergedEntry[] = []

  // Instructions → AGENTS.md
  if (allEntries.length > 0) {
    const targetPath = join(ctx.projectRoot, 'AGENTS.md')
    const content = renderInstructionsFile(allEntries, 'DzupAgent Instructions')
    const stored = syncState[targetPath]
    const existingContent = await readFileSafe(targetPath)
    classifyCandidate(
      { sourcePath: '.dzupagent/memory', targetPath, content },
      existingContent,
      stored?.lastSyncHash,
      toWrite,
      diverged,
    )
  }

  // Skills → .codex/skills/<bundleId>/SKILL.md
  if (caps.skills) {
    const skills = await ctx.fileLoader.loadSkills()
    for (const bundle of skills) {
      const content = renderClaudeCommand(bundle)
      const targetPath = join(ctx.projectRoot, '.codex', 'skills', bundle.bundleId, 'SKILL.md')
      const stored = syncState[targetPath]
      const existingContent = await readFileSafe(targetPath)
      classifyCandidate(
        { sourcePath: bundle.bundleId, targetPath, content },
        existingContent,
        stored?.lastSyncHash,
        toWrite,
        diverged,
      )
    }
  }

  // Agents → .codex/agents/<name>.md
  const toDelete: string[] = []
  if (caps.agents) {
    const agents = await ctx.agentLoader.loadAgents()
    const currentAgentPaths = new Set<string>()

    for (const agent of agents) {
      const content = renderClaudeAgent(agent)
      const targetPath = join(ctx.projectRoot, '.codex', 'agents', `${agent.name}.md`)
      currentAgentPaths.add(targetPath)
      const stored = syncState[targetPath]
      const existingContent = await readFileSafe(targetPath)
      classifyCandidate(
        { sourcePath: agent.filePath, targetPath, content },
        existingContent,
        stored?.lastSyncHash,
        toWrite,
        diverged,
      )
    }

    // Detect agents that were previously synced but are no longer defined
    // in .dzupagent/agents/. Scan syncState for paths under .codex/agents/.
    const codexAgentsPrefix = join(ctx.projectRoot, '.codex', 'agents') + '/'
    for (const trackedPath of Object.keys(syncState)) {
      if (trackedPath.startsWith(codexAgentsPrefix) && !currentAgentPaths.has(trackedPath)) {
        toDelete.push(trackedPath)
      }
    }
  }

  return { target: 'codex', toWrite, diverged, ...(toDelete.length > 0 ? { toDelete } : {}) }
}

export async function planGeminiSync(ctx: PlannerContext): Promise<SyncPlan> {
  const allEntries = await loadAllMemoryEntries(ctx)
  const targetPath = join(ctx.projectRoot, 'GEMINI.md')
  const state = await readStateJson(ctx.paths.stateFile)

  if (allEntries.length === 0) {
    return { target: 'gemini', toWrite: [], diverged: [] }
  }

  const content = renderInstructionsFile(allEntries, 'DzupAgent Gemini Instructions')
  const stored = state.sync[targetPath]
  const existingContent = await readFileSafe(targetPath)

  if (existingContent === undefined || stored === undefined) {
    return {
      target: 'gemini',
      toWrite: [{ sourcePath: '.dzupagent/memory', targetPath, content }],
      diverged: [],
    }
  }

  const currentHash = sha256(existingContent)
  if (stored.lastSyncHash === currentHash) {
    return {
      target: 'gemini',
      toWrite: [{ sourcePath: '.dzupagent/memory', targetPath, content }],
      diverged: [],
    }
  }

  return {
    target: 'gemini',
    toWrite: [],
    diverged: [{
      targetPath,
      lastSyncHash: stored.lastSyncHash,
      currentHash,
      newContent: content,
      sourcePath: '.dzupagent/memory',
    }],
  }
}

export async function planGooseSync(ctx: PlannerContext): Promise<SyncPlan> {
  const allEntries = await loadAllMemoryEntries(ctx)
  const targetPath = join(ctx.projectRoot, '.goosehints')
  const state = await readStateJson(ctx.paths.stateFile)

  if (allEntries.length === 0) {
    return { target: 'goose', toWrite: [], diverged: [] }
  }

  const content = renderGooseHints(allEntries)
  const stored = state.sync[targetPath]
  const existingContent = await readFileSafe(targetPath)

  if (existingContent === undefined || stored === undefined) {
    return {
      target: 'goose',
      toWrite: [{ sourcePath: '.dzupagent/memory', targetPath, content }],
      diverged: [],
    }
  }

  const currentHash = sha256(existingContent)
  if (stored.lastSyncHash === currentHash) {
    return {
      target: 'goose',
      toWrite: [{ sourcePath: '.dzupagent/memory', targetPath, content }],
      diverged: [],
    }
  }

  return {
    target: 'goose',
    toWrite: [],
    diverged: [{
      targetPath,
      lastSyncHash: stored.lastSyncHash,
      currentHash,
      newContent: content,
      sourcePath: '.dzupagent/memory',
    }],
  }
}

export async function planCrushSync(ctx: PlannerContext): Promise<SyncPlan> {
  const skills = await ctx.fileLoader.loadSkills()
  const state = await readStateJson(ctx.paths.stateFile)
  const syncState = state.sync
  const candidates: SyncCandidate[] = []

  for (const bundle of skills) {
    const content = renderClaudeCommand(bundle)
    const targetPath = join(ctx.projectRoot, '.crush', 'skills', `${bundle.bundleId}.md`)
    candidates.push({ sourcePath: bundle.bundleId, targetPath, content })
  }

  const toWrite: SyncPlanEntry[] = []
  const diverged: SyncDivergedEntry[] = []

  for (const candidate of candidates) {
    const stored = syncState[candidate.targetPath]
    const existingContent = await readFileSafe(candidate.targetPath)
    classifyCandidate(candidate, existingContent, stored?.lastSyncHash, toWrite, diverged)
  }

  return { target: 'crush', toWrite, diverged }
}

export async function planQwenSync(ctx: PlannerContext): Promise<SyncPlan> {
  const caps = PROVIDER_SYNC_CAPABILITIES.qwen
  const warnings: string[] = []
  const skills = await ctx.fileLoader.loadSkills()
  const agents = await ctx.agentLoader.loadAgents()
  const state = await readStateJson(ctx.paths.stateFile)
  const syncState = state.sync

  const candidates: SyncCandidate[] = []

  // Skills -> .qwen/skills/<bundleId>.md
  if (caps.skills) {
    for (const bundle of skills) {
      const content = renderQwenCommand(bundle)
      const targetPath = join(ctx.projectRoot, '.qwen', 'skills', `${bundle.bundleId}.md`)
      candidates.push({ sourcePath: bundle.bundleId, targetPath, content })
    }
  } else {
    warnings.push(`qwen: skills write-back is not supported — skipping skills.`)
  }

  // Agents -> .qwen/agents/<name>.md
  if (caps.agents) {
    for (const agent of agents) {
      const content = renderQwenAgent(agent)
      const targetPath = join(ctx.projectRoot, '.qwen', 'agents', `${agent.name}.md`)
      candidates.push({ sourcePath: agent.filePath, targetPath, content })
    }
  } else {
    warnings.push(`qwen: agents write-back is not supported — skipping agents.`)
  }

  const toWrite: SyncPlanEntry[] = []
  const diverged: SyncDivergedEntry[] = []

  for (const candidate of candidates) {
    const stored = syncState[candidate.targetPath]
    const existingContent = await readFileSafe(candidate.targetPath)
    classifyCandidate(candidate, existingContent, stored?.lastSyncHash, toWrite, diverged)
  }

  return { target: 'qwen', toWrite, diverged, ...(warnings.length > 0 ? { warnings } : {}) }
}

export async function planClaudeSync(ctx: PlannerContext): Promise<SyncPlan> {
  const caps = PROVIDER_SYNC_CAPABILITIES.claude
  const warnings: string[] = []
  const skills = await ctx.fileLoader.loadSkills()
  const agents = await ctx.agentLoader.loadAgents()
  const state = await readStateJson(ctx.paths.stateFile)
  const syncState = state.sync

  const candidates: SyncCandidate[] = []

  // Skills -> .claude/commands/<bundleId>.md
  if (caps.skills) {
    for (const bundle of skills) {
      const content = renderClaudeCommand(bundle)
      const targetPath = join(ctx.projectRoot, '.claude', 'commands', `${bundle.bundleId}.md`)
      candidates.push({ sourcePath: bundle.bundleId, targetPath, content })
    }
  } else {
    warnings.push(`claude: skills write-back is not supported — skipping skills.`)
  }

  // Agents -> .claude/agents/<name>.md
  if (caps.agents) {
    for (const agent of agents) {
      const content = renderClaudeAgent(agent)
      const targetPath = join(ctx.projectRoot, '.claude', 'agents', `${agent.name}.md`)
      candidates.push({ sourcePath: agent.filePath, targetPath, content })
    }
  } else {
    warnings.push(`claude: agents write-back is not supported — skipping agents.`)
  }

  const toWrite: SyncPlanEntry[] = []
  const diverged: SyncDivergedEntry[] = []

  for (const candidate of candidates) {
    const stored = syncState[candidate.targetPath]
    const existingContent = await readFileSafe(candidate.targetPath)
    classifyCandidate(candidate, existingContent, stored?.lastSyncHash, toWrite, diverged)
  }

  return { target: 'claude', toWrite, diverged, ...(warnings.length > 0 ? { warnings } : {}) }
}

export async function planSyncForTarget(
  target: SyncTarget,
  ctx: PlannerContext,
): Promise<SyncPlan> {
  switch (target) {
    case 'codex':  return planCodexSync(ctx)
    case 'gemini': return planGeminiSync(ctx)
    case 'goose':  return planGooseSync(ctx)
    case 'crush':  return planCrushSync(ctx)
    case 'qwen':   return planQwenSync(ctx)
    case 'claude': return planClaudeSync(ctx)
  }
}

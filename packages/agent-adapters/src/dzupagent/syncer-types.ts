/**
 * Public and internal type definitions for DzupAgentSyncer.
 *
 * Split out of `syncer.ts` (MC-017) to keep the coordinator thin and
 * type definitions in one focused module.
 */

import type { DzupAgentPaths } from '../types.js'
import type { DzupAgentFileLoader } from './file-loader.js'
import type { DzupAgentAgentLoader } from './agent-loader.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SyncTarget = 'claude' | 'codex' | 'gemini' | 'qwen' | 'goose' | 'crush'

/** Which providers support native write-back for which target types */
export const PROVIDER_SYNC_CAPABILITIES: Record<
  SyncTarget,
  { instructions: boolean; skills: boolean; agents: boolean }
> = {
  claude:  { instructions: true,  skills: true,  agents: true  },
  codex:   { instructions: true,  skills: true,  agents: true  },
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
  /** Native files whose source definition was removed from .dzupagent/. */
  toDelete?: string[]
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
  /** Native files deleted because their source definition was removed. */
  deleted?: string[]
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

export interface SyncStateEntry {
  lastSyncHash: string
  syncedAt: string
}

export interface StateJson {
  version: 1
  projections: Record<string, unknown>
  files: Record<string, unknown>
  sync: Record<string, SyncStateEntry>
}

// ---------------------------------------------------------------------------
// Candidate: intermediate type before divergence classification
// ---------------------------------------------------------------------------

export interface SyncCandidate {
  sourcePath: string
  targetPath: string
  content: string
}

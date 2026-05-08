/**
 * Public types for the DzupAgentImporter.
 */

import type { DzupAgentPaths } from '@dzupagent/adapter-types'

export interface ImportSource {
  type:
    | 'claude-md'
    | 'claude-commands'
    | 'claude-agents'
    | 'claude-memory'
    | 'codex-agents-md'
    | 'gemini-md'
    | 'gemini-settings'
    | 'qwen-md'
    | 'qwen-skills'
    | 'qwen-agents'
    | 'goose-hints'
    | 'crush-skills'
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
export interface ImportedFileEntry {
  hash: string
  importedAt: string
}

/** Shape of state.json (shared with FileAdapterSkillVersionStore) */
export interface StateJson {
  version: 1
  projections: Record<string, unknown>
  files: Record<string, ImportedFileEntry>
}

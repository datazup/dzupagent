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
 *
 * Implementation notes (MC-017):
 *   - Type definitions live in `./syncer-types.js`.
 *   - state.json IO + readFileSafe live in `./syncer-state.js`.
 *   - Unified diff builder lives in `./syncer-diff.js`.
 *   - Renderers + memory loader live in `./syncer-renderers.js`.
 *   - Per-target plan logic lives in `./syncer-planners.js`.
 *   - Plan -> disk apply logic lives in `./syncer-executor.js`.
 *   - This file is the thin coordinator class.
 */

import type { DzupAgentPaths } from '../types.js'
import type { AdapterSkillBundle } from '../skills/adapter-skill-types.js'
import type { DzupAgentFileLoader } from './file-loader.js'
import type { DzupAgentAgentLoader, AgentDefinition } from './agent-loader.js'
import {
  renderClaudeAgent as renderClaudeAgentImpl,
  renderClaudeCommand as renderClaudeCommandImpl,
  renderGooseHints as renderGooseHintsImpl,
  renderInstructionsFile as renderInstructionsFileImpl,
  renderQwenAgent as renderQwenAgentImpl,
  renderQwenCommand as renderQwenCommandImpl,
} from './syncer-renderers.js'
import { planSyncForTarget } from './syncer-planners.js'
import { executeSync, type ExecuteSyncOptions } from './syncer-executor.js'
import type {
  DzupAgentSyncerOptions,
  SyncPlan,
  SyncResult,
  SyncTarget,
} from './syncer-types.js'

// ---------------------------------------------------------------------------
// Re-exports (preserve original module's public API)
// ---------------------------------------------------------------------------

export type {
  SyncTarget,
  SyncPlan,
  SyncPlanEntry,
  SyncDivergedEntry,
  SyncResult,
  SyncResultWritten,
  SyncResultSkipped,
  SyncResultDiverged,
  DzupAgentSyncerOptions,
} from './syncer-types.js'

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
    return planSyncForTarget(target, {
      paths: this.paths,
      projectRoot: this.projectRoot,
      fileLoader: this.fileLoader,
      agentLoader: this.agentLoader,
    })
  }

  // -------------------------------------------------------------------------
  // Execute
  // -------------------------------------------------------------------------

  async executeSync(plan: SyncPlan, opts: ExecuteSyncOptions = {}): Promise<SyncResult> {
    return executeSync(this.paths.stateFile, plan, opts)
  }

  // -------------------------------------------------------------------------
  // Renderers (preserved as instance methods for backward compatibility)
  // -------------------------------------------------------------------------

  renderQwenCommand(bundle: AdapterSkillBundle): string {
    return renderQwenCommandImpl(bundle)
  }

  renderQwenAgent(agent: AgentDefinition): string {
    return renderQwenAgentImpl(agent)
  }

  renderClaudeCommand(bundle: AdapterSkillBundle): string {
    return renderClaudeCommandImpl(bundle)
  }

  renderClaudeAgent(agent: AgentDefinition): string {
    return renderClaudeAgentImpl(agent)
  }

  renderInstructionsFile(entries: Array<{ name: string; content: string }>, title: string): string {
    return renderInstructionsFileImpl(entries, title)
  }

  renderGooseHints(entries: Array<{ name: string; content: string }>): string {
    return renderGooseHintsImpl(entries)
  }
}

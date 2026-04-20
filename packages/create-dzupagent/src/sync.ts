/**
 * `dzupagent sync <target>` command.
 *
 * Generates native agent files (e.g. AGENTS.md, .claude/commands/*.md,
 * GEMINI.md, .goosehints, .qwen/*, .crush/*) from the `.dzupagent/`
 * definitions in a project.
 *
 * By default runs as a dry-run and prints the planned changes.  With
 * `--execute` the plan is applied and state.json is updated.
 *
 * The `@dzupagent/agent-adapters` package is loaded dynamically so that
 * this CLI remains usable without a hard dependency on it.
 */

import { resolve } from 'node:path'
import { colors } from './logger.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SyncTargetName =
  | 'claude'
  | 'codex'
  | 'gemini'
  | 'qwen'
  | 'goose'
  | 'crush'

export interface SyncCommandOptions {
  /** Apply the plan instead of just printing it. */
  execute?: boolean
  /** Overwrite diverged files instead of skipping them. */
  force?: boolean
  /**
   * Show the plan + diffs without writing any files to disk.
   * Works as a companion to `--force` — divergence handling is still shown,
   * but no writes occur and `state.json` is not touched.
   */
  dryRun?: boolean
  /**
   * Output format for dry-run diagnostics.
   * - 'console' (default): human-readable lines streamed to stdout.
   * - 'json': single JSON array flushed at the end.
   */
  dryRunFormat?: 'console' | 'json'
  /** Override the project root (defaults to `process.cwd()`). */
  cwd?: string
}

export const VALID_SYNC_TARGETS: ReadonlyArray<SyncTargetName> = [
  'claude',
  'codex',
  'gemini',
  'qwen',
  'goose',
  'crush',
]

// ---------------------------------------------------------------------------
// Minimal shapes mirrored from @dzupagent/agent-adapters
// ---------------------------------------------------------------------------

interface DzupAgentPathsLike {
  globalDir: string
  workspaceDir: string | undefined
  projectDir: string
  stateFile: string
  projectConfig: string
}

interface SyncPlanEntryLike {
  sourcePath: string
  targetPath: string
  content: string
}

interface SyncDivergedEntryLike {
  targetPath: string
  lastSyncHash: string
  currentHash: string
  newContent?: string
  sourcePath?: string
}

interface SyncPlanLike {
  target: SyncTargetName
  toWrite: SyncPlanEntryLike[]
  diverged: SyncDivergedEntryLike[]
  warnings?: string[]
}

interface SyncResultWrittenLike {
  targetPath: string
  sourcePath: string
}

interface SyncResultSkippedLike {
  targetPath: string
  reason: string
}

interface SyncResultDivergedLike {
  targetPath: string
  divergenceType: 'content' | 'deleted'
}

interface SyncResultLike {
  target: SyncTargetName
  written: SyncResultWrittenLike[]
  skipped: SyncResultSkippedLike[]
  diverged: SyncResultDivergedLike[]
  warnings?: string[]
}

interface AgentAdaptersSyncModule {
  WorkspaceResolver: new () => {
    resolve(projectRoot: string): Promise<DzupAgentPathsLike>
  }
  DzupAgentFileLoader: new (opts: { paths: DzupAgentPathsLike }) => unknown
  DzupAgentAgentLoader: new (opts: {
    paths: DzupAgentPathsLike
    skillLoader: unknown
    skillRegistry: unknown
  }) => unknown
  DzupAgentSyncer: new (opts: {
    paths: DzupAgentPathsLike
    projectRoot: string
    fileLoader: unknown
    agentLoader: unknown
  }) => {
    planSync(target: SyncTargetName): Promise<SyncPlanLike>
    executeSync(
      plan: SyncPlanLike,
      opts?: { force?: boolean; dryRun?: boolean; dryRunFormat?: 'console' | 'json' },
    ): Promise<SyncResultLike>
  }
  createDefaultSkillRegistry: () => unknown
}

// ---------------------------------------------------------------------------
// Dynamic loader
// ---------------------------------------------------------------------------

async function loadAgentAdapters(): Promise<AgentAdaptersSyncModule> {
  try {
    const mod: unknown = await import('@dzupagent/agent-adapters')
    return mod as AgentAdaptersSyncModule
  } catch {
    throw new Error(
      'Cannot run sync: @dzupagent/agent-adapters is not installed. ' +
        'Install it as a dependency to use the sync command.',
    )
  }
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

/**
 * Run the `sync` CLI command.
 *
 * Throws on unrecoverable errors (invalid target, missing adapters package,
 * syncer failure).  The caller is expected to translate exceptions into a
 * non-zero exit code.
 */
export async function runSyncCommand(
  target: string,
  options: SyncCommandOptions = {},
): Promise<void> {
  const normalized = target.toLowerCase() as SyncTargetName
  if (!VALID_SYNC_TARGETS.includes(normalized)) {
    throw new Error(
      `Unknown sync target "${target}". Valid targets: ${VALID_SYNC_TARGETS.join(', ')}`,
    )
  }

  const projectRoot = resolve(options.cwd ?? process.cwd())
  const adapters = await loadAgentAdapters()

  const resolver = new adapters.WorkspaceResolver()
  const paths = await resolver.resolve(projectRoot)

  const fileLoader = new adapters.DzupAgentFileLoader({ paths })
  const skillRegistry = adapters.createDefaultSkillRegistry()
  const agentLoader = new adapters.DzupAgentAgentLoader({
    paths,
    skillLoader: fileLoader,
    skillRegistry,
  })
  const syncer = new adapters.DzupAgentSyncer({
    paths,
    projectRoot,
    fileLoader,
    agentLoader,
  })

  const plan = await syncer.planSync(normalized)
  const dryRun = options.dryRun === true
  const force = options.force === true

  printPlan(plan, force, dryRun)

  if (options.execute !== true && !dryRun) {
    console.log('')
    console.log(colors.dim('Run with --execute to apply changes, or --dry-run to preview diffs.'))
    return
  }

  // Dry-run still invokes executeSync so the user sees full diffs,
  // but no files are written and state.json is not mutated.
  const result = await syncer.executeSync(plan, {
    force,
    dryRun,
    ...(options.dryRunFormat !== undefined ? { dryRunFormat: options.dryRunFormat } : {}),
  })
  printResult(result, dryRun)
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function printPlan(plan: SyncPlanLike, force = false, dryRun = false): void {
  console.log('')
  const suffix = dryRun ? colors.dim(' [dry-run]') : ''
  console.log(colors.bold(`Sync plan for ${colors.cyan(plan.target)}:${suffix}`))

  if (plan.toWrite.length === 0 && plan.diverged.length === 0) {
    console.log(colors.dim('  (no changes — nothing to sync)'))
    console.log('')
    console.log(colors.dim('Summary: 0 to write, 0 diverged'))
    return
  }

  for (const entry of plan.toWrite) {
    console.log(
      `  ${colors.green('✓')} Will write:    ${colors.dim(entry.targetPath)}`,
    )
  }

  for (const entry of plan.diverged) {
    if (force) {
      console.log(
        `  ${colors.yellow('⚠')} Diverged (will overwrite): ${colors.dim(entry.targetPath)}`,
      )
    } else {
      console.log(
        `  ${colors.yellow('⚠')} Diverged (skipped): ${colors.dim(entry.targetPath)}`,
      )
    }
  }

  if (plan.warnings !== undefined && plan.warnings.length > 0) {
    console.log('')
    for (const warning of plan.warnings) {
      console.log(`  ${colors.yellow('!')} ${warning}`)
    }
  }

  console.log('')
  const writeCount = plan.toWrite.length
  const divergedCount = plan.diverged.length
  const parts: string[] = []
  parts.push(`${writeCount} to write`)
  if (divergedCount > 0) {
    parts.push(force ? `${divergedCount} diverged (will overwrite)` : `${divergedCount} diverged (skipped)`)
  }
  console.log(`Summary: ${parts.join(', ')}`)
}

function printResult(result: SyncResultLike, dryRun = false): void {
  console.log('')
  const writtenCount = result.written.length
  const divergedCount = result.diverged.length
  const skippedCount = result.skipped.length

  const parts: string[] = []
  parts.push(dryRun ? `${writtenCount} would be written` : `${writtenCount} written`)
  if (divergedCount > 0) {
    parts.push(`${divergedCount} skipped (diverged)`)
  }
  if (skippedCount > 0) {
    parts.push(`${skippedCount} skipped`)
  }

  const prefix = dryRun ? 'Dry-run complete' : 'Sync complete'
  console.log(colors.green(`${prefix}: ${parts.join(', ')}`))
  if (dryRun) {
    console.log(colors.dim('No files were modified. Re-run with --execute to apply.'))
  }
}

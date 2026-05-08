/**
 * Sync executor for DzupAgentSyncer.
 *
 * Split out of `syncer.ts` (MC-017). Applies a `SyncPlan` to disk:
 *   - skips diverged files unless `force: true`
 *   - in `dryRun` mode, only emits diffs / "would write" entries via DryRunReporter
 *   - persists per-target hashes back into `.dzupagent/state.json` so future
 *     syncs can detect user edits.
 */

import { writeFile, mkdir, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DryRunReporter, type DryRunReporterMode } from './dry-run-reporter.js'
import { sha256 } from './hash-utils.js'
import { readFileSafe, readStateJson, writeStateJson } from './syncer-state.js'
import { buildUnifiedDiff } from './syncer-diff.js'
import type {
  SyncPlan,
  SyncResult,
  SyncResultDiverged,
  SyncResultSkipped,
  SyncResultWritten,
} from './syncer-types.js'

export interface ExecuteSyncOptions {
  force?: boolean
  dryRun?: boolean
  dryRunFormat?: DryRunReporterMode
}

export async function executeSync(
  stateFile: string,
  plan: SyncPlan,
  opts: ExecuteSyncOptions = {},
): Promise<SyncResult> {
  const force = opts.force === true
  const dryRun = opts.dryRun === true
  const dryRunFormat: DryRunReporterMode = opts.dryRunFormat ?? 'console'
  const reporter = new DryRunReporter({ format: dryRunFormat })
  const written: SyncResultWritten[] = []
  const skipped: SyncResultSkipped[] = []
  const resultDiverged: SyncResultDiverged[] = []
  const deleted: string[] = []

  if (plan.warnings !== undefined) {
    for (const warning of plan.warnings) {
      console.warn(warning)
    }
  }

  if (dryRun && dryRunFormat === 'console') {
    console.log('\n[dry-run] No files will be written. Showing planned changes:')
  }

  const state = await readStateJson(stateFile)

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

  // Delete entries whose source was removed from .dzupagent/
  if (plan.toDelete !== undefined) {
    for (const deletePath of plan.toDelete) {
      if (dryRun) {
        reporter.reportWouldWrite(`[delete] ${deletePath}`)
        deleted.push(deletePath)
        continue
      }

      try {
        await unlink(deletePath)
      } catch (err: unknown) {
        // File may have already been removed by the user — that's fine.
        const code = (err as { code?: string } | undefined)?.code
        if (code !== 'ENOENT') {
          throw err
        }
      }
      delete state.sync[deletePath]
      deleted.push(deletePath)
    }
  }

  if (dryRun) {
    reporter.flush()
  } else {
    await writeStateJson(stateFile, state)
  }

  return {
    target: plan.target,
    written,
    skipped,
    diverged: resultDiverged,
    ...(deleted.length > 0 ? { deleted } : {}),
    ...(plan.warnings !== undefined ? { warnings: plan.warnings } : {}),
  }
}

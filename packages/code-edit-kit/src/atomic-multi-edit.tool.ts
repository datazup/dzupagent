/**
 * atomic_multi_edit LangChain tool — applies a sequence of per-file unified
 * diffs as a single atomic batch. If any edit fails partway through, every
 * previously-applied file in the same batch is rolled back to its pre-batch
 * content (H3).
 *
 * Each entry in `edits` is `{ path, patch }`. The `path` field exists for
 * caller-side bookkeeping; the file(s) actually written are derived from the
 * `+++ b/<path>` headers inside `patch` (so a single entry may legitimately
 * touch multiple files when the patch is multi-file).
 *
 * Rollback semantics:
 *   - Before each edit, we capture every file the patch will touch.
 *   - On success, we register a rollback token via the configured store.
 *   - On any failure, we restore originals for every file touched so far in
 *     the batch (in reverse application order) and return the failure detail.
 */
import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'
import type { WorkspaceFS } from '@dzupagent/codegen'
import {
  FileRollbackStore,
  InMemoryRollbackStore,
  type RollbackStore,
} from './rollback/file-rollback-store.js'
import { extractDiffFiles } from './tools/apply-patch.tool.js'

const inputSchema = z.object({
  edits: z
    .array(
      z.object({
        path: z.string().describe('File path the patch primarily targets'),
        patch: z.string().describe('Unified diff in git diff format'),
      }),
    )
    .describe('Ordered list of per-file edits to apply atomically'),
})

export interface CreateAtomicMultiEditToolOptions {
  /** Custom rollback store. Overrides storageDir when supplied. */
  rollbackStore?: RollbackStore
  /**
   * When set (and no rollbackStore is given), persists rollback entries to
   * disk under this directory via `FileRollbackStore`.
   */
  storageDir?: string
}

export interface AtomicMultiEditResult {
  applied: string[]
  rolledBack: string[]
  error?: string
}

function uuid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (g.crypto?.randomUUID) return g.crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/**
 * Apply the captured originals back to the workspace to undo a partial batch.
 * Files that did not exist before (`null`) are deleted.
 */
async function restore(
  workspace: WorkspaceFS,
  originals: Map<string, string | null>,
): Promise<void> {
  for (const [p, original] of originals) {
    if (original === null) {
      await workspace.delete(p).catch(() => undefined)
    } else {
      await workspace.write(p, original)
    }
  }
}

/**
 * Build the atomic multi-edit tool. The returned LangChain tool serialises
 * `AtomicMultiEditResult` to JSON in its return string.
 */
export function createAtomicMultiEditTool(
  workspace: WorkspaceFS,
  opts: CreateAtomicMultiEditToolOptions = {},
): DynamicStructuredTool {
  const store: RollbackStore =
    opts.rollbackStore ??
    (opts.storageDir
      ? new FileRollbackStore(workspace, { storageDir: opts.storageDir })
      : new InMemoryRollbackStore())

  return new DynamicStructuredTool({
    name: 'atomic_multi_edit',
    description:
      'Apply a sequence of per-file unified diffs atomically. ' +
      'If any edit fails, every previously-applied file in the same batch is rolled back. ' +
      'Returns JSON with `applied`, `rolledBack`, and optional `error`.',
    schema: inputSchema,
    func: async (input) => {
      const result: AtomicMultiEditResult = { applied: [], rolledBack: [] }
      // Cumulative originals across the whole batch — keyed by path so each
      // file's pre-batch content is captured exactly once even if multiple
      // patches touch it.
      const batchOriginals = new Map<string, string | null>()
      const appliedOrder: string[] = []

      for (let i = 0; i < input.edits.length; i++) {
        const edit = input.edits[i]!
        const filesInDiff = extractDiffFiles(edit.patch)

        // Capture originals (only on first encounter so rollback restores
        // the true pre-batch state, not an intermediate one).
        for (const p of filesInDiff) {
          if (!batchOriginals.has(p)) {
            try {
              batchOriginals.set(p, await workspace.read(p))
            } catch {
              batchOriginals.set(p, null)
            }
          }
        }

        try {
          const patchResult = await workspace.applyPatch(edit.patch)
          if (patchResult.rolledBack) {
            const firstFailure = patchResult.results.find((r) => !r.success)
            const detail =
              firstFailure?.errorMessage ??
              firstFailure?.error ??
              'patch rejected'
            throw new Error(detail)
          }
          const successful = patchResult.results.filter((r) => r.success)
          if (successful.length === 0) {
            const firstFailure = patchResult.results.find((r) => !r.success)
            const detail =
              firstFailure?.errorMessage ??
              firstFailure?.error ??
              'no files applied'
            throw new Error(detail)
          }
          result.applied.push(edit.path)
          appliedOrder.push(edit.path)
        } catch (err: unknown) {
          // Roll back everything applied so far in the batch.
          await restore(workspace, batchOriginals)
          result.rolledBack = [...appliedOrder]
          result.error =
            err instanceof Error ? err.message : String(err)
          return JSON.stringify(result)
        }
      }

      // Whole batch applied — register a rollback token so the caller can
      // still undo the entire batch via `undoApplyPatch(token, store)`.
      if (appliedOrder.length > 0) {
        const token = uuid()
        await store.save(token, { workspace, originals: batchOriginals })
      }
      return JSON.stringify(result)
    },
  })
}

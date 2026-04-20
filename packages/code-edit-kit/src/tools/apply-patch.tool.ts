/**
 * apply_patch LangChain tool — applies a unified diff to a WorkspaceFS.
 *
 * Wraps `workspace.applyPatch()` and returns a human-readable summary:
 * - Files modified, total lines added/removed
 * - Rollback error when the patch was rejected
 *
 * Pre- and post-apply validation hooks declared on `opts.policy.hooks` are
 * executed in registration order. Pre-apply hooks run with `trigger` of
 * `'after_edit'`, `'after_patch'`, or `'always'` — all are evaluated before
 * calling `WorkspaceFS.applyPatch`. A hook returning `{ valid: false }` aborts
 * the operation via a `ToolRejectedError`.
 */
import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'
import type { WorkspaceFS } from '@dzupagent/codegen'
import {
  ToolRejectedError,
  type EditPolicy,
  type ValidationHook,
  type ValidationHookContext,
} from '../types.js'

const inputSchema = z.object({
  diff: z.string().describe('Unified diff in git diff format'),
})

/**
 * Count `+` / `-` lines in a unified diff, ignoring file headers
 * (`+++`, `---`) which are not additions/removals.
 */
export function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  const lines = diff.split(/\r?\n/)
  for (const line of lines) {
    // File headers start with "+++" / "---" and must not be counted as content.
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

/**
 * Extract destination file paths from a unified diff.
 * Reads every `+++ b/<path>` (or `+++ <path>`) line.
 */
export function extractDiffFiles(diff: string): string[] {
  const files: string[] = []
  const lines = diff.split(/\r?\n/)
  for (const line of lines) {
    if (!line.startsWith('+++ ')) continue
    const raw = line.slice(4).trim()
    if (raw === '/dev/null') continue
    const stripped = raw.replace(/^[ab]\//, '')
    files.push(stripped)
  }
  return files
}

/**
 * Determine whether a given hook applies to a stage. For pre-apply, we treat
 * `after_edit` / `after_patch` / `always` triggers as eligible to short-circuit
 * bad patches early. For post-apply the same triggers apply after writes land.
 */
function hookMatchesStage(
  hook: ValidationHook,
  stage: 'pre_apply' | 'post_apply',
): boolean {
  if (!hook.run) return false
  switch (hook.trigger) {
    case 'always':
      return true
    case 'after_write':
      return stage === 'post_apply'
    case 'after_patch':
    case 'after_edit':
      return true
    default:
      return false
  }
}

async function runHooks(
  hooks: ValidationHook[] | undefined,
  stage: 'pre_apply' | 'post_apply',
  ctx: ValidationHookContext,
): Promise<void> {
  if (!hooks || hooks.length === 0) return
  for (const hook of hooks) {
    if (!hookMatchesStage(hook, stage)) continue
    // Narrowed by hookMatchesStage (returns false when run is undefined).
    const runFn = hook.run!
    const res = await runFn(ctx)
    if (!res.valid) {
      const reason = res.reason ?? 'validation hook rejected the patch'
      throw new ToolRejectedError(
        `${hook.name} (${stage}): ${reason}`,
        hook.name,
        stage,
      )
    }
  }
}

export function createApplyPatchTool(
  workspace: WorkspaceFS,
  opts?: { policy?: EditPolicy },
): DynamicStructuredTool {
  const hooks = opts?.policy?.hooks

  return new DynamicStructuredTool({
    name: 'apply_patch',
    description:
      'Apply a unified diff (git diff format) to the workspace. ' +
      'Use this to make precise, multi-file edits described as a patch. ' +
      'Returns a summary of files modified and lines changed, or an error if the patch was rejected.',
    schema: inputSchema,
    func: async (input) => {
      const diff = input.diff
      const { added: linesAdded, removed: linesRemoved } = countDiffLines(diff)
      const filesInDiff = extractDiffFiles(diff)

      // ---- Pre-apply hook evaluation ----
      try {
        await runHooks(hooks, 'pre_apply', {
          stage: 'pre_apply',
          diff,
          filesModified: filesInDiff,
          linesAdded,
          linesRemoved,
        })
      } catch (err) {
        if (err instanceof ToolRejectedError) {
          return `apply_patch rejected by policy: ${err.message}`
        }
        const msg = err instanceof Error ? err.message : String(err)
        return `apply_patch pre-validation failed: ${msg}`
      }

      // ---- Apply ----
      let result
      try {
        result = await workspace.applyPatch(diff)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return `apply_patch failed: ${msg}`
      }

      if (result.rolledBack) {
        const firstFailure = result.results.find((r) => !r.success)
        const detail = firstFailure?.errorMessage ?? firstFailure?.error ?? 'unknown error'
        return `Patch rejected and rolled back: ${detail}`
      }

      const successful = result.results.filter((r) => r.success)

      if (successful.length === 0) {
        const firstFailure = result.results.find((r) => !r.success)
        const detail = firstFailure?.errorMessage ?? firstFailure?.error ?? 'unknown error'
        return `Patch applied 0 files. First failure: ${detail}`
      }

      const successfulPaths = successful.map((r) => r.filePath)

      // ---- Post-apply hook evaluation ----
      try {
        await runHooks(hooks, 'post_apply', {
          stage: 'post_apply',
          diff,
          filesModified: successfulPaths,
          linesAdded,
          linesRemoved,
        })
      } catch (err) {
        if (err instanceof ToolRejectedError) {
          return `apply_patch post-validation failed: ${err.message}`
        }
        const msg = err instanceof Error ? err.message : String(err)
        return `apply_patch post-validation error: ${msg}`
      }

      const fileList = successfulPaths.map((p) => `  - ${p}`).join('\n')
      const lineSummary =
        linesAdded + linesRemoved > 0
          ? ` (+${linesAdded}/-${linesRemoved} lines)`
          : ''

      const failed = result.results.filter((r) => !r.success)
      const failNote =
        failed.length > 0
          ? `\n${failed.length} file(s) failed: ${failed.map((r) => r.filePath).join(', ')}`
          : ''

      return (
        `Patch applied to ${successful.length} file(s)${lineSummary}:\n${fileList}${failNote}`
      )
    },
  })
}

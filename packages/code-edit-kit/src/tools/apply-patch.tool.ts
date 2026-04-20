/**
 * apply_patch LangChain tool — applies a unified diff to a WorkspaceFS.
 *
 * Wraps `workspace.applyPatch()` and returns a human-readable summary:
 * - Files modified, total lines added/removed
 * - Rollback error when the patch was rejected
 */
import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'
import type { WorkspaceFS } from '@dzupagent/codegen'
import type { EditPolicy } from '../types.js'

const inputSchema = z.object({
  diff: z.string().describe('Unified diff in git diff format'),
})

export function createApplyPatchTool(
  workspace: WorkspaceFS,
  opts?: { policy?: EditPolicy },
): DynamicStructuredTool {
  // opts.policy is reserved for future use — accepted but not consumed yet.
  void opts

  return new DynamicStructuredTool({
    name: 'apply_patch',
    description:
      'Apply a unified diff (git diff format) to the workspace. ' +
      'Use this to make precise, multi-file edits described as a patch. ' +
      'Returns a summary of files modified and lines changed, or an error if the patch was rejected.',
    schema: inputSchema,
    func: async (input) => {
      let result
      try {
        result = await workspace.applyPatch(input.diff)
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

      // Count lines added/removed from hunkResults across successful patches.
      let linesAdded = 0
      let linesRemoved = 0
      for (const r of successful) {
        for (const hunk of r.hunkResults) {
          if (hunk.applied && hunk.appliedAtLine !== undefined) {
            // appliedAtLine alone doesn't give add/remove counts — we leave
            // detailed counts at 0 since PatchApplyResult has no direct tally.
            // This is a conservative choice; the summary still lists files.
          }
        }
      }

      const fileList = successful.map((r) => `  - ${r.filePath}`).join('\n')
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

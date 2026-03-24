/**
 * Enhanced edit-file tool — applies one or more search/replace edits to
 * a file in the VirtualFS.
 *
 * Supports:
 * - Multiple edits per call (applied sequentially)
 * - Exact-match search with clear error on mismatch
 * - Optional replaceAll flag per edit
 * - Returns summary of applied/failed edits
 *
 * Uses DynamicStructuredTool (not the `tool()` helper) for reliable
 * nested Zod schema handling with @langchain/core.
 */
import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'
import type { VirtualFS } from '../vfs/virtual-fs.js'

const editEntrySchema = z.object({
  oldText: z.string().describe('Exact text to find (must match precisely including whitespace)'),
  newText: z.string().describe('Text to replace with'),
  replaceAll: z.boolean().optional().describe('Replace all occurrences (default: first only)'),
})

const inputSchema = z.object({
  filePath: z.string().describe('Path of the file to edit'),
  edits: z.array(editEntrySchema).min(1).describe('One or more search/replace edits to apply sequentially'),
})

export function createEditFileTool(vfs: VirtualFS) {
  return new DynamicStructuredTool({
    name: 'edit_file',
    description:
      'Edit an existing file by applying one or more search/replace operations. ' +
      'Each edit finds exact text and replaces it. Use for targeted modifications ' +
      'without rewriting the entire file.',
    schema: inputSchema,
    func: async (input) => {
      const { filePath, edits } = input
      const content = vfs.read(filePath)
      if (content === null) {
        return `Error: File not found: ${filePath}`
      }

      let current = content
      const applied: string[] = []
      const failed: string[] = []

      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i]!
        if (!current.includes(edit.oldText)) {
          const preview = edit.oldText.length > 60
            ? edit.oldText.slice(0, 60) + '...'
            : edit.oldText
          failed.push(`Edit ${i + 1}: search text not found: "${preview}"`)
          continue
        }

        if (edit.replaceAll) {
          current = current.split(edit.oldText).join(edit.newText)
        } else {
          current = current.replace(edit.oldText, edit.newText)
        }
        applied.push(`Edit ${i + 1}: applied`)
      }

      if (applied.length === 0) {
        return `All ${edits.length} edits failed:\n${failed.join('\n')}`
      }

      vfs.write(filePath, current)

      if (failed.length > 0) {
        return `Applied ${applied.length}/${edits.length} edits to ${filePath}.\nFailed:\n${failed.join('\n')}`
      }

      return `Applied ${applied.length} edit${applied.length > 1 ? 's' : ''} to ${filePath}`
    },
  })
}

/**
 * Multi-edit tool — apply edits to multiple files in one call.
 *
 * If any file is missing, those edits are skipped but others proceed.
 * Uses DynamicStructuredTool for reliable nested Zod schema handling.
 */
import { z } from 'zod'
import { DynamicStructuredTool } from '@langchain/core/tools'
import type { VirtualFS } from '../vfs/virtual-fs.js'

const fileEditSchema = z.object({
  filePath: z.string().describe('Path of the file to edit'),
  edits: z.array(
    z.object({
      oldText: z.string().describe('Exact text to find'),
      newText: z.string().describe('Text to replace with'),
    }),
  ).min(1),
})

const inputSchema = z.object({
  fileEdits: z.array(fileEditSchema).min(1).describe('Array of file edits to apply'),
})

export function createMultiEditTool(vfs: VirtualFS) {
  return new DynamicStructuredTool({
    name: 'multi_edit',
    description:
      'Apply edits to multiple files in one call. Each file gets one or more ' +
      'search/replace operations. Files that are not found are skipped. ' +
      'Use when making related changes across multiple files.',
    schema: inputSchema,
    func: async (input) => {
      const { fileEdits } = input
      const pending = new Map<string, string>()
      const results: string[] = []

      for (const { filePath, edits } of fileEdits) {
        const content = vfs.read(filePath)
        if (content === null) {
          results.push(`${filePath}: skipped (file not found)`)
          continue
        }

        let modified = content
        let editCount = 0
        const editFailures: string[] = []

        for (const edit of edits) {
          if (!modified.includes(edit.oldText)) {
            const preview = edit.oldText.length > 40
              ? edit.oldText.slice(0, 40) + '...'
              : edit.oldText
            editFailures.push(`search text not found: "${preview}"`)
            continue
          }
          modified = modified.replace(edit.oldText, edit.newText)
          editCount++
        }

        if (editCount > 0) {
          pending.set(filePath, modified)
          const msg = `${filePath}: ${editCount}/${edits.length} edits applied`
          if (editFailures.length > 0) {
            results.push(`${msg} (${editFailures.length} failed)`)
          } else {
            results.push(msg)
          }
        } else {
          results.push(`${filePath}: all edits failed`)
        }
      }

      for (const [filePath, content] of pending) {
        vfs.write(filePath, content)
      }

      const totalFiles = pending.size
      return totalFiles > 0
        ? `Applied edits to ${totalFiles} file${totalFiles > 1 ? 's' : ''}:\n${results.join('\n')}`
        : `No edits applied:\n${results.join('\n')}`
    },
  })
}

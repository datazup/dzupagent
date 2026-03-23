/**
 * Generic edit-file tool — modifies existing file in VFS via find/replace.
 */
import { z } from 'zod'
import { tool } from '@langchain/core/tools'

export function createEditFileTool() {
  return tool(
    async ({ filePath, oldText, newText, replaceAll }) => {
      // The actual edit happens through the state update returned by the tool.
      // The calling node captures this and applies the edit to vfsSnapshot.
      return JSON.stringify({
        action: 'edit_file',
        filePath,
        oldText: oldText.slice(0, 50),
        newText: newText.slice(0, 50),
        replaceAll: replaceAll ?? false,
        success: true,
      })
    },
    {
      name: 'edit_file',
      description: 'Edit an existing file by replacing specific text. Use for targeted modifications without rewriting the entire file.',
      schema: z.object({
        filePath: z.string().describe('Path of the file to edit'),
        oldText: z.string().describe('Exact text to find and replace'),
        newText: z.string().describe('Replacement text'),
        replaceAll: z.boolean().optional().describe('Replace all occurrences (default: false, replaces first only)'),
      }),
    },
  )
}

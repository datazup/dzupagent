/**
 * Generic write-file tool — writes content to VFS snapshot in LangGraph state.
 */
import { z } from 'zod'
import { tool } from '@langchain/core/tools'

export function createWriteFileTool() {
  return tool(
    async ({ filePath, content }) => {
      // The actual write happens through the state update returned by the tool.
      // The calling node must capture this tool output and update vfsSnapshot.
      return JSON.stringify({
        action: 'write_file',
        filePath,
        size: content.length,
        success: true,
      })
    },
    {
      name: 'write_file',
      description: 'Write content to a file in the virtual filesystem. Creates the file if it does not exist, overwrites if it does.',
      schema: z.object({
        filePath: z.string().describe('Path of the file to write (relative to project root)'),
        content: z.string().describe('Complete file content to write'),
      }),
    },
  )
}

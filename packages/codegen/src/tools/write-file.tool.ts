/**
 * Generic write-file tool — writes content to VFS snapshot in LangGraph state.
 *
 * When a CodegenToolContext with `workspace` is provided, the tool writes
 * through the Workspace abstraction. Otherwise it returns a JSON message
 * for the calling node to apply (backward-compatible behaviour).
 */
import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import type { CodegenToolContext } from './tool-context.js'

export function createWriteFileTool(context?: CodegenToolContext) {
  return tool(
    async ({ filePath, content }) => {
      // If a workspace is available, write through it
      if (context?.workspace) {
        try {
          await context.workspace.writeFile(filePath, content)
          return JSON.stringify({
            action: 'write_file',
            filePath,
            size: content.length,
            success: true,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return JSON.stringify({
            action: 'write_file',
            filePath,
            success: false,
            error: msg,
          })
        }
      }

      // Fallback: The actual write happens through the state update returned by the tool.
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

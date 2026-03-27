/**
 * Generic generate-file tool — uses CodeGenService to LLM-generate a file.
 */
import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import type { CodeGenService } from '../generation/code-gen-service.js'

export function createGenerateFileTool(codeGenService: CodeGenService, defaultSystemPrompt: string) {
  return tool(
    async ({ filePath, purpose, referenceCode }) => {
      const result = await codeGenService.generateFile(
        {
          filePath,
          purpose,
          ...(referenceCode ? { referenceFiles: { reference: referenceCode } } : {}),
        },
        defaultSystemPrompt,
      )

      return JSON.stringify({
        action: 'generate_file',
        filePath,
        content: result.content,
        language: result.language,
        source: result.source,
        tokensUsed: result.tokensUsed.inputTokens + result.tokensUsed.outputTokens,
      })
    },
    {
      name: 'generate_file',
      description: 'Generate a source file using the LLM. The file content is generated based on the purpose description and optional reference code.',
      schema: z.object({
        filePath: z.string().describe('Path for the generated file'),
        purpose: z.string().describe('Description of what this file should contain and its role in the project'),
        referenceCode: z.string().optional().describe('Optional reference code to use as a pattern'),
      }),
    },
  )
}

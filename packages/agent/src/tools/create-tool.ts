/**
 * Generic tool factory — creates LangChain StructuredTools with
 * Zod-validated inputs and outputs.
 *
 * Inspired by Mastra's createTool pattern, adapted for LangChain compatibility.
 *
 * Usage:
 * ```ts
 * const weatherTool = createForgeTool({
 *   id: 'get-weather',
 *   description: 'Get current weather for a location',
 *   inputSchema: z.object({ city: z.string() }),
 *   outputSchema: z.object({ temp: z.number(), unit: z.string() }),
 *   execute: async ({ city }) => ({ temp: 72, unit: 'F' }),
 * })
 * ```
 */
import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import type { StructuredToolInterface } from '@langchain/core/tools'

export interface ForgeToolConfig<
  TInput extends z.ZodType,
  TOutput extends z.ZodType = z.ZodType<string>,
> {
  /** Unique tool identifier */
  id: string
  /** What this tool does (shown to the LLM) */
  description: string
  /** Zod schema for validating inputs */
  inputSchema: TInput
  /** Optional Zod schema for validating outputs */
  outputSchema?: TOutput
  /** The tool's execution function */
  execute: (input: z.infer<TInput>) => Promise<z.infer<TOutput>>
  /** Optional: transform rich output into a model-friendly string */
  toModelOutput?: (output: z.infer<TOutput>) => string
}

/**
 * Create a LangChain-compatible tool with Zod validation on both
 * inputs and outputs.
 */
export function createForgeTool<
  TInput extends z.ZodType,
  TOutput extends z.ZodType = z.ZodType<string>,
>(config: ForgeToolConfig<TInput, TOutput>): StructuredToolInterface {
  return tool(
    async (input: z.infer<TInput>) => {
      const result = await config.execute(input)

      // Validate output if schema provided
      if (config.outputSchema) {
        config.outputSchema.parse(result)
      }

      // Format for model
      if (config.toModelOutput) {
        return config.toModelOutput(result)
      }

      return typeof result === 'string' ? result : JSON.stringify(result)
    },
    {
      name: config.id,
      description: config.description,
      schema: config.inputSchema,
    },
  )
}

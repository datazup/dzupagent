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
 *
 * `outputSchema` is optional. When it is omitted the tool's return type is
 * inferred from `execute` and is NOT constrained to `string` — the runtime
 * JSON-stringifies any non-string result:
 *
 * ```ts
 * const statsTool = createForgeTool({
 *   id: 'get-stats',
 *   description: 'Returns run statistics',
 *   inputSchema: z.object({ runId: z.string() }),
 *   execute: async () => ({ passed: 12, failed: 0 }), // -> '{"passed":12,"failed":0}'
 * })
 * ```
 */
import type { z } from 'zod'
import { tool } from '@langchain/core/tools'
import type { StructuredToolInterface } from '@langchain/core/tools'

/**
 * Configuration for {@link createForgeTool}.
 *
 * @typeParam TInput  - Zod schema for the tool's input. Always inferred from
 *                      the `inputSchema` property.
 * @typeParam TOutput - Zod schema for the tool's output. Inferred from
 *                      `outputSchema` when that is supplied. When it is
 *                      omitted this falls back to `z.ZodType<unknown>`, whose
 *                      inferred type is `unknown`, so it imposes no constraint.
 * @typeParam TResult - The type `execute` actually resolves to. Inferred from
 *                      `execute` itself and constrained by `z.infer<TOutput>`,
 *                      which is what keeps two properties true at once:
 *                        - with `outputSchema`, a mismatched return is still a
 *                          compile error (the constraint is the schema type);
 *                        - without `outputSchema`, the constraint is `unknown`,
 *                          so any return is legal AND `toModelOutput` still
 *                          receives the precise type `execute` returns rather
 *                          than a widened `unknown`.
 *                      Callers never pass this explicitly.
 */
export interface ForgeToolConfig<
  TInput extends z.ZodType,
  TOutput extends z.ZodType = z.ZodType<unknown>,
  TResult extends z.infer<TOutput> = z.infer<TOutput>,
> {
  /** Unique tool identifier */
  id: string
  /** What this tool does (shown to the LLM) */
  description: string
  /** Zod schema for validating inputs */
  inputSchema: TInput
  /**
   * Optional Zod schema for validating outputs.
   *
   * When supplied, `execute`'s return type is inferred from it and checked
   * against it at compile time, and validated against it at runtime. When
   * omitted, no output constraint is applied in either direction.
   */
  outputSchema?: TOutput
  /**
   * The tool's execution function.
   *
   * `context.signal` is aborted when the surrounding run is cancelled or
   * when a per-tool timeout fires. Tools that perform cancellable I/O should
   * pass this signal to fetch, subprocess, SDK, or polling APIs. Tools that
   * cannot interrupt underlying work may ignore it; the runtime will still
   * enforce the observable deadline.
   */
  execute: (
    input: z.infer<TInput>,
    context: ToolExecutionContext,
  ) => Promise<TResult>
  /** Optional: transform rich output into a model-friendly string */
  toModelOutput?: (output: TResult) => string
}

export interface ToolExecutionContext {
  signal: AbortSignal
}

/**
 * Create a LangChain-compatible tool with Zod validation on both
 * inputs and outputs.
 */
export function createForgeTool<
  TInput extends z.ZodType,
  TOutput extends z.ZodType = z.ZodType<unknown>,
  TResult extends z.infer<TOutput> = z.infer<TOutput>,
>(config: ForgeToolConfig<TInput, TOutput, TResult>): StructuredToolInterface {
  const built = tool(
    async (input: z.infer<TInput>, runtimeConfig?: { signal?: AbortSignal }) => {
      const result = await config.execute(input, {
        signal: runtimeConfig?.signal ?? new AbortController().signal,
      })

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
  // Cast: LangChain's `tool()` returns a union (DynamicStructuredTool | DynamicTool)
  // whose schema generics don't line up with `StructuredToolInterface` under
  // `exactOptionalPropertyTypes: true`. At runtime both satisfy the interface.
  return built as unknown as StructuredToolInterface
}

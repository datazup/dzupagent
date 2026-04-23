/**
 * Structured-output generation — extracted from DzupAgent.generateStructured().
 *
 * Implements the two-path strategy:
 * 1. Prefer the provider's native `withStructuredOutput` when capability
 *    metadata opts in.
 * 2. Fall back to text generation + JSON extraction + schema correction
 *    retry loop when the native call fails or is unsupported.
 *
 * Extraction keeps the DzupAgent class focused on orchestration and leaves
 * the (substantial) schema/retry logic here where it can be unit-tested in
 * isolation.
 */

import type { ZodType } from 'zod'
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import {
  attachStructuredOutputErrorContext,
  buildStructuredOutputCorrectionPrompt,
  buildStructuredOutputExhaustedError,
  executeStructuredParseLoop,
  isStructuredOutputExhaustedErrorMessage,
  prepareStructuredOutputSchemaContract,
  resolveStructuredOutputSchemaProvider,
  shouldAttemptNativeStructuredOutput,
  type StructuredOutputModelCapabilities,
  unwrapStructuredEnvelope,
} from '@dzupagent/core'
import type {
  DzupAgentConfig,
  GenerateOptions,
  GenerateResult,
} from './agent-types.js'

/** Context the structured-generate routine needs from its owning agent. */
export interface StructuredGenerateContext {
  agentId: string
  config: DzupAgentConfig
  resolvedModel: BaseChatModel
  prepareMessages: (messages: BaseMessage[]) => Promise<{ messages: BaseMessage[]; memoryFrame?: unknown }>
  generate: (messages: BaseMessage[], options?: GenerateOptions) => Promise<GenerateResult>
  resolveStructuredOutputCapabilities: (
    model: BaseChatModel,
  ) => StructuredOutputModelCapabilities | undefined
}

export async function generateStructured<T>(
  ctx: StructuredGenerateContext,
  messages: BaseMessage[],
  schema: ZodType<T>,
  options?: GenerateOptions,
): Promise<{ data: T; usage: GenerateResult['usage'] }> {
  const fallbackMaxRetries = 2
  const model = ctx.resolvedModel
  const structuredOutputCapabilities = ctx.resolveStructuredOutputCapabilities(model)
  const schemaProvider = resolveStructuredOutputSchemaProvider(
    options?.schemaProvider,
    structuredOutputCapabilities,
  )
  const schemaContract = prepareStructuredOutputSchemaContract(schema, {
    agentId: ctx.agentId,
    intent: options?.intent ?? null,
    schemaName: options?.schemaName,
    schemaProvider,
    previewChars: 240,
  })
  const requestMessages = schemaContract.requiresEnvelope
    ? [
        ...messages,
        new SystemMessage('Return the final JSON payload inside the top-level "result" property.'),
      ]
    : messages

  const modelName = (model as BaseChatModel & {
    model?: string
    modelName?: string
    name?: string
  }).model
    ?? (model as BaseChatModel & { modelName?: string }).modelName
    ?? (model as BaseChatModel & { name?: string }).name
    ?? 'unknown'

  ctx.config.eventBus?.emit({
    type: 'agent:structured_schema_prepared',
    agentId: ctx.agentId,
    schemaName: schemaContract.requestSchemaDescriptor.schemaName,
    schemaHash: schemaContract.requestSchemaDescriptor.schemaHash,
    provider: schemaContract.requestSchemaDescriptor.provider,
    topLevelType: schemaContract.requestSchemaDescriptor.summary.topLevelType,
    propertyCount: schemaContract.requestSchemaDescriptor.summary.totalProperties,
    requiredCount: schemaContract.requestSchemaDescriptor.summary.totalRequired,
  })

  let nativeStructuredError: Error | null = null

  // Try withStructuredOutput first (Anthropic/OpenAI support this natively)
  if (shouldAttemptNativeStructuredOutput(model, structuredOutputCapabilities)) {
    try {
      const structuredModel = (model as BaseChatModel & {
        withStructuredOutput: (s: ZodType<T>) => BaseChatModel
      }).withStructuredOutput(schemaContract.requestSchema as ZodType<T>)

      const prepared = await ctx.prepareMessages(requestMessages)
      const response = await structuredModel.invoke(prepared.messages)

      const parsed = schemaContract.responseSchema.parse(response)

      return {
        data: unwrapStructuredEnvelope(parsed, schemaContract.requiresEnvelope),
        usage: { totalInputTokens: 0, totalOutputTokens: 0, llmCalls: 1 },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      nativeStructuredError = err instanceof Error ? err : new Error(message)

      ctx.config.eventBus?.emit({
        type: 'agent:structured_native_rejected',
        agentId: ctx.agentId,
        schemaName: schemaContract.requestSchemaDescriptor.schemaName,
        schemaHash: schemaContract.requestSchemaDescriptor.schemaHash,
        provider: schemaContract.requestSchemaDescriptor.provider,
        model: modelName,
        message,
      })
      ctx.config.eventBus?.emit({
        type: 'agent:structured_fallback_used',
        agentId: ctx.agentId,
        schemaName: schemaContract.requestSchemaDescriptor.schemaName,
        schemaHash: schemaContract.requestSchemaDescriptor.schemaHash,
        provider: schemaContract.requestSchemaDescriptor.provider,
        model: modelName,
        from: 'native_provider',
        to: 'text_json',
      })

      console.warn('[DzupAgent.generateStructured] Native structured output failed; falling back to text JSON parsing.', {
        agentId: ctx.agentId,
        schemaName: schemaContract.requestSchemaDescriptor.schemaName,
        model: modelName,
        schemaHash: schemaContract.requestSchemaDescriptor.schemaHash,
        provider: schemaContract.requestSchemaDescriptor.provider,
        schemaSummary: schemaContract.requestSchemaDescriptor.summary,
        schemaPreview: schemaContract.requestSchemaDescriptor.schemaPreview,
        error: message,
      })

      // Some provider/runtime combinations reject the native structured schema
      // before the model can answer. Fall back to text generation plus local
      // JSON extraction so callers still get a structured result.
    }
  }

  // Fallback: generate text, extract JSON, and retry with a correction prompt.
  try {
    const fallbackResult = await executeStructuredParseLoop({
      initialState: {
        messages: requestMessages,
        usage: emptyGenerateUsage(),
      },
      maxRetries: fallbackMaxRetries,
      invoke: async (state) => {
        const result = await ctx.generate(state.messages, options)
        return {
          raw: result.content,
          meta: result.usage,
        }
      },
      parse: (raw) => {
        try {
          const jsonStr = extractJsonFromText(raw)
          const parsedJson = JSON.parse(jsonStr) as unknown
          const parsed = schemaContract.responseSchema.safeParse(parsedJson)
          if (parsed.success) {
            return {
              success: true as const,
              data: unwrapStructuredEnvelope(parsed.data, schemaContract.requiresEnvelope),
            }
          }

          const issues = parsed.error.issues
            .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')

          return {
            success: false as const,
            error: `Schema validation failed: ${issues}`,
          }
        } catch (err) {
          return {
            success: false as const,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      },
      onRetryState: (state, { raw, error, meta }) => ({
        messages: [
          ...state.messages,
          new AIMessage(raw),
          new HumanMessage(buildStructuredOutputCorrectionPrompt({
            schemaName: schemaContract.requestSchemaDescriptor.schemaName,
            schemaHash: schemaContract.requestSchemaDescriptor.schemaHash,
            description: 'Respond ONLY with valid JSON.',
          }, error)),
        ],
        usage: mergeGenerateUsage(state.usage, meta),
      }),
    })

    if (!fallbackResult.success) {
      throw new Error(buildStructuredOutputExhaustedError({
        schemaName: schemaContract.requestSchemaDescriptor.schemaName,
        schemaHash: schemaContract.requestSchemaDescriptor.schemaHash,
      }, fallbackResult.retries + 1))
    }

    return {
      data: fallbackResult.data as T,
      usage: mergeGenerateUsage(fallbackResult.state.usage, fallbackResult.meta),
    }
  } catch (err) {
    const failureMessage = err instanceof Error ? err.message : String(err)
    const enriched = attachStructuredOutputErrorContext(err, {
      agentId: ctx.agentId,
      intent: options?.intent ?? null,
      provider: schemaContract.requestSchemaDescriptor.provider,
      model: modelName,
      failureCategory: isStructuredOutputExhaustedErrorMessage(failureMessage, {
        schemaName: schemaContract.requestSchemaDescriptor.schemaName,
        schemaHash: schemaContract.requestSchemaDescriptor.schemaHash,
      })
        ? 'parse_exhausted'
        : 'provider_execution_failed',
      requiresEnvelope: schemaContract.requiresEnvelope,
      messageCount: requestMessages.length,
      requestSchema: schemaContract.requestSchemaDescriptor,
      responseSchema: schemaContract.responseSchemaDescriptor,
    })

    if (nativeStructuredError) {
      Object.assign(enriched, {
        nativeStructuredOutputError: nativeStructuredError.message,
      })
    }

    ctx.config.eventBus?.emit({
      type: 'agent:structured_validation_failed',
      agentId: ctx.agentId,
      schemaName: schemaContract.requestSchemaDescriptor.schemaName,
      schemaHash: schemaContract.requestSchemaDescriptor.schemaHash,
      provider: schemaContract.requestSchemaDescriptor.provider,
      model: modelName,
      message: enriched.message,
    })
    throw enriched
  }
}

/**
 * Extract the first valid JSON value from an LLM text response.
 * Handles code-fenced JSON blocks, bare JSON objects, and bare JSON arrays.
 * Throws SyntaxError if no valid JSON is found.
 */
export function extractJsonFromText(text: string): string {
  const trimmed = text.trim()

  // 1. Try fenced block: ```json ... ``` or ``` ... ```
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) {
    return fenced[1].trim()
  }

  // 2. Try to find the first { or [ and extract a balanced JSON value
  const firstBrace = trimmed.indexOf('{')
  const firstBracket = trimmed.indexOf('[')
  const start =
    firstBrace === -1 ? firstBracket
    : firstBracket === -1 ? firstBrace
    : Math.min(firstBrace, firstBracket)

  if (start !== -1) {
    // Walk forward to find the matching close, trying progressively longer slices
    const slice = trimmed.slice(start)
    // Try the full slice first (common case: response is pure JSON after preamble)
    try {
      JSON.parse(slice)
      return slice
    } catch {
      // Find the last } or ] and try that boundary
      const lastClose = Math.max(slice.lastIndexOf('}'), slice.lastIndexOf(']'))
      if (lastClose > 0) {
        const candidate = slice.slice(0, lastClose + 1)
        JSON.parse(candidate) // let it throw if still invalid
        return candidate
      }
    }
  }

  // 3. Last resort — return the trimmed text and let JSON.parse throw
  return trimmed
}

function emptyGenerateUsage(): GenerateResult['usage'] {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    llmCalls: 0,
  }
}

function mergeGenerateUsage(
  left: GenerateResult['usage'],
  right: GenerateResult['usage'],
): GenerateResult['usage'] {
  return {
    totalInputTokens: left.totalInputTokens + right.totalInputTokens,
    totalOutputTokens: left.totalOutputTokens + right.totalOutputTokens,
    llmCalls: left.llmCalls + right.llmCalls,
  }
}

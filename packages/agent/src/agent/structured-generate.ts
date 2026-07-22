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
  unwrapStructuredEnvelope,
} from '@dzupagent/core/pipeline'
import { injectPromptCacheMarkersForModel } from '@dzupagent/context'
import {
  runBeforeModelCall,
  runAfterModelCall,
  runOnModelError,
} from '@dzupagent/core/orchestration'
import {
  buildModelHookContext,
  resolveModelIdForHooks,
} from './model-hooks.js'
import { extractTokenUsage, type StructuredOutputModelCapabilities } from '@dzupagent/core/llm'
import { defaultLogger } from '@dzupagent/core/utils'
import { extractJsonFromText } from '@dzupagent/core'
import type { AIMessage as AIMessageType } from '@langchain/core/messages'
import type {
  DzupAgentConfig,
  GenerateOptions,
  GenerateResult,
} from './agent-types.js'
import { omitUndefined } from '../utils/exact-optional.js'

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
  const schemaContract = prepareStructuredOutputSchemaContract(schema, omitUndefined({
    agentId: ctx.agentId,
    intent: options?.intent ?? null,
    schemaName: options?.schemaName,
    schemaProvider,
    previewChars: 240,
  }))
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

  // WS3 Task 3.2 — resolve the model id + hook context once for the native
  // structured-output model-lifecycle hooks below.
  const resolvedModelId = resolveModelIdForHooks(ctx.config.model, model)
  const hookCtx = buildModelHookContext(ctx.config, ctx.agentId, options?.runId)

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
      // DZUPAGENT-AGENT-M-05 — request includeRaw so we can recover the
      // underlying AIMessage and extract real token usage. LangChain's
      // `withStructuredOutput(schema, { includeRaw: true })` returns
      // `{ raw: AIMessage, parsed: <schema> }`. We tolerate legacy
      // implementations that ignore the option and return the parsed value
      // directly (zero usage in that case).
      const structuredModel = (model as BaseChatModel & {
        withStructuredOutput: (s: ZodType<T>, opts?: { includeRaw?: boolean }) => BaseChatModel
      }).withStructuredOutput(schemaContract.requestSchema as ZodType<T>, { includeRaw: true })

      const prepared = await ctx.prepareMessages(requestMessages)
      // WS3 Task 3.2 — model-lifecycle hooks run BEFORE prompt-cache injection.
      // ORDERING IS LOAD-BEARING: `beforeModelCall` may rewrite the message
      // array, and cache breakpoints must be computed on the FINAL array.
      const beforeMessages = await runBeforeModelCall(
        ctx.config.hooks?.beforeModelCall
          ? [ctx.config.hooks.beforeModelCall]
          : undefined,
        ctx.config.eventBus,
        prepared.messages,
        resolvedModelId,
        hookCtx,
      )
      // REC-H-10 — apply Anthropic prompt-cache markers before invoking the
      // native structured-output model. The non-streaming/streaming paths
      // already inject in `prepareRunState`, but this branch bypasses
      // `prepareRunState` entirely (it calls `withStructuredOutput().invoke`
      // directly), so without this call we silently miss caching for every
      // structured generate call. Injector is a no-op for non-Claude models
      // and short transcripts.
      const cachedMessages = injectPromptCacheMarkersForModel(
        beforeMessages,
        ctx.resolvedModel,
      )
      const response = await structuredModel.invoke(cachedMessages)

      const { raw, payload } = unpackIncludeRawResponse(response)
      const parsed = schemaContract.responseSchema.parse(payload)
      const usage = buildNativeStructuredUsage(raw, modelName)

      // WS3 Task 3.2 — success seam: fire `afterModelCall` once with the
      // native response (best-effort; errors swallowed by the dispatcher).
      await runAfterModelCall(
        ctx.config.hooks?.afterModelCall
          ? [ctx.config.hooks.afterModelCall]
          : undefined,
        ctx.config.eventBus,
        cachedMessages,
        raw ?? new AIMessage(''),
        resolvedModelId,
        hookCtx,
      )

      return {
        data: unwrapStructuredEnvelope(parsed, schemaContract.requiresEnvelope),
        usage,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      nativeStructuredError = err instanceof Error ? err : new Error(message)

      // WS3 Task 3.2 — error seam: fire `onModelError` for the failed native
      // invocation before falling back to the text-JSON path.
      await runOnModelError(
        ctx.config.hooks?.onModelError
          ? [ctx.config.hooks.onModelError]
          : undefined,
        ctx.config.eventBus,
        nativeStructuredError,
        resolvedModelId,
        hookCtx,
      )

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

      defaultLogger.warn('[DzupAgent.generateStructured] Native structured output failed; falling back to text JSON parsing.', {
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
 *
 * Canonical implementation lives in `@dzupagent/core` (`extractJsonFromText`);
 * re-exported here to preserve the public `structured-generate` / `dzip-agent`
 * surface. Handles code-fenced JSON, bare objects/arrays, and returns the
 * trimmed input as a last resort so the caller's `JSON.parse` throws.
 */
export { extractJsonFromText }

/**
 * Unpack the response from `withStructuredOutput(schema, { includeRaw: true })`.
 *
 * Per LangChain convention, the returned runnable resolves to
 * `{ raw: AIMessage, parsed: <schema> }`. Older provider implementations and
 * test mocks may ignore the `includeRaw` flag and return the parsed value
 * directly; we tolerate that shape by treating the whole response as the
 * payload (with no raw message available for usage extraction).
 */
function unpackIncludeRawResponse(response: unknown): {
  raw: AIMessageType | undefined
  payload: unknown
} {
  if (response && typeof response === 'object' && 'parsed' in (response as Record<string, unknown>)) {
    const envelope = response as { raw?: unknown; parsed: unknown }
    const raw = envelope.raw
    return {
      raw: isLikelyAIMessage(raw) ? (raw as AIMessageType) : undefined,
      payload: envelope.parsed,
    }
  }
  return { raw: undefined, payload: response }
}

function isLikelyAIMessage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    'usage_metadata' in record
    || 'response_metadata' in record
    || 'content' in record
  )
}

/**
 * Build a GenerateResult.usage entry for the native structured-output path
 * by extracting real token usage from the raw AIMessage when available.
 */
function buildNativeStructuredUsage(
  raw: AIMessageType | undefined,
  modelName: string,
): GenerateResult['usage'] {
  if (!raw) {
    return { totalInputTokens: 0, totalOutputTokens: 0, llmCalls: 1 }
  }
  const usage = extractTokenUsage(raw, modelName)
  return {
    totalInputTokens: usage.inputTokens,
    totalOutputTokens: usage.outputTokens,
    llmCalls: 1,
  }
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

/**
 * LLM invocation with timeout, automatic retry, and usage tracking.
 */
import type { BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { isTransientError, DEFAULT_RETRY_CONFIG, type RetryConfig } from './retry.js'

/** Token usage extracted from LLM response metadata */
export interface TokenUsage {
  model: string
  inputTokens: number
  outputTokens: number
}

/** Options for invokeWithTimeout */
export interface InvokeOptions {
  /** Timeout in milliseconds (default: 120_000 = 2 minutes) */
  timeoutMs?: number
  /** Retry configuration */
  retry?: RetryConfig
  /** Callback fired after each successful invocation with token usage data */
  onUsage?: (usage: TokenUsage) => void
  /** Additional context string for tracking/logging */
  trackingContext?: string
}

const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Extract real token usage from an LLM response's metadata.
 *
 * Tries multiple paths used by different LangChain providers:
 *
 * 1. Top-level `usage_metadata` (LangChain 0.3+ standardized field)
 *    `{ input_tokens, output_tokens, total_tokens }`
 *
 * 2. `response_metadata.usage` — Anthropic format
 *    `{ input_tokens, output_tokens }`
 *
 * 3. `response_metadata.usage` — OpenAI format
 *    `{ prompt_tokens, completion_tokens, total_tokens }`
 *
 * 4. `response_metadata.usage_metadata` — some LangChain versions nest it here
 *    `{ input_tokens, output_tokens }`
 *
 * 5. `response_metadata.tokenUsage` — older LangChain format
 *    `{ promptTokens, completionTokens, totalTokens }`
 *
 * Returns `{ inputTokens: 0, outputTokens: 0 }` when no real usage is found.
 */
export function extractTokenUsage(
  response: BaseMessage,
  modelName?: string,
): TokenUsage {
  const resp = response as BaseMessage & {
    response_metadata?: Record<string, unknown>
    usage_metadata?: Record<string, unknown>
  }

  const meta = resp.response_metadata
  const resolvedModel = modelName ?? (meta?.['model'] as string | undefined) ?? 'unknown'

  // Path 1: Top-level usage_metadata (LangChain 0.3+ standardized)
  const topUsageMeta = resp.usage_metadata as Record<string, number> | undefined
  if (topUsageMeta && typeof topUsageMeta['input_tokens'] === 'number' && typeof topUsageMeta['output_tokens'] === 'number') {
    return {
      model: resolvedModel,
      inputTokens: topUsageMeta['input_tokens'],
      outputTokens: topUsageMeta['output_tokens'],
    }
  }

  // Path 2 & 3: response_metadata.usage (Anthropic input_tokens or OpenAI prompt_tokens)
  const usage = meta?.['usage'] as Record<string, unknown> | undefined
  if (usage) {
    if (typeof usage['input_tokens'] === 'number' && typeof usage['output_tokens'] === 'number') {
      return {
        model: resolvedModel,
        inputTokens: usage['input_tokens'],
        outputTokens: usage['output_tokens'],
      }
    }
    if (typeof usage['prompt_tokens'] === 'number' && typeof usage['completion_tokens'] === 'number') {
      return {
        model: resolvedModel,
        inputTokens: usage['prompt_tokens'],
        outputTokens: usage['completion_tokens'],
      }
    }
  }

  // Path 4: response_metadata.usage_metadata
  const usageMeta = meta?.['usage_metadata'] as Record<string, unknown> | undefined
  if (usageMeta) {
    if (typeof usageMeta['input_tokens'] === 'number' && typeof usageMeta['output_tokens'] === 'number') {
      return {
        model: resolvedModel,
        inputTokens: usageMeta['input_tokens'],
        outputTokens: usageMeta['output_tokens'],
      }
    }
  }

  // Path 5: response_metadata.tokenUsage (older LangChain format)
  const tokenUsage = meta?.['tokenUsage'] as Record<string, unknown> | undefined
  if (tokenUsage && typeof tokenUsage['promptTokens'] === 'number' && typeof tokenUsage['completionTokens'] === 'number') {
    return {
      model: resolvedModel,
      inputTokens: tokenUsage['promptTokens'],
      outputTokens: tokenUsage['completionTokens'],
    }
  }

  return { model: resolvedModel, inputTokens: 0, outputTokens: 0 }
}

/**
 * Estimate tokens from text length. Only use as fallback when real usage is unavailable.
 * Uses ~4 chars per token as a rough approximation.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Invoke an LLM model with timeout enforcement, automatic retry on
 * transient errors, and optional usage tracking callback.
 */
export async function invokeWithTimeout(
  model: BaseChatModel,
  messages: BaseMessage[],
  options?: InvokeOptions,
): Promise<BaseMessage> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retry = options?.retry ?? DEFAULT_RETRY_CONFIG
  const maxAttempts = retry.maxAttempts
  const backoffBase = retry.backoffMs ?? 1000
  const maxBackoff = retry.maxBackoffMs ?? 8000

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await Promise.race([
        model.invoke(messages),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`LLM call timed out after ${timeoutMs}ms`)),
            timeoutMs,
          ),
        ),
      ])

      // Fire usage callback if provided
      if (options?.onUsage) {
        const modelName = (model as BaseChatModel & { model?: string }).model
        const usage = extractTokenUsage(response, modelName)
        try {
          options.onUsage(usage)
        } catch {
          // Usage callback failure is non-fatal
        }
      }

      return response
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err))

      if (attempt < maxAttempts && isTransientError(lastError)) {
        const backoffMs = Math.min(backoffBase * 2 ** (attempt - 1), maxBackoff)
        await new Promise(resolve => setTimeout(resolve, backoffMs))
        continue
      }

      throw lastError
    }
  }

  throw lastError ?? new Error('LLM invocation failed')
}

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
 * Extract token usage from an LLM response's metadata.
 * Handles both Anthropic and OpenAI response formats.
 */
export function extractTokenUsage(
  response: BaseMessage,
  modelName?: string,
): TokenUsage {
  const meta = (response as BaseMessage & { response_metadata?: Record<string, unknown> }).response_metadata
  const usageBlock = (meta?.['usage'] ?? meta?.['usage_metadata'] ?? {}) as Record<string, unknown>

  return {
    model: modelName ?? (meta?.['model'] as string | undefined) ?? 'unknown',
    inputTokens: typeof usageBlock['input_tokens'] === 'number'
      ? usageBlock['input_tokens']
      : typeof usageBlock['prompt_tokens'] === 'number'
        ? usageBlock['prompt_tokens']
        : 0,
    outputTokens: typeof usageBlock['output_tokens'] === 'number'
      ? usageBlock['output_tokens']
      : typeof usageBlock['completion_tokens'] === 'number'
        ? usageBlock['completion_tokens']
        : 0,
  }
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

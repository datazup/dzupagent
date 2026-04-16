import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invokeWithTimeout, extractTokenUsage, estimateTokens } from '../llm/invoke.js'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'

// ---------------------------------------------------------------------------
// Mock model factory
// ---------------------------------------------------------------------------

function createMockModel(
  responses: BaseMessage[],
  options?: { delay?: number },
): BaseChatModel {
  let callIndex = 0
  return {
    invoke: vi.fn(async () => {
      if (options?.delay) {
        await new Promise((resolve) => setTimeout(resolve, options.delay))
      }
      const response = responses[callIndex] ?? responses[responses.length - 1]!
      callIndex++
      return response
    }),
  } as unknown as BaseChatModel
}

function createFailingModel(
  errors: Error[],
  thenResponse?: BaseMessage,
): BaseChatModel {
  let callIndex = 0
  return {
    invoke: vi.fn(async () => {
      if (callIndex < errors.length) {
        const err = errors[callIndex]!
        callIndex++
        throw err
      }
      callIndex++
      return thenResponse ?? new AIMessage({ content: 'recovered' })
    }),
  } as unknown as BaseChatModel
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('invokeWithTimeout', () => {
  const messages = [new AIMessage({ content: 'hello' })]

  it('returns model response on success', async () => {
    const response = new AIMessage({ content: 'world' })
    const model = createMockModel([response])

    const result = await invokeWithTimeout(model, messages)
    expect(result.content).toBe('world')
  })

  it('calls onUsage callback with token data', async () => {
    const response = new AIMessage({
      content: 'response',
      response_metadata: {
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    })
    const model = createMockModel([response])
    const onUsage = vi.fn()

    await invokeWithTimeout(model, messages, { onUsage })

    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 10,
        outputTokens: 20,
      }),
    )
  })

  it('survives onUsage callback throwing', async () => {
    const response = new AIMessage({ content: 'ok' })
    const model = createMockModel([response])
    const onUsage = vi.fn(() => {
      throw new Error('callback boom')
    })

    const result = await invokeWithTimeout(model, messages, { onUsage })
    expect(result.content).toBe('ok')
    expect(onUsage).toHaveBeenCalled()
  })

  it('times out when model is too slow', async () => {
    const response = new AIMessage({ content: 'slow' })
    const model = createMockModel([response], { delay: 500 })

    await expect(
      invokeWithTimeout(model, messages, { timeoutMs: 50 }),
    ).rejects.toThrow('timed out')
  })

  it('retries on transient errors', async () => {
    const model = createFailingModel(
      [new Error('rate_limit exceeded')],
      new AIMessage({ content: 'success after retry' }),
    )

    const result = await invokeWithTimeout(model, messages, {
      retry: { maxAttempts: 3, backoffMs: 10, maxBackoffMs: 20 },
    })
    expect(result.content).toBe('success after retry')
    expect(model.invoke).toHaveBeenCalledTimes(2)
  })

  it('does not retry on non-transient errors', async () => {
    const model = createFailingModel([new Error('Invalid API key')])

    await expect(
      invokeWithTimeout(model, messages, {
        retry: { maxAttempts: 3, backoffMs: 10, maxBackoffMs: 20 },
      }),
    ).rejects.toThrow('Invalid API key')
    expect(model.invoke).toHaveBeenCalledTimes(1)
  })

  it('throws after exhausting all retry attempts', async () => {
    const model = createFailingModel([
      new Error('rate_limit'),
      new Error('rate_limit'),
      new Error('rate_limit'),
    ])

    await expect(
      invokeWithTimeout(model, messages, {
        retry: { maxAttempts: 3, backoffMs: 10, maxBackoffMs: 20 },
      }),
    ).rejects.toThrow('rate_limit')
    expect(model.invoke).toHaveBeenCalledTimes(3)
  })

  it('uses default timeout and retry when options not provided', async () => {
    const response = new AIMessage({ content: 'default' })
    const model = createMockModel([response])

    const result = await invokeWithTimeout(model, messages)
    expect(result.content).toBe('default')
  })
})

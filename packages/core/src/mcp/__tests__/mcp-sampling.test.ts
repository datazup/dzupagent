import { describe, it, expect, vi } from 'vitest'
import { createSamplingHandler, registerSamplingHandler } from '../mcp-sampling.js'
import type { LLMInvokeFn } from '../mcp-sampling.js'
import type { MCPSamplingRequest } from '../mcp-sampling-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLLM(): LLMInvokeFn {
  return vi.fn<LLMInvokeFn>().mockResolvedValue({
    content: 'LLM response',
    model: 'test-model',
    stopReason: 'endTurn',
  })
}

function baseRequest(overrides: Partial<MCPSamplingRequest> = {}): MCPSamplingRequest {
  return {
    messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
    maxTokens: 100,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSamplingHandler', () => {
  it('routes a sampling request to the LLM function', async () => {
    const llm = createMockLLM()
    const handler = createSamplingHandler(llm)

    const result = await handler(baseRequest())

    expect(result.role).toBe('assistant')
    expect(result.content).toEqual({ type: 'text', text: 'LLM response' })
    expect(result.model).toBe('test-model')
    expect(result.stopReason).toBe('endTurn')

    expect(llm).toHaveBeenCalledWith(
      [{ role: 'user', content: 'Hello' }],
      { model: undefined, temperature: undefined, maxTokens: 100, stopSequences: undefined },
    )
  })

  it('includes system prompt as first message', async () => {
    const llm = createMockLLM()
    const handler = createSamplingHandler(llm)

    await handler(baseRequest({ systemPrompt: 'You are helpful.' }))

    const calls = (llm as ReturnType<typeof vi.fn>).mock.calls
    const messages = calls[0]?.[0] as Array<{ role: string; content: string }>
    expect(messages[0]).toEqual({ role: 'system', content: 'You are helpful.' })
    expect(messages[1]).toEqual({ role: 'user', content: 'Hello' })
  })

  it('clamps maxTokens to maxAllowedTokens', async () => {
    const llm = createMockLLM()
    const handler = createSamplingHandler(llm, { maxAllowedTokens: 50 })

    await handler(baseRequest({ maxTokens: 200 }))

    const calls = (llm as ReturnType<typeof vi.fn>).mock.calls
    const options = calls[0]?.[1] as { maxTokens: number }
    expect(options.maxTokens).toBe(50)
  })

  it('throws when request exceeds budget maxTokens', async () => {
    const llm = createMockLLM()
    const handler = createSamplingHandler(llm, {
      budget: { maxTokens: 30 },
    })

    await expect(handler(baseRequest({ maxTokens: 100 }))).rejects.toThrow(
      /exceeds token budget/,
    )
    expect(llm).not.toHaveBeenCalled()
  })

  it('uses default model when no preferences are specified', async () => {
    const llm = createMockLLM()
    const handler = createSamplingHandler(llm, { defaultModel: 'claude-3-haiku' })

    await handler(baseRequest())

    const calls = (llm as ReturnType<typeof vi.fn>).mock.calls
    const options = calls[0]?.[1] as { model: string }
    expect(options.model).toBe('claude-3-haiku')
  })

  it('selects model from preference hints', async () => {
    const llm = createMockLLM()
    const handler = createSamplingHandler(llm, { defaultModel: 'fallback-model' })

    await handler(baseRequest({
      modelPreferences: {
        hints: [{ name: 'claude-3-sonnet' }],
        intelligencePriority: 0.8,
      },
    }))

    const calls = (llm as ReturnType<typeof vi.fn>).mock.calls
    const options = calls[0]?.[1] as { model: string }
    expect(options.model).toBe('claude-3-sonnet')
  })

  it('skips hints without names and uses default', async () => {
    const llm = createMockLLM()
    const handler = createSamplingHandler(llm, { defaultModel: 'default-model' })

    await handler(baseRequest({
      modelPreferences: {
        hints: [{ name: undefined }, {}],
      },
    }))

    const calls = (llm as ReturnType<typeof vi.fn>).mock.calls
    const options = calls[0]?.[1] as { model: string }
    expect(options.model).toBe('default-model')
  })

  it('maps stop reason "length" to "maxTokens"', async () => {
    const llm = vi.fn<LLMInvokeFn>().mockResolvedValue({
      content: 'truncated',
      model: 'test',
      stopReason: 'length',
    })
    const handler = createSamplingHandler(llm)

    const result = await handler(baseRequest())
    expect(result.stopReason).toBe('maxTokens')
  })

  it('maps stop reason "stop" to "endTurn"', async () => {
    const llm = vi.fn<LLMInvokeFn>().mockResolvedValue({
      content: 'done',
      model: 'test',
      stopReason: 'stop',
    })
    const handler = createSamplingHandler(llm)

    const result = await handler(baseRequest())
    expect(result.stopReason).toBe('endTurn')
  })

  it('handles image content in messages', async () => {
    const llm = createMockLLM()
    const handler = createSamplingHandler(llm)

    await handler(baseRequest({
      messages: [
        { role: 'user', content: { type: 'image', data: 'base64data', mimeType: 'image/png' } },
      ],
    }))

    const calls = (llm as ReturnType<typeof vi.fn>).mock.calls
    const messages = calls[0]?.[0] as Array<{ role: string; content: string }>
    expect(messages[0]).toEqual({ role: 'user', content: '[Image: image/png]' })
  })
})

describe('registerSamplingHandler', () => {
  it('registers handler on the correct method', () => {
    const onRequest = vi.fn()
    const handler = createSamplingHandler(createMockLLM())

    registerSamplingHandler(onRequest, handler)

    expect(onRequest).toHaveBeenCalledWith('sampling/createMessage', expect.any(Function))
  })

  it('registered handler invokes the sampling handler', async () => {
    let registeredHandler: ((params: unknown) => Promise<unknown>) | undefined
    const onRequest = vi.fn((method: string, h: (params: unknown) => Promise<unknown>) => {
      if (method === 'sampling/createMessage') {
        registeredHandler = h
      }
    })

    const llm = createMockLLM()
    const handler = createSamplingHandler(llm)
    registerSamplingHandler(onRequest, handler)

    expect(registeredHandler).toBeDefined()

    const result = await registeredHandler!(baseRequest()) as { role: string; content: { text: string } }
    expect(result.role).toBe('assistant')
    expect(result.content.text).toBe('LLM response')
  })

  it('unregister prevents further handler invocations', async () => {
    let registeredHandler: ((params: unknown) => Promise<unknown>) | undefined
    const onRequest = vi.fn((method: string, h: (params: unknown) => Promise<unknown>) => {
      if (method === 'sampling/createMessage') {
        registeredHandler = h
      }
    })

    const llm = createMockLLM()
    const handler = createSamplingHandler(llm)
    const reg = registerSamplingHandler(onRequest, handler)

    reg.unregister()

    await expect(registeredHandler!(baseRequest())).rejects.toThrow(
      /unregistered/,
    )
  })
})

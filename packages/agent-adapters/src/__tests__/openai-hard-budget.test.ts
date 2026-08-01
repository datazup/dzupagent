import { describe, expect, it, vi } from 'vitest'
import { OpenAIAdapter } from '../openai/openai-adapter.js'
import { collectEvents } from './test-helpers.js'
import {
  AdapterHardBudgetHostProfileRegistry,
  type AdapterHardBudgetEvaluation,
} from '../hard-budget.js'
import {
  FIXTURE_MODEL,
  fixtureBinding,
  fixtureRegistry,
} from './hard-budget-test-fixtures.js'

function sseResponse(): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode([
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
        'data: [DONE]',
        '',
      ].join('\n')))
      controller.close()
    },
  })
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body,
    text: () => Promise.resolve(''),
    headers: new Headers(),
  } as unknown as Response
}

describe('OpenAIAdapter hard-budget provider boundary', () => {
  it('binds the concrete model profile before opening streaming transport', async () => {
    const evaluations: AdapterHardBudgetEvaluation[] = []
    const fetchImpl = vi.fn().mockResolvedValue(sseResponse())
    const adapter = new OpenAIAdapter({
      apiKey: 'fixture-key',
      model: FIXTURE_MODEL,
      fetchImpl: fetchImpl as typeof fetch,
      hardBudget: {
        registry: fixtureRegistry(),
        binding: fixtureBinding(),
        onEvaluation: (evaluation) => evaluations.push(evaluation),
      },
    })

    const events = await collectEvents(adapter.execute({
      prompt: 'Use the fixture tool.',
      systemPrompt: 'Provider-free test only.',
      options: {
        tools: [{
          name: 'fixture_tool',
          description: 'Returns a provider-free fixture.',
          parameters: { type: 'object', properties: {} },
        }],
        tool_choice: 'auto',
      },
    }))

    expect(events.at(-1)).toMatchObject({
      type: 'adapter:completed',
      result: 'ok',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(evaluations).toHaveLength(1)
    expect(evaluations[0]).toMatchObject({
      accepted: true,
      model: FIXTURE_MODEL,
      toolReservedTokens: expect.any(Number),
      envelopeTokens: expect.any(Number),
    })
    expect(evaluations[0]!.toolReservedTokens).toBeGreaterThan(0)

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    const request = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(request).toMatchObject({
      model: FIXTURE_MODEL,
      messages: [
        { role: 'system', content: 'Provider-free test only.' },
        { role: 'user', content: 'Use the fixture tool.' },
      ],
      tool_choice: 'auto',
    })
    expect(request.tools).toEqual(expect.any(Array))
  })

  it('does not open transport when a streaming model profile is missing', async () => {
    const fetchImpl = vi.fn()
    const evaluations: AdapterHardBudgetEvaluation[] = []
    const adapter = new OpenAIAdapter({
      apiKey: 'fixture-key',
      model: FIXTURE_MODEL,
      fetchImpl: fetchImpl as typeof fetch,
      hardBudget: {
        registry: new AdapterHardBudgetHostProfileRegistry([]),
        binding: fixtureBinding(),
        onEvaluation: (evaluation) => evaluations.push(evaluation),
      },
    })

    const events = await collectEvents(adapter.execute({
      prompt: 'must not leave the process',
    }))
    expect(events.at(-1)).toMatchObject({
      type: 'adapter:failed',
      error: 'adapter hard-budget profile is missing',
    })
    expect(evaluations).toContainEqual(expect.objectContaining({
      accepted: false,
      code: 'profile_not_found',
    }))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('applies the same fail-closed gate to non-streaming run()', async () => {
    const fetchImpl = vi.fn()
    const adapter = new OpenAIAdapter({
      apiKey: 'fixture-key',
      model: FIXTURE_MODEL,
      fetchImpl: fetchImpl as typeof fetch,
      hardBudget: {
        registry: new AdapterHardBudgetHostProfileRegistry([]),
        binding: fixtureBinding(),
      },
    })

    await expect(adapter.run('must not leave the process')).rejects.toMatchObject({
      code: 'profile_not_found',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

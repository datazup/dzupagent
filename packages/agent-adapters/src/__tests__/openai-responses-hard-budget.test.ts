import { describe, expect, it, vi } from 'vitest'
import { OpenAIAdapter } from '../openai/openai-adapter.js'
import {
  OPENAI_RESPONSES_REQUEST_FORMAT_FINGERPRINT,
  OPENAI_RESPONSES_REQUEST_FORMAT_ID,
  OPENAI_RESPONSES_REQUEST_FORMAT_REVISION,
  buildOpenAIResponsesInputRequest,
  createOpenAIResponsesInputTokenProofBinding,
  defineOpenAIResponsesHardBudgetHostProfile,
  type AdapterHardBudgetEvaluation,
  type AdapterHardBudgetUsageReconciliation,
} from '../hard-budget.js'
import { collectEvents } from './test-helpers.js'
import {
  FIXTURE_MODEL,
  fixtureBinding,
  fixtureProofProfile,
  fixtureRegistry,
} from './hard-budget-test-fixtures.js'

const FIXED_NOW = Date.parse('2026-08-01T00:01:00.000Z')

function responsesBinding() {
  return fixtureBinding({
    requestFormatId: OPENAI_RESPONSES_REQUEST_FORMAT_ID,
    requestFormatRevision: OPENAI_RESPONSES_REQUEST_FORMAT_REVISION,
  })
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sseResponse(inputTokens: number): Response {
  return new Response([
    'data: {"type":"response.output_text.delta","delta":"ok"}',
    `data: {"type":"response.completed","response":{"usage":{"input_tokens":${inputTokens},"output_tokens":1}}}`,
    'data: [DONE]',
    '',
  ].join('\n'), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function rawSseResponse(lines: readonly string[]): Response {
  return new Response([...lines, 'data: [DONE]', ''].join('\n'), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

describe('OpenAI Responses exact hard-budget boundary', () => {
  it('binds operator-supplied limits to the exact Responses revisions', () => {
    const fixture = fixtureProofProfile()
    const profile = defineOpenAIResponsesHardBudgetHostProfile({
      schemaVersion: fixture.schemaVersion,
      id: fixture.id,
      revision: fixture.revision,
      model: fixture.model,
      contextWindowTokens: fixture.contextWindowTokens,
      reservedOutputTokens: fixture.reservedOutputTokens,
      reservedSummaryTokens: fixture.reservedSummaryTokens,
      tokenizer: fixture.tokenizer,
      modelSnapshot: fixture.modelSnapshot!,
      requestProofMaxAgeMs: fixture.requestProof!.maxAgeMs,
    })

    expect(profile).toMatchObject({
      provider: 'openai',
      requestFormat: {
        id: OPENAI_RESPONSES_REQUEST_FORMAT_ID,
        revision: OPENAI_RESPONSES_REQUEST_FORMAT_REVISION,
        fingerprint: OPENAI_RESPONSES_REQUEST_FORMAT_FINGERPRINT,
      },
      requestProof: { maxAgeMs: 5_000 },
    })
  })

  it('serializes golden tools and named tool choice deterministically', () => {
    const request = buildOpenAIResponsesInputRequest({
      provider: 'openai',
      model: FIXTURE_MODEL,
      messages: [
        { role: 'system', content: 'Keep it deterministic.' },
        { role: 'user', content: 'Look up the fixture.' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'lookup_fixture',
          description: 'Return the fixture.',
          parameters: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
          strict: true,
        },
      }],
      toolChoice: {
        type: 'function',
        function: { name: 'lookup_fixture' },
      },
    })

    expect(request).toEqual({
      model: FIXTURE_MODEL,
      input: [
        { role: 'system', content: 'Keep it deterministic.' },
        { role: 'user', content: 'Look up the fixture.' },
      ],
      tools: [{
        type: 'function',
        name: 'lookup_fixture',
        description: 'Return the fixture.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        strict: true,
      }],
      tool_choice: { type: 'function', name: 'lookup_fixture' },
    })
    expect(OPENAI_RESPONSES_REQUEST_FORMAT_FINGERPRINT)
      .toMatch(/^[a-f0-9]{64}$/)
  })

  it('counts, proves, sends, and reconciles the same token-relevant input', async () => {
    const evaluations: AdapterHardBudgetEvaluation[] = []
    const reconciliations: AdapterHardBudgetUsageReconciliation[] = []
    const fetchImpl = vi.fn(async (
      input: RequestInfo | URL,
      _init?: RequestInit,
    ) => {
      const url = String(input)
      if (url.endsWith('/responses/input_tokens')) return jsonResponse({ input_tokens: 123 })
      if (url.endsWith('/responses')) return sseResponse(123)
      throw new Error(`unexpected fixture URL: ${url}`)
    })
    const proof = createOpenAIResponsesInputTokenProofBinding({
      apiKey: 'fixture-key',
      fetchImpl: fetchImpl as typeof fetch,
      clock: () => FIXED_NOW,
    })
    const adapter = new OpenAIAdapter({
      apiKey: 'fixture-key',
      model: FIXTURE_MODEL,
      transport: 'responses',
      fetchImpl: fetchImpl as typeof fetch,
      hardBudget: {
        registry: fixtureRegistry([fixtureProofProfile()]),
        binding: responsesBinding(),
        requestProof: proof,
        clock: () => FIXED_NOW,
        onEvaluation: (evaluation) => evaluations.push(evaluation),
        onUsageReconciliation: (result) => reconciliations.push(result),
      },
    })

    const events = await collectEvents(adapter.execute({
      prompt: 'SENSITIVE-FIXTURE-PROMPT',
      systemPrompt: 'Provider-free test.',
      options: {
        tools: [{
          name: 'lookup_fixture',
          description: 'Return the fixture.',
          parameters: { type: 'object', properties: {} },
        }],
        tool_choice: 'auto',
      },
    }))

    expect(events.at(-1)).toMatchObject({
      type: 'adapter:completed',
      result: 'ok',
      usage: { inputTokens: 123, outputTokens: 1 },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const countInit = fetchImpl.mock.calls[0]![1]
    const createInit = fetchImpl.mock.calls[1]![1]
    expect(countInit).toBeDefined()
    expect(createInit).toBeDefined()
    const countBody = JSON.parse(String(countInit?.body)) as Record<string, unknown>
    const createBody = JSON.parse(String(createInit?.body)) as Record<string, unknown>
    expect(createBody).toEqual({ ...countBody, stream: true })
    expect(evaluations).toHaveLength(1)
    expect(evaluations[0]).toMatchObject({
      accepted: true,
      localMeasuredRequestTokens: expect.any(Number),
      providerMeasuredRequestTokens: 123,
      measuredRequestTokens: 123,
      requestFormatFingerprint: OPENAI_RESPONSES_REQUEST_FORMAT_FINGERPRINT,
      requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(reconciliations).toEqual([
      expect.objectContaining({
        preflightInputTokens: 123,
        responseInputTokens: 123,
        deltaTokens: 0,
        reconciled: true,
      }),
    ])
    expect(JSON.stringify({ evaluations, reconciliations }))
      .not.toContain('SENSITIVE-FIXTURE-PROMPT')
  })

  it('fails before either provider endpoint when the model snapshot is stale', async () => {
    const evaluations: AdapterHardBudgetEvaluation[] = []
    const fetchImpl = vi.fn()
    const staleNow = Date.parse('2026-09-01T00:00:00.000Z')
    const adapter = new OpenAIAdapter({
      apiKey: 'fixture-key',
      model: FIXTURE_MODEL,
      transport: 'responses',
      fetchImpl: fetchImpl as typeof fetch,
      hardBudget: {
        registry: fixtureRegistry([fixtureProofProfile()]),
        binding: responsesBinding(),
        requestProof: createOpenAIResponsesInputTokenProofBinding({
          apiKey: 'fixture-key',
          fetchImpl: fetchImpl as typeof fetch,
          clock: () => staleNow,
        }),
        clock: () => staleNow,
        onEvaluation: (evaluation) => evaluations.push(evaluation),
      },
    })

    const events = await collectEvents(adapter.execute({ prompt: 'fixture' }))

    expect(events.at(-1)).toMatchObject({
      type: 'adapter:failed',
      error: 'adapter hard-budget model snapshot has expired',
    })
    expect(evaluations).toContainEqual(expect.objectContaining({
      accepted: false,
      code: 'model_snapshot_stale',
    }))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('allows only the count endpoint when authoritative proof is over budget', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/responses/input_tokens')) {
        return jsonResponse({ input_tokens: 1_801 })
      }
      throw new Error('generation transport must stay closed')
    })
    const adapter = new OpenAIAdapter({
      apiKey: 'fixture-key',
      model: FIXTURE_MODEL,
      transport: 'responses',
      fetchImpl: fetchImpl as typeof fetch,
      hardBudget: {
        registry: fixtureRegistry([fixtureProofProfile()]),
        binding: responsesBinding(),
        requestProof: createOpenAIResponsesInputTokenProofBinding({
          apiKey: 'fixture-key',
          fetchImpl: fetchImpl as typeof fetch,
          clock: () => FIXED_NOW,
        }),
        clock: () => FIXED_NOW,
      },
    })

    const events = await collectEvents(adapter.execute({ prompt: 'fixture' }))

    expect(events.at(-1)).toMatchObject({
      type: 'adapter:failed',
      error: 'adapter request exceeds the provider input budget',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0]![0]))
      .toMatch(/\/responses\/input_tokens$/)
  })

  it('records response-usage drift without rewriting the provider result', async () => {
    const reconciliations: AdapterHardBudgetUsageReconciliation[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      return url.endsWith('/responses/input_tokens')
        ? jsonResponse({ input_tokens: 123 })
        : sseResponse(125)
    })
    const adapter = new OpenAIAdapter({
      apiKey: 'fixture-key',
      model: FIXTURE_MODEL,
      transport: 'responses',
      fetchImpl: fetchImpl as typeof fetch,
      hardBudget: {
        registry: fixtureRegistry([fixtureProofProfile()]),
        binding: responsesBinding(),
        requestProof: createOpenAIResponsesInputTokenProofBinding({
          apiKey: 'fixture-key',
          fetchImpl: fetchImpl as typeof fetch,
          clock: () => FIXED_NOW,
        }),
        clock: () => FIXED_NOW,
        usageReconciliationToleranceTokens: 1,
        onUsageReconciliation: (result) => reconciliations.push(result),
      },
    })

    const events = await collectEvents(adapter.execute({ prompt: 'fixture' }))

    expect(events.at(-1)).toMatchObject({
      type: 'adapter:completed',
      result: 'ok',
    })
    expect(reconciliations).toEqual([
      expect.objectContaining({
        preflightInputTokens: 123,
        responseInputTokens: 125,
        deltaTokens: 2,
        toleranceTokens: 1,
        reconciled: false,
        code: 'usage_mismatch',
      }),
    ])
  })

  it('keeps Responses transport opt-in for non-streaming callers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'response result' }],
      }],
      usage: { input_tokens: 9, output_tokens: 2 },
    }))
    const adapter = new OpenAIAdapter({
      apiKey: 'fixture-key',
      model: FIXTURE_MODEL,
      transport: 'responses',
      fetchImpl: fetchImpl as typeof fetch,
    })

    await expect(adapter.run('fixture')).resolves.toEqual({
      content: 'response result',
      usage: { inputTokens: 9, outputTokens: 2 },
    })
    expect(String(fetchImpl.mock.calls[0]![0])).toMatch(/\/responses$/)
    const body = JSON.parse(String(
      (fetchImpl.mock.calls[0]![1] as RequestInit).body,
    ))
    expect(body).toEqual({
      model: FIXTURE_MODEL,
      input: [{ role: 'user', content: 'fixture' }],
      stream: false,
    })
  })

  it('normalizes Responses function-call events into adapter tool calls', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(rawSseResponse([
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"lookup_fixture","arguments":""}}',
      'data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"id\\":\\"A\\"}"}',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call"}}',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":12,"output_tokens":3}}}',
    ]))
    const adapter = new OpenAIAdapter({
      apiKey: 'fixture-key',
      model: FIXTURE_MODEL,
      transport: 'responses',
      fetchImpl: fetchImpl as typeof fetch,
    })

    const events = await collectEvents(adapter.execute({ prompt: 'fixture' }))

    expect(events).toContainEqual(expect.objectContaining({
      type: 'adapter:tool_call',
      toolCallId: 'call_1',
      toolName: 'lookup_fixture',
      input: { id: 'A' },
    }))
    expect(events.at(-1)).toMatchObject({ type: 'adapter:completed' })
  })

  it('fails closed when a Responses stream lacks successful terminal truth', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(rawSseResponse([
      'data: {"type":"response.failed","response":{"status":"failed"}}',
    ]))
    const adapter = new OpenAIAdapter({
      apiKey: 'fixture-key',
      transport: 'responses',
      fetchImpl: fetchImpl as typeof fetch,
    })

    const events = await collectEvents(adapter.execute({ prompt: 'fixture' }))

    expect(events.map((event) => event.type)).toEqual([
      'adapter:started',
      'adapter:failed',
    ])
    expect(events.at(-1)).toMatchObject({
      type: 'adapter:failed',
      error: 'OpenAI Responses stream did not complete successfully',
    })
  })
})

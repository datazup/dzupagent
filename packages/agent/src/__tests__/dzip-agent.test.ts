/**
 * Unit tests for DzupAgent class (dzip-agent.ts).
 *
 * Covers: constructor, model resolution, asTool(), createChildBudget(),
 * generateStructured(), launch(), stream lifecycle, and configuration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { DzupAgent } from '../agent/dzip-agent.js'
import type { AgentStreamEvent, DzupAgentConfig } from '../agent/agent-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockModel(
  responses: AIMessage[],
  opts?: { withBindTools?: boolean; withStream?: boolean; withStructuredOutput?: boolean },
): BaseChatModel {
  let invokeIdx = 0
  let streamIdx = 0

  const model: Record<string, unknown> = {
    invoke: vi.fn(async (_msgs: BaseMessage[]) => {
      const resp = responses[invokeIdx] ?? responses.at(-1) ?? new AIMessage('done')
      invokeIdx++
      return resp
    }),
  }

  if (opts?.withBindTools !== false) {
    model.bindTools = vi.fn().mockReturnThis()
  }

  if (opts?.withStream !== false) {
    model.stream = vi.fn(async function* (_msgs: BaseMessage[]) {
      const resp = responses[streamIdx] ?? responses.at(-1) ?? new AIMessage('done')
      streamIdx++
      yield resp
    })
  }

  if (opts?.withStructuredOutput) {
    model.withStructuredOutput = vi.fn(() => ({
      invoke: vi.fn(async () => ({ answer: 42 })),
    }))
  }

  return model as unknown as BaseChatModel
}

function aiWithToolCalls(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  return new AIMessage({
    content: '',
    tool_calls: calls.map((c, i) => ({ id: `call_${i}`, name: c.name, args: c.args })),
  })
}

function minimalConfig(overrides: Partial<DzupAgentConfig> = {}): DzupAgentConfig {
  return {
    id: 'test-agent',
    instructions: 'You are a test agent.',
    model: createMockModel([new AIMessage('hello')]),
    ...overrides,
  }
}

async function collectStreamEvents(
  agent: DzupAgent,
  messages?: BaseMessage[],
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = []
  for await (const event of agent.stream(messages ?? [new HumanMessage('go')])) {
    events.push(event)
  }
  return events
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('DzupAgent constructor', () => {
  it('sets id, name, and description from config', () => {
    const agent = new DzupAgent(minimalConfig({
      id: 'my-agent',
      name: 'My Agent',
      description: 'Does things',
    }))
    expect(agent.id).toBe('my-agent')
    expect(agent.name).toBe('My Agent')
    expect(agent.description).toBe('Does things')
  })

  it('defaults name to id when name is not provided', () => {
    const agent = new DzupAgent(minimalConfig({ id: 'agent-x' }))
    expect(agent.name).toBe('agent-x')
  })

  it('defaults description when not provided', () => {
    const agent = new DzupAgent(minimalConfig({ id: 'agent-y', name: 'Agent Y' }))
    expect(agent.description).toBe('Agent: Agent Y')
  })

  it('exposes agentConfig as readonly copy', () => {
    const config = minimalConfig({ id: 'cfg-test' })
    const agent = new DzupAgent(config)
    expect(agent.agentConfig.id).toBe('cfg-test')
    expect(agent.agentConfig.instructions).toBe('You are a test agent.')
  })

  it('does not create mailbox when mailbox config is absent', () => {
    const agent = new DzupAgent(minimalConfig())
    expect(agent.mailbox).toBeUndefined()
  })

  it('creates mailbox when mailbox config is provided', () => {
    const agent = new DzupAgent(minimalConfig({ mailbox: {} }))
    expect(agent.mailbox).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

describe('DzupAgent model resolution', () => {
  it('uses BaseChatModel directly when model is not a string', () => {
    const model = createMockModel([new AIMessage('direct')])
    const agent = new DzupAgent(minimalConfig({ model }))
    // If no error thrown, model was resolved. Verify via generate.
    expect(agent.id).toBe('test-agent')
  })

  it('attaches explicit structured-output capabilities to a direct model instance', () => {
    const model = createMockModel([new AIMessage('direct')]) as BaseChatModel & {
      structuredOutputCapabilities?: {
        preferredStrategy: 'generic-parse'
        schemaProvider: 'generic'
        fallbackStrategies: ['fallback-prompt']
      }
    }

    new DzupAgent(minimalConfig({
      model,
      structuredOutputCapabilities: {
        preferredStrategy: 'generic-parse',
        schemaProvider: 'generic',
        fallbackStrategies: ['fallback-prompt'],
      },
    }))

    expect(model.structuredOutputCapabilities).toEqual({
      preferredStrategy: 'generic-parse',
      schemaProvider: 'generic',
      fallbackStrategies: ['fallback-prompt'],
    })
  })

  it('throws when model is a string but no registry is provided', () => {
    expect(() => {
      new DzupAgent(minimalConfig({ model: 'codegen', registry: undefined }))
    }).toThrow('no registry was provided')
  })

  it('resolves model tier string via registry.getModel', () => {
    const mockModel = createMockModel([new AIMessage('hi')])
    const registry = {
      getModel: vi.fn(() => mockModel),
      getModelByName: vi.fn(() => mockModel),
      getModelWithFallback: vi.fn(() => ({ model: mockModel, provider: 'test-provider' })),
      recordProviderSuccess: vi.fn(),
      recordProviderFailure: vi.fn(),
    }
    const agent = new DzupAgent(minimalConfig({
      model: 'chat',
      registry: registry as never,
    }))
    expect(registry.getModelWithFallback).toHaveBeenCalledWith('chat')
    expect(agent.id).toBe('test-agent')
  })

  it('resolves non-tier model string via registry.getModelByName', () => {
    const mockModel = createMockModel([new AIMessage('hi')])
    const registry = {
      getModel: vi.fn(() => mockModel),
      getModelByName: vi.fn(() => mockModel),
      getModelWithFallback: vi.fn(() => ({ model: mockModel, provider: 'test-provider' })),
      recordProviderSuccess: vi.fn(),
      recordProviderFailure: vi.fn(),
    }
    new DzupAgent(minimalConfig({
      model: 'gpt-4o',
      registry: registry as never,
    }))
    expect(registry.getModelByName).toHaveBeenCalledWith('gpt-4o')
  })

  it('recognizes all four model tier strings', () => {
    const mockModel = createMockModel([new AIMessage('hi')])
    const registry = {
      getModel: vi.fn(() => mockModel),
      getModelByName: vi.fn(() => mockModel),
      getModelWithFallback: vi.fn(() => ({ model: mockModel, provider: 'test-provider' })),
      recordProviderSuccess: vi.fn(),
      recordProviderFailure: vi.fn(),
    }

    for (const tier of ['chat', 'reasoning', 'codegen', 'embedding']) {
      new DzupAgent(minimalConfig({ model: tier, registry: registry as never }))
    }
    expect(registry.getModelWithFallback).toHaveBeenCalledTimes(4)
  })
})

// ---------------------------------------------------------------------------
// generate()
// ---------------------------------------------------------------------------

describe('DzupAgent generate()', () => {
  it('returns content from a simple LLM response', async () => {
    const model = createMockModel([new AIMessage('Hello world')])
    const agent = new DzupAgent(minimalConfig({ model }))
    const result = await agent.generate([new HumanMessage('Hi')])

    expect(result.content).toBe('Hello world')
    expect(result.stopReason).toBe('complete')
    expect(result.usage.llmCalls).toBeGreaterThanOrEqual(1)
  })

  it('executes tool calls and returns final response', async () => {
    const { z } = await import('zod')
    const { tool } = await import('@langchain/core/tools')

    const echoTool = tool(async ({ text }: { text: string }) => `echoed: ${text}`, {
      name: 'echo',
      description: 'echo',
      schema: z.object({ text: z.string() }),
    })

    const model = createMockModel([
      aiWithToolCalls([{ name: 'echo', args: { text: 'test' } }]),
      new AIMessage('Final answer'),
    ])

    const agent = new DzupAgent(minimalConfig({ model, tools: [echoTool] }))
    const result = await agent.generate([new HumanMessage('echo test')])

    expect(result.content).toBe('Final answer')
    expect(result.messages.some(
      m => m instanceof ToolMessage && typeof m.content === 'string' && m.content.includes('echoed: test'),
    )).toBe(true)
  })

  it('respects maxIterations option', async () => {
    const { z } = await import('zod')
    const { tool } = await import('@langchain/core/tools')

    const loopTool = tool(async () => 'looping', {
      name: 'loop',
      description: 'loop',
      schema: z.object({}),
    })

    // Model always returns tool calls, never stops
    const model = {
      invoke: vi.fn(async () => aiWithToolCalls([{ name: 'loop', args: {} }])),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(minimalConfig({ model, tools: [loopTool] }))
    const result = await agent.generate([new HumanMessage('go')], { maxIterations: 2 })

    expect(result.stopReason).toBe('iteration_limit')
    expect(result.hitIterationLimit).toBe(true)
  })

  it('supports abort signal', async () => {
    const controller = new AbortController()
    controller.abort()

    const model = createMockModel([new AIMessage('unreachable')])
    const agent = new DzupAgent(minimalConfig({ model }))
    const result = await agent.generate([new HumanMessage('go')], { signal: controller.signal })

    expect(result.stopReason).toBe('aborted')
  })
})

// ---------------------------------------------------------------------------
// generateStructured()
// ---------------------------------------------------------------------------

describe('DzupAgent generateStructured()', () => {
  it('parses JSON from LLM text response when withStructuredOutput is unavailable', async () => {
    const { z } = await import('zod')

    const model = createMockModel([
      new AIMessage('```json\n{"answer": 42}\n```'),
    ], { withStructuredOutput: false })
    const agent = new DzupAgent(minimalConfig({ model }))

    const schema = z.object({ answer: z.number() })
    const result = await agent.generateStructured([new HumanMessage('what is 6*7?')], schema)

    expect(result.data).toEqual({ answer: 42 })
    expect(result.usage.llmCalls).toBeGreaterThanOrEqual(1)
  })

  it('retries text JSON fallback with a correction prompt when parsing fails', async () => {
    const { z } = await import('zod')

    const model = createMockModel([
      new AIMessage('not valid json'),
      new AIMessage('{"answer": 42}'),
    ], { withStructuredOutput: false }) as BaseChatModel & {
      invoke: ReturnType<typeof vi.fn>
    }
    const agent = new DzupAgent(minimalConfig({ model }))

    const schema = z.object({ answer: z.number() })
    const result = await agent.generateStructured([new HumanMessage('what is 6*7?')], schema)

    expect(result.data).toEqual({ answer: 42 })
    expect(result.usage.llmCalls).toBe(2)
    expect(model.invoke).toHaveBeenCalledTimes(2)
  })

  it('uses withStructuredOutput when model supports it', async () => {
    const { z } = await import('zod')

    const model = createMockModel([new AIMessage('unused')], { withStructuredOutput: true })
    const agent = new DzupAgent(minimalConfig({ model }))

    const schema = z.object({ answer: z.number() })
    const result = await agent.generateStructured([new HumanMessage('what?')], schema)

    expect(result.data).toEqual({ answer: 42 })
  })

  it('falls back to text generation when native structured output rejects the schema', async () => {
    const { z } = await import('zod')

    const fallbackResponse = new AIMessage('{"answer": 42}')
    const model = createMockModel([fallbackResponse], { withStructuredOutput: true }) as BaseChatModel & {
      withStructuredOutput: ReturnType<typeof vi.fn>
      invoke: ReturnType<typeof vi.fn>
    }
    model.withStructuredOutput.mockReturnValue({
      invoke: vi.fn(async () => {
        throw new Error('Invalid schema for response_format')
      }),
    })

    const agent = new DzupAgent(minimalConfig({ model }))
    const schema = z.object({ answer: z.number() })
    const result = await agent.generateStructured([new HumanMessage('what?')], schema)

    expect(result.data).toEqual({ answer: 42 })
    expect(model.invoke).toHaveBeenCalledTimes(1)
  })

  it('skips native structured output when model capabilities declare prompt-json fallback only', async () => {
    const { z } = await import('zod')

    const model = createMockModel([
      new AIMessage('{"answer": 42}'),
    ], { withStructuredOutput: true }) as BaseChatModel & {
      withStructuredOutput: ReturnType<typeof vi.fn>
      invoke: ReturnType<typeof vi.fn>
      structuredOutputCapabilities?: {
        preferredStrategy: 'generic-parse'
        schemaProvider: 'generic'
        fallbackStrategies: ['fallback-prompt']
      }
    }
    model.structuredOutputCapabilities = {
      preferredStrategy: 'generic-parse',
      schemaProvider: 'generic',
      fallbackStrategies: ['fallback-prompt'],
    }

    const agent = new DzupAgent(minimalConfig({ model }))
    const schema = z.object({ answer: z.number() })
    const result = await agent.generateStructured([new HumanMessage('what?')], schema)

    expect(result.data).toEqual({ answer: 42 })
    expect(model.withStructuredOutput).not.toHaveBeenCalled()
    expect(model.invoke).toHaveBeenCalledTimes(1)
  })

  it('skips native structured output when direct-model config explicitly declares prompt-json fallback', async () => {
    const { z } = await import('zod')

    const model = createMockModel([
      new AIMessage('{"answer": 42}'),
    ], { withStructuredOutput: true }) as BaseChatModel & {
      withStructuredOutput: ReturnType<typeof vi.fn>
      invoke: ReturnType<typeof vi.fn>
    }

    const agent = new DzupAgent(minimalConfig({
      model,
      structuredOutputCapabilities: {
        preferredStrategy: 'generic-parse',
        schemaProvider: 'generic',
        fallbackStrategies: ['fallback-prompt'],
      },
    }))

    const schema = z.object({ answer: z.number() })
    const result = await agent.generateStructured([new HumanMessage('what?')], schema)

    expect(result.data).toEqual({ answer: 42 })
    expect(model.withStructuredOutput).not.toHaveBeenCalled()
    expect(model.invoke).toHaveBeenCalledTimes(1)
  })

  it('emits structured-output telemetry when native schema is rejected and fallback succeeds', async () => {
    const { z } = await import('zod')

    const fallbackResponse = new AIMessage('{"answer": 42}')
    const model = createMockModel([fallbackResponse], { withStructuredOutput: true }) as BaseChatModel & {
      withStructuredOutput: ReturnType<typeof vi.fn>
      invoke: ReturnType<typeof vi.fn>
    }
    model.withStructuredOutput.mockReturnValue({
      invoke: vi.fn(async () => {
        throw new Error('Invalid schema for response_format')
      }),
    })

    const eventBus = {
      emit: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      onAny: vi.fn(),
    }

    const agent = new DzupAgent(minimalConfig({
      model,
      eventBus: eventBus as never,
    }))
    const schema = z.object({ answer: z.number() })
    const result = await agent.generateStructured(
      [new HumanMessage('what?')],
      schema,
      { intent: 'generation:qa-answer', schemaName: 'test-agent.generation.qa.answer' },
    )

    expect(result.data).toEqual({ answer: 42 })
    expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent:structured_schema_prepared',
      agentId: 'test-agent',
      schemaName: 'test-agent.generation.qa.answer',
    }))
    expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent:structured_native_rejected',
      agentId: 'test-agent',
      schemaName: 'test-agent.generation.qa.answer',
      message: 'Invalid schema for response_format',
    }))
    expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent:structured_fallback_used',
      agentId: 'test-agent',
      schemaName: 'test-agent.generation.qa.answer',
      from: 'native_provider',
      to: 'text_json',
    }))
  })

  it('attaches structured-output diagnostics when fallback validation fails', async () => {
    const { z } = await import('zod')

    const model = createMockModel([new AIMessage('not json')], { withStructuredOutput: false })
    const eventBus = {
      emit: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      onAny: vi.fn(),
    }

    const agent = new DzupAgent(minimalConfig({
      model,
      eventBus: eventBus as never,
    }))
    const schema = z.object({ answer: z.number() })

    await expect(agent.generateStructured(
      [new HumanMessage('what?')],
      schema,
      { intent: 'generation:qa-answer', schemaName: 'test-agent.generation.qa.answer' },
    )).rejects.toMatchObject({
      agentId: 'test-agent',
      intent: 'generation:qa-answer',
      schemaName: 'test-agent.generation.qa.answer',
      provider: 'openai',
      model: 'unknown',
      failureCategory: 'parse_exhausted',
    })

    expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent:structured_validation_failed',
      agentId: 'test-agent',
      schemaName: 'test-agent.generation.qa.answer',
    }))
  })

  it('marks provider execution failures with an explicit structured-output failure category', async () => {
    const model = {
      invoke: vi.fn(async () => {
        throw new Error('provider timeout')
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(async function* () {}),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(minimalConfig({ model }))
    const { z } = await import('zod')

    await expect(agent.generateStructured(
      [new HumanMessage('what?')],
      z.object({ answer: z.number() }),
      { intent: 'generation:qa-answer', schemaName: 'test-agent.generation.qa.answer' },
    )).rejects.toMatchObject({
      failureCategory: 'provider_execution_failed',
      structuredOutput: {
        failureCategory: 'provider_execution_failed',
      },
    })
  })

  it('handles raw JSON (no code fence) in text response', async () => {
    const { z } = await import('zod')

    const model = createMockModel([
      new AIMessage('{"name": "test"}'),
    ], { withStructuredOutput: false })
    const agent = new DzupAgent(minimalConfig({ model }))

    const schema = z.object({ name: z.string() })
    const result = await agent.generateStructured([new HumanMessage('name?')], schema)

    expect(result.data).toEqual({ name: 'test' })
  })

  it('auto-wraps top-level array schemas and returns the unwrapped result', async () => {
    const { z } = await import('zod')

    const model = createMockModel([
      new AIMessage('{"result":[{"id":"REQ-1"},{"id":"REQ-2"}]}'),
    ], { withStructuredOutput: false })
    const agent = new DzupAgent(minimalConfig({ model }))

    const schema = z.array(z.object({ id: z.string() }))
    const result = await agent.generateStructured(
      [new HumanMessage('extract requirements')],
      schema,
      { intent: 'generation:requirement-extraction' },
    )

    expect(result.data).toEqual([{ id: 'REQ-1' }, { id: 'REQ-2' }])
  })

  it('uses envelope-aware schema naming and diagnostics for top-level array schemas', async () => {
    const { z } = await import('zod')

    const model = createMockModel([new AIMessage('not json')], { withStructuredOutput: false })
    const eventBus = {
      emit: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      onAny: vi.fn(),
    }

    const agent = new DzupAgent(minimalConfig({
      model,
      eventBus: eventBus as never,
    }))
    const schema = z.array(z.object({ id: z.string() }))

    await expect(agent.generateStructured(
      [new HumanMessage('extract requirements')],
      schema,
      { intent: 'generation:requirement-extraction' },
    )).rejects.toMatchObject({
      schemaName: 'test-agent.generation.requirement.extraction.envelope',
      structuredOutput: expect.objectContaining({
        requiresEnvelope: true,
      }),
    })

    expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'agent:structured_schema_prepared',
      schemaName: 'test-agent.generation.requirement.extraction.envelope',
    }))
  })
})

// ---------------------------------------------------------------------------
// asTool()
// ---------------------------------------------------------------------------

describe('DzupAgent asTool()', () => {
  it('returns a StructuredToolInterface with correct name and description', async () => {
    const model = createMockModel([new AIMessage('tool result')])
    const agent = new DzupAgent(minimalConfig({
      model,
      id: 'specialist',
      description: 'A specialist agent',
    }))

    const agentTool = await agent.asTool()
    expect(agentTool.name).toBe('agent-specialist')
    expect(agentTool.description).toBe('A specialist agent')
  })

  it('invokes the agent and returns content when called', async () => {
    const model = createMockModel([new AIMessage('tool output text')])
    const agent = new DzupAgent(minimalConfig({ model, id: 'worker' }))

    const agentTool = await agent.asTool()
    const result = await agentTool.invoke({ task: 'do something' })
    expect(result).toBe('tool output text')
  })

  it('appends context to the task message when provided', async () => {
    let capturedMessages: BaseMessage[] = []
    const model = {
      invoke: vi.fn(async (msgs: BaseMessage[]) => {
        capturedMessages = msgs
        return new AIMessage('with context')
      }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(minimalConfig({ model, id: 'ctx-agent' }))
    const agentTool = await agent.asTool()
    await agentTool.invoke({ task: 'analyze', context: 'extra info' })

    // The human message should contain both task and context
    const humanMsg = capturedMessages.find(m => m._getType() === 'human')
    expect(humanMsg).toBeDefined()
    expect(typeof humanMsg!.content === 'string' && humanMsg!.content).toContain('analyze')
    expect(typeof humanMsg!.content === 'string' && humanMsg!.content).toContain('extra info')
  })
})

// ---------------------------------------------------------------------------
// createChildBudget()
// ---------------------------------------------------------------------------

describe('DzupAgent createChildBudget()', () => {
  it('returns undefined when no guardrails are configured', () => {
    const agent = new DzupAgent(minimalConfig())
    expect(agent.createChildBudget()).toBeUndefined()
  })

  it('returns an IterationBudget when guardrails are configured', () => {
    const agent = new DzupAgent(minimalConfig({
      guardrails: { maxTokens: 10000 },
    }))
    const child = agent.createChildBudget()
    expect(child).toBeDefined()
    expect(child!.getState().totalInputTokens).toBe(0)
  })

  it('forked budget shares configuration with parent', () => {
    const agent = new DzupAgent(minimalConfig({
      guardrails: { maxTokens: 5000, maxCostCents: 10 },
    }))
    const child = agent.createChildBudget()
    expect(child).toBeDefined()
    // Both should have same limits - verify by checking isExceeded with no usage
    const check = child!.isExceeded()
    expect(check.exceeded).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// launch()
// ---------------------------------------------------------------------------

describe('DzupAgent launch()', () => {
  it('returns a RunHandle immediately with running status', async () => {
    const model = createMockModel([new AIMessage('launched result')])
    const agent = new DzupAgent(minimalConfig({ model }))

    const handle = await agent.launch([new HumanMessage('go')])

    expect(handle.runId).toBeDefined()
    expect(typeof handle.runId).toBe('string')
    // Status should be running at launch time
    expect(handle.currentStatus).toBe('running')
  })

  it('uses provided runId when given', async () => {
    const model = createMockModel([new AIMessage('ok')])
    const agent = new DzupAgent(minimalConfig({ model }))

    const handle = await agent.launch([new HumanMessage('go')], { runId: 'custom-run-123' })
    expect(handle.runId).toBe('custom-run-123')
  })

  it('resolves result() with completed output', async () => {
    const model = createMockModel([new AIMessage('final output')])
    const agent = new DzupAgent(minimalConfig({ model }))

    const handle = await agent.launch([new HumanMessage('go')])
    const result = await handle.result()

    expect(result.status).toBe('completed')
    expect(result.output).toBe('final output')
  })

  it('resolves result() with failed status on error', async () => {
    const model = {
      invoke: vi.fn(async () => { throw new Error('model crashed') }),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(minimalConfig({ model }))
    const handle = await agent.launch([new HumanMessage('go')])
    const result = await handle.result()

    expect(result.status).toBe('failed')
    expect(result.error).toContain('model crashed')
  })
})

// ---------------------------------------------------------------------------
// stream()
// ---------------------------------------------------------------------------

describe('DzupAgent stream()', () => {
  it('yields text and done events for simple response', async () => {
    const model = createMockModel([new AIMessage('streamed text')])
    const agent = new DzupAgent(minimalConfig({ model }))

    const events = await collectStreamEvents(agent)

    const textEvents = events.filter(e => e.type === 'text')
    const doneEvents = events.filter(e => e.type === 'done')

    expect(textEvents.length).toBeGreaterThanOrEqual(1)
    expect(doneEvents).toHaveLength(1)
    expect(doneEvents[0]!.data.stopReason).toBe('complete')
  })

  it('yields tool_call and tool_result events during tool execution', async () => {
    const { z } = await import('zod')
    const { tool } = await import('@langchain/core/tools')

    const echoTool = tool(async () => 'echo-result', {
      name: 'echo',
      description: 'echo',
      schema: z.object({ text: z.string() }),
    })

    const model = createMockModel([
      aiWithToolCalls([{ name: 'echo', args: { text: 'hi' } }]),
      new AIMessage('Final'),
    ])

    const agent = new DzupAgent(minimalConfig({ model, tools: [echoTool] }))
    const events = await collectStreamEvents(agent)

    const toolCallEvents = events.filter(e => e.type === 'tool_call')
    const toolResultEvents = events.filter(e => e.type === 'tool_result')

    expect(toolCallEvents.length).toBeGreaterThanOrEqual(1)
    expect(toolCallEvents[0]!.data.name).toBe('echo')
    expect(toolResultEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('yields done with aborted stopReason when signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const model = createMockModel([new AIMessage('unreachable')])
    const agent = new DzupAgent(minimalConfig({ model }))

    const events: AgentStreamEvent[] = []
    for await (const event of agent.stream([new HumanMessage('go')], { signal: controller.signal })) {
      events.push(event)
    }

    const doneEvent = events.find(e => e.type === 'done')
    expect(doneEvent?.data.stopReason).toBe('aborted')
  })

  it('falls back to generate path when model lacks stream method', async () => {
    const model = createMockModel([new AIMessage('fallback')], { withStream: false })

    // Remove stream from model to trigger fallback
    delete (model as Record<string, unknown>).stream

    const agent = new DzupAgent(minimalConfig({ model }))
    const events = await collectStreamEvents(agent)

    const doneEvent = events.findLast(e => e.type === 'done')
    expect(doneEvent?.data.stopReason).toBe('complete')
    expect(doneEvent?.data.content).toBe('fallback')
  })

  it('falls back to generate path when middleware uses wrapModelCall', async () => {
    const model = createMockModel([new AIMessage('unused')])
    const agent = new DzupAgent(minimalConfig({
      model,
      middleware: [{
        name: 'custom-invoke',
        wrapModelCall: async () => new AIMessage('wrapped'),
      }],
    }))

    const events = await collectStreamEvents(agent)

    const doneEvent = events.findLast(e => e.type === 'done')
    expect(doneEvent?.data.content).toBe('wrapped')
    expect(doneEvent?.data.stopReason).toBe('complete')
  })

  it('yields budget_warning events when budget thresholds are crossed', async () => {
    const { z } = await import('zod')
    const { tool } = await import('@langchain/core/tools')

    const workTool = tool(async () => 'ok', {
      name: 'work',
      description: 'work',
      schema: z.object({}),
    })

    // Create model with high token usage to trigger budget warnings
    let callCount = 0
    const model = {
      invoke: vi.fn(),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(async function* () {
        callCount++
        const msg = callCount <= 2
          ? aiWithToolCalls([{ name: 'work', args: {} }])
          : new AIMessage('done')
        // Attach usage metadata
        ;(msg as AIMessage & { usage_metadata: unknown }).usage_metadata = {
          input_tokens: 400,
          output_tokens: 100,
        }
        yield msg
      }),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(minimalConfig({
      model,
      tools: [workTool],
      guardrails: { maxTokens: 1000, budgetWarnings: [0.5] },
    }))

    const events = await collectStreamEvents(agent)
    const budgetWarnings = events.filter(e => e.type === 'budget_warning')

    // At 500 tokens used (after first iteration), should cross 0.5 threshold
    expect(budgetWarnings.length).toBeGreaterThanOrEqual(1)
  })

  it('yields iteration_limit done event when maxIterations reached', async () => {
    const { z } = await import('zod')
    const { tool } = await import('@langchain/core/tools')

    const stepTool = tool(async () => 'ok', {
      name: 'step',
      description: 'step',
      schema: z.object({}),
    })

    const model = {
      invoke: vi.fn(),
      bindTools: vi.fn().mockReturnThis(),
      stream: vi.fn(async function* () {
        yield aiWithToolCalls([{ name: 'step', args: {} }])
      }),
    } as unknown as BaseChatModel

    const agent = new DzupAgent(minimalConfig({ model, tools: [stepTool] }))
    const events: AgentStreamEvent[] = []
    for await (const event of agent.stream([new HumanMessage('go')], { maxIterations: 2 })) {
      events.push(event)
    }

    const doneEvent = events.findLast(e => e.type === 'done')
    expect(doneEvent?.data.stopReason).toBe('iteration_limit')
    expect(doneEvent?.data.hitIterationLimit).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Event bus integration
// ---------------------------------------------------------------------------

describe('DzupAgent event bus integration', () => {
  it('emits tool:latency events via eventBus during streaming', async () => {
    const { z } = await import('zod')
    const { tool } = await import('@langchain/core/tools')

    const emittedEvents: unknown[] = []
    const eventBus = {
      emit: vi.fn((e: unknown) => emittedEvents.push(e)),
      on: vi.fn(),
      off: vi.fn(),
    }

    const echoTool = tool(async () => 'result', {
      name: 'echo',
      description: 'echo',
      schema: z.object({}),
    })

    const model = createMockModel([
      aiWithToolCalls([{ name: 'echo', args: {} }]),
      new AIMessage('done'),
    ])

    const agent = new DzupAgent(minimalConfig({
      model,
      tools: [echoTool],
      eventBus: eventBus as never,
    }))

    await collectStreamEvents(agent)

    const latencyEvents = emittedEvents.filter(
      (e: unknown) => (e as Record<string, unknown>).type === 'tool:latency',
    )
    expect(latencyEvents.length).toBeGreaterThanOrEqual(1)
  })
})

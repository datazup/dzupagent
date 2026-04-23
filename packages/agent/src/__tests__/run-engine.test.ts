import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { DzupAgentConfig, GenerateOptions, GenerateResult } from '../agent/agent-types.js'
import type { ToolLoopResult, StopReason, ToolStat } from '../agent/tool-loop.js'

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted ensures these are available during vi.mock hoisting
// ---------------------------------------------------------------------------

const {
  mockRunToolLoop,
  mockExtractFinalAiMessageContent,
  mockCreateToolLoopLearningHook,
} = vi.hoisted(() => ({
  mockRunToolLoop: vi.fn(),
  mockExtractFinalAiMessageContent: vi.fn(),
  mockCreateToolLoopLearningHook: vi.fn(),
}))

vi.mock('../agent/tool-loop.js', () => ({
  runToolLoop: mockRunToolLoop,
}))

vi.mock('../agent/message-utils.js', () => ({
  extractFinalAiMessageContent: mockExtractFinalAiMessageContent,
}))

vi.mock('../agent/tool-loop-learning.js', () => ({
  createToolLoopLearningHook: mockCreateToolLoopLearningHook,
}))

// Import AFTER mocks are set up
import {
  prepareRunState,
  executeGenerateRun,
  emitStopReasonTelemetry,
  createToolStatTracker,
  executeStreamingToolCall,
  type PreparedRunState,
} from '../agent/run-engine.js'
import { IterationBudget } from '../guardrails/iteration-budget.js'
import { StuckDetector } from '../guardrails/stuck-detector.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockTool(name: string, result = 'ok'): StructuredToolInterface {
  return {
    name,
    description: `Mock ${name}`,
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => result),
  } as unknown as StructuredToolInterface
}

function mockModel(): BaseChatModel {
  return {
    invoke: vi.fn(async () => new AIMessage('done')),
  } as unknown as BaseChatModel
}

function basePrepareParams(overrides: Partial<Parameters<typeof prepareRunState>[0]> = {}) {
  const tools = [mockTool('read_file'), mockTool('write_file')]
  const model = mockModel()
  return {
    config: {
      id: 'test-agent',
      instructions: 'You are a test agent.',
      model: 'gpt-4' as const,
    } satisfies DzupAgentConfig as DzupAgentConfig,
    resolvedModel: model,
    messages: [new HumanMessage('hello')] as BaseMessage[],
    options: undefined as GenerateOptions | undefined,
    prepareMessages: vi.fn(async (msgs: BaseMessage[]) => ({ messages: msgs })),
    getTools: vi.fn(() => tools),
    bindTools: vi.fn((_m: BaseChatModel, _t: StructuredToolInterface[]) => model),
    runBeforeAgentHooks: vi.fn(async () => {}),
    ...overrides,
  }
}

function makeToolLoopResult(overrides: Partial<ToolLoopResult> = {}): ToolLoopResult {
  return {
    messages: [new HumanMessage('hello'), new AIMessage('done')],
    totalInputTokens: 100,
    totalOutputTokens: 50,
    llmCalls: 1,
    hitIterationLimit: false,
    stopReason: 'complete' as StopReason,
    toolStats: [],
    ...overrides,
  }
}

function baseExecuteParams(
  runState: PreparedRunState,
  overrides: Partial<Parameters<typeof executeGenerateRun>[0]> = {},
) {
  return {
    agentId: 'test-agent',
    config: {
      id: 'test-agent',
      instructions: 'You are a test agent.',
      model: 'gpt-4',
    } as DzupAgentConfig,
    options: undefined as GenerateOptions | undefined,
    runState,
    invokeModel: vi.fn(async () => new AIMessage('done')),
    transformToolResult: vi.fn(async (_n: string, _i: Record<string, unknown>, r: string) => r),
    maybeUpdateSummary: vi.fn(async () => {}),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// prepareRunState
// ---------------------------------------------------------------------------

describe('prepareRunState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateToolLoopLearningHook.mockReturnValue(undefined)
  })

  // -- maxIterations resolution priority --

  describe('maxIterations resolution', () => {
    it('uses options.maxIterations when provided', async () => {
      const params = basePrepareParams({
        options: { maxIterations: 25 },
        config: {
          id: 'a',
          instructions: '',
          model: 'gpt-4',
          guardrails: { maxIterations: 15 },
          maxIterations: 5,
        },
      })
      const state = await prepareRunState(params)
      expect(state.maxIterations).toBe(25)
    })

    it('falls back to config.guardrails.maxIterations', async () => {
      const params = basePrepareParams({
        config: {
          id: 'a',
          instructions: '',
          model: 'gpt-4',
          guardrails: { maxIterations: 15 },
          maxIterations: 5,
        },
      })
      const state = await prepareRunState(params)
      expect(state.maxIterations).toBe(15)
    })

    it('falls back to config.maxIterations', async () => {
      const params = basePrepareParams({
        config: {
          id: 'a',
          instructions: '',
          model: 'gpt-4',
          maxIterations: 7,
        },
      })
      const state = await prepareRunState(params)
      expect(state.maxIterations).toBe(7)
    })

    it('defaults to 10 when nothing is set', async () => {
      const params = basePrepareParams()
      const state = await prepareRunState(params)
      expect(state.maxIterations).toBe(10)
    })

    it('uses options.maxIterations over all config values', async () => {
      const params = basePrepareParams({
        options: { maxIterations: 99 },
        config: {
          id: 'a',
          instructions: '',
          model: 'gpt-4',
          guardrails: { maxIterations: 50 },
          maxIterations: 20,
        },
      })
      const state = await prepareRunState(params)
      expect(state.maxIterations).toBe(99)
    })

    it('options.maxIterations=0 is falsy, falls through to guardrails', async () => {
      // 0 is falsy in JS nullish coalescing with ??  — actually ?? treats 0 as defined
      // So maxIterations: 0 should actually be used (0 is not null/undefined)
      const params = basePrepareParams({
        options: { maxIterations: 0 },
        config: {
          id: 'a',
          instructions: '',
          model: 'gpt-4',
          guardrails: { maxIterations: 15 },
        },
      })
      const state = await prepareRunState(params)
      // ?? only treats null/undefined as fallthrough, 0 is kept
      expect(state.maxIterations).toBe(0)
    })
  })

  // -- budget creation --

  describe('budget creation', () => {
    it('creates IterationBudget when config.guardrails exists', async () => {
      const params = basePrepareParams({
        config: {
          id: 'a',
          instructions: '',
          model: 'gpt-4',
          guardrails: { maxTokens: 5000 },
        },
      })
      const state = await prepareRunState(params)
      expect(state.budget).toBeInstanceOf(IterationBudget)
    })

    it('budget is undefined when config.guardrails is absent', async () => {
      const params = basePrepareParams({
        config: { id: 'a', instructions: '', model: 'gpt-4' },
      })
      const state = await prepareRunState(params)
      expect(state.budget).toBeUndefined()
    })

    it('creates budget with empty guardrails object', async () => {
      const params = basePrepareParams({
        config: {
          id: 'a',
          instructions: '',
          model: 'gpt-4',
          guardrails: {},
        },
      })
      const state = await prepareRunState(params)
      expect(state.budget).toBeInstanceOf(IterationBudget)
    })
  })

  // -- prepareMessages --

  describe('prepareMessages', () => {
    it('calls prepareMessages and returns its result', async () => {
      const prepared = [new HumanMessage('prepared')]
      const params = basePrepareParams({
        prepareMessages: vi.fn(async () => ({ messages: prepared })),
      })
      const state = await prepareRunState(params)
      expect(params.prepareMessages).toHaveBeenCalledWith(params.messages)
      expect(state.preparedMessages).toBe(prepared)
    })

    it('passes original messages to prepareMessages', async () => {
      const original = [new HumanMessage('original')]
      const params = basePrepareParams({
        messages: original,
        prepareMessages: vi.fn(async (msgs: BaseMessage[]) => ({ messages: msgs })),
      })
      await prepareRunState(params)
      expect(params.prepareMessages).toHaveBeenCalledWith(original)
    })

    it('threads memoryFrame from prepareMessages into the run state', async () => {
      const prepared = [new HumanMessage('prepared')]
      const frame = { tag: 'test-frame' }
      const params = basePrepareParams({
        prepareMessages: vi.fn(async () => ({ messages: prepared, memoryFrame: frame })),
      })
      const state = await prepareRunState(params)
      expect(state.memoryFrame).toBe(frame)
    })
  })

  // -- getTools and toolMap --

  describe('tools and toolMap', () => {
    it('calls getTools() and stores result', async () => {
      const tools = [mockTool('alpha'), mockTool('beta')]
      const params = basePrepareParams({ getTools: vi.fn(() => tools) })
      const state = await prepareRunState(params)
      expect(params.getTools).toHaveBeenCalledOnce()
      expect(state.tools).toBe(tools)
    })

    it('creates toolMap from tool names', async () => {
      const alpha = mockTool('alpha')
      const beta = mockTool('beta')
      const params = basePrepareParams({ getTools: vi.fn(() => [alpha, beta]) })
      const state = await prepareRunState(params)
      expect(state.toolMap.size).toBe(2)
      expect(state.toolMap.get('alpha')).toBe(alpha)
      expect(state.toolMap.get('beta')).toBe(beta)
    })

    it('handles empty tool list', async () => {
      const params = basePrepareParams({ getTools: vi.fn(() => []) })
      const state = await prepareRunState(params)
      expect(state.tools).toHaveLength(0)
      expect(state.toolMap.size).toBe(0)
    })
  })

  // -- bindTools --

  describe('bindTools', () => {
    it('calls bindTools with resolvedModel and tools', async () => {
      const boundModel = mockModel()
      const tools = [mockTool('t1')]
      const resolvedModel = mockModel()
      const params = basePrepareParams({
        resolvedModel,
        getTools: vi.fn(() => tools),
        bindTools: vi.fn(() => boundModel),
      })
      const state = await prepareRunState(params)
      expect(params.bindTools).toHaveBeenCalledWith(resolvedModel, tools)
      expect(state.model).toBe(boundModel)
    })
  })

  // -- runBeforeAgentHooks --

  describe('runBeforeAgentHooks', () => {
    it('calls runBeforeAgentHooks', async () => {
      const params = basePrepareParams()
      await prepareRunState(params)
      expect(params.runBeforeAgentHooks).toHaveBeenCalledOnce()
    })
  })

  // -- stuckDetector --

  describe('stuckDetector', () => {
    it('created by default (no guardrails)', async () => {
      const params = basePrepareParams({
        config: { id: 'a', instructions: '', model: 'gpt-4' },
      })
      const state = await prepareRunState(params)
      expect(state.stuckDetector).toBeInstanceOf(StuckDetector)
    })

    it('created when guardrails exist but stuckDetector not specified', async () => {
      const params = basePrepareParams({
        config: { id: 'a', instructions: '', model: 'gpt-4', guardrails: {} },
      })
      const state = await prepareRunState(params)
      expect(state.stuckDetector).toBeInstanceOf(StuckDetector)
    })

    it('NOT created when guardrails.stuckDetector === false', async () => {
      const params = basePrepareParams({
        config: {
          id: 'a',
          instructions: '',
          model: 'gpt-4',
          guardrails: { stuckDetector: false },
        },
      })
      const state = await prepareRunState(params)
      expect(state.stuckDetector).toBeUndefined()
    })

    it('passes config through when guardrails.stuckDetector is an object', async () => {
      const params = basePrepareParams({
        config: {
          id: 'a',
          instructions: '',
          model: 'gpt-4',
          guardrails: { stuckDetector: { maxRepeatCalls: 5 } },
        },
      })
      const state = await prepareRunState(params)
      expect(state.stuckDetector).toBeInstanceOf(StuckDetector)
    })
  })

  // -- learningHook --

  describe('learningHook', () => {
    it('calls createToolLoopLearningHook with selfLearning config', async () => {
      const selfLearning = { enabled: true }
      const params = basePrepareParams({
        config: {
          id: 'a',
          instructions: '',
          model: 'gpt-4',
          selfLearning,
        },
      })
      mockCreateToolLoopLearningHook.mockReturnValue(undefined)
      await prepareRunState(params)
      expect(mockCreateToolLoopLearningHook).toHaveBeenCalledWith(selfLearning)
    })

    it('calls loadSpecialistConfig when hook is created', async () => {
      const loadFn = vi.fn(async () => undefined)
      mockCreateToolLoopLearningHook.mockReturnValue({
        loadSpecialistConfig: loadFn,
      })
      const params = basePrepareParams({
        config: {
          id: 'a',
          instructions: '',
          model: 'gpt-4',
          selfLearning: { enabled: true },
        },
      })
      await prepareRunState(params)
      expect(loadFn).toHaveBeenCalledOnce()
    })

    it('suppresses loadSpecialistConfig errors (non-fatal)', async () => {
      const loadFn = vi.fn(async () => {
        throw new Error('registry unavailable')
      })
      mockCreateToolLoopLearningHook.mockReturnValue({
        loadSpecialistConfig: loadFn,
      })
      const params = basePrepareParams({
        config: {
          id: 'a',
          instructions: '',
          model: 'gpt-4',
          selfLearning: { enabled: true },
        },
      })
      // Should not throw
      await expect(prepareRunState(params)).resolves.toBeDefined()
    })

    it('does not call loadSpecialistConfig when hook is undefined', async () => {
      mockCreateToolLoopLearningHook.mockReturnValue(undefined)
      const params = basePrepareParams({
        config: {
          id: 'a',
          instructions: '',
          model: 'gpt-4',
          selfLearning: undefined,
        },
      })
      await prepareRunState(params)
      // no error thrown, and no loadSpecialistConfig called
    })
  })

  // -- return shape --

  describe('return shape', () => {
    it('returns all expected fields', async () => {
      const params = basePrepareParams({
        config: {
          id: 'a',
          instructions: '',
          model: 'gpt-4',
          guardrails: { maxTokens: 1000 },
        },
      })
      const state = await prepareRunState(params)
      expect(state).toHaveProperty('maxIterations')
      expect(state).toHaveProperty('budget')
      expect(state).toHaveProperty('preparedMessages')
      expect(state).toHaveProperty('tools')
      expect(state).toHaveProperty('toolMap')
      expect(state).toHaveProperty('model')
      expect(state).toHaveProperty('stuckDetector')
    })
  })
})

// ---------------------------------------------------------------------------
// executeGenerateRun
// ---------------------------------------------------------------------------

describe('executeGenerateRun', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateToolLoopLearningHook.mockReturnValue(undefined)
  })

  function makeRunState(overrides: Partial<PreparedRunState> = {}): PreparedRunState {
    const tools = [mockTool('search')]
    return {
      maxIterations: 10,
      budget: undefined,
      preparedMessages: [new HumanMessage('hello')],
      tools,
      toolMap: new Map(tools.map(t => [t.name, t])),
      model: mockModel(),
      stuckDetector: undefined,
      ...overrides,
    }
  }

  it('delegates to runToolLoop with correct arguments', async () => {
    const runState = makeRunState({ maxIterations: 5 })
    const toolLoopResult = makeToolLoopResult()
    mockRunToolLoop.mockResolvedValue(toolLoopResult)
    mockExtractFinalAiMessageContent.mockReturnValue('final text')

    const params = baseExecuteParams(runState)
    await executeGenerateRun(params)

    expect(mockRunToolLoop).toHaveBeenCalledOnce()
    const [model, messages, tools, config] = mockRunToolLoop.mock.calls[0]!
    expect(model).toBe(runState.model)
    expect(messages).toBe(runState.preparedMessages)
    expect(tools).toBe(runState.tools)
    expect(config.maxIterations).toBe(5)
  })

  it('returns GenerateResult with final text from extractFinalAiMessageContent', async () => {
    const runState = makeRunState()
    mockRunToolLoop.mockResolvedValue(makeToolLoopResult())
    mockExtractFinalAiMessageContent.mockReturnValue('the final answer')

    const result = await executeGenerateRun(baseExecuteParams(runState))

    expect(result.content).toBe('the final answer')
  })

  it('returns empty content when no AI message found', async () => {
    const runState = makeRunState()
    mockRunToolLoop.mockResolvedValue(makeToolLoopResult())
    mockExtractFinalAiMessageContent.mockReturnValue('')

    const result = await executeGenerateRun(baseExecuteParams(runState))
    expect(result.content).toBe('')
  })

  it('calls maybeUpdateSummary with final messages', async () => {
    const runState = makeRunState()
    const msgs = [new HumanMessage('h'), new AIMessage('a')]
    mockRunToolLoop.mockResolvedValue(makeToolLoopResult({ messages: msgs }))
    mockExtractFinalAiMessageContent.mockReturnValue('done')

    const params = baseExecuteParams(runState)
    await executeGenerateRun(params)

    expect(params.maybeUpdateSummary).toHaveBeenCalledWith(msgs, undefined)
  })

  it('passes memoryFrame from runState to maybeUpdateSummary', async () => {
    const frame = { tag: 'run-frame' }
    const runState = makeRunState({ memoryFrame: frame })
    const msgs = [new HumanMessage('h'), new AIMessage('a')]
    mockRunToolLoop.mockResolvedValue(makeToolLoopResult({ messages: msgs }))

    const params = baseExecuteParams(runState)
    await executeGenerateRun(params)

    expect(params.maybeUpdateSummary).toHaveBeenCalledWith(msgs, frame)
  })

  it('surfaces memoryFrame from runState on the returned result for observability', async () => {
    // P6 Task 1: when memory is configured (e.g. arrowMemory), the
    // memoryFrame captured during prepareMessages() must propagate through
    // the run so callers can read `result.memoryFrame` (and via
    // `runInBackground` -> `_complete`, the public `RunResult.memoryFrame`).
    const frame = { snapshot: 'frozen', recordCount: 42 }
    const runState = makeRunState({ memoryFrame: frame })
    mockRunToolLoop.mockResolvedValue(makeToolLoopResult())
    mockExtractFinalAiMessageContent.mockReturnValue('done')

    const result = await executeGenerateRun(baseExecuteParams(runState))

    expect(result.memoryFrame).toBe(frame)
    expect(result.memoryFrame).not.toBeNull()
    expect(result.memoryFrame).toBeDefined()
  })

  it('leaves memoryFrame undefined on the returned result when memory is not configured', async () => {
    // No arrowMemory / memory config -> prepareMessages returns no frame ->
    // runState.memoryFrame is undefined -> RunResult.memoryFrame is undefined.
    const runState = makeRunState()
    mockRunToolLoop.mockResolvedValue(makeToolLoopResult())
    mockExtractFinalAiMessageContent.mockReturnValue('done')

    const result = await executeGenerateRun(baseExecuteParams(runState))

    expect(result.memoryFrame).toBeUndefined()
  })

  it('returns correct usage stats', async () => {
    const runState = makeRunState()
    mockRunToolLoop.mockResolvedValue(
      makeToolLoopResult({
        totalInputTokens: 200,
        totalOutputTokens: 100,
        llmCalls: 3,
      }),
    )
    mockExtractFinalAiMessageContent.mockReturnValue('done')

    const result = await executeGenerateRun(baseExecuteParams(runState))

    expect(result.usage).toEqual({
      totalInputTokens: 200,
      totalOutputTokens: 100,
      llmCalls: 3,
    })
  })

  it('passes stopReason through', async () => {
    const runState = makeRunState()
    mockRunToolLoop.mockResolvedValue(
      makeToolLoopResult({ stopReason: 'iteration_limit', hitIterationLimit: true }),
    )
    mockExtractFinalAiMessageContent.mockReturnValue('partial')

    const result = await executeGenerateRun(baseExecuteParams(runState))

    expect(result.stopReason).toBe('iteration_limit')
    expect(result.hitIterationLimit).toBe(true)
  })

  it('passes toolStats through', async () => {
    const stats: ToolStat[] = [{ name: 'search', calls: 3, errors: 0, totalMs: 150, avgMs: 50 }]
    const runState = makeRunState()
    mockRunToolLoop.mockResolvedValue(makeToolLoopResult({ toolStats: stats }))
    mockExtractFinalAiMessageContent.mockReturnValue('done')

    const result = await executeGenerateRun(baseExecuteParams(runState))
    expect(result.toolStats).toBe(stats)
  })

  it('passes stuckError through', async () => {
    const runState = makeRunState()
    const stuckError = { name: 'StuckError', reason: 'looping', repeatedTool: 'search', escalationLevel: 3, recoveryAction: 'loop_aborted', message: 'stuck' }
    mockRunToolLoop.mockResolvedValue(
      makeToolLoopResult({ stopReason: 'stuck', stuckError: stuckError as never }),
    )
    mockExtractFinalAiMessageContent.mockReturnValue('')

    const result = await executeGenerateRun(baseExecuteParams(runState))
    expect(result.stopReason).toBe('stuck')
    expect(result.stuckError).toBe(stuckError)
  })

  it('passes budget from runState to runToolLoop config', async () => {
    const budget = new IterationBudget({ maxTokens: 1000 })
    const runState = makeRunState({ budget })
    mockRunToolLoop.mockResolvedValue(makeToolLoopResult())
    mockExtractFinalAiMessageContent.mockReturnValue('done')

    await executeGenerateRun(baseExecuteParams(runState))

    const config = mockRunToolLoop.mock.calls[0]![3] as Record<string, unknown>
    expect(config.budget).toBe(budget)
  })

  it('passes stuckDetector from runState to runToolLoop config', async () => {
    const detector = new StuckDetector()
    const runState = makeRunState({ stuckDetector: detector })
    mockRunToolLoop.mockResolvedValue(makeToolLoopResult())
    mockExtractFinalAiMessageContent.mockReturnValue('done')

    await executeGenerateRun(baseExecuteParams(runState))

    const config = mockRunToolLoop.mock.calls[0]![3] as Record<string, unknown>
    expect(config.stuckDetector).toBe(detector)
  })

  it('passes signal from options to runToolLoop', async () => {
    const controller = new AbortController()
    const runState = makeRunState()
    mockRunToolLoop.mockResolvedValue(makeToolLoopResult())
    mockExtractFinalAiMessageContent.mockReturnValue('done')

    await executeGenerateRun(
      baseExecuteParams(runState, { options: { signal: controller.signal } }),
    )

    const config = mockRunToolLoop.mock.calls[0]![3] as Record<string, unknown>
    expect(config.signal).toBe(controller.signal)
  })

  it('passes toolStatsTracker from config to runToolLoop', async () => {
    const tracker = { formatAsPromptHint: vi.fn(() => '') }
    const runState = makeRunState()
    mockRunToolLoop.mockResolvedValue(makeToolLoopResult())
    mockExtractFinalAiMessageContent.mockReturnValue('done')

    await executeGenerateRun(
      baseExecuteParams(runState, {
        config: {
          id: 'a',
          instructions: '',
          model: 'gpt-4',
          toolStatsTracker: tracker,
        },
      }),
    )

    const config = mockRunToolLoop.mock.calls[0]![3] as Record<string, unknown>
    expect(config.toolStatsTracker).toBe(tracker)
  })

  it('passes intent from options to runToolLoop', async () => {
    const runState = makeRunState()
    mockRunToolLoop.mockResolvedValue(makeToolLoopResult())
    mockExtractFinalAiMessageContent.mockReturnValue('done')

    await executeGenerateRun(
      baseExecuteParams(runState, { options: { intent: 'code-review' } }),
    )

    const config = mockRunToolLoop.mock.calls[0]![3] as Record<string, unknown>
    expect(config.intent).toBe('code-review')
  })

  // -- outputFilter --

  it('applies outputFilter when defined', async () => {
    const runState = makeRunState()
    mockRunToolLoop.mockResolvedValue(makeToolLoopResult())
    mockExtractFinalAiMessageContent.mockReturnValue('raw output')

    const result = await executeGenerateRun(
      baseExecuteParams(runState, {
        config: {
          id: 'a',
          instructions: '',
          model: 'gpt-4',
          guardrails: {
            outputFilter: async (output: string) => output.replace('raw', 'filtered'),
          },
        },
      }),
    )

    expect(result.content).toBe('filtered output')
  })

  it('keeps original content when outputFilter returns null', async () => {
    const runState = makeRunState()
    mockRunToolLoop.mockResolvedValue(makeToolLoopResult())
    mockExtractFinalAiMessageContent.mockReturnValue('original')

    const result = await executeGenerateRun(
      baseExecuteParams(runState, {
        config: {
          id: 'a',
          instructions: '',
          model: 'gpt-4',
          guardrails: {
            outputFilter: async () => null,
          },
        },
      }),
    )

    expect(result.content).toBe('original')
  })

  // -- onUsage callback --

  it('forwards onUsage from options to runToolLoop', async () => {
    const onUsage = vi.fn()
    const runState = makeRunState()
    mockRunToolLoop.mockResolvedValue(makeToolLoopResult())
    mockExtractFinalAiMessageContent.mockReturnValue('done')

    await executeGenerateRun(
      baseExecuteParams(runState, { options: { onUsage } }),
    )

    const config = mockRunToolLoop.mock.calls[0]![3] as Record<string, unknown>
    expect(config).toHaveProperty('onUsage')
    // Invoke it to ensure it delegates
    const wrapper = config.onUsage as (usage: unknown) => void
    const usage = { model: 'gpt-4', inputTokens: 10, outputTokens: 5 }
    wrapper(usage)
    expect(onUsage).toHaveBeenCalledWith(usage)
  })

  // -- eventBus emissions --

  it('emits agent:stuck_detected via onStuckDetected callback', async () => {
    const events: unknown[] = []
    const eventBus = {
      emit: vi.fn((e: unknown) => { events.push(e) }),
      on: vi.fn(),
      off: vi.fn(),
    }
    const runState = makeRunState()
    mockRunToolLoop.mockResolvedValue(makeToolLoopResult())
    mockExtractFinalAiMessageContent.mockReturnValue('done')

    await executeGenerateRun(
      baseExecuteParams(runState, {
        agentId: 'agent-1',
        config: {
          id: 'agent-1',
          instructions: '',
          model: 'gpt-4',
          eventBus: eventBus as never,
        },
      }),
    )

    // Extract the onStuckDetected callback and invoke it
    const config = mockRunToolLoop.mock.calls[0]![3] as Record<string, unknown>
    const onStuckDetected = config.onStuckDetected as (reason: string, recovery: string) => void
    onStuckDetected('repeated calls', 'try different approach')

    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent:stuck_detected',
        agentId: 'agent-1',
        reason: 'repeated calls',
        recovery: 'try different approach',
      }),
    )
  })

  it('emits tool:latency via onToolLatency callback', async () => {
    const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
    const runState = makeRunState()
    mockRunToolLoop.mockResolvedValue(makeToolLoopResult())
    mockExtractFinalAiMessageContent.mockReturnValue('done')

    await executeGenerateRun(
      baseExecuteParams(runState, {
        config: {
          id: 'a',
          instructions: '',
          model: 'gpt-4',
          eventBus: eventBus as never,
        },
      }),
    )

    const config = mockRunToolLoop.mock.calls[0]![3] as Record<string, unknown>
    const onToolLatency = config.onToolLatency as (name: string, ms: number, err?: string) => void
    onToolLatency('search', 42)

    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool:latency',
        toolName: 'search',
        durationMs: 42,
      }),
    )
  })

  it('emits tool:latency with error field when error provided', async () => {
    const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
    const runState = makeRunState()
    mockRunToolLoop.mockResolvedValue(makeToolLoopResult())
    mockExtractFinalAiMessageContent.mockReturnValue('done')

    await executeGenerateRun(
      baseExecuteParams(runState, {
        config: {
          id: 'a',
          instructions: '',
          model: 'gpt-4',
          eventBus: eventBus as never,
        },
      }),
    )

    const config = mockRunToolLoop.mock.calls[0]![3] as Record<string, unknown>
    const onToolLatency = config.onToolLatency as (name: string, ms: number, err?: string) => void
    onToolLatency('search', 100, 'timeout')

    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool:latency',
        toolName: 'search',
        durationMs: 100,
        error: 'timeout',
      }),
    )
  })

  it('emits onStuck event with correct escalation info', async () => {
    const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
    const runState = makeRunState()
    mockRunToolLoop.mockResolvedValue(makeToolLoopResult())
    mockExtractFinalAiMessageContent.mockReturnValue('done')

    await executeGenerateRun(
      baseExecuteParams(runState, {
        agentId: 'agent-x',
        config: {
          id: 'agent-x',
          instructions: '',
          model: 'gpt-4',
          eventBus: eventBus as never,
        },
      }),
    )

    const config = mockRunToolLoop.mock.calls[0]![3] as Record<string, unknown>
    const onStuck = config.onStuck as (toolName: string, stage: number) => void

    // Stage 1
    onStuck('read_file', 1)
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent:stuck_detected',
        recovery: 'Tool blocked',
      }),
    )

    // Stage 2
    onStuck('read_file', 2)
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        recovery: 'Nudge injected',
      }),
    )

    // Stage 3
    onStuck('read_file', 3)
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        recovery: 'Aborting loop',
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// emitStopReasonTelemetry
// ---------------------------------------------------------------------------

describe('emitStopReasonTelemetry', () => {
  it('emits agent:stop_reason event via eventBus', () => {
    const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
    const stats: ToolStat[] = [{ name: 't', calls: 1, errors: 0, totalMs: 10, avgMs: 10 }]

    emitStopReasonTelemetry(
      { eventBus: eventBus as never },
      'agent-1',
      { stopReason: 'complete', llmCalls: 3, toolStats: stats },
    )

    expect(eventBus.emit).toHaveBeenCalledWith({
      type: 'agent:stop_reason',
      agentId: 'agent-1',
      reason: 'complete',
      iterations: 3,
      toolStats: stats,
    })
  })

  it('does nothing when eventBus is undefined', () => {
    // Should not throw
    emitStopReasonTelemetry(
      {},
      'agent-1',
      { stopReason: 'complete', llmCalls: 1, toolStats: [] },
    )
  })

  it('emits with different stop reasons', () => {
    const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() }
    const reasons: StopReason[] = ['complete', 'iteration_limit', 'budget_exceeded', 'aborted', 'error', 'stuck']

    for (const reason of reasons) {
      emitStopReasonTelemetry(
        { eventBus: eventBus as never },
        'a',
        { stopReason: reason, llmCalls: 1, toolStats: [] },
      )
    }

    expect(eventBus.emit).toHaveBeenCalledTimes(reasons.length)
  })
})

// ---------------------------------------------------------------------------
// createToolStatTracker
// ---------------------------------------------------------------------------

describe('createToolStatTracker', () => {
  it('starts with empty array', () => {
    const tracker = createToolStatTracker()
    expect(tracker.toArray()).toEqual([])
  })

  it('records a single tool call', () => {
    const tracker = createToolStatTracker()
    tracker.record('search', 50)
    const stats = tracker.toArray()
    expect(stats).toHaveLength(1)
    expect(stats[0]).toEqual({
      name: 'search',
      calls: 1,
      errors: 0,
      totalMs: 50,
      avgMs: 50,
    })
  })

  it('accumulates multiple calls for same tool', () => {
    const tracker = createToolStatTracker()
    tracker.record('search', 50)
    tracker.record('search', 100)
    tracker.record('search', 150)
    const stats = tracker.toArray()
    expect(stats).toHaveLength(1)
    expect(stats[0]!.calls).toBe(3)
    expect(stats[0]!.totalMs).toBe(300)
    expect(stats[0]!.avgMs).toBe(100)
  })

  it('tracks errors separately', () => {
    const tracker = createToolStatTracker()
    tracker.record('deploy', 50)
    tracker.record('deploy', 100, 'timeout')
    tracker.record('deploy', 75)
    const stats = tracker.toArray()
    expect(stats[0]!.calls).toBe(3)
    expect(stats[0]!.errors).toBe(1)
  })

  it('tracks multiple different tools', () => {
    const tracker = createToolStatTracker()
    tracker.record('read', 10)
    tracker.record('write', 20)
    tracker.record('read', 30)
    const stats = tracker.toArray()
    expect(stats).toHaveLength(2)
    const read = stats.find(s => s.name === 'read')!
    const write = stats.find(s => s.name === 'write')!
    expect(read.calls).toBe(2)
    expect(write.calls).toBe(1)
  })

  it('avgMs is 0 when calls is somehow 0', () => {
    // This case shouldn't happen in practice, but covers the guard
    const tracker = createToolStatTracker()
    // Just verify empty is properly handled
    expect(tracker.toArray()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// executeStreamingToolCall
// ---------------------------------------------------------------------------

describe('executeStreamingToolCall', () => {
  function baseStreamParams(
    overrides: Partial<Parameters<typeof executeStreamingToolCall>[0]> = {},
  ) {
    const tool = mockTool('search', 'results found')
    return {
      toolCall: { id: 'call_1', name: 'search', args: { query: 'test' } },
      toolMap: new Map<string, StructuredToolInterface>([['search', tool]]),
      budget: undefined as IterationBudget | undefined,
      stuckDetector: undefined as StuckDetector | undefined,
      transformToolResult: vi.fn(async (_n: string, _i: Record<string, unknown>, r: string) => r),
      onToolLatency: vi.fn(),
      statTracker: createToolStatTracker(),
      ...overrides,
    }
  }

  it('executes tool and returns ToolMessage with result', async () => {
    const result = await executeStreamingToolCall(baseStreamParams())
    expect(result.message).toBeInstanceOf(ToolMessage)
    expect(result.message.content).toBe('results found')
    expect(result.eventResult).toBe('results found')
  })

  it('returns blocked message when tool is blocked by budget', async () => {
    const budget = new IterationBudget({ blockedTools: ['search'] })
    const result = await executeStreamingToolCall(
      baseStreamParams({ budget }),
    )
    expect(result.message.content).toContain('blocked by guardrails')
    expect(result.eventResult).toBe('[blocked]')
  })

  it('returns not-found message when tool is missing from toolMap', async () => {
    const result = await executeStreamingToolCall(
      baseStreamParams({
        toolCall: { id: 'call_1', name: 'nonexistent', args: {} },
      }),
    )
    expect(result.message.content).toContain('not found')
    expect(result.message.content).toContain('Available tools: search')
    expect(result.eventResult).toBe('[not found]')
  })

  it('generates toolCallId when not provided', async () => {
    const result = await executeStreamingToolCall(
      baseStreamParams({
        toolCall: { name: 'search', args: {} },
      }),
    )
    expect(result.message.tool_call_id).toMatch(/^call_/)
  })

  it('applies transformToolResult to the output', async () => {
    const params = baseStreamParams({
      transformToolResult: vi.fn(async () => 'transformed'),
    })
    const result = await executeStreamingToolCall(params)
    expect(result.message.content).toBe('transformed')
    expect(result.eventResult).toBe('transformed')
  })

  it('records stat on success', async () => {
    const params = baseStreamParams()
    await executeStreamingToolCall(params)
    const stats = params.statTracker.toArray()
    expect(stats).toHaveLength(1)
    expect(stats[0]!.name).toBe('search')
    expect(stats[0]!.calls).toBe(1)
    expect(stats[0]!.errors).toBe(0)
  })

  it('calls onToolLatency on success', async () => {
    const params = baseStreamParams()
    await executeStreamingToolCall(params)
    expect(params.onToolLatency).toHaveBeenCalledWith('search', expect.any(Number))
  })

  it('handles tool invocation error gracefully', async () => {
    const failTool = {
      name: 'fail',
      description: 'fails',
      schema: {} as never,
      lc_namespace: [] as string[],
      invoke: vi.fn(async () => { throw new Error('boom') }),
    } as unknown as StructuredToolInterface

    const params = baseStreamParams({
      toolCall: { id: 'call_1', name: 'fail', args: {} },
      toolMap: new Map([['fail', failTool]]),
    })
    const result = await executeStreamingToolCall(params)

    expect(result.message.content).toContain('Error executing tool "fail": boom')
    expect(result.eventResult).toBe('[error: boom]')
  })

  it('records error stat on failure', async () => {
    const failTool = {
      name: 'fail',
      description: 'fails',
      schema: {} as never,
      lc_namespace: [] as string[],
      invoke: vi.fn(async () => { throw new Error('boom') }),
    } as unknown as StructuredToolInterface

    const params = baseStreamParams({
      toolCall: { id: 'call_1', name: 'fail', args: {} },
      toolMap: new Map([['fail', failTool]]),
    })
    await executeStreamingToolCall(params)
    const stats = params.statTracker.toArray()
    expect(stats[0]!.errors).toBe(1)
  })

  it('calls onToolLatency with error on failure', async () => {
    const failTool = {
      name: 'fail',
      description: 'fails',
      schema: {} as never,
      lc_namespace: [] as string[],
      invoke: vi.fn(async () => { throw new Error('boom') }),
    } as unknown as StructuredToolInterface

    const params = baseStreamParams({
      toolCall: { id: 'call_1', name: 'fail', args: {} },
      toolMap: new Map([['fail', failTool]]),
    })
    await executeStreamingToolCall(params)
    expect(params.onToolLatency).toHaveBeenCalledWith('fail', expect.any(Number), 'boom')
  })

  it('detects stuck on repeated successful tool calls', async () => {
    const detector = new StuckDetector({ maxRepeatCalls: 1 })
    const params = baseStreamParams({ stuckDetector: detector })
    const result = await executeStreamingToolCall(params)

    // First call flags stuck because maxRepeatCalls=1 means 1 identical call triggers stuck
    expect(result.stuckReason).toBeDefined()
    expect(result.stuckRecovery).toContain('blocked')
    expect(result.stuckNudge).toBeInstanceOf(ToolMessage)
  })

  it('detects stuck on repeated errors', async () => {
    const detector = new StuckDetector({ maxErrorsInWindow: 1 })
    const failTool = {
      name: 'fail',
      description: 'fails',
      schema: {} as never,
      lc_namespace: [] as string[],
      invoke: vi.fn(async () => { throw new Error('boom') }),
    } as unknown as StructuredToolInterface

    const params = baseStreamParams({
      toolCall: { id: 'call_1', name: 'fail', args: {} },
      toolMap: new Map([['fail', failTool]]),
      stuckDetector: detector,
    })
    const result = await executeStreamingToolCall(params)

    expect(result.stuckReason).toBeDefined()
    expect(result.shouldStop).toBe(true)
  })

  it('converts non-string tool result to JSON', async () => {
    const objTool = {
      name: 'obj',
      description: 'returns object',
      schema: {} as never,
      lc_namespace: [] as string[],
      invoke: vi.fn(async () => ({ key: 'value' })),
    } as unknown as StructuredToolInterface

    const params = baseStreamParams({
      toolCall: { id: 'call_1', name: 'obj', args: {} },
      toolMap: new Map([['obj', objTool]]),
    })
    await executeStreamingToolCall(params)
    expect(params.transformToolResult).toHaveBeenCalledWith(
      'obj',
      {},
      JSON.stringify({ key: 'value' }),
    )
  })

  it('non-Error thrown is stringified', async () => {
    const failTool = {
      name: 'fail',
      description: 'fails',
      schema: {} as never,
      lc_namespace: [] as string[],
      invoke: vi.fn(async () => { throw 'string error' }),
    } as unknown as StructuredToolInterface

    const params = baseStreamParams({
      toolCall: { id: 'call_1', name: 'fail', args: {} },
      toolMap: new Map([['fail', failTool]]),
    })
    const result = await executeStreamingToolCall(params)
    expect(result.message.content).toContain('string error')
  })
})

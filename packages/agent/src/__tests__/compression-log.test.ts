/**
 * Session V — compressionLog wiring in the run engine.
 *
 * Verifies that `onCompressed` (wired inside `executeGenerateRun`)
 * accumulates compression events into an in-memory log that is then
 * surfaced on `GenerateResult.compressionLog`.
 *
 * The tests mock `runToolLoop` so they can assert against the exact
 * `onCompressed` callback the engine passes in, without needing to drive
 * a full ReAct loop.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { DzupAgentConfig, GenerateOptions } from '../agent/agent-types.js'
import type { ToolLoopResult, StopReason } from '../agent/tool-loop.js'

// ---------------------------------------------------------------------------
// Mocks
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

import {
  executeGenerateRun,
  type PreparedRunState,
} from '../agent/run-engine.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockTool(name: string): StructuredToolInterface {
  return {
    name,
    description: `Mock ${name}`,
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => 'ok'),
  } as unknown as StructuredToolInterface
}

function mockModel(): BaseChatModel {
  return {
    invoke: vi.fn(async () => new AIMessage('done')),
  } as unknown as BaseChatModel
}

function makeRunState(overrides: Partial<PreparedRunState> = {}): PreparedRunState {
  const tools = [mockTool('search')]
  return {
    maxIterations: 10,
    budget: undefined,
    preparedMessages: [new HumanMessage('hello')],
    tools,
    toolMap: new Map(tools.map((t) => [t.name, t])),
    model: mockModel(),
    stuckDetector: undefined,
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
    transformToolResult: vi.fn(
      async (_n: string, _i: Record<string, unknown>, r: string) => r,
    ),
    maybeUpdateSummary: vi.fn(async () => {}),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeGenerateRun — compressionLog wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateToolLoopLearningHook.mockReturnValue(undefined)
    mockExtractFinalAiMessageContent.mockReturnValue('done')
  })

  it('leaves compressionLog undefined when no compression event fires', async () => {
    // runToolLoop does NOT invoke the onCompressed callback — simulating
    // a run where pressure never transitioned to critical, so
    // maybeCompress always returned { compressed: false }.
    mockRunToolLoop.mockResolvedValue(makeToolLoopResult())

    const runState = makeRunState()
    const result = await executeGenerateRun(baseExecuteParams(runState))

    expect(result.compressionLog).toBeUndefined()
  })

  it('populates compressionLog with one entry when onCompressed fires once', async () => {
    // Capture the config passed to runToolLoop so we can invoke the
    // onCompressed callback the run engine wired in.
    mockRunToolLoop.mockImplementation(
      async (
        _model: BaseChatModel,
        _messages: BaseMessage[],
        _tools: StructuredToolInterface[],
        cfg: { onCompressed?: (info: { before: number; after: number; summary: string | null }) => void },
      ): Promise<ToolLoopResult> => {
        // Simulate the tool loop invoking onCompressed exactly once,
        // as it would after `maybeCompress` returned `compressed: true`.
        cfg.onCompressed?.({ before: 20, after: 5, summary: 'conversation compacted' })
        return makeToolLoopResult()
      },
    )

    const runState = makeRunState()
    const result = await executeGenerateRun(baseExecuteParams(runState))

    expect(result.compressionLog).toBeDefined()
    expect(result.compressionLog).toHaveLength(1)
  })

  it('records correct before/after/summary/ts fields on each log entry', async () => {
    const tsBefore = Date.now()
    mockRunToolLoop.mockImplementation(
      async (
        _model: BaseChatModel,
        _messages: BaseMessage[],
        _tools: StructuredToolInterface[],
        cfg: { onCompressed?: (info: { before: number; after: number; summary: string | null }) => void },
      ): Promise<ToolLoopResult> => {
        cfg.onCompressed?.({ before: 42, after: 7, summary: 'compact summary' })
        cfg.onCompressed?.({ before: 30, after: 4, summary: null })
        return makeToolLoopResult()
      },
    )

    const runState = makeRunState()
    const result = await executeGenerateRun(baseExecuteParams(runState))
    const tsAfter = Date.now()

    expect(result.compressionLog).toHaveLength(2)

    const [first, second] = result.compressionLog!
    expect(first).toMatchObject({
      before: 42,
      after: 7,
      summary: 'compact summary',
    })
    expect(first!.ts).toBeGreaterThanOrEqual(tsBefore)
    expect(first!.ts).toBeLessThanOrEqual(tsAfter)

    expect(second).toMatchObject({
      before: 30,
      after: 4,
      summary: null,
    })
    expect(second!.ts).toBeGreaterThanOrEqual(tsBefore)
    expect(second!.ts).toBeLessThanOrEqual(tsAfter)
  })

  it('returns compressionLog as part of GenerateResult (alongside other fields)', async () => {
    // Verifies that compressionLog is surfaced on the same object as
    // the usual GenerateResult fields, not on a detached channel.
    mockRunToolLoop.mockImplementation(
      async (
        _model: BaseChatModel,
        _messages: BaseMessage[],
        _tools: StructuredToolInterface[],
        cfg: { onCompressed?: (info: { before: number; after: number; summary: string | null }) => void },
      ): Promise<ToolLoopResult> => {
        cfg.onCompressed?.({ before: 15, after: 3, summary: 'compacted' })
        return makeToolLoopResult({
          totalInputTokens: 321,
          totalOutputTokens: 123,
          llmCalls: 2,
        })
      },
    )

    const runState = makeRunState()
    const result = await executeGenerateRun(baseExecuteParams(runState))

    // compressionLog is present on the same result object as content/usage
    expect(result.content).toBe('done')
    expect(result.usage).toEqual({
      totalInputTokens: 321,
      totalOutputTokens: 123,
      llmCalls: 2,
    })
    expect(result.compressionLog).toEqual([
      expect.objectContaining({
        before: 15,
        after: 3,
        summary: 'compacted',
        ts: expect.any(Number),
      }),
    ])
  })
})

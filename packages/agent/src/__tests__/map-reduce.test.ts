/**
 * Tests for mapReduce, mapReduceMulti, and merge strategies.
 *
 * Uses the same mock chat model convention as supervisor.test.ts
 * so all tests are deterministic (no real LLM calls).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { BaseMessage } from '@langchain/core/messages'
import { ForgeAgent } from '../agent/forge-agent.js'
import { mapReduce, mapReduceMulti } from '../orchestration/map-reduce.js'
import {
  concatMerge,
  voteMerge,
  numberedMerge,
  jsonArrayMerge,
  getMergeStrategy,
} from '../orchestration/merge-strategies.js'

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as supervisor.test.ts)
// ---------------------------------------------------------------------------

function createMockModel(
  responses: Array<{ content: string; tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }> }>,
): BaseChatModel {
  let callIndex = 0
  const invoke = vi.fn(async (_messages: BaseMessage[]) => {
    const resp = responses[callIndex] ?? responses[responses.length - 1]!
    callIndex++
    return new AIMessage({
      content: resp.content,
      tool_calls: resp.tool_calls?.map(tc => ({
        id: tc.id,
        name: tc.name,
        args: tc.args,
        type: 'tool_call' as const,
      })),
      response_metadata: {},
    })
  })

  return {
    invoke,
    bindTools: vi.fn(function (this: BaseChatModel) {
      return this
    }),
    _modelType: () => 'base_chat_model',
    _llmType: () => 'mock',
  } as unknown as BaseChatModel
}

function createAgent(id: string, responses: Array<{ content: string }>): ForgeAgent {
  return new ForgeAgent({
    id,
    name: id,
    model: createMockModel(responses),
    instructions: `You are ${id}`,
  })
}

// ---------------------------------------------------------------------------
// mapReduce
// ---------------------------------------------------------------------------

describe('mapReduce', () => {
  it('processes 3 chunks with same agent and merges results', async () => {
    // The model returns a different response for each call
    const model = createMockModel([
      { content: 'chunk-0-done' },
      { content: 'chunk-1-done' },
      { content: 'chunk-2-done' },
    ])
    const agent = new ForgeAgent({
      id: 'worker',
      name: 'worker',
      model,
      instructions: 'Process chunks',
    })

    const result = await mapReduce(agent, ['c0', 'c1', 'c2'])

    expect(result.stats.total).toBe(3)
    expect(result.stats.succeeded).toBe(3)
    expect(result.stats.failed).toBe(0)
    expect(result.agentResults).toHaveLength(3)
    // Default merge is 'concat' which joins with \n\n---\n\n
    expect(result.result).toContain('chunk-0-done')
    expect(result.result).toContain('chunk-1-done')
    expect(result.result).toContain('chunk-2-done')
  })

  it('captures partial failure without rejecting', async () => {
    // First and third calls succeed, second throws
    let callCount = 0
    const model = {
      invoke: vi.fn(async () => {
        callCount++
        if (callCount === 2) throw new Error('chunk-1 failed')
        return new AIMessage({
          content: `success-${callCount}`,
          response_metadata: {},
        })
      }),
      bindTools: vi.fn(function (this: BaseChatModel) { return this }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const agent = new ForgeAgent({
      id: 'partial',
      name: 'partial',
      model,
      instructions: 'Process',
    })

    const result = await mapReduce(agent, ['a', 'b', 'c'])

    expect(result.stats.total).toBe(3)
    expect(result.stats.succeeded).toBe(2)
    expect(result.stats.failed).toBe(1)

    const failed = result.agentResults.find(r => !r.success)
    expect(failed).toBeDefined()
    expect(failed!.error).toContain('chunk-1 failed')

    // Merged result only includes successful outputs
    expect(result.result).not.toContain('chunk-1 failed')
  })

  it('handles all chunks failing', async () => {
    const model = {
      invoke: vi.fn(async () => { throw new Error('all-fail') }),
      bindTools: vi.fn(function (this: BaseChatModel) { return this }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const agent = new ForgeAgent({
      id: 'all-fail',
      name: 'all-fail',
      model,
      instructions: 'Fail',
    })

    const result = await mapReduce(agent, ['x', 'y'])

    expect(result.stats.total).toBe(2)
    expect(result.stats.succeeded).toBe(0)
    expect(result.stats.failed).toBe(2)
    expect(result.result).toBe('')
  })

  it('respects concurrency=1 for sequential execution', async () => {
    const executionOrder: number[] = []
    let callCount = 0

    const model = {
      invoke: vi.fn(async () => {
        const idx = callCount++
        executionOrder.push(idx)
        // Small delay to make ordering observable
        await new Promise(r => setTimeout(r, 10))
        return new AIMessage({
          content: `result-${idx}`,
          response_metadata: {},
        })
      }),
      bindTools: vi.fn(function (this: BaseChatModel) { return this }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const agent = new ForgeAgent({
      id: 'seq-worker',
      name: 'seq-worker',
      model,
      instructions: 'Process',
    })

    const result = await mapReduce(agent, ['a', 'b', 'c'], { concurrency: 1 })

    expect(result.stats.succeeded).toBe(3)
    // With concurrency=1, calls must be sequential: 0, 1, 2
    expect(executionOrder).toEqual([0, 1, 2])
  })

  it('default concurrency (5) runs chunks in parallel', async () => {
    const concurrentCount = { current: 0, max: 0 }

    const model = {
      invoke: vi.fn(async () => {
        concurrentCount.current++
        if (concurrentCount.current > concurrentCount.max) {
          concurrentCount.max = concurrentCount.current
        }
        // Small delay so we can observe concurrency
        await new Promise(r => setTimeout(r, 20))
        concurrentCount.current--
        return new AIMessage({ content: 'ok', response_metadata: {} })
      }),
      bindTools: vi.fn(function (this: BaseChatModel) { return this }),
      _modelType: () => 'base_chat_model',
      _llmType: () => 'mock',
    } as unknown as BaseChatModel

    const agent = new ForgeAgent({
      id: 'par-worker',
      name: 'par-worker',
      model,
      instructions: 'Process',
    })

    // 3 chunks with default concurrency=5 should all run concurrently
    await mapReduce(agent, ['a', 'b', 'c'])

    // All 3 should have run at the same time since limit (5) > count (3)
    expect(concurrentCount.max).toBe(3)
  })

  it('uses custom merge strategy (numbered)', async () => {
    const agent = createAgent('num-worker', [
      { content: 'first' },
      { content: 'second' },
      { content: 'third' },
    ])

    const result = await mapReduce(agent, ['a', 'b', 'c'], {
      mergeStrategy: 'custom',
      customMerge: numberedMerge,
    })

    expect(result.result).toContain('1. first')
    expect(result.result).toContain('2. second')
    expect(result.result).toContain('3. third')
  })

  it('tracks positive durationMs', async () => {
    const agent = createAgent('dur-worker', [{ content: 'fast' }])

    const result = await mapReduce(agent, ['x'])

    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    // Also check per-agent duration
    expect(result.agentResults[0]!.durationMs).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// mapReduceMulti
// ---------------------------------------------------------------------------

describe('mapReduceMulti', () => {
  it('processes heterogeneous agent-task pairs', async () => {
    const agentA = createAgent('analyst', [{ content: 'analysis-result' }])
    const agentB = createAgent('writer', [{ content: 'written-report' }])
    const agentC = createAgent('reviewer', [{ content: 'review-feedback' }])

    const result = await mapReduceMulti([
      { agent: agentA, input: 'analyze data' },
      { agent: agentB, input: 'write report' },
      { agent: agentC, input: 'review output' },
    ])

    expect(result.stats.total).toBe(3)
    expect(result.stats.succeeded).toBe(3)
    expect(result.result).toContain('analysis-result')
    expect(result.result).toContain('written-report')
    expect(result.result).toContain('review-feedback')

    // Verify each agentResult has the correct agentId
    expect(result.agentResults[0]!.agentId).toBe('analyst')
    expect(result.agentResults[1]!.agentId).toBe('writer')
    expect(result.agentResults[2]!.agentId).toBe('reviewer')
  })

  it('works with a single task', async () => {
    const agent = createAgent('solo', [{ content: 'only-output' }])

    const result = await mapReduceMulti([{ agent, input: 'do it' }])

    expect(result.stats.total).toBe(1)
    expect(result.stats.succeeded).toBe(1)
    expect(result.result).toContain('only-output')
  })

  it('returns empty result for empty tasks', async () => {
    const result = await mapReduceMulti([])

    expect(result.stats.total).toBe(0)
    expect(result.stats.succeeded).toBe(0)
    expect(result.stats.failed).toBe(0)
    expect(result.result).toBe('')
    expect(result.agentResults).toEqual([])
  })

  it('respects abort signal', async () => {
    const controller = new AbortController()
    controller.abort() // Pre-abort

    const agent = createAgent('aborted', [{ content: 'should not reach' }])

    const result = await mapReduceMulti(
      [{ agent, input: 'task' }],
      { signal: controller.signal },
    )

    // executeAgent catches the abort error and returns a failed AgentOutput
    expect(result.stats.failed).toBe(1)
    const failedResult = result.agentResults[0]!
    expect(failedResult.success).toBe(false)
    expect(failedResult.error).toContain('Aborted')
  })
})

// ---------------------------------------------------------------------------
// Merge strategies
// ---------------------------------------------------------------------------

describe('Merge strategies', () => {
  describe('concatMerge', () => {
    it('joins results with separator', () => {
      const result = concatMerge(['alpha', 'beta', 'gamma'])
      expect(result).toBe('alpha\n\n---\n\nbeta\n\n---\n\ngamma')
    })

    it('returns single result as-is (no separator)', () => {
      expect(concatMerge(['only'])).toBe('only')
    })

    it('returns empty string for empty array', () => {
      expect(concatMerge([])).toBe('')
    })
  })

  describe('voteMerge', () => {
    it('returns the most common result', () => {
      const result = voteMerge(['A', 'B', 'A', 'C', 'A'])
      expect(result).toBe('A')
    })

    it('breaks ties by first occurrence', () => {
      // Both appear once; first one encountered wins because
      // the loop only updates on strictly greater count
      const result = voteMerge(['X', 'Y'])
      expect(result).toBe('X')
    })

    it('trims whitespace before comparing', () => {
      const result = voteMerge(['  hello  ', 'hello', '  hello'])
      expect(result).toBe('hello')
    })

    it('returns empty string for empty array', () => {
      expect(voteMerge([])).toBe('')
    })
  })

  describe('numberedMerge', () => {
    it('formats results as numbered list', () => {
      const result = numberedMerge(['first', 'second', 'third'])
      expect(result).toBe('1. first\n\n2. second\n\n3. third')
    })

    it('handles single item', () => {
      expect(numberedMerge(['only'])).toBe('1. only')
    })
  })

  describe('jsonArrayMerge', () => {
    it('produces valid JSON array', () => {
      const result = jsonArrayMerge(['a', 'b', 'c'])
      const parsed = JSON.parse(result as string)
      expect(parsed).toEqual(['a', 'b', 'c'])
    })

    it('handles empty array', () => {
      const result = jsonArrayMerge([])
      expect(JSON.parse(result as string)).toEqual([])
    })

    it('handles results containing special characters', () => {
      const result = jsonArrayMerge(['line\nbreak', '"quoted"', 'tab\there'])
      const parsed = JSON.parse(result as string)
      expect(parsed).toHaveLength(3)
      expect(parsed[0]).toBe('line\nbreak')
      expect(parsed[1]).toBe('"quoted"')
    })
  })

  describe('getMergeStrategy', () => {
    it('resolves known strategy names', () => {
      expect(getMergeStrategy('concat')).toBe(concatMerge)
      expect(getMergeStrategy('vote')).toBe(voteMerge)
      expect(getMergeStrategy('numbered')).toBe(numberedMerge)
      expect(getMergeStrategy('json')).toBe(jsonArrayMerge)
    })

    it('throws on unknown strategy name', () => {
      expect(() => getMergeStrategy('unknown')).toThrow('Unknown merge strategy "unknown"')
    })
  })
})

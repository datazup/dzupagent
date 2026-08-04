/**
 * C-03 — Streamed chunks must be ASSEMBLED, not overwritten.
 *
 * Pre-fix, `consumeStream` did `fullResponse = chunk` on every delta, so
 * only the final delta survived. Real providers split one logical
 * response across many deltas:
 *
 *   - tool-call arguments arrive as partial JSON fragments in
 *     `tool_call_chunks`, so a tool call spread over three deltas was
 *     silently dropped entirely;
 *   - `usage_metadata` frequently lands on a NON-terminal delta
 *     (Anthropic reports input tokens on the first), so budget
 *     accounting fell back to the chars/4 estimator;
 *   - a terminal delta with no tool data made the loop take the
 *     `complete` branch and finish the run without ever executing the
 *     tool the model actually asked for.
 *
 * These tests drive `DzupAgent.stream()` with a genuinely multi-delta
 * mock and assert the assembled outcome.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { TokenUsage } from '@dzupagent/core'
import { DzupAgent } from '../agent/dzip-agent.js'
import type { AgentStreamEvent } from '../agent/agent-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Delta {
  content?: string
  tool_call_chunks?: Array<{
    id?: string
    name?: string
    args?: string
    index?: number
  }>
  usage_metadata?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }
}

/**
 * Build an `AIMessageChunk` for one delta. `usage_metadata` is typed as
 * `never` on LangChain's default message structure but honoured at
 * runtime, hence the boundary cast.
 */
function makeChunk(delta: Delta): AIMessageChunk {
  const fields: Record<string, unknown> = { content: delta.content ?? '' }
  if (delta.tool_call_chunks) {
    fields['tool_call_chunks'] = delta.tool_call_chunks.map((tc, i) => ({
      type: 'tool_call_chunk' as const,
      id: tc.id ?? `call_${i}`,
      ...(tc.name !== undefined ? { name: tc.name } : {}),
      args: tc.args ?? '',
      index: tc.index ?? i,
    }))
  }
  if (delta.usage_metadata) fields['usage_metadata'] = delta.usage_metadata
  return new AIMessageChunk(
    fields as unknown as ConstructorParameters<typeof AIMessageChunk>[0],
  )
}

/**
 * Model whose `.stream()` emits a scripted list of deltas per iteration —
 * i.e. what a real provider does, and what a single-chunk mock never
 * exercises.
 */
function createMultiChunkModel(iterations: Delta[][]): BaseChatModel {
  let iteration = 0
  const model: Record<string, unknown> = {
    invoke: vi.fn(async () => new AIMessage('invoke-not-expected')),
    stream: vi.fn(async function* () {
      const deltas = iterations[iteration] ?? iterations.at(-1) ?? []
      iteration++
      for (const delta of deltas) yield makeChunk(delta)
    }),
    bindTools: vi.fn().mockReturnThis(),
    model: 'mock-multi-chunk-model',
  }
  return model as unknown as BaseChatModel
}

function mockTool(name: string, result = 'tool output'): {
  tool: StructuredToolInterface
  invokeFn: ReturnType<typeof vi.fn>
} {
  const invokeFn = vi.fn(async () => result)
  return {
    tool: {
      name,
      description: `Mock tool ${name}`,
      schema: {} as never,
      lc_namespace: [] as string[],
      invoke: invokeFn,
    } as unknown as StructuredToolInterface,
    invokeFn,
  }
}

async function drainStream(
  agent: DzupAgent,
  messages: BaseMessage[],
  options?: { onUsage?: (usage: TokenUsage) => void },
): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = []
  for await (const event of agent.stream(messages, options)) {
    events.push(event)
  }
  return events
}

/**
 * Iteration 1: a tool call whose JSON args are split across three deltas,
 * usage metadata on the FIRST (non-terminal) delta, and a terminal delta
 * that carries text only — no tool-call data at all.
 * Iteration 2: a plain text answer that ends the run.
 */
const SPLIT_TOOL_CALL_SCRIPT: Delta[][] = [
  [
    {
      content: 'Loo',
      usage_metadata: { input_tokens: 111, output_tokens: 7, total_tokens: 118 },
      tool_call_chunks: [
        { id: 'tc_split', name: 'lookup', args: '{"q":', index: 0 },
      ],
    },
    { tool_call_chunks: [{ id: 'tc_split', args: '"deep', index: 0 }] },
    { tool_call_chunks: [{ id: 'tc_split', args: ' value"}', index: 0 }] },
    { content: 'king' },
  ],
  [{ content: 'done' }],
]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('native stream chunk assembly (C-03)', () => {
  it('assembles tool args split across three deltas into one complete tool call', async () => {
    const { tool, invokeFn } = mockTool('lookup')
    const agent = new DzupAgent({
      id: 'stream-assembly-tool-args',
      instructions: 'Test agent.',
      model: createMultiChunkModel(SPLIT_TOOL_CALL_SCRIPT),
      tools: [tool],
    })

    await drainStream(agent, [new HumanMessage('look it up')])

    // Exactly ONE tool call, with the JSON reassembled from all three
    // fragments — not the last fragment, and not dropped entirely.
    expect(invokeFn).toHaveBeenCalledTimes(1)
    expect(invokeFn.mock.calls[0]![0]).toEqual({ q: 'deep value' })
  })

  it('preserves usage_metadata carried on a non-terminal chunk', async () => {
    const { tool } = mockTool('lookup')
    const usages: TokenUsage[] = []
    const agent = new DzupAgent({
      id: 'stream-assembly-usage',
      instructions: 'Test agent.',
      model: createMultiChunkModel(SPLIT_TOOL_CALL_SCRIPT),
      tools: [tool],
    })

    await drainStream(agent, [new HumanMessage('look it up')], {
      onUsage: (usage) => usages.push(usage),
    })

    // The first iteration's usage came from the FIRST delta; the terminal
    // delta had none. Real counts must survive, not the chars/4 estimate.
    expect(usages.length).toBeGreaterThan(0)
    expect(usages[0]!.inputTokens).toBe(111)
    expect(usages[0]!.outputTokens).toBe(7)
  })

  it('still executes the tool when the terminal chunk carries no tool-call data', async () => {
    const { tool, invokeFn } = mockTool('lookup')
    const agent = new DzupAgent({
      id: 'stream-assembly-terminal-chunk',
      instructions: 'Test agent.',
      model: createMultiChunkModel(SPLIT_TOOL_CALL_SCRIPT),
      tools: [tool],
    })

    const events = await drainStream(agent, [new HumanMessage('look it up')])

    // Pre-fix the terminal (tool-call-free) delta became `fullResponse`,
    // so the loop took the `complete` branch on iteration 1 and returned
    // 'Looking' without ever running the tool.
    expect(invokeFn).toHaveBeenCalledTimes(1)
    const done = events.find((event) => event.type === 'done')
    expect(done?.data?.stopReason).toBe('complete')
    expect(done?.data?.content).toBe('done')
  })

  it('accumulates streamed text content across deltas', async () => {
    const agent = new DzupAgent({
      id: 'stream-assembly-text',
      instructions: 'Test agent.',
      model: createMultiChunkModel([
        [{ content: 'Hello' }, { content: ', ' }, { content: 'world' }],
      ]),
    })

    const events = await drainStream(agent, [new HumanMessage('hi')])

    const textEvents = events.filter((event) => event.type === 'text')
    expect(textEvents).toHaveLength(3)
    const done = events.find((event) => event.type === 'done')
    expect(done?.data?.content).toBe('Hello, world')
  })

  it('falls back to last-message semantics for non-chunk stream messages', async () => {
    // Some providers/mocks yield plain AIMessages (each already complete).
    // Those have no `concat`, so last-message semantics must be retained
    // rather than throwing.
    const model: Record<string, unknown> = {
      invoke: vi.fn(async () => new AIMessage('unused')),
      stream: vi.fn(async function* () {
        yield new AIMessage('only message')
      }),
      bindTools: vi.fn().mockReturnThis(),
      model: 'plain-message-model',
    }
    const agent = new DzupAgent({
      id: 'stream-assembly-plain',
      instructions: 'Test agent.',
      model: model as unknown as BaseChatModel,
    })

    const events = await drainStream(agent, [new HumanMessage('hi')])
    const done = events.find((event) => event.type === 'done')
    expect(done?.data?.content).toBe('only message')
  })
})

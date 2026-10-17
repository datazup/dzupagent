/**
 * DZUPAGENT-AGENT-H-12 parity — the native stream() path bounds a tool result
 * before it enters the model's history, with the same cap and marker as
 * generate(). The `tool_result` stream event keeps the raw output.
 */
import { describe, it, expect, vi } from 'vitest'
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { DzupAgent } from '../agent/dzip-agent.js'
import type { AgentStreamEvent, DzupAgentConfig } from '../agent/agent-types.js'
import { DEFAULT_MAX_TOOL_RESULT_CHARS } from '../agent/tool-loop/policy-enabled-tool-executor.js'

function capturingStreamingModel(responses: AIMessage[], calls: BaseMessage[][]): BaseChatModel {
  let idx = 0
  return {
    invoke: vi.fn(async () => responses.at(-1) ?? new AIMessage('done')),
    stream: vi.fn(async function* (msgs: BaseMessage[]) {
      calls.push([...msgs])
      yield responses[idx++] ?? responses.at(-1) ?? new AIMessage('done')
    }),
    bindTools: vi.fn().mockReturnThis(),
    model: 'mock-stream-model',
  } as unknown as BaseChatModel
}

function bigTool(output: string): StructuredToolInterface {
  return {
    name: 'big',
    description: 'returns a large payload',
    schema: {} as never,
    lc_namespace: [] as string[],
    invoke: vi.fn(async () => output),
  } as unknown as StructuredToolInterface
}

async function streamOnce(output: string, overrides: Partial<DzupAgentConfig> = {}) {
  const calls: BaseMessage[][] = []
  const agent = new DzupAgent({
    id: 'stream-cap-agent',
    instructions: 'You are a test agent.',
    model: capturingStreamingModel([
      new AIMessage({ content: '', tool_calls: [{ id: 'tc_1', name: 'big', args: {} }] }),
      new AIMessage('done'),
    ], calls),
    tools: [bigTool(output)],
    ...overrides,
  })
  const events: AgentStreamEvent[] = []
  for await (const event of agent.stream([new HumanMessage('go')])) events.push(event)
  const toolMessage = calls[1]?.find((m) => m._getType() === 'tool')
  const toolResultEvent = events.find((e) => e.type === 'tool_result')
  return {
    context: String(toolMessage?.content ?? ''),
    eventResult: toolResultEvent?.type === 'tool_result' ? String(toolResultEvent.data['result']) : undefined,
  }
}

describe('stream() tool-result cap', () => {
  it('applies the default cap with no toolExecution config, inside the closed fence', async () => {
    const raw = 'y'.repeat(DEFAULT_MAX_TOOL_RESULT_CHARS + 10)
    const { context, eventResult } = await streamOnce(raw)
    expect(context).toContain(`[tool result truncated: kept ${DEFAULT_MAX_TOOL_RESULT_CHARS} of ${raw.length} characters]`)
    expect(context.trimEnd().endsWith('</untrusted_content>')).toBe(true)
    expect(eventResult).toBe(raw)
  })

  it('honours toolExecution.maxToolResultChars', async () => {
    const raw = 'x'.repeat(50_000)
    const { context } = await streamOnce(raw, { toolExecution: { maxToolResultChars: 5_000 } })
    expect(context).toContain('[tool result truncated: kept 5000 of 50000 characters]')
    expect(context.length).toBeLessThan(5_000 + 300)
  })

  it('leaves small results untouched', async () => {
    const { context } = await streamOnce('small')
    expect(context).toContain('small')
    expect(context).not.toContain('truncated')
  })
})

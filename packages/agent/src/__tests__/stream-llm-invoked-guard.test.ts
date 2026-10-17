/**
 * A throwing event bus on `llm:invoked` must not end a native stream() run:
 * the model call already succeeded, so the telemetry failure is logged and
 * the run completes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { DzupEvent, DzupEventBus } from '@dzupagent/core'
import { defaultLogger } from '@dzupagent/core/utils'
import { DzupAgent } from '../agent/dzip-agent.js'
import type { AgentStreamEvent } from '../agent/agent-types.js'

function streamingModel(reply: AIMessage): BaseChatModel {
  return {
    invoke: vi.fn(async () => reply),
    stream: vi.fn(async function* () {
      yield reply
    }),
    bindTools: vi.fn().mockReturnThis(),
    model: 'mock-stream-model',
  } as unknown as BaseChatModel
}

describe('stream() llm:invoked emission guard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('completes the run and logs when the bus throws on llm:invoked', async () => {
    const warnSpy = vi.spyOn(defaultLogger, 'warn').mockImplementation(() => {})
    const seen: string[] = []
    const eventBus = {
      emit: vi.fn((event: DzupEvent) => {
        seen.push(event.type)
        if (event.type === 'llm:invoked') throw new Error('sink down')
      }),
      on: vi.fn(() => () => {}),
      once: vi.fn(() => () => {}),
      onAny: vi.fn(() => () => {}),
    } as unknown as DzupEventBus

    const agent = new DzupAgent({
      id: 'stream-guard-agent',
      instructions: 'You are a test agent.',
      model: streamingModel(new AIMessage('hello')),
      eventBus,
    })
    const events: AgentStreamEvent[] = []
    for await (const event of agent.stream([new HumanMessage('hi')])) events.push(event)

    expect(seen).toContain('llm:invoked')
    const done = events.findLast((e) => e.type === 'done')
    expect(done?.type === 'done' ? done.data['stopReason'] : undefined).toBe('complete')
    expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('llm:invoked emission failed'))).toBe(true)
  })
})

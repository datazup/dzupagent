/**
 * Concurrency test — verifies that two concurrent `generate()` calls on the
 * same DzupAgent instance do NOT share per-run state (specifically the
 * memory frame). Prior to the fix the agent stored `lastMemoryFrame` as an
 * instance field that could be clobbered by a concurrent call.
 *
 * The fix threads the memory frame through the prepared run state so each
 * in-flight call owns its own frame.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'

import { DzupAgent } from '../agent/dzip-agent.js'

/**
 * Build a mock model whose `invoke` waits a tick before returning so we
 * can reliably interleave two concurrent runs.
 */
function createSlowModel(
  label: string,
  delayMs: number,
): {
  model: BaseChatModel
  invokeCalls: BaseMessage[][]
} {
  const invokeCalls: BaseMessage[][] = []
  const model = {
    invoke: vi.fn(async (msgs: BaseMessage[]) => {
      invokeCalls.push(msgs)
      await new Promise(resolve => setTimeout(resolve, delayMs))
      return new AIMessage(`done:${label}`)
    }),
    bindTools: vi.fn().mockReturnThis(),
    stream: vi.fn(),
  } as unknown as BaseChatModel

  return { model, invokeCalls }
}

describe('DzupAgent concurrency — per-run memory frame', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('removes lastMemoryFrame instance field (per-run plumbing only)', () => {
    const { model } = createSlowModel('x', 0)
    const agent = new DzupAgent({
      id: 'structural',
      instructions: 'Base instructions',
      model,
    })

    // The instance-level field has been removed as part of the fix; per-run
    // memory frames are threaded through prepareMessages()/run state.
    const withField = agent as unknown as { lastMemoryFrame?: unknown }
    expect(withField.lastMemoryFrame).toBeUndefined()
    expect('lastMemoryFrame' in withField).toBe(false)
  })

  it('prepareMessages() returns { messages, memoryFrame? } shape', async () => {
    const { model } = createSlowModel('shape', 0)
    const agent = new DzupAgent({
      id: 'shape-check',
      instructions: 'Base instructions',
      model,
    })

    const prepareMessages = (
      agent as unknown as {
        prepareMessages: (
          msgs: BaseMessage[],
        ) => Promise<{ messages: BaseMessage[]; memoryFrame?: unknown }>
      }
    ).prepareMessages.bind(agent)

    const result = await prepareMessages([new HumanMessage('hi')])
    expect(Array.isArray(result.messages)).toBe(true)
    // memoryFrame is optional — absent when no memory is configured.
    expect(result).toHaveProperty('messages')
  })

  it('fires two concurrent generate() calls without cross-contaminating state', async () => {
    // Memory service used to provide non-trivial memory context that would
    // have triggered the lastMemoryFrame write path in the pre-fix code.
    const memory = {
      get: vi.fn(async () => [{ text: 'stored fact' }]),
      formatForPrompt: vi.fn(
        (records: Array<Record<string, unknown>>) =>
          records.length === 0
            ? ''
            : `## Memory Context\n- ${String(records[0]?.['text'] ?? '')}`,
      ),
    }

    const { model } = createSlowModel('concurrent', 20)

    const agent = new DzupAgent({
      id: 'concurrent-agent',
      instructions: 'Base instructions',
      model,
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
    })

    // Fire two concurrent runs. If memory frame state were shared on the
    // instance, the later run could overwrite the earlier run's frame
    // before the earlier run reached maybeUpdateSummary().
    const settled = await Promise.allSettled([
      agent.generate([new HumanMessage('call A')]),
      agent.generate([new HumanMessage('call B')]),
    ])
    for (const r of settled) {
      if (r.status === 'rejected') {
        throw r.reason
      }
    }
    const [resultA, resultB] = settled.map(
      r => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof agent.generate>>>).value,
    )

    // Both calls must complete successfully and independently.
    expect(resultA!.content).toBe('done:concurrent')
    expect(resultB!.content).toBe('done:concurrent')

    // Each generate() call must produce its own distinct result object.
    expect(resultA).not.toBe(resultB)
    expect(resultA!.messages).not.toBe(resultB!.messages)

    // The instance must NOT retain a `lastMemoryFrame` field anymore.
    const instanceField = (agent as unknown as { lastMemoryFrame?: unknown }).lastMemoryFrame
    expect(instanceField).toBeUndefined()

    // Memory was loaded independently for each concurrent run.
    expect(memory.get).toHaveBeenCalledTimes(2)

    // Each invocation received its own distinct prepared-message array.
    expect(model.invoke).toHaveBeenCalledTimes(2)
    const calls = (model.invoke as ReturnType<typeof vi.fn>).mock.calls
    const firstPrepared = calls[0]?.[0] as BaseMessage[]
    const secondPrepared = calls[1]?.[0] as BaseMessage[]
    expect(firstPrepared).not.toBe(secondPrepared)

    // Human tails reflect each caller's distinct input — proving the
    // prepared message lists were NOT shared across the two runs.
    const humanA = firstPrepared.find(m => m._getType() === 'human') as HumanMessage | undefined
    const humanB = secondPrepared.find(m => m._getType() === 'human') as HumanMessage | undefined
    const humanContents = [humanA?.content, humanB?.content].map(c =>
      typeof c === 'string' ? c : JSON.stringify(c),
    )
    expect(humanContents).toContain('call A')
    expect(humanContents).toContain('call B')

    // Each run had its own SystemMessage instance.
    const sysA = firstPrepared.find(m => m instanceof SystemMessage)
    const sysB = secondPrepared.find(m => m instanceof SystemMessage)
    expect(sysA).toBeDefined()
    expect(sysB).toBeDefined()
  })

  it('concurrent prepareMessages() calls do not clobber a shared instance field', async () => {
    // Use a memory service whose formatForPrompt invocation captures a
    // unique value per call — this is the functional equivalent of the
    // memoryFrame pass-through for the purposes of proving per-run
    // isolation WITHOUT requiring the @dzupagent/memory-ipc Arrow runtime.
    let tick = 0
    const memory = {
      get: vi.fn(async () => {
        const localTick = ++tick
        // Give the event loop a chance to interleave before returning.
        await new Promise(resolve => setTimeout(resolve, 10))
        return [{ text: `fact-${localTick}` }]
      }),
      formatForPrompt: vi.fn((records: Array<Record<string, unknown>>) =>
        records.length === 0
          ? ''
          : `## Memory Context\n- ${String(records[0]?.['text'] ?? '')}`,
      ),
    }

    const { model } = createSlowModel('prep', 5)
    const agent = new DzupAgent({
      id: 'concurrent-prep',
      instructions: 'Base instructions',
      model,
      memory,
      memoryNamespace: 'facts',
      memoryScope: { project: 'demo' },
    })

    // Reach past the public surface to prepareMessages so we can observe
    // the per-run result directly for each call.
    const prepareMessages = (
      agent as unknown as {
        prepareMessages: (
          msgs: BaseMessage[],
        ) => Promise<{ messages: BaseMessage[]; memoryFrame?: unknown }>
      }
    ).prepareMessages.bind(agent)

    const [preparedA, preparedB] = await Promise.all([
      prepareMessages([new HumanMessage('A')]),
      prepareMessages([new HumanMessage('B')]),
    ])

    // Each concurrent call returned its own messages array.
    expect(preparedA.messages).not.toBe(preparedB.messages)

    // Each run observed a DISTINCT memory fact (different tick value),
    // proving the per-call memory load did not share state.
    const systemA = preparedA.messages.find(m => m instanceof SystemMessage) as SystemMessage | undefined
    const systemB = preparedB.messages.find(m => m instanceof SystemMessage) as SystemMessage | undefined
    expect(systemA).toBeDefined()
    expect(systemB).toBeDefined()

    const contentA = typeof systemA!.content === 'string' ? systemA!.content : JSON.stringify(systemA!.content)
    const contentB = typeof systemB!.content === 'string' ? systemB!.content : JSON.stringify(systemB!.content)

    const factTagRe = /fact-(\d+)/
    const factA = factTagRe.exec(contentA)?.[1]
    const factB = factTagRe.exec(contentB)?.[1]
    expect(factA).toBeDefined()
    expect(factB).toBeDefined()
    expect(factA).not.toBe(factB)

    // Instance-level memoryFrame field must not exist.
    expect((agent as unknown as { lastMemoryFrame?: unknown }).lastMemoryFrame).toBeUndefined()
  })
})

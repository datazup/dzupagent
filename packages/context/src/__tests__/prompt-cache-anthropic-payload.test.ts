import { describe, it, expect } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import { applyCacheBreakpoints } from '../prompt-cache.js'

/**
 * Regression coverage for DZUPAGENT-AGENT-C-02.
 *
 * `applyCacheBreakpoints` used to write `cache_control` onto
 * `additional_kwargs` only. `@langchain/anthropic` (verified against the
 * installed 1.5.1, `dist/utils/message_inputs.js`) reads `cache_control`
 * **exclusively off content blocks**:
 *
 *   const cacheControl = "cache_control" in contentPart
 *     ? contentPart.cache_control : void 0
 *
 * `additional_kwargs` does not appear anywhere in that module, so every
 * breakpoint was dropped before serialization and prompt caching was inert.
 *
 * These tests assert the placement the provider actually consumes. The
 * authoritative check round-trips through `@langchain/anthropic`'s own
 * `convertPromptToAnthropic`; it is loaded dynamically because
 * `@dzupagent/context` deliberately does not take a hard dependency on a
 * provider package. The structural assertions below run unconditionally.
 */

type Block = { type?: string, text?: string, cache_control?: unknown, [k: string]: unknown }

function blocks(m: BaseMessage): Block[] {
  expect(Array.isArray(m.content)).toBe(true)
  return m.content as unknown as Block[]
}

function lastBlock(m: BaseMessage): Block {
  const b = blocks(m)
  return b[b.length - 1] as Block
}

/** Long enough to qualify as a content-addressed anchor (>= 2000 chars). */
const LONG = 'a considered and reasonably long assistant turn. '.repeat(60)

/**
 * Dynamically importing `@langchain/anthropic` pulls in the whole provider
 * package; under a parallel suite on a loaded box that comfortably exceeds
 * the 30s default.
 */
const SLOW = 240_000

describe('applyCacheBreakpoints — content-block placement (DZUPAGENT-AGENT-C-02)', () => {
  it('puts cache_control on a content block, not only additional_kwargs', () => {
    const result = applyCacheBreakpoints([
      new SystemMessage('You are a helpful assistant.'),
      new HumanMessage('hello'),
    ])

    const sys = result[0]!
    expect(lastBlock(sys)).toEqual({
      type: 'text',
      text: 'You are a helpful assistant.',
      cache_control: { type: 'ephemeral' },
    })

    const human = result[1]!
    expect(lastBlock(human).cache_control).toEqual({ type: 'ephemeral' })
    expect(lastBlock(human).type).toBe('text')
  })

  it('marks only the last block of an existing block array', () => {
    const msg = new HumanMessage({
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    })
    const result = applyCacheBreakpoints([new SystemMessage('sys'), msg])
    const b = blocks(result[1]!)
    expect(b).toHaveLength(2)
    expect(b[0]!.cache_control).toBeUndefined()
    expect(b[1]!.cache_control).toEqual({ type: 'ephemeral' })
    expect(b[1]!.text).toBe('second')
  })

  it('leaves unmarked messages as plain content (no spurious blocks)', () => {
    // 5 non-system messages: only the last 3 get breakpoints.
    const result = applyCacheBreakpoints([
      new SystemMessage('sys'),
      new HumanMessage('m1'),
      new AIMessage('m2'),
      new HumanMessage('m3'),
      new AIMessage('m4'),
      new HumanMessage('m5'),
    ])
    expect(result[1]!.content).toBe('m1')
    expect(result[2]!.content).toBe('m2')
    expect(lastBlock(result[3]!).cache_control).toEqual({ type: 'ephemeral' })
    expect(lastBlock(result[4]!).cache_control).toEqual({ type: 'ephemeral' })
    expect(lastBlock(result[5]!).cache_control).toEqual({ type: 'ephemeral' })
  })

  it('does not mutate the caller\'s messages', () => {
    const original = new HumanMessage('hello')
    applyCacheBreakpoints([new SystemMessage('sys'), original])
    expect(original.content).toBe('hello')
    expect(original.additional_kwargs.cache_control).toBeUndefined()
  })

  it('does not create an empty text block for empty content', () => {
    const empty = new AIMessage('')
    const result = applyCacheBreakpoints([new SystemMessage('sys'), empty])
    expect(result[1]!.content).toBe('')
  })

  it('serializes into an Anthropic request payload carrying cache_control', async () => {
    let convertPromptToAnthropic: ((p: unknown) => {
      system?: unknown
      messages: Array<{ role: string, content: unknown }>
    }) | undefined
    let ChatPromptValue: (new (m: BaseMessage[]) => unknown) | undefined
    try {
      ;({ convertPromptToAnthropic } = (await import('@langchain/anthropic')) as never)
      ;({ ChatPromptValue } = (await import('@langchain/core/prompt_values')) as never)
    } catch {
      // Provider package not installed in this environment.
    }
    if (!convertPromptToAnthropic || !ChatPromptValue) {
      throw new Error(
        '@langchain/anthropic is required for the AGENT-C-02 payload assertion',
      )
    }

    const marked = applyCacheBreakpoints([
      new SystemMessage('You are a helpful assistant.'),
      new HumanMessage(LONG),
      new AIMessage(LONG),
      new ToolMessage({ content: LONG, tool_call_id: 'call_1' }),
    ])

    const payload = convertPromptToAnthropic(new ChatPromptValue(marked))
    const serialized = JSON.stringify(payload)

    // The marker survives conversion — this is the assertion the old
    // additional_kwargs placement could never satisfy.
    expect(serialized).toContain('cache_control')

    // System prelude carries the breakpoint on its content block.
    expect(payload.system).toEqual([
      {
        type: 'text',
        text: 'You are a helpful assistant.',
        cache_control: { type: 'ephemeral' },
      },
    ])

    // Every converted message carries at least one marked block.
    for (const m of payload.messages) {
      expect(Array.isArray(m.content)).toBe(true)
      expect(JSON.stringify(m.content)).toContain('"cache_control"')
    }

    // Tool results keep their Anthropic shape (tool_use_id preserved).
    const toolMsg = payload.messages.at(-1)!
    const toolBlock = (toolMsg.content as Block[])[0]!
    expect(toolBlock.type).toBe('tool_result')
    expect(toolBlock.tool_use_id).toBe('call_1')
  }, SLOW)

  it('proves additional_kwargs alone is dropped by the provider', async () => {
    const { convertPromptToAnthropic } = (await import('@langchain/anthropic')) as never as {
      convertPromptToAnthropic: (p: unknown) => { system?: unknown, messages: unknown[] }
    }
    const { ChatPromptValue } = (await import('@langchain/core/prompt_values')) as never as {
      ChatPromptValue: new (m: BaseMessage[]) => unknown
    }

    const human = new HumanMessage('hello')
    human.additional_kwargs = { cache_control: { type: 'ephemeral' } }
    const payload = convertPromptToAnthropic(
      new ChatPromptValue([new SystemMessage('sys'), human]),
    )
    // Documents the defect this finding fixed: the old placement is invisible.
    expect(JSON.stringify(payload)).not.toContain('cache_control')
  }, SLOW)
})

import { describe, it, expect } from 'vitest'
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import {
  applyAnthropicCacheControl,
  applyCacheBreakpoints,
} from '../prompt-cache.js'

// ---------------------------------------------------------------------------
// applyAnthropicCacheControl (raw Anthropic format)
// ---------------------------------------------------------------------------

describe('applyAnthropicCacheControl', () => {
  describe('system prompt caching', () => {
    it('wraps a string system prompt into a content block with cache_control', () => {
      const { system } = applyAnthropicCacheControl('You are helpful.', [])

      expect(system).toHaveLength(1)
      expect(system[0]).toEqual({
        type: 'text',
        text: 'You are helpful.',
        cache_control: { type: 'ephemeral' },
      })
    })

    it('marks the last block of an array system prompt', () => {
      const blocks = [
        { type: 'text', text: 'Part 1' },
        { type: 'text', text: 'Part 2' },
      ]
      const { system } = applyAnthropicCacheControl(blocks, [])

      expect(system[0]).not.toHaveProperty('cache_control')
      expect(system[1]).toEqual({
        type: 'text',
        text: 'Part 2',
        cache_control: { type: 'ephemeral' },
      })
    })

    it('handles empty array system prompt', () => {
      const { system } = applyAnthropicCacheControl([], [])
      expect(system).toEqual([])
    })

    it('handles single-block array system prompt', () => {
      const blocks = [{ type: 'text', text: 'Only block' }]
      const { system } = applyAnthropicCacheControl(blocks, [])

      expect(system[0]).toEqual({
        type: 'text',
        text: 'Only block',
        cache_control: { type: 'ephemeral' },
      })
    })
  })

  describe('message caching', () => {
    it('marks the last 3 messages with cache_control', () => {
      const msgs = [
        { role: 'user', content: 'msg 1' },
        { role: 'assistant', content: 'msg 2' },
        { role: 'user', content: 'msg 3' },
        { role: 'assistant', content: 'msg 4' },
        { role: 'user', content: 'msg 5' },
      ]

      const { messages } = applyAnthropicCacheControl('system', msgs)

      // Last 3 should be marked (msg 3, 4, 5)
      // msg 1 and 2 should NOT be marked
      expect(messages[0]!.content).toBe('msg 1')
      expect(messages[1]!.content).toBe('msg 2')

      // Marked messages should have content blocks with cache_control
      for (let i = 2; i < 5; i++) {
        const content = messages[i]!.content
        expect(Array.isArray(content)).toBe(true)
        const blocks = content as Array<{ cache_control?: { type: string } }>
        expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral' })
      }
    })

    it('marks all messages when there are fewer than 3', () => {
      const msgs = [
        { role: 'user', content: 'only msg' },
      ]

      const { messages } = applyAnthropicCacheControl('system', msgs)

      const content = messages[0]!.content
      expect(Array.isArray(content)).toBe(true)
      const blocks = content as Array<{ cache_control?: { type: string } }>
      expect(blocks[0]!.cache_control).toEqual({ type: 'ephemeral' })
    })

    it('handles exactly 3 messages (all marked)', () => {
      const msgs = [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ]

      const { messages } = applyAnthropicCacheControl('system', msgs)

      for (const m of messages) {
        const content = m.content
        expect(Array.isArray(content)).toBe(true)
      }
    })

    it('handles messages with array content blocks', () => {
      const msgs = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'text', text: 'world' },
          ],
        },
      ]

      const { messages } = applyAnthropicCacheControl('system', msgs)

      const content = messages[0]!.content as Array<{ type: string; text?: string; cache_control?: { type: string } }>
      // Should mark the last block of the content array
      expect(content[0]).not.toHaveProperty('cache_control')
      expect(content[1]!.cache_control).toEqual({ type: 'ephemeral' })
    })

    it('handles empty messages array', () => {
      const { messages } = applyAnthropicCacheControl('system', [])
      expect(messages).toEqual([])
    })

    it('does not mutate original messages', () => {
      const original = [{ role: 'user', content: 'test' }]
      const originalContent = original[0]!.content

      applyAnthropicCacheControl('system', original)

      expect(original[0]!.content).toBe(originalContent)
    })

    it('handles message with empty array content', () => {
      const msgs = [{ role: 'user', content: [] as Array<{ type: string }> }]

      const { messages } = applyAnthropicCacheControl('system', msgs)

      // Empty content array, no blocks to mark
      expect(messages[0]!.content).toEqual([])
    })
  })

  describe('total breakpoints', () => {
    it('uses at most 4 breakpoints (1 system + 3 messages)', () => {
      const msgs = Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `msg ${i}`,
      }))

      const { system, messages } = applyAnthropicCacheControl('sys', msgs)

      // 1 breakpoint on system
      expect(system[0]!.cache_control).toBeDefined()

      // Count message breakpoints
      let breakpoints = 0
      for (const m of messages) {
        if (Array.isArray(m.content)) {
          for (const block of m.content as Array<{ cache_control?: unknown }>) {
            if (block.cache_control) breakpoints++
          }
        }
      }
      expect(breakpoints).toBe(3)
    })
  })
})

// ---------------------------------------------------------------------------
// applyCacheBreakpoints (LangChain BaseMessage format)
// ---------------------------------------------------------------------------

describe('applyCacheBreakpoints', () => {
  it('returns empty array for empty input', () => {
    expect(applyCacheBreakpoints([])).toEqual([])
  })

  it('marks system messages with cache_control in additional_kwargs', () => {
    const msgs: BaseMessage[] = [
      new SystemMessage('You are helpful'),
      new HumanMessage('Hi'),
      new AIMessage('Hello'),
    ]

    const result = applyCacheBreakpoints(msgs)

    expect(result[0]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('marks the last 3 non-system messages', () => {
    const msgs: BaseMessage[] = [
      new SystemMessage('system'),
      new HumanMessage('msg 1'),
      new AIMessage('msg 2'),
      new HumanMessage('msg 3'),
      new AIMessage('msg 4'),
      new HumanMessage('msg 5'),
    ]

    const result = applyCacheBreakpoints(msgs)

    // System marked
    expect(result[0]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    // msg 1 and 2 NOT marked
    expect(result[1]!.additional_kwargs.cache_control).toBeUndefined()
    expect(result[2]!.additional_kwargs.cache_control).toBeUndefined()
    // msg 3, 4, 5 marked
    expect(result[3]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    expect(result[4]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    expect(result[5]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('marks all non-system messages when there are fewer than 3', () => {
    const msgs: BaseMessage[] = [
      new SystemMessage('system'),
      new HumanMessage('only user msg'),
    ]

    const result = applyCacheBreakpoints(msgs)

    expect(result[0]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    expect(result[1]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('does not mutate original messages', () => {
    const original = new HumanMessage('test')
    const originalKwargs = { ...original.additional_kwargs }

    applyCacheBreakpoints([original])

    expect(original.additional_kwargs).toEqual(originalKwargs)
  })

  it('handles messages without system messages', () => {
    const msgs: BaseMessage[] = [
      new HumanMessage('msg 1'),
      new AIMessage('msg 2'),
      new HumanMessage('msg 3'),
      new AIMessage('msg 4'),
    ]

    const result = applyCacheBreakpoints(msgs)

    // No system message, so only last 3 non-system messages marked
    expect(result[0]!.additional_kwargs.cache_control).toBeUndefined()
    expect(result[1]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    expect(result[2]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    expect(result[3]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('handles tool messages as non-system messages', () => {
    const msgs: BaseMessage[] = [
      new SystemMessage('system'),
      new HumanMessage('user'),
      new AIMessage({
        content: 'calling tool',
        tool_calls: [{ id: 'tc-1', name: 'test', args: {} }],
      }),
      new ToolMessage({ content: 'result', tool_call_id: 'tc-1' }),
      new AIMessage('final'),
    ]

    const result = applyCacheBreakpoints(msgs)

    // System marked
    expect(result[0]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    // user (index 1) not marked (4 non-system messages, only last 3 marked)
    expect(result[1]!.additional_kwargs.cache_control).toBeUndefined()
    // AI, Tool, AI (indices 2-4) marked
    expect(result[2]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    expect(result[3]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    expect(result[4]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('handles multiple system messages', () => {
    const msgs: BaseMessage[] = [
      new SystemMessage('system 1'),
      new SystemMessage('system 2'),
      new HumanMessage('user'),
      new AIMessage('assistant'),
    ]

    const result = applyCacheBreakpoints(msgs)

    // Both system messages should be marked
    expect(result[0]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    expect(result[1]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    // Last 2 non-system messages marked (only 2 non-system, so both)
    expect(result[2]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    expect(result[3]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('handles single system message only', () => {
    const msgs: BaseMessage[] = [new SystemMessage('alone')]

    const result = applyCacheBreakpoints(msgs)

    expect(result[0]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('preserves message type and content', () => {
    const msgs: BaseMessage[] = [
      new SystemMessage('sys'),
      new HumanMessage('hello'),
      new AIMessage('world'),
    ]

    const result = applyCacheBreakpoints(msgs)

    expect(result[0]!._getType()).toBe('system')
    expect(result[0]!.content).toBe('sys')
    expect(result[1]!._getType()).toBe('human')
    expect(result[1]!.content).toBe('hello')
    expect(result[2]!._getType()).toBe('ai')
    expect(result[2]!.content).toBe('world')
  })

  it('preserves existing additional_kwargs while adding cache_control', () => {
    const msg = new HumanMessage('test')
    msg.additional_kwargs = { custom: 'value' }

    const result = applyCacheBreakpoints([msg])

    expect(result[0]!.additional_kwargs.custom).toBe('value')
    expect(result[0]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('handles a realistic long conversation (rolling window)', () => {
    const msgs: BaseMessage[] = [new SystemMessage('system')]
    for (let i = 0; i < 20; i++) {
      msgs.push(new HumanMessage(`user ${i}`))
      msgs.push(new AIMessage(`assistant ${i}`))
    }

    const result = applyCacheBreakpoints(msgs)

    // System message marked
    expect(result[0]!.additional_kwargs.cache_control).toBeDefined()

    // Count non-system marked messages
    let markedCount = 0
    for (let i = 1; i < result.length; i++) {
      if (result[i]!.additional_kwargs.cache_control) markedCount++
    }
    expect(markedCount).toBe(3)

    // Only the last 3 non-system messages should be marked
    const lastThreeIndices = [result.length - 1, result.length - 2, result.length - 3]
    for (const idx of lastThreeIndices) {
      expect(result[idx]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    }
  })
})

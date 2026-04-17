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

describe('applyAnthropicCacheControl malformed input handling', () => {
  it('handles system blocks where last block has a custom shape', () => {
    const blocks = [
      { type: 'text', text: 'pre' },
      { type: 'image', source: { type: 'base64' } },
    ]
    const { system } = applyAnthropicCacheControl(blocks, [])
    expect(system).toHaveLength(2)
    expect((system[1] as { cache_control?: { type: string } }).cache_control).toEqual({ type: 'ephemeral' })
  })

  it('preserves extra metadata on message objects', () => {
    const msgs = [
      { role: 'user', content: 'hi', metadata: { id: 42 } },
    ]
    const { messages } = applyAnthropicCacheControl('sys', msgs)
    expect((messages[0] as { metadata?: { id: number } }).metadata).toEqual({ id: 42 })
  })

  it('handles a single user message (marks it)', () => {
    const msgs = [{ role: 'user', content: 'only one' }]
    const { messages } = applyAnthropicCacheControl('sys', msgs)
    const content = messages[0]!.content as Array<{ cache_control?: { type: string } }>
    expect(content[0]!.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('handles non-array non-string content defensively (returns msg unchanged)', () => {
    const msgs = [{ role: 'user', content: null as unknown as string }]
    const { messages } = applyAnthropicCacheControl('sys', msgs)
    expect(messages[0]!.content).toBeNull()
  })

  it('does not mutate input message references', () => {
    const originalBlocks = [{ type: 'text', text: 'a' }]
    const msgs = [{ role: 'user', content: originalBlocks }]
    const before = originalBlocks[0]
    applyAnthropicCacheControl('sys', msgs)
    expect(originalBlocks[0]).toBe(before)
    expect(originalBlocks[0]).not.toHaveProperty('cache_control')
  })
})

describe('applyCacheBreakpoints cache invalidation and edge scenarios', () => {
  it('returns the same empty array reference (not a new one) for empty input', () => {
    const input: BaseMessage[] = []
    const result = applyCacheBreakpoints(input)
    expect(result).toBe(input)
  })

  it('handles all-system messages (nothing to mark as non-system breakpoint)', () => {
    const msgs: BaseMessage[] = [
      new SystemMessage('a'),
      new SystemMessage('b'),
      new SystemMessage('c'),
    ]
    const result = applyCacheBreakpoints(msgs)
    for (const m of result) {
      expect(m.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    }
  })

  it('produces a new array, not the same reference, for non-empty input', () => {
    const msgs: BaseMessage[] = [new HumanMessage('a')]
    const result = applyCacheBreakpoints(msgs)
    expect(result).not.toBe(msgs)
    expect(result[0]).not.toBe(msgs[0])
  })

  it('clones additional_kwargs to avoid mutation (cache miss on original)', () => {
    const msg = new HumanMessage('test')
    msg.additional_kwargs = { existing: true }
    const result = applyCacheBreakpoints([msg])
    expect(result[0]!.additional_kwargs).not.toBe(msg.additional_kwargs)
    expect(msg.additional_kwargs).toEqual({ existing: true })
  })

  it('preserves the message prototype chain on clones', () => {
    const ai = new AIMessage('content')
    const result = applyCacheBreakpoints([ai])
    expect(result[0]).toBeInstanceOf(AIMessage)
    expect(result[0]!._getType()).toBe('ai')
  })

  it('preserves tool_call_id on cloned ToolMessage', () => {
    const msgs: BaseMessage[] = [
      new AIMessage({
        content: 'call',
        tool_calls: [{ id: 'tc-1', name: 't', args: {} }],
      }),
      new ToolMessage({ content: 'result', tool_call_id: 'tc-1', name: 't' }),
    ]
    const result = applyCacheBreakpoints(msgs)
    const cloned = result[1] as ToolMessage
    expect(cloned.tool_call_id).toBe('tc-1')
    expect(cloned).toBeInstanceOf(ToolMessage)
  })

  it('handles exactly 3 non-system messages (all marked)', () => {
    const msgs: BaseMessage[] = [
      new SystemMessage('sys'),
      new HumanMessage('a'),
      new AIMessage('b'),
      new HumanMessage('c'),
    ]
    const result = applyCacheBreakpoints(msgs)
    expect(result[1]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    expect(result[2]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
    expect(result[3]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('handles messages preserving tool_calls array on AIMessage', () => {
    const ai = new AIMessage({
      content: 'calling',
      tool_calls: [{ id: 'tc-1', name: 'my_tool', args: { foo: 'bar' } }],
    })
    const result = applyCacheBreakpoints([ai])
    const cloned = result[0] as AIMessage
    expect(cloned.tool_calls).toBeDefined()
    expect(cloned.tool_calls?.[0]?.name).toBe('my_tool')
  })

  it('handles message with preexisting cache_control key (overwrites)', () => {
    const msg = new HumanMessage('x')
    msg.additional_kwargs = { cache_control: { type: 'other' } as unknown as { type: 'ephemeral' } }
    const result = applyCacheBreakpoints([msg])
    expect(result[0]!.additional_kwargs.cache_control).toEqual({ type: 'ephemeral' })
  })
})

describe('applyAnthropicCacheControl breakpoint budget enforcement', () => {
  it('never exceeds 4 total cache breakpoints regardless of message count', () => {
    const msgs = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg ${i}`,
    }))
    const { system, messages } = applyAnthropicCacheControl('sys', msgs)

    let total = 0
    if (Array.isArray(system)) {
      for (const block of system as Array<{ cache_control?: unknown }>) {
        if (block.cache_control) total++
      }
    }
    for (const m of messages) {
      if (Array.isArray(m.content)) {
        for (const block of m.content as Array<{ cache_control?: unknown }>) {
          if (block.cache_control) total++
        }
      }
    }
    expect(total).toBeLessThanOrEqual(4)
  })

  it('marks fewer than 3 messages when conversation is short', () => {
    const msgs = [{ role: 'user', content: 'solo' }]
    const { messages } = applyAnthropicCacheControl('sys', msgs)
    const content = messages[0]!.content as Array<{ cache_control?: unknown }>
    expect(content[0]!.cache_control).toBeDefined()
  })
})

describe('applyCacheBreakpoints with realistic Claude Code-like inputs', () => {
  it('handles a multi-turn tool conversation', () => {
    const msgs: BaseMessage[] = [
      new SystemMessage('You are an agent'),
      new HumanMessage('list files'),
      new AIMessage({
        content: 'ok',
        tool_calls: [{ id: 'tc-ls', name: 'ls', args: {} }],
      }),
      new ToolMessage({ content: 'file1.ts\nfile2.ts', tool_call_id: 'tc-ls' }),
      new AIMessage('done'),
    ]
    const result = applyCacheBreakpoints(msgs)
    expect(result.length).toBe(msgs.length)
    expect(result[0]!.additional_kwargs.cache_control).toBeDefined()
  })

  it('handles system-only conversation (no user messages)', () => {
    const msgs: BaseMessage[] = [
      new SystemMessage('standalone instructions'),
    ]
    const result = applyCacheBreakpoints(msgs)
    expect(result[0]!.additional_kwargs.cache_control).toBeDefined()
  })
})

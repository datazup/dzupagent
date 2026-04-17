import { describe, it, expect, vi } from 'vitest'
import { HumanMessage, AIMessage, ToolMessage, SystemMessage } from '@langchain/core/messages'
import { createExtractionHook, type MessageExtractionFn } from '../extraction-bridge.js'

describe('createExtractionHook', () => {
  // -----------------------------------------------------------------------
  // Basic behavior
  // -----------------------------------------------------------------------

  it('calls extractFn with filtered human and ai messages', async () => {
    const extractFn = vi.fn<MessageExtractionFn>()
    const hook = createExtractionHook(extractFn)

    const messages = [
      new HumanMessage('hello'),
      new AIMessage('hi there'),
      new ToolMessage({ content: 'result', tool_call_id: 'tc-1' }),
      new HumanMessage('next question'),
    ]

    await hook(messages)

    expect(extractFn).toHaveBeenCalledTimes(1)
    const passedMessages = extractFn.mock.calls[0]![0]
    // Should filter out the ToolMessage
    expect(passedMessages.length).toBe(3)
    expect(passedMessages.every(m => m._getType() === 'human' || m._getType() === 'ai')).toBe(true)
  })

  it('does not call extractFn when no messages match the filter', async () => {
    const extractFn = vi.fn<MessageExtractionFn>()
    const hook = createExtractionHook(extractFn)

    const messages = [
      new ToolMessage({ content: 'result', tool_call_id: 'tc-1' }),
      new SystemMessage('system msg'),
    ]

    await hook(messages)

    expect(extractFn).not.toHaveBeenCalled()
  })

  it('does not call extractFn for empty messages', async () => {
    const extractFn = vi.fn<MessageExtractionFn>()
    const hook = createExtractionHook(extractFn)

    await hook([])

    expect(extractFn).not.toHaveBeenCalled()
  })

  // -----------------------------------------------------------------------
  // maxMessages option
  // -----------------------------------------------------------------------

  it('limits messages to maxMessages (takes last N)', async () => {
    const extractFn = vi.fn<MessageExtractionFn>()
    const hook = createExtractionHook(extractFn, { maxMessages: 2 })

    const messages = [
      new HumanMessage('first'),
      new AIMessage('second'),
      new HumanMessage('third'),
      new AIMessage('fourth'),
    ]

    await hook(messages)

    expect(extractFn).toHaveBeenCalledTimes(1)
    const passedMessages = extractFn.mock.calls[0]![0]
    expect(passedMessages.length).toBe(2)
    // Should be the LAST 2 messages
    expect((passedMessages[0]!.content as string)).toBe('third')
    expect((passedMessages[1]!.content as string)).toBe('fourth')
  })

  it('uses default maxMessages of 20', async () => {
    const extractFn = vi.fn<MessageExtractionFn>()
    const hook = createExtractionHook(extractFn)

    // Create 25 human messages
    const messages = Array.from({ length: 25 }, (_, i) => new HumanMessage(`msg ${i}`))

    await hook(messages)

    const passedMessages = extractFn.mock.calls[0]![0]
    expect(passedMessages.length).toBe(20)
    // Should be last 20
    expect((passedMessages[0]!.content as string)).toBe('msg 5')
  })

  it('passes all messages when fewer than maxMessages', async () => {
    const extractFn = vi.fn<MessageExtractionFn>()
    const hook = createExtractionHook(extractFn, { maxMessages: 50 })

    const messages = [
      new HumanMessage('one'),
      new AIMessage('two'),
    ]

    await hook(messages)

    expect(extractFn.mock.calls[0]![0].length).toBe(2)
  })

  // -----------------------------------------------------------------------
  // Custom messageTypes
  // -----------------------------------------------------------------------

  it('respects custom messageTypes filter', async () => {
    const extractFn = vi.fn<MessageExtractionFn>()
    const hook = createExtractionHook(extractFn, { messageTypes: ['tool'] })

    const messages = [
      new HumanMessage('hello'),
      new AIMessage('hi'),
      new ToolMessage({ content: 'result', tool_call_id: 'tc-1' }),
    ]

    await hook(messages)

    expect(extractFn).toHaveBeenCalledTimes(1)
    const passedMessages = extractFn.mock.calls[0]![0]
    expect(passedMessages.length).toBe(1)
    expect(passedMessages[0]!._getType()).toBe('tool')
  })

  it('can filter for system messages only', async () => {
    const extractFn = vi.fn<MessageExtractionFn>()
    const hook = createExtractionHook(extractFn, { messageTypes: ['system'] })

    const messages = [
      new SystemMessage('sys'),
      new HumanMessage('hello'),
      new AIMessage('hi'),
    ]

    await hook(messages)

    const passedMessages = extractFn.mock.calls[0]![0]
    expect(passedMessages.length).toBe(1)
    expect(passedMessages[0]!._getType()).toBe('system')
  })

  it('handles combined maxMessages and messageTypes', async () => {
    const extractFn = vi.fn<MessageExtractionFn>()
    const hook = createExtractionHook(extractFn, {
      maxMessages: 2,
      messageTypes: ['human', 'ai', 'tool'],
    })

    const messages = [
      new HumanMessage('a'),
      new AIMessage('b'),
      new ToolMessage({ content: 'c', tool_call_id: 'tc-1' }),
      new HumanMessage('d'),
    ]

    await hook(messages)

    const passedMessages = extractFn.mock.calls[0]![0]
    expect(passedMessages.length).toBe(2)
    // Last 2 of the 4 filtered messages
    expect((passedMessages[0]!.content as string)).toBe('c')
    expect((passedMessages[1]!.content as string)).toBe('d')
  })

  // -----------------------------------------------------------------------
  // Return value
  // -----------------------------------------------------------------------

  it('returns a function that returns a promise', async () => {
    const extractFn = vi.fn<MessageExtractionFn>().mockResolvedValue(undefined)
    const hook = createExtractionHook(extractFn)

    const result = hook([new HumanMessage('test')])
    expect(result).toBeInstanceOf(Promise)
    await result
  })
})

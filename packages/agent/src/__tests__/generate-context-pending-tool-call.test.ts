/**
 * DZC-P1c — `appendGenerateContext` must not split an assistant tool-call
 * message from the tool results that will follow it. When the transcript ends
 * with a pending tool-call exchange (e.g. a mid-turn compression adopted it),
 * the caller context goes immediately before that AI message.
 */
import { describe, expect, it } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import {
  appendGenerateContext,
  hasExactGenerateContextSuffix,
} from '../agent/run-engine/generate-context.js'

const CONTEXT = 'caller context'

function pendingToolCall(): AIMessage {
  return new AIMessage({
    content: '',
    tool_calls: [{ id: 'call-1', name: 'echo', args: {} }],
  })
}

function types(messages: BaseMessage[]): string[] {
  return messages.map(m => m._getType())
}

describe('appendGenerateContext — pending tool-call exchange (DZC-P1c)', () => {
  it('places the context before a trailing AI tool-call message', () => {
    const pending = pendingToolCall()
    const out = appendGenerateContext(
      [new SystemMessage('base'), new HumanMessage('hi'), pending],
      CONTEXT,
    )

    expect(types(out)).toEqual(['system', 'human', 'system', 'ai'])
    expect(out[2]!.content).toBe(CONTEXT)
    expect(out.at(-1)).toBe(pending)
  })

  it('moves a context that sits after the pending AI message in front of it', () => {
    const pending = pendingToolCall()
    const out = appendGenerateContext(
      [
        new SystemMessage(CONTEXT),
        new HumanMessage('hi'),
        pending,
      ],
      CONTEXT,
    )

    expect(types(out)).toEqual(['human', 'system', 'ai'])
    expect(out.at(-1)).toBe(pending)
  })

  it('is idempotent on the pending-exchange slot', () => {
    const once = appendGenerateContext(
      [new HumanMessage('hi'), pendingToolCall()],
      CONTEXT,
    )
    expect(hasExactGenerateContextSuffix(once, CONTEXT)).toBe(true)
    expect(appendGenerateContext(once, CONTEXT)).toBe(once)
  })

  it('still appends at the end once the tool results are in', () => {
    const out = appendGenerateContext(
      [
        new HumanMessage('hi'),
        pendingToolCall(),
        new ToolMessage({ content: 'r', tool_call_id: 'call-1' }),
      ],
      CONTEXT,
    )

    expect(types(out)).toEqual(['human', 'ai', 'tool', 'system'])
  })

  it('still appends at the end after a plain AI answer', () => {
    const out = appendGenerateContext(
      [new HumanMessage('hi'), new AIMessage('answer')],
      CONTEXT,
    )

    expect(types(out)).toEqual(['human', 'ai', 'system'])
  })
})

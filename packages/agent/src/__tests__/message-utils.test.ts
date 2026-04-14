import { describe, expect, it } from 'vitest'
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages'
import { estimateTokens, formatSummaryContext } from '@dzupagent/core'

import {
  buildPreparedMessages,
  estimateConversationTokensForMessages,
  extractFinalAiMessageContent,
} from '../agent/message-utils.js'

describe('message-utils', () => {
  it('builds prepared messages with memory and summary context after base instructions', () => {
    const messages = [new HumanMessage('Review this diff')]
    const prepared = buildPreparedMessages({
      baseInstructions: 'Base instructions',
      memoryContext: '## Memory Context\n- prior fact',
      conversationSummary: 'Conversation summary',
      messages,
    })

    expect(prepared).toHaveLength(2)
    expect(prepared[0]).toBeInstanceOf(SystemMessage)
    expect((prepared[0] as SystemMessage).content).toBe(
      [
        'Base instructions',
        '## Memory Context\n- prior fact',
        formatSummaryContext('Conversation summary'),
      ].join('\n\n'),
    )
    expect(prepared[1]).toBe(messages[0])
  })

  it('preserves empty base instructions shape when only memory context is added', () => {
    const prepared = buildPreparedMessages({
      baseInstructions: '',
      memoryContext: '## Memory Context\n- retained',
      conversationSummary: null,
      messages: [],
    })

    expect((prepared[0] as SystemMessage).content).toBe('\n\n## Memory Context\n- retained')
  })

  it('estimates tokens using the same concatenated message content semantics as DzupAgent', () => {
    const messages = [
      new HumanMessage('hello'),
      new AIMessage([{ type: 'text', text: 'world' }]),
    ]

    expect(estimateConversationTokensForMessages(messages)).toBe(
      estimateTokens('hello' + JSON.stringify([{ type: 'text', text: 'world' }])),
    )
  })

  it('extracts the last AI message content as string or JSON payload', () => {
    const messages = [
      new HumanMessage('first'),
      new AIMessage('draft'),
      new AIMessage([{ type: 'text', text: 'final' }]),
    ]

    expect(extractFinalAiMessageContent(messages)).toBe(
      JSON.stringify([{ type: 'text', text: 'final' }]),
    )
  })

  it('extracts content from an ai-typed base message stub without relying on AIMessage instances', () => {
    const messages = [
      new HumanMessage('first'),
      {
        content: 'stub final',
        _getType: () => 'ai',
      } as BaseMessage,
    ]

    expect(extractFinalAiMessageContent(messages)).toBe('stub final')
  })

  it('returns empty string when no AI message exists', () => {
    expect(extractFinalAiMessageContent([new HumanMessage('only human')])).toBe('')
  })
})

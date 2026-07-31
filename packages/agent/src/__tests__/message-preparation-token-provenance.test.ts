import { describe, expect, it, vi } from 'vitest'
import { HumanMessage, AIMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { Tokenizer } from '@dzupagent/core/llm'
import { maybeUpdateSummary } from '../agent/message-preparation.js'

function tokenizerWithDetailedCount(tokens: number): Tokenizer {
  return {
    model: 'test-exact',
    encode: () => [],
    countTokens: () => tokens,
    countDetailed: () => ({
      tokens,
      method: 'exact',
      model: 'test-exact',
    }),
    countMessages: () => tokens,
  }
}

describe('message preparation token provenance', () => {
  it('uses the resolved tokenizer for the rolling-summary trigger and summary budget', async () => {
    const invoke = vi.fn().mockResolvedValue(new AIMessage('new summary'))
    const summary = {
      value: null as string | null,
      get() {
        return this.value
      },
      set(value: string | null) {
        this.value = value
      },
    }

    await maybeUpdateSummary(
      {
        agentId: 'agent-1',
        config: {
          id: 'agent-1',
          instructions: 'test',
          model: 'gpt-4o',
          messageConfig: {
            maxMessages: 100,
            maxMessageTokens: 10,
            keepRecentMessages: 1,
          },
        },
        resolvedModel: { invoke } as unknown as BaseChatModel,
        tokenizer: tokenizerWithDetailedCount(100),
        summary,
      },
      [new HumanMessage('short'), new AIMessage('also short')],
    )

    expect(invoke).toHaveBeenCalledOnce()
    expect(summary.value).toBe('new summary')
  })
})

import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import { describe, expect, it, vi } from 'vitest'

import type { TokenCounter } from '../../token-lifecycle.js'
import { compactCompletedToolResults } from '../compact-completed-tool-results.js'
import type { CompletedToolCompactionProfileV1 } from '../types.js'

const exactCounter: TokenCounter = {
  count(text) {
    return Math.ceil(text.length / 4)
  },
  countDetailed(text) {
    return { tokens: Math.ceil(text.length / 4), method: 'exact', model: 'test-exact' }
  },
}

function profile(
  overrides: Partial<CompletedToolCompactionProfileV1> = {},
): CompletedToolCompactionProfileV1 {
  return {
    schema: 'datazup.context.completed-tool-compaction-profile/v1',
    preserveRecentCompletedPairs: 1,
    minimumResultTokens: 8,
    maxCompactedResults: 8,
    measurement: 'require-tokenizer',
    ...overrides,
  }
}

function call(id: string, name = 'lookup'): AIMessage {
  return new AIMessage({
    content: `calling ${name}`,
    tool_calls: [{ id, name, args: { query: id } }],
  })
}

function result(id: string, content = 'x'.repeat(400)): ToolMessage {
  return new ToolMessage({ content, tool_call_id: id, name: 'lookup' })
}

describe('compactCompletedToolResults', () => {
  it('compacts only old fully completed pairs and preserves the recent prefix shape', () => {
    const messages: BaseMessage[] = [
      new HumanMessage('start'),
      call('call-old'),
      result('call-old'),
      call('call-recent'),
      result('call-recent'),
      new HumanMessage('continue'),
    ]

    const compacted = compactCompletedToolResults(messages, profile(), {
      tokenCounter: exactCounter,
      model: 'test-exact',
    })

    expect(compacted.status).toBe('completed')
    expect(compacted.reason).toBe('compacted')
    expect(compacted.compactedToolCallIds).toEqual(['call-old'])
    expect(compacted.reclaimedTokens).toBeGreaterThan(0)
    expect(compacted.afterTokens).toBeLessThan(compacted.beforeTokens)
    expect(compacted.messages).not.toBe(messages)
    expect(compacted.messages[0]).toBe(messages[0])
    expect(compacted.messages[1]).toBe(messages[1])
    expect(compacted.messages[3]).toBe(messages[3])
    expect(compacted.messages[4]).toBe(messages[4])
    expect((compacted.messages[2] as ToolMessage).content).toBe(
      '[Completed tool result compacted]',
    )
    expect((messages[2] as ToolMessage).content).toBe('x'.repeat(400))
  })

  it('preserves tool identity, status, artifact, metadata, and response fields on a detached clone', () => {
    const original = new ToolMessage({
      id: 'message-id',
      content: 'sensitive-output'.repeat(50),
      tool_call_id: 'call-1',
      name: 'lookup',
      status: 'error',
      artifact: { retained: ['host-only'] },
      metadata: { trace: 'trace-1' },
      additional_kwargs: { provider: { request: 'request-1' } },
      response_metadata: { usage: { input_tokens: 12 } },
    })
    const messages: BaseMessage[] = [call('call-1'), original]

    const compacted = compactCompletedToolResults(
      messages,
      profile({ preserveRecentCompletedPairs: 0 }),
      { tokenCounter: exactCounter },
    )
    const replacement = compacted.messages[1] as ToolMessage

    expect(compacted.status).toBe('completed')
    expect(replacement).toBeInstanceOf(ToolMessage)
    expect(replacement).not.toBe(original)
    expect(replacement).toMatchObject({
      id: 'message-id',
      tool_call_id: 'call-1',
      name: 'lookup',
      status: 'error',
      artifact: { retained: ['host-only'] },
      metadata: { trace: 'trace-1' },
      additional_kwargs: { provider: { request: 'request-1' } },
      response_metadata: { usage: { input_tokens: 12 } },
    })
    expect(replacement.artifact).not.toBe(original.artifact)
    expect(replacement.metadata).not.toBe(original.metadata)
    expect(replacement.additional_kwargs).not.toBe(original.additional_kwargs)
    expect(original.content).toBe('sensitive-output'.repeat(50))
  })

  it('retains incomplete tool-call groups untouched', () => {
    const messages: BaseMessage[] = [
      new AIMessage({
        content: 'two calls',
        tool_calls: [
          { id: 'call-1', name: 'lookup', args: {} },
          { id: 'call-2', name: 'lookup', args: {} },
        ],
      }),
      result('call-1'),
      new HumanMessage('interrupted'),
    ]

    const compacted = compactCompletedToolResults(
      messages,
      profile({ preserveRecentCompletedPairs: 0 }),
      { tokenCounter: exactCounter },
    )

    expect(compacted).toMatchObject({
      status: 'unchanged',
      reason: 'no-eligible-results',
      reclaimedTokens: 0,
    })
    expect(compacted.messages).toBe(messages)
  })

  it.each([
    {
      name: 'orphan result',
      messages: [result('missing')],
    },
    {
      name: 'reordered results',
      messages: [
        new AIMessage({
          content: 'two calls',
          tool_calls: [
            { id: 'call-1', name: 'lookup', args: {} },
            { id: 'call-2', name: 'lookup', args: {} },
          ],
        }),
        result('call-2'),
        result('call-1'),
      ],
    },
    {
      name: 'duplicate result',
      messages: [call('call-1'), result('call-1'), result('call-1')],
    },
    {
      name: 'late result for an incomplete group',
      messages: [call('call-1'), new HumanMessage('interrupted'), result('call-1')],
    },
  ])('rejects $name without changing the transcript', ({ messages }) => {
    const compacted = compactCompletedToolResults(
      messages,
      profile({ preserveRecentCompletedPairs: 0 }),
      { tokenCounter: exactCounter },
    )

    expect(compacted.status).toBe('rejected')
    expect(compacted.reason).toBe('invalid-tool-pairing')
    expect(compacted.messages).toBe(messages)
  })

  it('stops at the bounded result limit and reports an unmet target as partial', () => {
    const messages: BaseMessage[] = [
      call('call-1'), result('call-1'),
      call('call-2'), result('call-2'),
    ]
    const compacted = compactCompletedToolResults(
      messages,
      profile({
        preserveRecentCompletedPairs: 0,
        maxCompactedResults: 1,
        targetReclaimedTokens: 10_000,
      }),
      { tokenCounter: exactCounter },
    )

    expect(compacted.status).toBe('partial')
    expect(compacted.reason).toBe('target-not-met')
    expect(compacted.compactedToolCallIds).toEqual(['call-1'])
    expect((compacted.messages[3] as ToolMessage).content).toBe('x'.repeat(400))
  })

  it('rejects an unproven measurement when the profile requires a tokenizer', () => {
    const messages: BaseMessage[] = [call('call-1'), result('call-1')]
    const compacted = compactCompletedToolResults(
      messages,
      profile({ preserveRecentCompletedPairs: 0 }),
    )

    expect(compacted).toMatchObject({
      status: 'rejected',
      reason: 'token-measurement-unproven',
      measurementMethod: 'heuristic',
    })
    expect(compacted.messages).toBe(messages)
  })

  it('validates pairing before exposing transcript text to a token counter', () => {
    const counter: TokenCounter = {
      count: vi.fn(() => 1),
      countDetailed: vi.fn(() => ({ tokens: 1, method: 'exact' as const })),
    }
    const messages: BaseMessage[] = [result('orphan')]

    const compacted = compactCompletedToolResults(
      messages,
      profile({ preserveRecentCompletedPairs: 0 }),
      { tokenCounter: counter },
    )

    expect(compacted.reason).toBe('invalid-tool-pairing')
    expect(counter.count).not.toHaveBeenCalled()
    expect(counter.countDetailed).not.toHaveBeenCalled()
  })

  it('rejects atomically if tokenizer provenance degrades during replacement measurement', () => {
    let detailedCalls = 0
    const intermittent: TokenCounter = {
      count(text) {
        return Math.ceil(text.length / 4)
      },
      countDetailed(text) {
        detailedCalls += 1
        if (detailedCalls === 3) throw new Error('tokenizer unavailable')
        return { tokens: Math.ceil(text.length / 4), method: 'exact' }
      },
    }
    const messages: BaseMessage[] = [call('call-1'), result('call-1')]

    const compacted = compactCompletedToolResults(
      messages,
      profile({ preserveRecentCompletedPairs: 0 }),
      { tokenCounter: intermittent },
    )

    expect(compacted).toMatchObject({
      status: 'rejected',
      reason: 'token-measurement-unproven',
      measurementMethod: 'exact',
    })
    expect(compacted.messages).toBe(messages)
    expect((messages[1] as ToolMessage).content).toBe('x'.repeat(400))
  })

  it('allows an explicitly admitted heuristic and remains idempotent', () => {
    const messages: BaseMessage[] = [call('call-1'), result('call-1')]
    const admitted = profile({
      preserveRecentCompletedPairs: 0,
      measurement: 'allow-heuristic',
    })
    const first = compactCompletedToolResults(messages, admitted)
    const second = compactCompletedToolResults(first.messages, admitted)

    expect(first.status).toBe('completed')
    expect(first.measurementMethod).toBe('heuristic')
    expect(second).toMatchObject({
      status: 'unchanged',
      reason: 'no-token-reclamation',
      reclaimedTokens: 0,
    })
    expect(second.messages).toBe(first.messages)
  })

  it('rejects accessor-bearing clone fields atomically', () => {
    const unsafe = result('call-2')
    Object.defineProperty(unsafe, 'artifact', {
      configurable: true,
      get() {
        throw new Error('must remain private')
      },
    })
    const messages: BaseMessage[] = [
      call('call-1'), result('call-1'),
      call('call-2'), unsafe,
    ]

    const compacted = compactCompletedToolResults(
      messages,
      profile({ preserveRecentCompletedPairs: 0 }),
      { tokenCounter: exactCounter },
    )

    expect(compacted.status).toBe('rejected')
    expect(compacted.reason).toBe('clone-rejected')
    expect(compacted.messages).toBe(messages)
    expect((messages[1] as ToolMessage).content).toBe('x'.repeat(400))
  })

  it('returns a fixed rejection for hostile array and profile proxies', () => {
    const hostileMessages = new Proxy([] as BaseMessage[], {
      get(target, property, receiver) {
        if (property === 'length') throw new Error('secret-array-value')
        return Reflect.get(target, property, receiver)
      },
    })
    const hostileProfile = new Proxy(profile(), {
      ownKeys() {
        throw new Error('secret-profile-value')
      },
    })

    expect(() => compactCompletedToolResults(hostileMessages, profile())).not.toThrow()
    expect(compactCompletedToolResults(hostileMessages, profile()).reason).toBe('invalid-input')
    expect(() => compactCompletedToolResults([], hostileProfile)).not.toThrow()
    expect(compactCompletedToolResults([], hostileProfile).reason).toBe('invalid-profile')
  })
})

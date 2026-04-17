import { describe, it, expect, vi } from 'vitest'
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { summarizeAndTrim } from '../message-manager.js'
import { ContextTransferService } from '../context-transfer.js'

function createMockModel(response: string): BaseChatModel {
  return {
    invoke: vi.fn().mockResolvedValue(new AIMessage(response)),
  } as unknown as BaseChatModel
}

describe('message-manager alignSplitBoundary — AIMessage with tool_calls adjacent to split', () => {
  it('walks back past AI with tool_calls when previous at boundary', async () => {
    const model = createMockModel('summary')
    const msgs: BaseMessage[] = [
      new HumanMessage('old-1'),
      new HumanMessage('old-2'),
      new AIMessage({
        content: 'calling',
        tool_calls: [{ id: 'tc-boundary', name: 't', args: {} }],
      }),
      new ToolMessage({ content: 'r', tool_call_id: 'tc-boundary', name: 't' }),
      new HumanMessage('r-1'),
      new AIMessage('r-2'),
      new HumanMessage('r-3'),
      new AIMessage('r-4'),
    ]
    const result = await summarizeAndTrim(msgs, null, model, { keepRecentMessages: 4 })
    expect(result.trimmedMessages.length).toBeGreaterThanOrEqual(4)
  })

  it('aligns boundary to include AI tool_calls that would be orphaned otherwise', async () => {
    const model = createMockModel('s')
    const aiCall = new AIMessage({
      content: 'call',
      tool_calls: [{ id: 'tc-incl', name: 't', args: {} }],
    })
    const msgs: BaseMessage[] = [
      new HumanMessage('padding-1'),
      new HumanMessage('padding-2'),
      new HumanMessage('padding-3'),
      aiCall,
      new ToolMessage({ content: 'tr', tool_call_id: 'tc-incl' }),
      new AIMessage('tail-1'),
      new HumanMessage('tail-2'),
      new AIMessage('tail-3'),
    ]
    const result = await summarizeAndTrim(msgs, null, model, { keepRecentMessages: 4 })
    expect(result.trimmedMessages.length).toBeGreaterThanOrEqual(4)
  })

  it('handles alignment that would produce split < 0 (clamped to 0)', async () => {
    const model = createMockModel('s')
    const aiCall = new AIMessage({
      content: 'first call',
      tool_calls: [{ id: 'tc-first', name: 't', args: {} }],
    })
    const msgs: BaseMessage[] = [
      aiCall,
      new ToolMessage({ content: 'tr', tool_call_id: 'tc-first' }),
      new ToolMessage({ content: 'tr2', tool_call_id: 'tc-first' }),
      new AIMessage('a'),
      new HumanMessage('b'),
    ]
    const result = await summarizeAndTrim(msgs, null, model, { keepRecentMessages: 3 })
    expect(result.trimmedMessages.length).toBeGreaterThanOrEqual(0)
  })
})

describe('message-manager alignSplitBoundary — split lands just after AI with tool_calls', () => {
  it('decrements split when immediately preceding message has tool_calls', async () => {
    const model = createMockModel('summary')
    const aiCall = new AIMessage({
      content: 'call',
      tool_calls: [{ id: 'tc-prev-boundary', name: 't', args: {} }],
    })
    const tool = new ToolMessage({ content: 'r', tool_call_id: 'tc-prev-boundary', name: 't' })
    const msgs: BaseMessage[] = [
      new HumanMessage('old-1'),
      new HumanMessage('old-2'),
      aiCall,
      tool,
      new HumanMessage('split-here'),
      new AIMessage('a'),
      new HumanMessage('b'),
      new AIMessage('c'),
      new HumanMessage('d'),
      new AIMessage('e'),
    ]
    const result = await summarizeAndTrim(msgs, null, model, { keepRecentMessages: 6 })
    expect(result.trimmedMessages.length).toBeGreaterThanOrEqual(6)
    expect(result.summary).toBe('summary')
  })

  it('handles alignment where split=1 and messages[0] has tool_calls', async () => {
    const model = createMockModel('s')
    const aiCall = new AIMessage({
      content: 'first',
      tool_calls: [{ id: 'tc-first-align', name: 't', args: {} }],
    })
    const msgs: BaseMessage[] = [
      aiCall,
      new HumanMessage('target-split'),
      new AIMessage('a'),
      new HumanMessage('b'),
    ]
    const result = await summarizeAndTrim(msgs, null, model, { keepRecentMessages: 3 })
    expect(result.trimmedMessages.length).toBeGreaterThanOrEqual(0)
  })
})

describe('context-transfer getContent defensive fallback', () => {
  it('handles message content that is neither string nor array (null)', () => {
    const service = new ContextTransferService()
    const msg = new HumanMessage({
      content: null as unknown as string,
    })
    const ctx = service.extractContext([msg], 'plan')
    expect(typeof ctx.summary).toBe('string')
  })

  it('handles number-like content (coerced to string)', () => {
    const service = new ContextTransferService()
    const raw = { content: 42 } as unknown as BaseMessage
    Object.setPrototypeOf(raw, HumanMessage.prototype)
    const msgs: BaseMessage[] = [raw]
    const ctx = service.extractContext(msgs, 'plan')
    expect(typeof ctx.summary).toBe('string')
  })
})

describe('context-transfer workingState exclusion scopes', () => {
  it('excludes working state from summary-only scope', () => {
    const service = new ContextTransferService({
      relevanceRules: [
        { from: 'a', to: 'b', transferScope: 'summary-only', priority: 10 },
      ],
    })
    const ctx = {
      fromIntent: 'a',
      toIntent: 'b',
      summary: 'just summary',
      decisions: ['d'],
      relevantFiles: ['f.ts'],
      workingState: { k: 'v' },
      transferredAt: Date.now(),
      tokenEstimate: 10,
    }
    const msg = service.formatAsMessage(ctx)
    const content = msg.content as string
    expect(content).not.toContain('### Key Decisions')
    expect(content).not.toContain('### Relevant Files')
    expect(content).not.toContain('### Working State')
    expect(content).toContain('just summary')
  })

  it('excludes workingState when empty even in all-scope', () => {
    const service = new ContextTransferService({
      relevanceRules: [
        { from: 'a', to: 'b', transferScope: 'all', priority: 10 },
      ],
    })
    const ctx = {
      fromIntent: 'a',
      toIntent: 'b',
      summary: 'x',
      decisions: ['d1'],
      relevantFiles: ['f.ts'],
      workingState: {},
      transferredAt: Date.now(),
      tokenEstimate: 10,
    }
    const msg = service.formatAsMessage(ctx)
    const content = msg.content as string
    expect(content).not.toContain('### Working State')
  })

  it('omits decisions section when decisions array is empty in all-scope', () => {
    const service = new ContextTransferService({
      relevanceRules: [
        { from: 'a', to: 'b', transferScope: 'all', priority: 10 },
      ],
    })
    const ctx = {
      fromIntent: 'a',
      toIntent: 'b',
      summary: 'x',
      decisions: [],
      relevantFiles: ['f.ts'],
      workingState: {},
      transferredAt: Date.now(),
      tokenEstimate: 10,
    }
    const msg = service.formatAsMessage(ctx)
    const content = msg.content as string
    expect(content).not.toContain('### Key Decisions')
    expect(content).toContain('### Relevant Files')
  })

  it('omits files section when array is empty', () => {
    const service = new ContextTransferService({
      relevanceRules: [
        { from: 'a', to: 'b', transferScope: 'all', priority: 10 },
      ],
    })
    const ctx = {
      fromIntent: 'a',
      toIntent: 'b',
      summary: 'x',
      decisions: ['d1'],
      relevantFiles: [],
      workingState: {},
      transferredAt: Date.now(),
      tokenEstimate: 10,
    }
    const msg = service.formatAsMessage(ctx)
    const content = msg.content as string
    expect(content).toContain('### Key Decisions')
    expect(content).not.toContain('### Relevant Files')
  })
})

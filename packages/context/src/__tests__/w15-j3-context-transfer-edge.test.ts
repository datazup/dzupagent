import { describe, it, expect } from 'vitest'
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import { ContextTransferService } from '../context-transfer.js'

describe('ContextTransferService empty and boundary inputs', () => {
  it('extracts context from empty messages array', () => {
    const service = new ContextTransferService()
    const ctx = service.extractContext([], 'generate')
    expect(ctx.summary).toBe('')
    expect(ctx.decisions).toEqual([])
    expect(ctx.relevantFiles).toEqual([])
    expect(ctx.workingState).toEqual({})
    expect(ctx.fromIntent).toBe('generate')
    expect(ctx.toIntent).toBe('')
  })

  it('extracts context with workingState when provided', () => {
    const service = new ContextTransferService()
    const ctx = service.extractContext([], 'plan', { stepsCompleted: 3 })
    expect(ctx.workingState).toEqual({ stepsCompleted: 3 })
  })

  it('extracts context from system-only messages (no conversational output)', () => {
    const service = new ContextTransferService()
    const msgs: BaseMessage[] = [
      new SystemMessage('rules'),
    ]
    const ctx = service.extractContext(msgs, 'plan')
    expect(ctx.summary).toBe('')
  })

  it('handles single human message', () => {
    const service = new ContextTransferService()
    const msgs: BaseMessage[] = [new HumanMessage('just a question')]
    const ctx = service.extractContext(msgs, 'plan')
    expect(ctx.summary).toContain('just a question')
  })

  it('filters tool messages out of summary conversation', () => {
    const service = new ContextTransferService()
    const msgs: BaseMessage[] = [
      new HumanMessage('what'),
      new AIMessage('answer'),
      new ToolMessage({ content: 'tool result', tool_call_id: 'tc-1' }),
    ]
    const ctx = service.extractContext(msgs, 'debug')
    expect(ctx.summary).not.toContain('tool result')
    expect(ctx.summary).toContain('what')
  })
})

describe('ContextTransferService relevance and scope', () => {
  it('returns true for isRelevant with no rules configured', () => {
    const service = new ContextTransferService({ relevanceRules: [] })
    expect(service.isRelevant('anything', 'something')).toBe(true)
  })

  it('returns summary-only fallback for unknown intent pairs via catch-all', () => {
    const service = new ContextTransferService()
    const scope = service.getTransferScope('unknown-a', 'unknown-b')
    expect(scope).toBe('summary-only')
  })

  it('picks highest-priority rule when multiple match', () => {
    const service = new ContextTransferService({
      relevanceRules: [
        { from: 'a', to: 'b', transferScope: 'summary-only', priority: 1 },
        { from: 'a', to: 'b', transferScope: 'all', priority: 100 },
      ],
    })
    expect(service.getTransferScope('a', 'b')).toBe('all')
  })

  it('returns summary-only when no matching rule exists', () => {
    const service = new ContextTransferService({
      relevanceRules: [
        { from: 'x', to: 'y', transferScope: 'all', priority: 10 },
      ],
    })
    expect(service.getTransferScope('foo', 'bar')).toBe('summary-only')
  })

  it('handles string-based patterns in rules', () => {
    const service = new ContextTransferService({
      relevanceRules: [
        { from: 'exact-match', to: 'target', transferScope: 'all', priority: 10 },
      ],
    })
    expect(service.isRelevant('exact-match', 'target')).toBe(true)
    expect(service.isRelevant('different', 'target')).toBe(false)
  })
})

describe('ContextTransferService message formatting', () => {
  it('formats a context with empty fields using only the summary header', () => {
    const service = new ContextTransferService()
    const ctx = {
      fromIntent: 'plan',
      toIntent: 'implement',
      summary: 'a plan',
      decisions: [],
      relevantFiles: [],
      workingState: {},
      transferredAt: Date.now(),
      tokenEstimate: 10,
    }
    const msg = service.formatAsMessage(ctx)
    const content = msg.content as string
    expect(content).toContain('Context Transferred from "plan"')
    expect(content).toContain('### Summary')
    expect(content).not.toContain('### Key Decisions')
    expect(content).not.toContain('### Relevant Files')
    expect(content).not.toContain('### Working State')
  })

  it('includes workingState in "all" scope output', () => {
    const service = new ContextTransferService({
      relevanceRules: [
        { from: 'a', to: 'b', transferScope: 'all', priority: 10 },
      ],
    })
    const ctx = {
      fromIntent: 'a',
      toIntent: 'b',
      summary: 'summary',
      decisions: ['d1'],
      relevantFiles: ['file.ts'],
      workingState: { step: 1 },
      transferredAt: Date.now(),
      tokenEstimate: 10,
    }
    const msg = service.formatAsMessage(ctx)
    const content = msg.content as string
    expect(content).toContain('### Working State')
    expect(content).toContain('"step": 1')
  })

  it('truncates output when exceeds token budget', () => {
    const service = new ContextTransferService({
      maxTransferTokens: 10,
      charsPerToken: 4,
      relevanceRules: [
        { from: 'a', to: 'b', transferScope: 'all', priority: 10 },
      ],
    })
    const ctx = {
      fromIntent: 'a',
      toIntent: 'b',
      summary: 'x'.repeat(500),
      decisions: ['d1', 'd2', 'd3'],
      relevantFiles: ['a.ts', 'b.ts', 'c.ts'],
      workingState: { key: 'value' },
      transferredAt: Date.now(),
      tokenEstimate: 10,
    }
    const msg = service.formatAsMessage(ctx)
    const content = msg.content as string
    expect(content).toContain('[Context truncated to fit token budget]')
  })

  it('excludes decisions when scope is files-only', () => {
    const service = new ContextTransferService({
      relevanceRules: [
        { from: 'a', to: 'b', transferScope: 'files-only', priority: 10 },
      ],
    })
    const ctx = {
      fromIntent: 'a',
      toIntent: 'b',
      summary: 'sum',
      decisions: ['important decision'],
      relevantFiles: ['file.ts'],
      workingState: {},
      transferredAt: Date.now(),
      tokenEstimate: 10,
    }
    const msg = service.formatAsMessage(ctx)
    const content = msg.content as string
    expect(content).not.toContain('important decision')
    expect(content).toContain('file.ts')
  })

  it('excludes files when scope is decisions-only', () => {
    const service = new ContextTransferService({
      relevanceRules: [
        { from: 'a', to: 'b', transferScope: 'decisions-only', priority: 10 },
      ],
    })
    const ctx = {
      fromIntent: 'a',
      toIntent: 'b',
      summary: 'sum',
      decisions: ['choice-1'],
      relevantFiles: ['secret.ts'],
      workingState: { ignored: true },
      transferredAt: Date.now(),
      tokenEstimate: 10,
    }
    const msg = service.formatAsMessage(ctx)
    const content = msg.content as string
    expect(content).toContain('choice-1')
    expect(content).not.toContain('secret.ts')
    expect(content).not.toContain('ignored')
  })

  it('uses "all" scope when toIntent is empty (pre-injection)', () => {
    const service = new ContextTransferService()
    const ctx = {
      fromIntent: 'plan',
      toIntent: '',
      summary: 'sum',
      decisions: ['d1'],
      relevantFiles: ['f.ts'],
      workingState: { x: 1 },
      transferredAt: Date.now(),
      tokenEstimate: 10,
    }
    const msg = service.formatAsMessage(ctx)
    const content = msg.content as string
    expect(content).toContain('### Key Decisions')
    expect(content).toContain('### Relevant Files')
    expect(content).toContain('### Working State')
  })
})

describe('ContextTransferService injectContext', () => {
  it('prepends context when no system message exists', () => {
    const service = new ContextTransferService()
    const ctx = service.extractContext(
      [new HumanMessage('prior')],
      'plan',
    )
    const target: BaseMessage[] = [new HumanMessage('new question')]
    const out = service.injectContext(ctx, target)
    expect(out.length).toBe(2)
    expect(out[0]!._getType()).toBe('system')
    expect(out[1]!._getType()).toBe('human')
  })

  it('inserts context after the first system message', () => {
    const service = new ContextTransferService()
    const ctx = service.extractContext([new HumanMessage('prior')], 'plan')
    const target: BaseMessage[] = [
      new SystemMessage('sys'),
      new HumanMessage('q'),
    ]
    const out = service.injectContext(ctx, target)
    expect(out.length).toBe(3)
    expect(out[0]!._getType()).toBe('system')
    expect(out[0]!.content).toBe('sys')
    expect(out[1]!._getType()).toBe('system')
    expect(out[2]!._getType()).toBe('human')
  })

  it('does not mutate the input messages array', () => {
    const service = new ContextTransferService()
    const ctx = service.extractContext([new HumanMessage('prior')], 'plan')
    const target: BaseMessage[] = [new HumanMessage('q')]
    const originalLen = target.length
    service.injectContext(ctx, target)
    expect(target.length).toBe(originalLen)
  })
})

describe('ContextTransferService.transfer pipeline', () => {
  it('returns null when the transfer is not relevant', () => {
    const service = new ContextTransferService({
      relevanceRules: [
        { from: 'only-this', to: 'only-that', transferScope: 'all', priority: 10 },
      ],
    })
    const out = service.transfer(
      [new HumanMessage('prior')],
      'something-else',
      [new HumanMessage('now')],
      'also-different',
    )
    expect(out).toBeNull()
  })

  it('returns augmented target messages when relevant', () => {
    const service = new ContextTransferService()
    const out = service.transfer(
      [new HumanMessage('decided on a plan'), new AIMessage('ok')],
      'plan',
      [new HumanMessage('now implement')],
      'implement',
    )
    expect(out).not.toBeNull()
    expect(out!.length).toBeGreaterThan(1)
  })

  it('passes workingState through to extractContext', () => {
    const service = new ContextTransferService({
      relevanceRules: [
        { from: 'a', to: 'b', transferScope: 'all', priority: 10 },
      ],
    })
    const out = service.transfer(
      [new HumanMessage('prior')],
      'a',
      [new HumanMessage('now')],
      'b',
      { key: 'preserved' },
    )
    expect(out).not.toBeNull()
    const systemMsg = out!.find(m => m._getType() === 'system')
    expect(systemMsg?.content).toContain('preserved')
  })
})

describe('ContextTransferService decision extraction', () => {
  it('extracts sentences with decision patterns', () => {
    const service = new ContextTransferService()
    const msgs: BaseMessage[] = [
      new AIMessage('We decided to use PostgreSQL for the backend. Then we started'),
    ]
    const ctx = service.extractContext(msgs, 'plan')
    expect(ctx.decisions.length).toBeGreaterThanOrEqual(1)
    expect(ctx.decisions[0]).toContain('decided')
  })

  it('skips decisions below minimum length threshold', () => {
    const service = new ContextTransferService()
    const msgs: BaseMessage[] = [
      new AIMessage('decided.'),
    ]
    const ctx = service.extractContext(msgs, 'plan')
    expect(ctx.decisions).toEqual([])
  })

  it('deduplicates identical decision sentences across messages', () => {
    const service = new ContextTransferService()
    const msgs: BaseMessage[] = [
      new AIMessage('We decided to use TypeScript'),
      new AIMessage('We decided to use TypeScript'),
    ]
    const ctx = service.extractContext(msgs, 'plan')
    expect(ctx.decisions.length).toBe(1)
  })

  it('limits decisions to MAX_DECISIONS (10)', () => {
    const service = new ContextTransferService()
    const content = Array.from({ length: 20 }, (_, i) => `We decided on option ${i} deliberately`).join('.')
    const msgs: BaseMessage[] = [new AIMessage(content)]
    const ctx = service.extractContext(msgs, 'plan')
    expect(ctx.decisions.length).toBeLessThanOrEqual(10)
  })
})

describe('ContextTransferService file path extraction', () => {
  it('extracts file paths from content', () => {
    const service = new ContextTransferService()
    const msgs: BaseMessage[] = [
      new AIMessage('I modified src/core/utils.ts and packages/api/index.ts'),
    ]
    const ctx = service.extractContext(msgs, 'implement')
    expect(ctx.relevantFiles.length).toBeGreaterThanOrEqual(1)
  })

  it('returns empty file list when no paths exist', () => {
    const service = new ContextTransferService()
    const msgs: BaseMessage[] = [new AIMessage('just plain text here')]
    const ctx = service.extractContext(msgs, 'implement')
    expect(ctx.relevantFiles).toEqual([])
  })

  it('deduplicates file paths across messages', () => {
    const service = new ContextTransferService()
    const msgs: BaseMessage[] = [
      new AIMessage('edited src/a.ts'),
      new AIMessage('also src/a.ts again'),
    ]
    const ctx = service.extractContext(msgs, 'implement')
    const occurrences = ctx.relevantFiles.filter(p => p === 'src/a.ts').length
    expect(occurrences).toBeLessThanOrEqual(1)
  })
})

describe('ContextTransferService array content handling', () => {
  it('extracts text from array-shaped message content', () => {
    const service = new ContextTransferService()
    const msgs: BaseMessage[] = [
      new HumanMessage({
        content: [
          { type: 'text' as const, text: 'first part' },
          { type: 'text' as const, text: 'second part' },
        ],
      }),
    ]
    const ctx = service.extractContext(msgs, 'plan')
    expect(ctx.summary).toContain('first part')
    expect(ctx.summary).toContain('second part')
  })

  it('handles array parts with no text field', () => {
    const service = new ContextTransferService()
    const msgs: BaseMessage[] = [
      new HumanMessage({
        content: [
          { type: 'image_url', image_url: 'http://x' } as unknown as { type: 'text'; text: string },
        ],
      }),
    ]
    const ctx = service.extractContext(msgs, 'plan')
    expect(typeof ctx.summary).toBe('string')
  })
})

/**
 * MC-04b (MEMCTX-CACHE-PREFIX-20261108-R1): stable instruction cache prefix,
 * context side.
 *
 * - case b: system breakpoint placement (block 0 for two or more text blocks,
 *   today's placement otherwise), block keys and the four-breakpoint budget,
 *   checked on the payload produced by the installed `@langchain/anthropic`
 *   converter (`convertPromptToAnthropic`, local only, no network).
 * - case d: tokenizer-based cache-size gate (item 4) and opt-in tokenizer
 *   eviction (item 5), each with its unchanged-default case.
 */
import { describe, expect, it } from 'vitest'
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages'
import { ChatPromptValue } from '@langchain/core/prompt_values'
import { convertPromptToAnthropic } from '@langchain/anthropic'
import { applyCacheBreakpoints } from '../prompt-cache.js'
import { injectPromptCacheMarkers } from '../prompt-cache-injector.js'
import { resolveTokenCounter } from '../message-token-estimate.js'
import { evictIfNeeded, evictWithOffload } from '../context-eviction.js'
import type { TokenCounter } from '../token-lifecycle.js'

const MARKER = { type: 'ephemeral' }
const CLAUDE = 'claude-sonnet-4-6'

type Block = Record<string, unknown>

function systemBlocks(...texts: string[]): SystemMessage {
  return new SystemMessage({ content: texts.map((text) => ({ type: 'text', text })) })
}

function payload(messages: BaseMessage[]) {
  return convertPromptToAnthropic(new ChatPromptValue(messages)) as {
    system?: unknown
    messages: Array<{ content: unknown }>
  }
}

/** Every `cache_control` in a converted payload (system and messages). */
function breakpointCount(p: ReturnType<typeof payload>): number {
  let count = 0
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (value && typeof value === 'object') {
      if ('cache_control' in value) count++
      Object.values(value).forEach(visit)
    }
  }
  visit(p.system)
  visit(p.messages)
  return count
}

function conversation(n: number): BaseMessage[] {
  const out: BaseMessage[] = []
  for (let i = 0; i < n; i++) {
    out.push(new HumanMessage(`question ${i} ${'q'.repeat(2100)}`))
    out.push(new AIMessage(`answer ${i} ${'a'.repeat(2100)}`))
  }
  return out
}

describe('MC-04b case b: system breakpoint placement (applyCacheBreakpoints)', () => {
  it('places the one system breakpoint on block 0 of a multi-block text system message', () => {
    const marked = applyCacheBreakpoints([
      systemBlocks('INSTRUCTIONS', '\n\nmemory', '\n\n## Prior Conversation Context\n\nsummary'),
      new HumanMessage('hi'),
    ])
    const blocks = marked[0]!.content as Block[]
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toEqual({ type: 'text', text: 'INSTRUCTIONS', cache_control: MARKER })
    expect(blocks[1]).toEqual({ type: 'text', text: '\n\nmemory' })
    expect(blocks[2]).toEqual({ type: 'text', text: '\n\n## Prior Conversation Context\n\nsummary' })
  })

  it('places it on block 0 for exactly two text blocks', () => {
    const marked = applyCacheBreakpoints([systemBlocks('I', '\n\nmemo')])
    const blocks = marked[0]!.content as Block[]
    expect(blocks[0]!['cache_control']).toEqual(MARKER)
    expect('cache_control' in blocks[1]!).toBe(false)
  })

  it('removes a stale cache_control from later system blocks (one system breakpoint)', () => {
    const stale = new SystemMessage({
      content: [
        { type: 'text', text: 'I' },
        { type: 'text', text: '\n\nmemo', cache_control: MARKER },
      ],
    })
    const marked = applyCacheBreakpoints([stale])
    const blocks = marked[0]!.content as Block[]
    expect(blocks[0]!['cache_control']).toEqual(MARKER)
    expect('cache_control' in blocks[1]!).toBe(false)
    // The original message is not mutated.
    expect((stale.content as Block[])[1]!['cache_control']).toEqual(MARKER)
  })

  it('keeps today\'s placement for a string system message (whole content)', () => {
    const marked = applyCacheBreakpoints([new SystemMessage('INSTRUCTIONS\n\nmemory')])
    expect(marked[0]!.content).toEqual([
      { type: 'text', text: 'INSTRUCTIONS\n\nmemory', cache_control: MARKER },
    ])
  })

  it('keeps today\'s placement for a single-block system message', () => {
    const marked = applyCacheBreakpoints([systemBlocks('INSTRUCTIONS')])
    expect(marked[0]!.content).toEqual([
      { type: 'text', text: 'INSTRUCTIONS', cache_control: MARKER },
    ])
  })

  it('keeps today\'s last-block placement when the blocks are not all text', () => {
    const mixed = new SystemMessage({
      content: [
        { type: 'text', text: 'I' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
      ],
    })
    const blocks = applyCacheBreakpoints([mixed])[0]!.content as Block[]
    expect('cache_control' in blocks[0]!).toBe(false)
    expect(blocks[1]!['cache_control']).toEqual(MARKER)
  })

  it('keeps the additional_kwargs observability mirror on the system message', () => {
    const marked = applyCacheBreakpoints([systemBlocks('I', '\n\nmemo')])
    expect(marked[0]!.additional_kwargs['cache_control']).toEqual(MARKER)
  })
})

describe('MC-04b case b: converted Anthropic payload', () => {
  const messages: BaseMessage[] = [
    systemBlocks('INSTRUCTIONS', '\n\nmemory', '\n\n## Prior Conversation Context\n\nsummary'),
    ...conversation(4),
    new AIMessage({
      content: '',
      tool_calls: [{ id: 'call-1', name: 'read_file', args: { path: 'a.ts' }, type: 'tool_call' }],
    }),
    new ToolMessage({ content: 'r'.repeat(2100), tool_call_id: 'call-1' }),
  ]

  it('system is a single block array with cache_control on block 0 only', () => {
    const p = payload(applyCacheBreakpoints(messages))
    expect(Array.isArray(p.system)).toBe(true)
    const system = p.system as Block[]
    expect(system).toHaveLength(3)
    expect(system[0]!['cache_control']).toEqual(MARKER)
    expect(system[0]!['text']).toBe('INSTRUCTIONS')
    expect(system.slice(1).some((b) => 'cache_control' in b)).toBe(false)
  })

  it('no system block carries a key other than type, text and cache_control', () => {
    const system = payload(applyCacheBreakpoints(messages)).system as Block[]
    for (const block of system) {
      for (const key of Object.keys(block)) {
        expect(['type', 'text', 'cache_control']).toContain(key)
      }
    }
  })

  it('at most 4 breakpoints exist in the whole payload, for both strategies', () => {
    for (const cacheStrategy of ['content-addressed', 'positional'] as const) {
      const p = payload(applyCacheBreakpoints(messages, { cacheStrategy }))
      expect(breakpointCount(p), cacheStrategy).toBeLessThanOrEqual(4)
      expect(breakpointCount(p), cacheStrategy).toBeGreaterThanOrEqual(1)
    }
  })

  it('a string system message keeps one whole-content system block in the payload', () => {
    const p = payload(applyCacheBreakpoints([new SystemMessage('ALL'), new HumanMessage('hi')]))
    expect(p.system).toEqual([{ type: 'text', text: 'ALL', cache_control: MARKER }])
  })
})

/**
 * The agent-side MC-04b tests (`packages/agent/src/__tests__/stable-prefix-cache.test.ts`
 * and the MC-04a eval) place the system breakpoint with this rule, copied
 * verbatim, because in that package `@dzupagent/context` resolves to a
 * prebuilt `dist` and relative imports into this package are forbidden. This
 * contract case pins the copy to `applyCacheBreakpoints`.
 */
function markSystemBlock0(messages: BaseMessage[]): BaseMessage[] {
  const marker = { type: 'ephemeral' }
  return messages.map((m, index) => {
    if (index !== 0 || m._getType() !== 'system') return m
    const content = m.content
    if (typeof content === 'string') {
      return new SystemMessage({ content: content ? [{ type: 'text', text: content, cache_control: marker }] : '' })
    }
    const blocks = (content as Array<Record<string, unknown>>).map((b) => ({ ...b }))
    const textOnly = blocks.length >= 2 && blocks.every((b) => b['type'] === 'text' && typeof b['text'] === 'string')
    if (textOnly) {
      blocks.forEach((b, j) => {
        if (j === 0) b['cache_control'] = marker
        else delete b['cache_control']
      })
    } else if (blocks.length > 0) {
      blocks[blocks.length - 1]!['cache_control'] = marker
    }
    return new SystemMessage({ content: blocks as never })
  })
}

describe('MC-04b contract: the agent-side placement rule equals applyCacheBreakpoints', () => {
  const shapes: Array<[string, SystemMessage]> = [
    ['three text blocks', systemBlocks('I', '\n\nmemo', `\n\n## Prior Conversation Context\n\ns`)],
    ['two text blocks', systemBlocks('I', '\n\nmemo')],
    ['one text block', systemBlocks('I')],
    ['string', new SystemMessage('I\n\nmemo')],
    ['stale later marker', new SystemMessage({
      content: [{ type: 'text', text: 'I' }, { type: 'text', text: '\n\nm', cache_control: MARKER }],
    })],
    ['mixed blocks', new SystemMessage({
      content: [{ type: 'text', text: 'I' }, { type: 'image_url', image_url: { url: 'data:x' } }],
    })],
  ]
  for (const [label, system] of shapes) {
    it(`same converted system field: ${label}`, () => {
      const rest = conversation(2)
      expect(payload(markSystemBlock0([system, ...rest])).system)
        .toEqual(payload(applyCacheBreakpoints([system, ...rest])).system)
    })
  }
})

describe('MC-04b case d: tokenizer-based cache-size gate (item 4)', () => {
  const counter = resolveTokenCounter(undefined, CLAUDE)

  function count(text: string): number {
    return counter.count(text, CLAUDE)
  }

  function marked(messages: BaseMessage[]): boolean {
    return messages.some((m) => m.additional_kwargs['cache_control'] !== undefined)
  }

  it('selects the tokenizer-backed counter for a Claude id', () => {
    expect(counter).toBe(resolveTokenCounter(undefined, 'gpt-4o'))
    expect(counter).not.toBe(resolveTokenCounter(undefined, undefined))
  })

  it('skips a prompt that is 1024+ by chars/4 but under 1024 tokens by the tokenizer', () => {
    const text = 'internationalization '.repeat(220)
    // Precondition: the two estimates disagree around the threshold.
    expect(Math.ceil(text.length / 4)).toBeGreaterThanOrEqual(1024)
    expect(count(text)).toBeLessThan(1024)
    const input = [new SystemMessage(text)]
    expect(injectPromptCacheMarkers(input, CLAUDE)).toBe(input)
  })

  it('caches a prompt that is under 1024 by chars/4 but 1024+ tokens by the tokenizer', () => {
    const text = Array.from({ length: 1200 }, (_, i) => String(i % 10)).join(' ')
    expect(Math.ceil(text.length / 4)).toBeLessThan(1024)
    expect(count(text)).toBeGreaterThanOrEqual(1024)
    const out = injectPromptCacheMarkers([new SystemMessage(text)], CLAUDE)
    expect(marked(out)).toBe(true)
  })

  it('unchanged default: non-Claude ids stay a no-op', () => {
    const input = [new SystemMessage('word '.repeat(5000))]
    expect(injectPromptCacheMarkers(input, 'gpt-4o')).toBe(input)
    expect(injectPromptCacheMarkers(input, '')).toBe(input)
  })

  it('unchanged default: the threshold is 1024 and minTokensForCache still overrides it', () => {
    // Exactly at and just under the default threshold, measured by the same counter.
    let text = ''
    while (count(text + ' w') < 1024) text += ' w'
    expect(count(text)).toBeLessThan(1024)
    expect(count(text)).toBeGreaterThan(1000)
    expect(marked(injectPromptCacheMarkers([new SystemMessage(text)], CLAUDE))).toBe(false)
    const at = `${text} w`
    expect(count(at)).toBeGreaterThanOrEqual(1024)
    expect(marked(injectPromptCacheMarkers([new SystemMessage(at)], CLAUDE))).toBe(true)
    expect(marked(injectPromptCacheMarkers([new SystemMessage('short')], CLAUDE, { minTokensForCache: 1 })))
      .toBe(true)
  })
})

describe('MC-04b case d: opt-in tokenizer eviction (item 5)', () => {
  const fixed = (n: number): TokenCounter => ({ count: () => n })

  it('with a tokenCounter, a long text under the token threshold is kept', () => {
    const content = 'line\n'.repeat(40_000) // 200 000 chars: evicted by chars/4
    expect(evictIfNeeded(content, 'big.txt').evicted).toBe(true)
    const result = evictIfNeeded(content, 'big.txt', { tokenCounter: fixed(19_999) })
    expect(result).toEqual({ evicted: false, content })
  })

  it('with a tokenCounter, a short text at or over the token threshold is evicted and reports counted tokens', () => {
    const content = Array.from({ length: 100 }, (_, i) => `row ${i}`).join('\n')
    expect(evictIfNeeded(content, 'small.txt').evicted).toBe(false)
    const result = evictIfNeeded(content, 'small.txt', { tokenCounter: fixed(20_000) })
    expect(result.evicted).toBe(true)
    expect(result.content.startsWith('[Content truncated — 100 lines, ~20000 tokens]')).toBe(true)
    expect(result.originalLength).toBe(content.length)
    expect(result.lineCount).toBe(100)
  })

  it('evictWithOffload honours the tokenCounter too', async () => {
    const writes: string[] = []
    const sink = { write: async (p: string) => { writes.push(p) }, append: async () => {} }
    const content = Array.from({ length: 100 }, (_, i) => `row ${i}`).join('\n')
    const result = await evictWithOffload(content, 'x', sink, { tokenCounter: fixed(25_000) })
    expect(result.evicted).toBe(true)
    expect(writes).toHaveLength(1)
    expect(result.content.startsWith('[Content truncated — 100 lines, ~25000 tokens]')).toBe(true)
  })

  it('unchanged default: without a tokenCounter the chars threshold and preview are byte-for-byte as before', () => {
    const under = 'a'.repeat(20_000 * 4 - 1)
    expect(evictIfNeeded(under, 'f')).toEqual({ evicted: false, content: under })
    const lines = Array.from({ length: 80 }, (_, i) => `${i}`.padEnd(1_000, '.'))
    const over = lines.join('\n')
    const result = evictIfNeeded(over, 'f.txt')
    const expected = [
      `[Content truncated — 80 lines, ~${Math.ceil(over.length / 4)} tokens]`,
      '',
      '--- First 50 lines ---',
      lines.slice(0, 50).join('\n'),
      '',
      '--- [10 lines omitted] ---',
      '',
      '--- Last 20 lines ---',
      lines.slice(-20).join('\n'),
      '',
      '[Use read_file("f.txt", { offset, limit }) to view specific sections]',
    ].join('\n')
    expect(result).toEqual({
      evicted: true,
      content: expected,
      originalLength: over.length,
      lineCount: 80,
    })
  })
})

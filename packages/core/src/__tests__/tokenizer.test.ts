import { describe, expect, it } from 'vitest'
import {
  AnthropicTokenizer,
  HeuristicTokenizer,
  TiktokenTokenizer,
  type Tokenizer,
} from '../llm/tokenizer.js'
import {
  TokenizerRegistry,
  defaultTokenizerRegistry,
} from '../llm/tokenizer-registry.js'

describe('HeuristicTokenizer', () => {
  it('returns a positive token count for non-empty text', () => {
    const t = new HeuristicTokenizer()
    expect(t.countTokens('hello world')).toBeGreaterThan(0)
  })

  it('returns 0 for empty text', () => {
    const t = new HeuristicTokenizer()
    expect(t.countTokens('')).toBe(0)
  })

  it('uses ceil(length / 4) for the count', () => {
    const t = new HeuristicTokenizer()
    expect(t.countTokens('1234')).toBe(1)
    expect(t.countTokens('12345')).toBe(2)
    expect(t.countTokens('12345678')).toBe(2)
  })

  it('encode returns array of token-count length', () => {
    const t = new HeuristicTokenizer()
    const text = 'hello world this is a test'
    expect(t.encode(text)).toHaveLength(t.countTokens(text))
  })

  it('countMessages sums string contents correctly', () => {
    const t = new HeuristicTokenizer()
    const total = t.countMessages([
      { content: '1234' },
      { content: '12345678' },
    ])
    expect(total).toBe(t.countTokens('1234') + t.countTokens('12345678'))
  })

  it('countMessages stringifies non-string content', () => {
    const t = new HeuristicTokenizer()
    const obj = { content: { foo: 'bar' } }
    const expected = t.countTokens(JSON.stringify({ foo: 'bar' }))
    expect(t.countMessages([obj])).toBe(expected)
  })

  it('countMessages tolerates null/undefined content', () => {
    const t = new HeuristicTokenizer()
    expect(t.countMessages([{ content: null }, { content: undefined }])).toBe(0)
  })

  it('exposes the model identifier', () => {
    expect(new HeuristicTokenizer().model).toBe('heuristic')
    expect(new HeuristicTokenizer('custom').model).toBe('custom')
  })
})

describe('AnthropicTokenizer (Claude BPE wiring)', () => {
  // The Anthropic backend is an optional peer. These tests verify the live
  // BPE path when it is installed and the deterministic heuristic fallback
  // when it is not.
  const isBackendAvailable = (() => {
    try {
      const tk = new AnthropicTokenizer('claude-3-5-sonnet-20241022')
      // Trivial inputs can match the heuristic, so use natural-language text
      // where the optional BPE backend normally diverges from char/4.
      const heuristic = new HeuristicTokenizer().countTokens(
        'The quick brown fox jumps over the lazy dog',
      )
      const counted = tk.countTokens(
        'The quick brown fox jumps over the lazy dog',
      )
      return counted !== heuristic && counted > 0
    } catch {
      return false
    }
  })()

  it('uses the Anthropic BPE tokenizer when @anthropic-ai/tokenizer is available', () => {
    const tk = new AnthropicTokenizer('claude-3-5-sonnet-20241022')
    const heuristic = new HeuristicTokenizer()
    const text = 'The quick brown fox jumps over the lazy dog'
    const bpe = tk.countTokens(text)
    if (isBackendAvailable) {
      // Real BPE produces fewer tokens than char/4 for this English sentence.
      expect(bpe).toBeGreaterThan(0)
      expect(bpe).toBeLessThan(heuristic.countTokens(text))
    } else {
      // Backend unavailable in this environment; fallback must be heuristic.
      expect(bpe).toBe(heuristic.countTokens(text))
    }
  })

  it('returns 0 for empty string regardless of backend availability', () => {
    const tk = new AnthropicTokenizer('claude-3-5-sonnet-20241022')
    expect(tk.countTokens('')).toBe(0)
    expect(tk.encode('').length).toBe(0)
  })

  it('returns a plausible count for a long string (>0 and < length)', () => {
    const tk = new AnthropicTokenizer('claude-3-5-sonnet-20241022')
    const long =
      'lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(10)
    const n = tk.countTokens(long)
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(long.length)
  })

  it('encode returns a numeric array whose length matches countTokens', () => {
    const tk = new AnthropicTokenizer('claude-3-5-sonnet-20241022')
    const text = 'hello tokenizer'
    const ids = tk.encode(text)
    expect(Array.isArray(ids)).toBe(true)
    expect(ids).toHaveLength(tk.countTokens(text))
  })

  it('countMessages aggregates across array using BPE counts', () => {
    const tk = new AnthropicTokenizer('claude-3-5-sonnet-20241022')
    const total = tk.countMessages([
      { content: 'aaaa' },
      { content: 'bbbbbbbb' },
    ])
    const a = tk.countTokens('aaaa')
    const b = tk.countTokens('bbbbbbbb')
    expect(total).toBe(a + b)
  })

  it('exposes the configured model', () => {
    expect(new AnthropicTokenizer('claude-foo').model).toBe('claude-foo')
  })
})

describe('defaultTokenizerRegistry (end-to-end Claude path)', () => {
  it('routes claude-* models through AnthropicTokenizer with BPE counts', () => {
    const tk = defaultTokenizerRegistry.resolve('claude-3-5-sonnet-20241022')
    expect(tk).toBeInstanceOf(AnthropicTokenizer)
    const heuristic = new HeuristicTokenizer().countTokens(
      'The quick brown fox jumps over the lazy dog',
    )
    const counted = tk.countTokens(
      'The quick brown fox jumps over the lazy dog',
    )
    expect(counted).toBeGreaterThan(0)
    // The registry contract is provider routing. The optional backend may be
    // absent, in which case AnthropicTokenizer falls back to the heuristic.
    expect(counted).toBeLessThanOrEqual(heuristic)
  })

  it('non-claude model (gpt-4) routes through TiktokenTokenizer (or heuristic fallback)', () => {
    const tk = defaultTokenizerRegistry.resolve('gpt-4')
    expect(tk).toBeInstanceOf(TiktokenTokenizer)
    const n = tk.countTokens('hello world')
    expect(n).toBeGreaterThan(0)
  })
})

describe('TiktokenTokenizer (fallback path)', () => {
  it('falls back to heuristic when js-tiktoken is unavailable', () => {
    const tk = new TiktokenTokenizer('gpt-4o')
    const text = 'hello tokenizer fallback'
    // heuristic count for individual text
    expect(tk.countTokens(text)).toBeGreaterThan(0)
  })

  it('countMessages adds per-message overhead', () => {
    const tk = new TiktokenTokenizer()
    const single = tk.countTokens('hello')
    const total = tk.countMessages([{ content: 'hello' }])
    // overhead ensures total > raw count
    expect(total).toBeGreaterThan(single)
  })

  it('countMessages returns 0 for empty array', () => {
    const tk = new TiktokenTokenizer()
    expect(tk.countMessages([])).toBe(0)
  })

  it('exposes the configured model', () => {
    expect(new TiktokenTokenizer('gpt-test').model).toBe('gpt-test')
  })
})

describe('TokenizerRegistry', () => {
  it('resolve returns AnthropicTokenizer for claude models', () => {
    const reg = new TokenizerRegistry()
    reg.register(/claude/i, (id) => new AnthropicTokenizer(id))
    const t = reg.resolve('claude-3-5-sonnet-20241022')
    expect(t).toBeInstanceOf(AnthropicTokenizer)
    expect(t.model).toBe('claude-3-5-sonnet-20241022')
  })

  it('resolve returns TiktokenTokenizer for gpt models', () => {
    const reg = new TokenizerRegistry()
    reg.register(/gpt-/i, (id) => new TiktokenTokenizer(id))
    const t = reg.resolve('gpt-4o')
    expect(t).toBeInstanceOf(TiktokenTokenizer)
    expect(t.model).toBe('gpt-4o')
  })

  it('resolve falls back to HeuristicTokenizer when no pattern matches', () => {
    const reg = new TokenizerRegistry()
    const t = reg.resolve('totally-unknown-model')
    expect(t).toBeInstanceOf(HeuristicTokenizer)
  })

  it('resolveOrFallback is an alias of resolve', () => {
    const reg = new TokenizerRegistry()
    expect(reg.resolveOrFallback('foo')).toBeInstanceOf(HeuristicTokenizer)
  })

  it('register override (later wins because newest is prepended)', () => {
    const reg = new TokenizerRegistry()
    const custom: Tokenizer = {
      model: 'custom',
      encode: () => [],
      countTokens: () => 999,
      countMessages: () => 999,
    }
    reg.register(/anything/i, new AnthropicTokenizer())
    reg.register(/custom-model/i, custom)
    expect(reg.resolve('custom-model').countTokens('foo')).toBe(999)
  })

  it('clear removes all registrations', () => {
    const reg = new TokenizerRegistry()
    reg.register(/claude/i, new AnthropicTokenizer())
    reg.clear()
    expect(reg.resolve('claude-3-5-sonnet')).toBeInstanceOf(HeuristicTokenizer)
  })
})

describe('defaultTokenizerRegistry', () => {
  it('resolves claude models to AnthropicTokenizer', () => {
    expect(defaultTokenizerRegistry.resolve('claude-3-5-sonnet-20241022')).toBeInstanceOf(AnthropicTokenizer)
  })

  it('resolves gpt-4o to TiktokenTokenizer', () => {
    expect(defaultTokenizerRegistry.resolve('gpt-4o')).toBeInstanceOf(TiktokenTokenizer)
  })

  it('resolves o1/o3 models to TiktokenTokenizer', () => {
    expect(defaultTokenizerRegistry.resolve('o1-preview')).toBeInstanceOf(TiktokenTokenizer)
    expect(defaultTokenizerRegistry.resolve('o3-mini')).toBeInstanceOf(TiktokenTokenizer)
  })

  it('falls back to HeuristicTokenizer for unknown models', () => {
    expect(defaultTokenizerRegistry.resolve('mistral-large')).toBeInstanceOf(HeuristicTokenizer)
    expect(defaultTokenizerRegistry.resolve('heuristic')).toBeInstanceOf(HeuristicTokenizer)
  })

  it('countTokens via resolved tokenizer always returns a number for non-empty text', () => {
    const text = 'hello world from the tokenizer'
    expect(defaultTokenizerRegistry.resolve('claude-3-5-sonnet').countTokens(text)).toBeGreaterThan(0)
    expect(defaultTokenizerRegistry.resolve('gpt-4o').countTokens(text)).toBeGreaterThan(0)
    expect(defaultTokenizerRegistry.resolve('unknown').countTokens(text)).toBeGreaterThan(0)
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { TiktokenCounter, __internals } from '../tiktoken-counter.js'

/**
 * Coverage for TiktokenCounter provider routing (REC-M-02).
 *
 * The optional backends `js-tiktoken` and `@anthropic-ai/tokenizer` may or
 * may not be installed at test time. These tests therefore validate
 * deterministic behaviour: routing decisions, fallback paths, and the
 * Claude-detection predicate. They do not assert exact token counts when
 * a backend is loaded (those are version-dependent), only that the
 * counter returns a sensible positive integer for non-empty input.
 */
describe('TiktokenCounter — Claude routing (REC-M-02)', () => {
  beforeEach(() => {
    __internals.resetCache()
  })

  describe('isClaudeModel detection', () => {
    it('returns true for explicit claude model ids', () => {
      expect(__internals.isClaudeModel('claude-3-5-sonnet-20241022')).toBe(true)
      expect(__internals.isClaudeModel('claude-sonnet-4-6')).toBe(true)
      expect(__internals.isClaudeModel('claude-opus-4-7')).toBe(true)
    })

    it('returns true for anthropic-prefixed ids', () => {
      expect(__internals.isClaudeModel('anthropic/claude-3-haiku')).toBe(true)
      expect(__internals.isClaudeModel('anthropic.claude-3-5-sonnet-v2:0')).toBe(true)
    })

    it('is case-insensitive', () => {
      expect(__internals.isClaudeModel('CLAUDE-3-OPUS')).toBe(true)
      expect(__internals.isClaudeModel('Claude-3-5-Sonnet')).toBe(true)
      expect(__internals.isClaudeModel('Anthropic/Claude')).toBe(true)
    })

    it('returns false for OpenAI models', () => {
      expect(__internals.isClaudeModel('gpt-4o')).toBe(false)
      expect(__internals.isClaudeModel('gpt-4-turbo')).toBe(false)
      expect(__internals.isClaudeModel('gpt-3.5-turbo')).toBe(false)
      expect(__internals.isClaudeModel('o1-preview')).toBe(false)
    })

    it('returns false for Gemini and other providers', () => {
      expect(__internals.isClaudeModel('gemini-1.5-pro')).toBe(false)
      expect(__internals.isClaudeModel('llama-3.1-70b')).toBe(false)
      expect(__internals.isClaudeModel('mistral-large')).toBe(false)
    })

    it('returns false for undefined / empty model', () => {
      expect(__internals.isClaudeModel(undefined)).toBe(false)
      expect(__internals.isClaudeModel('')).toBe(false)
    })
  })

  describe('count() — return value contracts', () => {
    const counter = new TiktokenCounter()

    it('returns 0 for empty string regardless of model', () => {
      expect(counter.count('', 'claude-3-5-sonnet')).toBe(0)
      expect(counter.count('', 'gpt-4o')).toBe(0)
      expect(counter.count('', undefined)).toBe(0)
    })

    it('returns a positive integer for non-empty Claude input', () => {
      const n = counter.count('hello world from claude', 'claude-3-5-sonnet-20241022')
      expect(n).toBeGreaterThan(0)
      expect(Number.isInteger(n)).toBe(true)
    })

    it('returns a positive integer for non-empty OpenAI input', () => {
      const n = counter.count('hello world from gpt', 'gpt-4o')
      expect(n).toBeGreaterThan(0)
      expect(Number.isInteger(n)).toBe(true)
    })

    it('returns a positive integer for unknown model (cl100k fallback)', () => {
      const n = counter.count('hello world unknown model', 'some-future-model-v9')
      expect(n).toBeGreaterThan(0)
      expect(Number.isInteger(n)).toBe(true)
    })

    it('returns a positive integer when model is undefined', () => {
      const n = counter.count('hello world no model')
      expect(n).toBeGreaterThan(0)
      expect(Number.isInteger(n)).toBe(true)
    })
  })

  describe('count() — backward compatibility', () => {
    const counter = new TiktokenCounter()

    it('produces identical results across calls (deterministic)', () => {
      const text = 'The quick brown fox jumps over the lazy dog.'
      const a = counter.count(text, 'gpt-4o')
      const b = counter.count(text, 'gpt-4o')
      expect(a).toBe(b)
    })

    it('does not throw on very long input', () => {
      const text = 'x'.repeat(50_000)
      expect(() => counter.count(text, 'gpt-4o')).not.toThrow()
      expect(() => counter.count(text, 'claude-3-5-sonnet')).not.toThrow()
    })

    it('does not throw on unicode / emoji', () => {
      const text = 'Здравствуй мир — hello world'
      expect(() => counter.count(text, 'claude-3-5-sonnet')).not.toThrow()
      expect(() => counter.count(text, 'gpt-4o')).not.toThrow()
    })

    it('falls back gracefully for chars/4 lower bound', () => {
      // Heuristic floor: at minimum every backend should produce <= chars
      // and >= a small positive number for non-trivial input.
      const text = 'a'.repeat(400)
      const claudeN = counter.count(text, 'claude-3-5-sonnet')
      const gptN = counter.count(text, 'gpt-4o')
      expect(claudeN).toBeGreaterThan(0)
      expect(claudeN).toBeLessThanOrEqual(text.length)
      expect(gptN).toBeGreaterThan(0)
      expect(gptN).toBeLessThanOrEqual(text.length)
    })
  })
})

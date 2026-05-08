/**
 * Tests for the shared {@link extractTokenUsage} helper.
 *
 * Focus: verify that both the SDK-normalized field name
 * (`cached_input_tokens`) and the raw Anthropic Messages API field name
 * (`cache_read_input_tokens`) are correctly mapped onto
 * {@link TokenUsage.cachedInputTokens}, and that cache_creation_input_tokens
 * is mapped onto {@link TokenUsage.cacheWriteTokens}.
 */

import { describe, it, expect } from 'vitest'
import { extractTokenUsage } from '../base/extract-token-usage.js'

describe('extractTokenUsage', () => {
  it('returns undefined for null/undefined/non-object input', () => {
    expect(extractTokenUsage(null)).toBeUndefined()
    expect(extractTokenUsage(undefined)).toBeUndefined()
    expect(extractTokenUsage('not an object')).toBeUndefined()
    expect(extractTokenUsage(42)).toBeUndefined()
  })

  it('extracts input_tokens and output_tokens', () => {
    const usage = extractTokenUsage({ input_tokens: 100, output_tokens: 50 })
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 50 })
  })

  it('coerces missing input/output to 0', () => {
    const usage = extractTokenUsage({})
    expect(usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  describe('cache token extraction', () => {
    it('maps cached_input_tokens (SDK-normalized) → cachedInputTokens', () => {
      const usage = extractTokenUsage({
        input_tokens: 100,
        output_tokens: 50,
        cached_input_tokens: 800,
      })
      expect(usage?.cachedInputTokens).toBe(800)
    })

    it('maps cache_read_input_tokens (raw Anthropic API) → cachedInputTokens', () => {
      const usage = extractTokenUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 750,
      })
      expect(usage?.cachedInputTokens).toBe(750)
    })

    it('prefers cache_read_input_tokens over cached_input_tokens when both present', () => {
      const usage = extractTokenUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 999,
        cached_input_tokens: 111,
      })
      expect(usage?.cachedInputTokens).toBe(999)
    })

    it('maps cache_creation_input_tokens → cacheWriteTokens', () => {
      const usage = extractTokenUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 600,
      })
      expect(usage?.cacheWriteTokens).toBe(600)
    })

    it('extracts both cache read and cache write when present', () => {
      const usage = extractTokenUsage({
        input_tokens: 200,
        output_tokens: 100,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 300,
      })
      expect(usage).toMatchObject({
        inputTokens: 200,
        outputTokens: 100,
        cachedInputTokens: 500,
        cacheWriteTokens: 300,
      })
    })

    it('omits cache fields when not present', () => {
      const usage = extractTokenUsage({ input_tokens: 100, output_tokens: 50 })
      expect(usage?.cachedInputTokens).toBeUndefined()
      expect(usage?.cacheWriteTokens).toBeUndefined()
    })

    it('ignores non-numeric cache token values', () => {
      const usage = extractTokenUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 'not a number',
        cache_creation_input_tokens: null,
      })
      expect(usage?.cachedInputTokens).toBeUndefined()
      expect(usage?.cacheWriteTokens).toBeUndefined()
    })
  })

  it('extracts cost_cents when present', () => {
    const usage = extractTokenUsage({
      input_tokens: 100,
      output_tokens: 50,
      cost_cents: 12.5,
    })
    expect(usage?.costCents).toBe(12.5)
  })

  it('omits cost_cents when not numeric', () => {
    const usage = extractTokenUsage({
      input_tokens: 100,
      output_tokens: 50,
      cost_cents: 'free',
    })
    expect(usage?.costCents).toBeUndefined()
  })
})

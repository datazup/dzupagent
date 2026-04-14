import { describe, it, expect } from 'vitest'
import { resolveFallbackProviderId, requireFallbackProviderId } from '../utils/provider-helpers.js'

describe('resolveFallbackProviderId', () => {
  it('should return first provider from Map', () => {
    const map = new Map([['claude', {} as never], ['codex', {} as never]])
    expect(resolveFallbackProviderId(map)).toBe('claude')
  })

  it('should return first provider from adapter array', () => {
    const arr = [{ providerId: 'gemini' }, { providerId: 'qwen' }] as never[]
    expect(resolveFallbackProviderId(arr)).toBe('gemini')
  })

  it('should return first provider from string array', () => {
    expect(resolveFallbackProviderId(['claude', 'codex'])).toBe('claude')
  })

  it('should exclude specified providers', () => {
    const map = new Map([['claude', {} as never], ['codex', {} as never], ['gemini', {} as never]])
    expect(resolveFallbackProviderId(map, ['claude'])).toBe('codex')
  })

  it('should return undefined when all excluded', () => {
    const map = new Map([['claude', {} as never]])
    expect(resolveFallbackProviderId(map, ['claude'])).toBeUndefined()
  })

  it('should return undefined for empty sources', () => {
    expect(resolveFallbackProviderId(new Map())).toBeUndefined()
    expect(resolveFallbackProviderId([])).toBeUndefined()
  })
})

describe('requireFallbackProviderId', () => {
  it('should throw when no providers available', () => {
    const map = new Map([['claude', {} as never]])
    expect(() => requireFallbackProviderId(map, ['claude'])).toThrow('No available provider')
  })

  it('should return provider when available', () => {
    const map = new Map([['claude', {} as never], ['codex', {} as never]])
    expect(requireFallbackProviderId(map, ['claude'])).toBe('codex')
  })

  it('should throw for empty map', () => {
    expect(() => requireFallbackProviderId(new Map())).toThrow('No available provider')
  })
})

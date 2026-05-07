import { describe, it, expect } from 'vitest'
import { resolveFallbackProviderId, requireFallbackProviderId } from '../utils/provider-helpers.js'
import type { AdapterProviderId, AgentCLIAdapter } from '../types.js'

const stubAdapter = {} as unknown as AgentCLIAdapter

describe('resolveFallbackProviderId', () => {
  it('should return first provider from Map', () => {
    const map = new Map<AdapterProviderId, AgentCLIAdapter>([['claude', stubAdapter], ['codex', stubAdapter]])
    expect(resolveFallbackProviderId(map)).toBe('claude')
  })

  it('should return first provider from adapter array', () => {
    const arr = [{ providerId: 'gemini' }, { providerId: 'qwen' }] as unknown as AgentCLIAdapter[]
    expect(resolveFallbackProviderId(arr)).toBe('gemini')
  })

  it('should return first provider from string array', () => {
    expect(resolveFallbackProviderId(['claude', 'codex'])).toBe('claude')
  })

  it('should exclude specified providers', () => {
    const map = new Map<AdapterProviderId, AgentCLIAdapter>([
      ['claude', stubAdapter],
      ['codex', stubAdapter],
      ['gemini', stubAdapter],
    ])
    expect(resolveFallbackProviderId(map, ['claude'])).toBe('codex')
  })

  it('should return undefined when all excluded', () => {
    const map = new Map<AdapterProviderId, AgentCLIAdapter>([['claude', stubAdapter]])
    expect(resolveFallbackProviderId(map, ['claude'])).toBeUndefined()
  })

  it('should return undefined for empty sources', () => {
    expect(resolveFallbackProviderId(new Map())).toBeUndefined()
    expect(resolveFallbackProviderId([])).toBeUndefined()
  })
})

describe('requireFallbackProviderId', () => {
  it('should throw when no providers available', () => {
    const map = new Map<AdapterProviderId, AgentCLIAdapter>([['claude', stubAdapter]])
    expect(() => requireFallbackProviderId(map, ['claude'])).toThrow('No available provider')
  })

  it('should return provider when available', () => {
    const map = new Map<AdapterProviderId, AgentCLIAdapter>([['claude', stubAdapter], ['codex', stubAdapter]])
    expect(requireFallbackProviderId(map, ['claude'])).toBe('codex')
  })

  it('should throw for empty map', () => {
    expect(() => requireFallbackProviderId(new Map())).toThrow('No available provider')
  })
})

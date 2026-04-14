import { describe, it, expect } from 'vitest'
import { generateCacheKey } from '../key-generator.js'
import type { CacheableRequest } from '../types.js'

function makeRequest(overrides: Partial<CacheableRequest> = {}): CacheableRequest {
  return {
    messages: [{ role: 'user', content: 'Hello' }],
    model: 'gpt-4',
    temperature: 0,
    maxTokens: 256,
    ...overrides,
  }
}

describe('generateCacheKey', () => {
  it('produces a deterministic key for identical requests', () => {
    const req = makeRequest()
    const a = generateCacheKey(req)
    const b = generateCacheKey(makeRequest())
    expect(a).toBe(b)
  })

  it('returns different keys for different messages', () => {
    const a = generateCacheKey(makeRequest({ messages: [{ role: 'user', content: 'Hello' }] }))
    const b = generateCacheKey(makeRequest({ messages: [{ role: 'user', content: 'World' }] }))
    expect(a).not.toBe(b)
  })

  it('returns different keys for different models', () => {
    const a = generateCacheKey(makeRequest({ model: 'gpt-4' }))
    const b = generateCacheKey(makeRequest({ model: 'gpt-3.5-turbo' }))
    expect(a).not.toBe(b)
  })

  it('returns different keys for different temperatures', () => {
    const a = generateCacheKey(makeRequest({ temperature: 0 }))
    const b = generateCacheKey(makeRequest({ temperature: 0.5 }))
    expect(a).not.toBe(b)
  })

  it('returns different keys for different maxTokens', () => {
    const a = generateCacheKey(makeRequest({ maxTokens: 100 }))
    const b = generateCacheKey(makeRequest({ maxTokens: 200 }))
    expect(a).not.toBe(b)
  })

  it('treats undefined temperature as 0', () => {
    const a = generateCacheKey(makeRequest({ temperature: 0 }))
    const b = generateCacheKey(makeRequest({ temperature: undefined }))
    expect(a).toBe(b)
  })

  it('prefixes with "llm:" when no namespace is given', () => {
    const key = generateCacheKey(makeRequest())
    expect(key).toMatch(/^llm:[a-f0-9]{64}$/)
  })

  it('prefixes with namespace when provided', () => {
    const key = generateCacheKey(makeRequest(), 'tenant-x')
    expect(key).toMatch(/^tenant-x:llm:[a-f0-9]{64}$/)
  })

  it('different namespaces yield different keys for same request', () => {
    const req = makeRequest()
    const a = generateCacheKey(req, 'ns-a')
    const b = generateCacheKey(req, 'ns-b')
    expect(a).not.toBe(b)
  })

  it('produces a valid SHA-256 hex digest (64 chars)', () => {
    const key = generateCacheKey(makeRequest())
    const hash = key.replace('llm:', '')
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[a-f0-9]+$/)
  })

  it('is stable across multiple message entries', () => {
    const req = makeRequest({
      messages: [
        { role: 'system', content: 'You are a helpful assistant' },
        { role: 'user', content: 'Explain caching' },
      ],
    })
    const a = generateCacheKey(req)
    const b = generateCacheKey(req)
    expect(a).toBe(b)
  })

  it('differentiates message role from content', () => {
    const a = generateCacheKey(makeRequest({
      messages: [{ role: 'user', content: 'assistant' }],
    }))
    const b = generateCacheKey(makeRequest({
      messages: [{ role: 'assistant', content: 'user' }],
    }))
    expect(a).not.toBe(b)
  })

  it('ignores extra properties on the request', () => {
    const base = makeRequest()
    const withExtra = makeRequest({ extraProp: 'irrelevant' } as Partial<CacheableRequest>)
    expect(generateCacheKey(base)).toBe(generateCacheKey(withExtra))
  })
})

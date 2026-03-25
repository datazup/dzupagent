import { describe, it, expect } from 'vitest'
import { parseMemoryEntry } from '../consolidation-types.js'

describe('parseMemoryEntry', () => {
  it('should extract text field', () => {
    const entry = parseMemoryEntry('k1', { text: 'hello world' })
    expect(entry.key).toBe('k1')
    expect(entry.text).toBe('hello world')
  })

  it('should JSON.stringify value when text is missing', () => {
    const entry = parseMemoryEntry('k1', { foo: 'bar' })
    expect(entry.text).toBe('{"foo":"bar"}')
  })

  it('should extract decay metadata', () => {
    const now = Date.now()
    const entry = parseMemoryEntry('k1', {
      text: 'test',
      _decay: {
        strength: 0.5,
        accessCount: 3,
        lastAccessedAt: now,
        createdAt: now - 1000,
        halfLifeMs: 86400000,
      },
    })
    expect(entry.decay).toBeDefined()
    expect(entry.decay!.strength).toBe(0.5)
    expect(entry.decay!.accessCount).toBe(3)
    expect(entry.createdAt).toBe(now - 1000)
    expect(entry.lastAccessedAt).toBe(now)
    expect(entry.accessCount).toBe(3)
  })

  it('should handle incomplete decay metadata gracefully', () => {
    const entry = parseMemoryEntry('k1', {
      text: 'test',
      _decay: { strength: 0.5 }, // missing other fields
    })
    expect(entry.decay).toBeUndefined()
  })

  it('should extract pinned and importance fields', () => {
    const entry = parseMemoryEntry('k1', {
      text: 'test',
      pinned: true,
      importance: 0.9,
    })
    expect(entry.pinned).toBe(true)
    expect(entry.importance).toBe(0.9)
  })

  it('should fall back to top-level createdAt when no decay', () => {
    const entry = parseMemoryEntry('k1', {
      text: 'test',
      createdAt: 12345,
      lastAccessedAt: 67890,
      accessCount: 5,
    })
    expect(entry.createdAt).toBe(12345)
    expect(entry.lastAccessedAt).toBe(67890)
    expect(entry.accessCount).toBe(5)
  })

  it('should preserve raw value', () => {
    const value = { text: 'hello', extra: 42 }
    const entry = parseMemoryEntry('k1', value)
    expect(entry.raw).toBe(value)
  })
})

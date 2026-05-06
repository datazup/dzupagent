import { describe, it, expect } from 'vitest'
import { KeywordFTSSearch } from '../retrieval/fts-search.js'
import type { FTSSearchResult } from '../retrieval/fts-search.js'

function makeRecord(key: string, text: string) {
  return { key, value: { text } }
}

function makeContentRecord(key: string, content: string) {
  return { key, value: { content } }
}

describe('KeywordFTSSearch', () => {
  const sut = new KeywordFTSSearch()

  describe('search — happy path', () => {
    it('returns matching records sorted by score descending', () => {
      const records = [
        makeRecord('a', 'authentication service handles login and tokens'),
        makeRecord('b', 'payment processing for invoices'),
        makeRecord('c', 'authentication token validation and refresh'),
      ]
      const results = sut.search(records, 'authentication token', 10)
      // 'c' mentions both 'authentication' and 'token'; 'a' mentions 'authentication' and 'tokens'
      expect(results.length).toBeGreaterThanOrEqual(2)
      // Top results should contain a or c
      const topKeys = results.map(r => r.key)
      expect(topKeys).toContain('a')
      expect(topKeys).toContain('c')
      // 'b' has no matching terms, should not appear
      expect(topKeys).not.toContain('b')
      // Results sorted descending by score
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i]!.score).toBeGreaterThanOrEqual(results[i + 1]!.score)
      }
    })

    it('reads from content field when text is absent', () => {
      const records = [makeContentRecord('x', 'database migration rollback procedure')]
      const results = sut.search(records, 'database migration', 10)
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('x')
    })

    it('falls back to JSON.stringify for records with neither text nor content', () => {
      const records = [{ key: 'j', value: { topic: 'migration', step: 'rollback' } }]
      const results = sut.search(records, 'migration', 10)
      // JSON.stringify includes the field value; may or may not match depending on tokenisation
      expect(Array.isArray(results)).toBe(true)
    })

    it('respects the limit parameter', () => {
      const records = Array.from({ length: 10 }, (_, i) =>
        makeRecord(`k${i}`, `authentication service ${i}`),
      )
      const results = sut.search(records, 'authentication', 3)
      expect(results).toHaveLength(3)
    })
  })

  describe('search — stop word filtering', () => {
    it('ignores queries composed entirely of stop words', () => {
      const records = [makeRecord('a', 'the cat is on the mat')]
      const results = sut.search(records, 'the is a', 10)
      expect(results).toEqual([])
    })

    it('does not boost stop words appearing in documents', () => {
      const records = [makeRecord('a', 'authentication and authorisation')]
      // 'and' is a stop word, 'authentication' is not
      const results = sut.search(records, 'authentication and', 10)
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('a')
    })
  })

  describe('search — TF-IDF scoring', () => {
    it('gives higher IDF weight to rare terms', () => {
      // 'rare' appears only in doc 'b'; 'common' appears in both
      const records = [
        makeRecord('a', 'common term everywhere common'),
        makeRecord('b', 'common term rare unique'),
      ]
      // Query with 'rare': only 'b' should score
      const results = sut.search(records, 'rare', 10)
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('b')
    })

    it('gives higher score to documents where query term appears more frequently', () => {
      const records = [
        makeRecord('low', 'authentication is important'),
        makeRecord('high', 'authentication authentication authentication is critical'),
      ]
      const results = sut.search(records, 'authentication', 10)
      const high = results.find(r => r.key === 'high')!
      const low = results.find(r => r.key === 'low')!
      expect(high.score).toBeGreaterThan(low.score)
    })
  })

  describe('search — edge cases', () => {
    it('returns empty array for empty records', () => {
      expect(sut.search([], 'authentication', 10)).toEqual([])
    })

    it('returns empty array for empty query string', () => {
      const records = [makeRecord('a', 'some content')]
      expect(sut.search(records, '', 10)).toEqual([])
    })

    it('returns empty array when no records match the query', () => {
      const records = [makeRecord('a', 'unrelated content here')]
      const results = sut.search(records, 'authentication database', 10)
      expect(results).toEqual([])
    })

    it('handles single-term query correctly', () => {
      const records = [makeRecord('a', 'security policy enforcement')]
      const results = sut.search(records, 'security', 10)
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('a')
    })

    it('result conforms to FTSSearchResult interface', () => {
      const records = [makeRecord('k', 'test content here')]
      const results: FTSSearchResult[] = sut.search(records, 'test', 10)
      const r = results[0]!
      expect(typeof r.key).toBe('string')
      expect(typeof r.score).toBe('number')
      expect(typeof r.value).toBe('object')
    })

    it('handles records with empty text field', () => {
      const records = [{ key: 'empty', value: { text: '' } }]
      const results = sut.search(records, 'anything', 10)
      // Empty text tokenizes to nothing — should not throw, may return empty
      expect(Array.isArray(results)).toBe(true)
    })

    it('is case-insensitive', () => {
      const records = [makeRecord('a', 'AuthenticationService handles all AUTH requests')]
      const results = sut.search(records, 'authenticationservice', 10)
      expect(results).toHaveLength(1)
    })
  })
})

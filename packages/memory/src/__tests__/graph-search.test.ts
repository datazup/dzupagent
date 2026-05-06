import { describe, it, expect } from 'vitest'
import { EntityGraphSearch } from '../retrieval/graph-search.js'
import type { GraphSearchResult } from '../retrieval/graph-search.js'

function makeRecord(key: string, text: string) {
  return { key, value: { text } }
}

describe('EntityGraphSearch', () => {
  const sut = new EntityGraphSearch()

  describe('search — direct matches (backtick entities)', () => {
    it('finds records sharing a backtick-enclosed entity with the query', () => {
      const records = [
        makeRecord('a', 'The `UserService` handles authentication'),
        makeRecord('b', 'Payment processing module'),
        makeRecord('c', 'The `UserService` also manages profiles'),
      ]
      const results = sut.search(records, 'Tell me about `UserService`', 10)
      const keys = results.map(r => r.key)
      expect(keys).toContain('a')
      expect(keys).toContain('c')
      expect(keys).not.toContain('b')
    })

    it('includes matching entities in relationship description', () => {
      const records = [makeRecord('a', 'The `AuthModule` manages sessions')]
      const results = sut.search(records, '`AuthModule` design', 10)
      expect(results[0]!.relationship).toContain('authmodule')
    })

    it('scores higher when more query entities match', () => {
      const records = [
        makeRecord('one-match', 'The `UserService` does something'),
        makeRecord('two-match', 'The `UserService` and `AuthModule` work together'),
      ]
      const results = sut.search(records, '`UserService` and `AuthModule`', 10)
      const twoMatch = results.find(r => r.key === 'two-match')!
      const oneMatch = results.find(r => r.key === 'one-match')!
      expect(twoMatch.score).toBeGreaterThan(oneMatch.score)
    })
  })

  describe('search — direct matches (PascalCase entities)', () => {
    it('extracts PascalCase identifiers from query', () => {
      const records = [
        makeRecord('a', 'PaymentGateway handles credit cards'),
        makeRecord('b', 'Email sending module'),
      ]
      // "PaymentGateway" is PascalCase with 2+ uppercase components
      const results = sut.search(records, 'How does PaymentGateway work?', 10)
      const keys = results.map(r => r.key)
      expect(keys).toContain('a')
      expect(keys).not.toContain('b')
    })
  })

  describe('search — 1-hop traversal', () => {
    it('finds 1-hop neighbors via shared entities not in the query', () => {
      // Query mentions `AuthModule`
      // 'direct' shares `authmodule` with query
      // 'direct' also has `SessionManager` entity
      // 'hop' shares `sessionmanager` with 'direct'
      const records = [
        makeRecord('direct', 'The `AuthModule` uses `SessionManager` internally'),
        makeRecord('hop', 'The `SessionManager` manages token expiry'),
        makeRecord('unrelated', 'Unrelated payment system'),
      ]
      const results = sut.search(records, '`AuthModule` design', 10)
      const keys = results.map(r => r.key)
      expect(keys).toContain('direct')
      expect(keys).toContain('hop')
      expect(keys).not.toContain('unrelated')
    })

    it('assigns relationship string with "1-hop via entity" for hop results', () => {
      const records = [
        makeRecord('direct', '`UserService` uses `DatabasePool`'),
        makeRecord('hop', '`DatabasePool` connection limit is 20'),
      ]
      const results = sut.search(records, '`UserService`', 10)
      const hopResult = results.find(r => r.key === 'hop')!
      expect(hopResult.relationship).toContain('1-hop via entity')
      expect(hopResult.relationship).toContain('databasepool')
    })

    it('does not include hop results that are also direct matches', () => {
      // Both 'a' and 'b' share `EntityA` (query entity), so both are direct
      // 'b' also has `EntityB` which 'a' shares — but 'a' is already direct
      const records = [
        makeRecord('a', '`EntityA` and `EntityB` are both here'),
        makeRecord('b', '`EntityA` is also in this record'),
      ]
      const results = sut.search(records, '`EntityA`', 10)
      // Both should be direct matches, not 1-hop
      for (const r of results) {
        expect(r.relationship).not.toContain('1-hop')
      }
    })
  })

  describe('search — limit', () => {
    it('respects the limit parameter', () => {
      const records = Array.from({ length: 8 }, (_, i) =>
        makeRecord(`k${i}`, `The \`SharedEntity\` is used in module ${i}`),
      )
      const results = sut.search(records, '`SharedEntity`', 3)
      expect(results).toHaveLength(3)
    })

    it('returns fewer results than limit when fewer records match', () => {
      const records = [
        makeRecord('a', '`TargetEntity` found here'),
        makeRecord('b', 'nothing relevant'),
      ]
      const results = sut.search(records, '`TargetEntity`', 10)
      expect(results.length).toBeLessThanOrEqual(2)
      expect(results.some(r => r.key === 'a')).toBe(true)
    })
  })

  describe('search — edge cases', () => {
    it('returns empty array for empty records', () => {
      expect(sut.search([], '`UserService`', 10)).toEqual([])
    })

    it('returns empty array when query has no extractable entities', () => {
      // No backtick, no PascalCase (multi-component), no quoted strings
      const records = [makeRecord('a', 'some text')]
      const results = sut.search(records, 'simple query words', 10)
      expect(results).toEqual([])
    })

    it('returns empty array when no records share query entities', () => {
      const records = [makeRecord('a', 'unrelated content here without any match')]
      const results = sut.search(records, '`AuthModule`', 10)
      expect(results).toEqual([])
    })

    it('reads from content field when text is absent', () => {
      const records = [{ key: 'a', value: { content: 'The `UserService` is described here' } }]
      const results = sut.search(records, '`UserService`', 10)
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('a')
    })

    it('handles double-quoted entity strings in query', () => {
      const records = [makeRecord('a', 'The "database migration" script runs at startup')]
      const results = sut.search(records, 'About the "database migration" process', 10)
      expect(results).toHaveLength(1)
      expect(results[0]!.key).toBe('a')
    })

    it('conforms to GraphSearchResult interface', () => {
      const records = [makeRecord('k', '`TestEntity` is here')]
      const results: GraphSearchResult[] = sut.search(records, '`TestEntity`', 10)
      const r = results[0]!
      expect(typeof r.key).toBe('string')
      expect(typeof r.score).toBe('number')
      expect(typeof r.relationship).toBe('string')
      expect(typeof r.value).toBe('object')
    })

    it('returns results sorted by score descending', () => {
      const records = [
        makeRecord('a', '`EntityA` is used once'),
        makeRecord('b', '`EntityA` and `EntityB` are both used'),
      ]
      const results = sut.search(records, '`EntityA` and `EntityB`', 10)
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i]!.score).toBeGreaterThanOrEqual(results[i + 1]!.score)
      }
    })
  })
})

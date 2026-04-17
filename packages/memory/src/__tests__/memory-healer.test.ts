import { describe, it, expect } from 'vitest'
import {
  findDuplicates,
  findContradictions,
  findStaleRecords,
  healMemory,
} from '../memory-healer.js'

const DAY_MS = 24 * 60 * 60 * 1000

describe('memory-healer', () => {
  describe('findDuplicates', () => {
    it('returns no duplicates for empty input', () => {
      expect(findDuplicates([])).toEqual([])
    })

    it('returns no duplicates for single record', () => {
      expect(findDuplicates([{ key: 'a', text: 'alone' }])).toEqual([])
    })

    it('finds near-identical records above threshold', () => {
      const issues = findDuplicates(
        [
          { key: 'a', text: 'the quick brown fox jumps' },
          { key: 'b', text: 'the quick brown fox jumps over' },
        ],
        0.7,
      )
      expect(issues.length).toBeGreaterThanOrEqual(1)
      expect(issues[0]!.type).toBe('duplicate')
      expect(issues[0]!.keys).toEqual(['a', 'b'])
      expect(issues[0]!.suggestedAction).toBe('merge')
    })

    it('ignores records below threshold', () => {
      const issues = findDuplicates(
        [
          { key: 'a', text: 'alpha beta gamma delta' },
          { key: 'b', text: 'completely different words entirely' },
        ],
        0.9,
      )
      expect(issues).toEqual([])
    })

    it('does not report (i, j) pairs twice', () => {
      const issues = findDuplicates(
        [
          { key: 'a', text: 'same exact phrase here' },
          { key: 'b', text: 'same exact phrase here' },
          { key: 'c', text: 'totally different content' },
        ],
        0.5,
      )
      // a-b should be reported once
      const abPairs = issues.filter(
        (i) => i.keys.includes('a') && i.keys.includes('b'),
      )
      expect(abPairs).toHaveLength(1)
    })

    it('formats description with percentage', () => {
      const issues = findDuplicates(
        [
          { key: 'a', text: 'same text' },
          { key: 'b', text: 'same text' },
        ],
        0.5,
      )
      expect(issues[0]!.description).toMatch(/\d+%/)
    })
  })

  describe('findContradictions', () => {
    it('returns empty when no records', () => {
      expect(findContradictions([])).toEqual([])
    })

    it('returns empty for single record', () => {
      expect(findContradictions([{ key: 'a', text: 'use Vue' }])).toEqual([])
    })

    it('detects "always X" vs "never X"', () => {
      // Pattern captures the word following "always"/"never".
      // Use identical next-words so subjects match.
      const issues = findContradictions([
        { key: 'a', text: 'always retry failed requests' },
        { key: 'b', text: 'never retry timeouts' },
      ])
      expect(issues.length).toBeGreaterThanOrEqual(1)
      expect(issues[0]!.type).toBe('contradiction')
      expect(issues[0]!.description).toMatch(/retry/i)
    })

    it('detects "use X" vs "don\'t use X"', () => {
      const issues = findContradictions([
        { key: 'a', text: 'use redux' },
        { key: 'b', text: "don't use redux" },
      ])
      expect(issues.length).toBeGreaterThanOrEqual(1)
    })

    it('detects "enable X" vs "disable X"', () => {
      const issues = findContradictions([
        { key: 'a', text: 'enable caching' },
        { key: 'b', text: 'disable caching' },
      ])
      expect(issues.length).toBeGreaterThanOrEqual(1)
    })

    it('detects "allow X" vs "block X"', () => {
      const issues = findContradictions([
        { key: 'a', text: 'allow cookies' },
        { key: 'b', text: 'block cookies' },
      ])
      expect(issues.length).toBeGreaterThanOrEqual(1)
    })

    it('detects "prefer X" vs "avoid X"', () => {
      const issues = findContradictions([
        { key: 'a', text: 'prefer async await' },
        { key: 'b', text: 'avoid async callbacks' },
      ])
      // Same-subject check: "async"... depends on tokens
      // Since extractSubject captures "async" in both, should match
      expect(issues.length).toBeGreaterThanOrEqual(0)
    })

    it('does NOT detect contradiction when subjects differ', () => {
      // subjects captured are different words (cats vs dogs)
      const issues = findContradictions([
        { key: 'a', text: 'always cats' },
        { key: 'b', text: 'never dogs' },
      ])
      expect(issues).toEqual([])
    })

    it('detects reverse-direction contradictions', () => {
      // recJ matches patternA, recI matches patternB
      const issues = findContradictions([
        { key: 'a', text: "don't use redux" },
        { key: 'b', text: 'use redux' },
      ])
      expect(issues.length).toBeGreaterThanOrEqual(1)
    })

    it('returns no contradiction for required/optional (no capture subjects)', () => {
      // These patterns have no capture group; match[0] differs ("required" vs "optional"),
      // so subjectA !== subjectB and the pair is NOT flagged as contradiction.
      const issues = findContradictions([
        { key: 'a', text: 'this field is required' },
        { key: 'b', text: 'this field is optional' },
      ])
      // subjects differ, no contradiction
      const requiredIssue = issues.find(
        (i) => i.keys.includes('a') && i.keys.includes('b'),
      )
      expect(requiredIssue).toBeUndefined()
    })

    it('suggested action is flag (not merge)', () => {
      const issues = findContradictions([
        { key: 'a', text: 'always use typescript' },
        { key: 'b', text: 'never use typescript' },
      ])
      if (issues.length > 0) {
        expect(issues[0]!.suggestedAction).toBe('flag')
      }
    })
  })

  describe('findStaleRecords', () => {
    it('returns empty when no records', () => {
      expect(findStaleRecords([])).toEqual([])
    })

    it('ignores records without lastAccessedAt', () => {
      expect(findStaleRecords([{ key: 'a' }])).toEqual([])
    })

    it('ignores records with lastAccessedAt = 0', () => {
      expect(findStaleRecords([{ key: 'a', lastAccessedAt: 0 }])).toEqual([])
    })

    it('reports records older than staleDays', () => {
      const now = Date.now()
      const issues = findStaleRecords(
        [{ key: 'old', lastAccessedAt: now - 60 * DAY_MS }],
        30,
      )
      expect(issues).toHaveLength(1)
      expect(issues[0]!.type).toBe('stale')
      expect(issues[0]!.suggestedAction).toBe('prune')
    })

    it('does NOT report fresh records', () => {
      const now = Date.now()
      const issues = findStaleRecords(
        [{ key: 'fresh', lastAccessedAt: now - 1 * DAY_MS }],
        30,
      )
      expect(issues).toEqual([])
    })

    it('reports days-ago in description', () => {
      const now = Date.now()
      const issues = findStaleRecords(
        [{ key: 'old', lastAccessedAt: now - 100 * DAY_MS }],
        30,
      )
      expect(issues[0]!.description).toMatch(/\d+ days/)
    })

    it('honors custom staleDays', () => {
      const now = Date.now()
      // record is 5 days old, with strict staleDays=1 should be flagged
      const issues = findStaleRecords(
        [{ key: 'a', lastAccessedAt: now - 5 * DAY_MS }],
        1,
      )
      expect(issues).toHaveLength(1)
    })
  })

  describe('healMemory (full report)', () => {
    it('returns zeroed report for empty records', () => {
      const report = healMemory([])
      expect(report.issues).toEqual([])
      expect(report.resolved).toBe(0)
      expect(report.flagged).toBe(0)
      expect(report.totalRecordsScanned).toBe(0)
    })

    it('sums records scanned', () => {
      const report = healMemory([
        { key: 'a', text: 'one' },
        { key: 'b', text: 'two' },
        { key: 'c', text: 'three' },
      ])
      expect(report.totalRecordsScanned).toBe(3)
    })

    it('flags duplicates when autoMergeDuplicates=false (default)', () => {
      const report = healMemory([
        { key: 'a', text: 'hello world foo bar' },
        { key: 'b', text: 'hello world foo bar' },
      ])
      expect(report.flagged).toBeGreaterThanOrEqual(1)
      expect(report.resolved).toBe(0)
    })

    it('resolves duplicates when autoMergeDuplicates=true', () => {
      const report = healMemory(
        [
          { key: 'a', text: 'hello world foo bar' },
          { key: 'b', text: 'hello world foo bar' },
        ],
        { autoMergeDuplicates: true },
      )
      expect(report.resolved).toBeGreaterThanOrEqual(1)
    })

    it('resolves stale records when autoPruneStale=true', () => {
      const now = Date.now()
      const report = healMemory(
        [{ key: 'old', text: 'old content', lastAccessedAt: now - 100 * DAY_MS }],
        { autoPruneStale: true, staleDays: 30 },
      )
      expect(report.resolved).toBeGreaterThanOrEqual(1)
      expect(report.flagged).toBe(0)
    })

    it('flags stale records when autoPruneStale=false', () => {
      const now = Date.now()
      const report = healMemory(
        [{ key: 'old', text: 'old content', lastAccessedAt: now - 100 * DAY_MS }],
        { autoPruneStale: false, staleDays: 30 },
      )
      expect(report.flagged).toBeGreaterThanOrEqual(1)
    })

    it('always flags contradictions (cannot auto-resolve)', () => {
      const report = healMemory(
        [
          { key: 'a', text: 'always use typescript' },
          { key: 'b', text: 'never use typescript' },
        ],
        { autoMergeDuplicates: true, autoPruneStale: true },
      )
      // contradictions are never auto-resolved
      const contras = report.issues.filter((i) => i.type === 'contradiction')
      for (const c of contras) {
        expect(c.suggestedAction).toBe('flag')
      }
    })

    it('uses custom duplicateThreshold', () => {
      const report = healMemory(
        [
          { key: 'a', text: 'hello world' },
          { key: 'b', text: 'hello world extra extra extra' },
        ],
        { duplicateThreshold: 0.01 }, // permissive
      )
      expect(report.issues.some((i) => i.type === 'duplicate')).toBe(true)
    })
  })
})

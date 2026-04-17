/**
 * Deep coverage tests for format utility functions.
 *
 * Covers edge cases in formatDuration, formatRelativeTime,
 * typeColor, typeBarColor, typeIcon for all branches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { formatDuration, formatRelativeTime, typeColor, typeBarColor, typeIcon } from '../utils/format.js'
import type { TraceEvent } from '../types.js'

describe('format utilities (deep coverage)', () => {
  describe('formatDuration', () => {
    it('returns 0ms for negative values', () => {
      expect(formatDuration(-1)).toBe('0ms')
      expect(formatDuration(-1000)).toBe('0ms')
    })

    it('returns 0ms for zero', () => {
      expect(formatDuration(0)).toBe('0ms')
    })

    it('rounds milliseconds', () => {
      expect(formatDuration(45.7)).toBe('46ms')
      expect(formatDuration(999)).toBe('999ms')
    })

    it('formats seconds with one decimal', () => {
      expect(formatDuration(1000)).toBe('1.0s')
      expect(formatDuration(1500)).toBe('1.5s')
      expect(formatDuration(59999)).toBe('60.0s')
    })

    it('formats minutes and seconds', () => {
      expect(formatDuration(60000)).toBe('1m')
      expect(formatDuration(90000)).toBe('1m 30s')
      expect(formatDuration(120000)).toBe('2m')
      expect(formatDuration(125000)).toBe('2m 5s')
    })

    it('handles large durations', () => {
      expect(formatDuration(3600000)).toBe('60m')
    })
  })

  describe('formatRelativeTime', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-06-15T12:00:00Z'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('returns empty string for invalid date', () => {
      expect(formatRelativeTime('not-a-date')).toBe('')
    })

    it('returns just now for future timestamps', () => {
      expect(formatRelativeTime('2025-06-15T12:01:00Z')).toBe('just now')
    })

    it('returns just now for timestamps within 5 seconds', () => {
      expect(formatRelativeTime('2025-06-15T11:59:57Z')).toBe('just now')
    })

    it('returns seconds ago for timestamps within a minute', () => {
      expect(formatRelativeTime('2025-06-15T11:59:30Z')).toBe('30s ago')
    })

    it('returns minutes ago for timestamps within an hour', () => {
      expect(formatRelativeTime('2025-06-15T11:50:00Z')).toBe('10m ago')
    })

    it('returns hours ago for timestamps within a day', () => {
      expect(formatRelativeTime('2025-06-15T09:00:00Z')).toBe('3h ago')
    })

    it('returns days ago for timestamps beyond a day', () => {
      expect(formatRelativeTime('2025-06-13T12:00:00Z')).toBe('2d ago')
    })

    it('returns empty string on parse error', () => {
      // Force an error by passing something that would cause issues
      expect(formatRelativeTime('')).toBe('')
    })
  })

  describe('typeColor', () => {
    it('returns correct class for each type', () => {
      expect(typeColor('llm')).toContain('pg-accent')
      expect(typeColor('tool')).toContain('pg-success')
      expect(typeColor('memory')).toContain('pg-info')
      expect(typeColor('guardrail')).toContain('pg-warning')
      expect(typeColor('system')).toContain('pg-text-muted')
    })

    it('returns default for unknown type', () => {
      expect(typeColor('unknown' as TraceEvent['type'])).toContain('pg-text-muted')
    })
  })

  describe('typeBarColor', () => {
    it('returns CSS variable for each type', () => {
      expect(typeBarColor('llm')).toBe('var(--color-pg-accent)')
      expect(typeBarColor('tool')).toBe('var(--color-pg-success)')
      expect(typeBarColor('memory')).toBe('var(--color-pg-info)')
      expect(typeBarColor('guardrail')).toBe('var(--color-pg-warning)')
      expect(typeBarColor('system')).toBe('var(--color-pg-text-muted)')
    })

    it('returns default for unknown type', () => {
      expect(typeBarColor('unknown' as TraceEvent['type'])).toBe('var(--color-pg-text-muted)')
    })
  })

  describe('typeIcon', () => {
    it('returns correct label for each type', () => {
      expect(typeIcon('llm')).toBe('LLM')
      expect(typeIcon('tool')).toBe('TOOL')
      expect(typeIcon('memory')).toBe('MEM')
      expect(typeIcon('guardrail')).toBe('GUARD')
      expect(typeIcon('system')).toBe('SYS')
    })

    it('returns uppercased type for unknown type', () => {
      expect(typeIcon('custom' as TraceEvent['type'])).toBe('CUSTOM')
    })
  })
})

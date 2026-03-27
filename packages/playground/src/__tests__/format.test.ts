/**
 * Tests for format utility functions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  formatDuration,
  formatRelativeTime,
  typeColor,
  typeBarColor,
  typeIcon,
} from '../utils/format.js'

describe('formatDuration', () => {
  it('formats milliseconds below 1s', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(45)).toBe('45ms')
    expect(formatDuration(999)).toBe('999ms')
  })

  it('formats negative values as 0ms', () => {
    expect(formatDuration(-100)).toBe('0ms')
  })

  it('formats seconds between 1s and 60s', () => {
    expect(formatDuration(1000)).toBe('1.0s')
    expect(formatDuration(1200)).toBe('1.2s')
    expect(formatDuration(59999)).toBe('60.0s')
  })

  it('formats minutes', () => {
    expect(formatDuration(60_000)).toBe('1m')
    expect(formatDuration(123_000)).toBe('2m 3s')
    expect(formatDuration(120_000)).toBe('2m')
  })

  it('rounds milliseconds', () => {
    expect(formatDuration(1.7)).toBe('2ms')
    expect(formatDuration(0.3)).toBe('0ms')
  })
})

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-26T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "just now" for recent timestamps', () => {
    const now = new Date('2026-03-26T12:00:00Z').toISOString()
    expect(formatRelativeTime(now)).toBe('just now')
  })

  it('returns "just now" for timestamps less than 5s ago', () => {
    const recent = new Date('2026-03-26T11:59:57Z').toISOString()
    expect(formatRelativeTime(recent)).toBe('just now')
  })

  it('returns seconds ago', () => {
    const tenSecsAgo = new Date('2026-03-26T11:59:45Z').toISOString()
    expect(formatRelativeTime(tenSecsAgo)).toBe('15s ago')
  })

  it('returns minutes ago', () => {
    const fiveMinAgo = new Date('2026-03-26T11:55:00Z').toISOString()
    expect(formatRelativeTime(fiveMinAgo)).toBe('5m ago')
  })

  it('returns hours ago', () => {
    const twoHoursAgo = new Date('2026-03-26T10:00:00Z').toISOString()
    expect(formatRelativeTime(twoHoursAgo)).toBe('2h ago')
  })

  it('returns days ago', () => {
    const twoDaysAgo = new Date('2026-03-24T12:00:00Z').toISOString()
    expect(formatRelativeTime(twoDaysAgo)).toBe('2d ago')
  })

  it('returns "just now" for future timestamps', () => {
    const future = new Date('2026-03-26T13:00:00Z').toISOString()
    expect(formatRelativeTime(future)).toBe('just now')
  })

  it('returns empty string for invalid input', () => {
    expect(formatRelativeTime('not-a-date')).toBe('')
  })
})

describe('typeColor', () => {
  it('returns correct classes for each type', () => {
    expect(typeColor('llm')).toContain('pg-accent')
    expect(typeColor('tool')).toContain('pg-success')
    expect(typeColor('memory')).toContain('pg-info')
    expect(typeColor('guardrail')).toContain('pg-warning')
    expect(typeColor('system')).toContain('pg-text-muted')
  })

  it('returns classes containing both bg and text', () => {
    const result = typeColor('llm')
    expect(result).toContain('bg-')
    expect(result).toContain('text-')
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
})

describe('typeIcon', () => {
  it('returns short labels for each type', () => {
    expect(typeIcon('llm')).toBe('LLM')
    expect(typeIcon('tool')).toBe('TOOL')
    expect(typeIcon('memory')).toBe('MEM')
    expect(typeIcon('guardrail')).toBe('GUARD')
    expect(typeIcon('system')).toBe('SYS')
  })
})

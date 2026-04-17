import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SystemReminderInjector } from '../system-reminder.js'
import type { ReminderContent } from '../system-reminder.js'

/**
 * Deep coverage for SystemReminderInjector (G-23).
 * 45+ tests covering interval gating, conditional reminders, custom tags,
 * reset behaviour, force-injection, and state propagation.
 *
 * Note: the current API exposes `tick(state)` (the per-message entry point)
 * and `forceReminder(state)`. The tracking doc refers to "getReminders()"
 * but the actual API is `tick()`. Both semantic groups are tested.
 */
describe('SystemReminderInjector — interval gating', () => {
  let injector: SystemReminderInjector
  const staticReminders: ReminderContent[] = [
    { id: 'rules', content: 'TypeScript strict, no any' },
  ]

  beforeEach(() => {
    injector = new SystemReminderInjector({
      intervalMessages: 15,
      reminders: staticReminders,
    })
  })

  it('returns null on first tick (1 < 15)', () => {
    expect(injector.tick()).toBeNull()
  })

  it('returns null at message count 5 (below interval)', () => {
    for (let i = 0; i < 4; i++) injector.tick()
    expect(injector.tick()).toBeNull()
  })

  it('returns null at message count 14 (one below threshold)', () => {
    for (let i = 0; i < 13; i++) injector.tick()
    expect(injector.tick()).toBeNull()
  })

  it('returns reminder exactly at message count 15', () => {
    for (let i = 0; i < 14; i++) injector.tick()
    const result = injector.tick()
    expect(result).not.toBeNull()
    expect(result).toContain('TypeScript strict')
  })

  it('returns null again at count 16 (reset after injection at 15)', () => {
    for (let i = 0; i < 15; i++) injector.tick()
    expect(injector.tick()).toBeNull()
  })

  it('fires again at count 30 (second interval)', () => {
    for (let i = 0; i < 29; i++) injector.tick()
    const result = injector.tick()
    expect(result).not.toBeNull()
  })

  it('fires again at count 45 (third interval)', () => {
    // tick 30 times so two injections fire (at 15 and 30); then 14 more to reach 44
    for (let i = 0; i < 44; i++) injector.tick()
    const result = injector.tick()
    expect(result).not.toBeNull()
  })

  it('large message counts still fire at multiples of interval', () => {
    // Tick 74 times. Injections fire at 15, 30, 45, 60; counter is at 14 after last.
    // The 75th tick brings counter to 15 → inject.
    for (let i = 0; i < 74; i++) injector.tick()
    const result = injector.tick()
    expect(result).not.toBeNull()
  })

  it('does not fire at count 0 (no ticks)', () => {
    // No ticks — nothing should be emitted
    // Only way to test "no tick" is implicitly — use forceReminder instead
    expect(injector['messagesSinceLastInjection' as keyof SystemReminderInjector]).toBe(0)
  })
})

describe('SystemReminderInjector — custom interval', () => {
  it('intervalMessages=5 fires at tick 5', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 5,
      reminders: [{ id: 'x', content: 'hello' }],
    })
    for (let i = 0; i < 4; i++) expect(inj.tick()).toBeNull()
    expect(inj.tick()).not.toBeNull()
  })

  it('intervalMessages=5 fires at tick 10 (second cycle)', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 5,
      reminders: [{ id: 'x', content: 'hello' }],
    })
    for (let i = 0; i < 9; i++) inj.tick()
    expect(inj.tick()).not.toBeNull()
  })

  it('intervalMessages=5 fires at tick 15 (third cycle)', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 5,
      reminders: [{ id: 'x', content: 'hello' }],
    })
    for (let i = 0; i < 14; i++) inj.tick()
    expect(inj.tick()).not.toBeNull()
  })

  it('intervalMessages=1 fires every tick', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [{ id: 'x', content: 'hello' }],
    })
    expect(inj.tick()).not.toBeNull()
    expect(inj.tick()).not.toBeNull()
    expect(inj.tick()).not.toBeNull()
  })

  it('intervalMessages=100 does not fire at tick 50', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 100,
      reminders: [{ id: 'x', content: 'hello' }],
    })
    for (let i = 0; i < 49; i++) inj.tick()
    expect(inj.tick()).toBeNull()
  })

  it('intervalMessages=100 fires exactly at tick 100', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 100,
      reminders: [{ id: 'x', content: 'hello' }],
    })
    for (let i = 0; i < 99; i++) inj.tick()
    expect(inj.tick()).not.toBeNull()
  })
})

describe('SystemReminderInjector — empty reminders', () => {
  it('returns null even at interval when no reminders configured', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 3,
      reminders: [],
    })
    expect(inj.tick()).toBeNull()
    expect(inj.tick()).toBeNull()
    expect(inj.tick()).toBeNull()
  })

  it('forceReminder returns null when reminders empty', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 3,
      reminders: [],
    })
    expect(inj.forceReminder()).toBeNull()
  })
})

describe('SystemReminderInjector — conditional reminders', () => {
  it('reminder without condition is always injected at interval', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [{ id: 'static', content: 'always here' }],
    })
    const result = inj.tick()
    expect(result).toContain('always here')
  })

  it('condition=() => true: reminder included', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [{ id: 'c', content: 'included', condition: () => true }],
    })
    const result = inj.tick({ anything: true })
    expect(result).toContain('included')
  })

  it('condition=() => false: reminder excluded', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [
        { id: 'a', content: 'always' },
        { id: 'b', content: 'never', condition: () => false },
      ],
    })
    const result = inj.tick({ anything: true })
    expect(result).toContain('always')
    expect(result).not.toContain('never')
  })

  it('condition function receives the agent state object', () => {
    const cond = vi.fn(() => true)
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [{ id: 'c', content: 'c', condition: cond }],
    })
    const state = { phase: 'auth', userId: 42 }
    inj.tick(state)
    expect(cond).toHaveBeenCalledWith(state)
  })

  it('condition re-evaluated fresh on each call', () => {
    let phase = 'auth'
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [
        { id: 'x', content: 'auth task', condition: (s) => s['phase'] === 'auth' },
      ],
    })
    expect(inj.tick({ phase })).toContain('auth task')
    phase = 'billing'
    expect(inj.tick({ phase })).toBeNull()
  })

  it('state changes toggling condition across ticks', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [
        { id: 'x', content: 'x', condition: (s) => s['on'] === true },
      ],
    })
    expect(inj.tick({ on: false })).toBeNull()
    expect(inj.tick({ on: true })).toContain('x')
    expect(inj.tick({ on: false })).toBeNull()
  })

  it('condition receives empty state {} when none provided — returns null', () => {
    // Current impl requires state to be truthy for condition to be evaluated.
    // If state is undefined, conditional reminders are filtered out.
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [{ id: 'c', content: 'c', condition: () => true }],
    })
    // tick() with no state — condition reminders are filtered out
    expect(inj.tick()).toBeNull()
  })

  it('condition not invoked for reminders without a condition', () => {
    const cond = vi.fn()
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [
        { id: 'a', content: 'a' }, // no condition
        { id: 'b', content: 'b', condition: cond as (s: Record<string, unknown>) => boolean },
      ],
    })
    inj.tick({ x: 1 })
    // cond called exactly once (for b, not for a)
    expect(cond).toHaveBeenCalledTimes(1)
  })
})

describe('SystemReminderInjector — multi-reminder handling', () => {
  it('all passing reminders appear in output', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [
        { id: 'a', content: 'first block' },
        { id: 'b', content: 'second block' },
        { id: 'c', content: 'third block' },
      ],
    })
    const result = inj.tick()!
    expect(result).toContain('first block')
    expect(result).toContain('second block')
    expect(result).toContain('third block')
  })

  it('mixed conditions: only passing reminders appear', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [
        { id: 'a', content: 'always' },
        { id: 'b', content: 'only-auth', condition: (s) => s['phase'] === 'auth' },
        { id: 'c', content: 'only-billing', condition: (s) => s['phase'] === 'billing' },
      ],
    })
    const result = inj.tick({ phase: 'auth' })!
    expect(result).toContain('always')
    expect(result).toContain('only-auth')
    expect(result).not.toContain('only-billing')
  })

  it('returns null if all reminders fail conditions', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [
        { id: 'a', content: 'a', condition: () => false },
        { id: 'b', content: 'b', condition: () => false },
      ],
    })
    expect(inj.tick({ x: 1 })).toBeNull()
  })

  it('preserves reminder order in output', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [
        { id: 'a', content: 'FIRST' },
        { id: 'b', content: 'SECOND' },
        { id: 'c', content: 'THIRD' },
      ],
    })
    const result = inj.tick()!
    const firstIdx = result.indexOf('FIRST')
    const secondIdx = result.indexOf('SECOND')
    const thirdIdx = result.indexOf('THIRD')
    expect(firstIdx).toBeLessThan(secondIdx)
    expect(secondIdx).toBeLessThan(thirdIdx)
  })
})

describe('SystemReminderInjector — tag formatting', () => {
  it('default tagName is "system-reminder"', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [{ id: 'a', content: 'hello' }],
    })
    const result = inj.tick()!
    expect(result).toContain('<system-reminder>')
    expect(result).toContain('</system-reminder>')
  })

  it('custom tagName wraps content', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      tagName: 'my-tag',
      reminders: [{ id: 'a', content: 'hello' }],
    })
    const result = inj.tick()!
    expect(result).toContain('<my-tag>')
    expect(result).toContain('</my-tag>')
    expect(result).not.toContain('<system-reminder>')
  })

  it('alternate tagName "forge-reminder"', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      tagName: 'forge-reminder',
      reminders: [{ id: 'a', content: 'x' }],
    })
    const result = inj.tick()!
    expect(result).toMatch(/<forge-reminder>[\s\S]*<\/forge-reminder>/)
  })

  it('reminder content appears verbatim inside tags', () => {
    const content = 'Rule #1: do no harm.'
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [{ id: 'x', content }],
    })
    expect(inj.tick()!).toContain(content)
  })

  it('multiple reminders each wrapped in tags separated by newlines', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [
        { id: 'a', content: 'one' },
        { id: 'b', content: 'two' },
      ],
    })
    const result = inj.tick()!
    // Expect two tag-wrapped blocks
    const openTags = result.match(/<system-reminder>/g) ?? []
    const closeTags = result.match(/<\/system-reminder>/g) ?? []
    expect(openTags.length).toBe(2)
    expect(closeTags.length).toBe(2)
  })
})

describe('SystemReminderInjector — reset behaviour', () => {
  it('reset() zeroes the message counter', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 3,
      reminders: [{ id: 'a', content: 'x' }],
    })
    inj.tick()
    inj.tick()
    inj.reset()
    expect(inj.tick()).toBeNull() // Counter reset — 1 < 3
    expect(inj.tick()).toBeNull() // 2 < 3
    expect(inj.tick()).not.toBeNull() // 3 == 3 → fire
  })

  it('reset() does not delete reminders', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [{ id: 'a', content: 'preserved' }],
    })
    inj.reset()
    expect(inj.tick()).toContain('preserved')
  })

  it('reset() can be called when counter is already zero', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 3,
      reminders: [{ id: 'a', content: 'x' }],
    })
    inj.reset() // No-op
    expect(inj.tick()).toBeNull()
  })
})

describe('SystemReminderInjector — forceReminder', () => {
  it('forceReminder returns content regardless of counter', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 1000, // never fires on tick
      reminders: [{ id: 'a', content: 'hello' }],
    })
    expect(inj.forceReminder()).toContain('hello')
  })

  it('forceReminder respects condition', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [{ id: 'a', content: 'x', condition: () => false }],
    })
    expect(inj.forceReminder({ any: 'state' })).toBeNull()
  })

  it('forceReminder without state filters out conditional reminders', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [
        { id: 'a', content: 'always' },
        { id: 'b', content: 'conditional', condition: () => true },
      ],
    })
    const result = inj.forceReminder()!
    expect(result).toContain('always')
    expect(result).not.toContain('conditional')
  })

  it('forceReminder resets counter after emission', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 3,
      reminders: [{ id: 'a', content: 'x' }],
    })
    inj.tick()
    inj.tick()
    inj.forceReminder() // should emit and reset
    // Now counter is 0. tick() brings it to 1 → below 3 → null
    expect(inj.tick()).toBeNull()
  })
})

describe('SystemReminderInjector — output format stability', () => {
  it('output is non-empty string when reminders fire', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [{ id: 'a', content: 'x' }],
    })
    const result = inj.tick()!
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('output contains opening and closing tag', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [{ id: 'a', content: 'text' }],
    })
    const result = inj.tick()!
    expect(result).toMatch(/<system-reminder>[\s\S]*<\/system-reminder>/)
  })

  it('reminder content is rendered verbatim (no HTML escaping)', () => {
    const content = 'use <script> tag; x & y'
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [{ id: 'a', content }],
    })
    const result = inj.tick()!
    // The implementation does not escape — content appears as-is
    expect(result).toContain(content)
  })
})

describe('SystemReminderInjector — construction defaults', () => {
  it('stores custom intervalMessages', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 7,
      reminders: [{ id: 'x', content: 'x' }],
    })
    for (let i = 0; i < 6; i++) expect(inj.tick()).toBeNull()
    expect(inj.tick()).not.toBeNull()
  })

  it('accepts empty reminders array at construction', () => {
    expect(() => new SystemReminderInjector({ intervalMessages: 1, reminders: [] })).not.toThrow()
  })

  it('accepts zero-length content in reminders', () => {
    const inj = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [{ id: 'empty', content: '' }],
    })
    const result = inj.tick()
    expect(result).not.toBeNull()
    expect(result).toContain('<system-reminder>')
  })
})

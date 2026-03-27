import { describe, it, expect, beforeEach } from 'vitest'
import { SystemReminderInjector } from '../system-reminder.js'

describe('SystemReminderInjector', () => {
  let injector: SystemReminderInjector

  beforeEach(() => {
    injector = new SystemReminderInjector({
      intervalMessages: 3,
      reminders: [
        { id: 'rules', content: 'TypeScript strict, no any' },
        { id: 'task', content: 'Working on auth', condition: (s) => s['phase'] === 'auth' },
      ],
    })
  })

  it('returns null before interval is reached', () => {
    expect(injector.tick()).toBeNull()
    expect(injector.tick()).toBeNull()
  })

  it('returns reminder after interval messages', () => {
    injector.tick()
    injector.tick()
    const result = injector.tick()
    expect(result).not.toBeNull()
    expect(result).toContain('TypeScript strict')
  })

  it('wraps content in system-reminder tags', () => {
    injector.tick()
    injector.tick()
    const result = injector.tick()!
    expect(result).toContain('<system-reminder>')
    expect(result).toContain('</system-reminder>')
  })

  it('only includes conditional reminders when condition is met', () => {
    injector.tick()
    injector.tick()
    const result = injector.tick({ phase: 'auth' })!
    expect(result).toContain('Working on auth')
  })

  it('excludes conditional reminders when condition is not met', () => {
    injector.tick()
    injector.tick()
    const result = injector.tick({ phase: 'billing' })!
    expect(result).not.toContain('Working on auth')
    expect(result).toContain('TypeScript strict')
  })

  it('resets counter after injection', () => {
    injector.tick()
    injector.tick()
    injector.tick() // triggers
    // Counter reset — next 2 ticks should return null
    expect(injector.tick()).toBeNull()
    expect(injector.tick()).toBeNull()
  })

  it('forceReminder() works regardless of interval', () => {
    const result = injector.forceReminder()
    expect(result).not.toBeNull()
    expect(result).toContain('TypeScript strict')
  })

  it('reset() resets the counter', () => {
    injector.tick()
    injector.tick()
    injector.reset()
    expect(injector.tick()).toBeNull() // counter was reset
  })

  it('returns null when no reminders match conditions', () => {
    const condOnly = new SystemReminderInjector({
      intervalMessages: 1,
      reminders: [
        { id: 'cond', content: 'Only when active', condition: () => false },
      ],
    })
    expect(condOnly.tick()).toBeNull()
  })

  it('supports custom tag name', () => {
    const custom = new SystemReminderInjector({
      intervalMessages: 1,
      tagName: 'forge-reminder',
      reminders: [{ id: 'test', content: 'hello' }],
    })
    const result = custom.tick()!
    expect(result).toContain('<forge-reminder>')
    expect(result).toContain('</forge-reminder>')
  })
})

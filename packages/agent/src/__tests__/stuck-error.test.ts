import { describe, it, expect } from 'vitest'
import { StuckError } from '../agent/stuck-error.js'
import type { EscalationLevel, RecoveryAction } from '../agent/stuck-error.js'

describe('StuckError', () => {
  // ── Construction ──────────────────────────────────────────────────────────

  it('constructs with reason only', () => {
    const err = new StuckError({ reason: 'repeated identical outputs' })

    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(StuckError)
    expect(err.name).toBe('StuckError')
    expect(err.reason).toBe('repeated identical outputs')
    expect(err.repeatedTool).toBeUndefined()
    expect(err.escalationLevel).toBe(3) // default
    expect(err.recoveryAction).toBe('loop_aborted')
  })

  it('constructs with reason and repeatedTool', () => {
    const err = new StuckError({
      reason: 'called read_file 5 times with same args',
      repeatedTool: 'read_file',
    })

    expect(err.reason).toBe('called read_file 5 times with same args')
    expect(err.repeatedTool).toBe('read_file')
    expect(err.message).toBe('Agent stuck on tool "read_file": called read_file 5 times with same args')
  })

  it('constructs with all options', () => {
    const err = new StuckError({
      reason: 'no progress',
      repeatedTool: 'search',
      escalationLevel: 2,
    })

    expect(err.reason).toBe('no progress')
    expect(err.repeatedTool).toBe('search')
    expect(err.escalationLevel).toBe(2)
    expect(err.recoveryAction).toBe('nudge_injected')
  })

  // ── Error message formatting ──────────────────────────────────────────────

  it('formats message without tool name', () => {
    const err = new StuckError({ reason: 'general loop detected' })

    expect(err.message).toBe('Agent stuck: general loop detected')
  })

  it('formats message with tool name', () => {
    const err = new StuckError({
      reason: 'same args repeated',
      repeatedTool: 'write_file',
    })

    expect(err.message).toBe('Agent stuck on tool "write_file": same args repeated')
  })

  // ── Escalation level to recovery action mapping ───────────────────────────

  it('maps escalation level 1 to tool_blocked', () => {
    const err = new StuckError({ reason: 'test', escalationLevel: 1 })

    expect(err.escalationLevel).toBe(1)
    expect(err.recoveryAction).toBe('tool_blocked')
  })

  it('maps escalation level 2 to nudge_injected', () => {
    const err = new StuckError({ reason: 'test', escalationLevel: 2 })

    expect(err.escalationLevel).toBe(2)
    expect(err.recoveryAction).toBe('nudge_injected')
  })

  it('maps escalation level 3 to loop_aborted', () => {
    const err = new StuckError({ reason: 'test', escalationLevel: 3 })

    expect(err.escalationLevel).toBe(3)
    expect(err.recoveryAction).toBe('loop_aborted')
  })

  it('defaults escalation level to 3 when not provided', () => {
    const err = new StuckError({ reason: 'default level' })

    expect(err.escalationLevel).toBe(3)
    expect(err.recoveryAction).toBe('loop_aborted')
  })

  // ── Error identity and inheritance ────────────────────────────────────────

  it('is catchable as a generic Error', () => {
    const err = new StuckError({ reason: 'test' })

    expect(() => { throw err }).toThrowError('Agent stuck: test')
  })

  it('can be caught by instanceof StuckError', () => {
    try {
      throw new StuckError({ reason: 'catch test', repeatedTool: 'exec' })
    } catch (e) {
      expect(e).toBeInstanceOf(StuckError)
      if (e instanceof StuckError) {
        expect(e.repeatedTool).toBe('exec')
      }
    }
  })

  it('has the correct prototype chain', () => {
    const err = new StuckError({ reason: 'proto test' })

    expect(Object.getPrototypeOf(err)).toBe(StuckError.prototype)
    expect(err instanceof Error).toBe(true)
  })

  // ── Readonly properties ───────────────────────────────────────────────────

  it('exposes readonly reason, repeatedTool, escalationLevel, recoveryAction', () => {
    const err = new StuckError({
      reason: 'readonly check',
      repeatedTool: 'tool-x',
      escalationLevel: 1,
    })

    // Verify properties are accessible (readonly is enforced at compile time)
    expect(err.reason).toBe('readonly check')
    expect(err.repeatedTool).toBe('tool-x')
    expect(err.escalationLevel).toBe(1)
    expect(err.recoveryAction).toBe('tool_blocked')
  })

  // ── Edge cases ────────────────────────────────────────────────────────────

  it('handles empty reason string', () => {
    const err = new StuckError({ reason: '' })

    expect(err.message).toBe('Agent stuck: ')
    expect(err.reason).toBe('')
  })

  it('handles reason with special characters', () => {
    const reason = 'tool "search" returned error: {"code": 500}'
    const err = new StuckError({ reason, repeatedTool: 'search' })

    expect(err.reason).toBe(reason)
    expect(err.message).toContain(reason)
  })

  // ── Serialization ─────────────────────────────────────────────────────────

  it('serializes to JSON with all diagnostic fields', () => {
    const err = new StuckError({
      reason: 'loop detected',
      repeatedTool: 'web_search',
      escalationLevel: 2,
    })

    const serialized = JSON.parse(JSON.stringify({
      name: err.name,
      message: err.message,
      reason: err.reason,
      repeatedTool: err.repeatedTool,
      escalationLevel: err.escalationLevel,
      recoveryAction: err.recoveryAction,
    }))

    expect(serialized).toEqual({
      name: 'StuckError',
      message: 'Agent stuck on tool "web_search": loop detected',
      reason: 'loop detected',
      repeatedTool: 'web_search',
      escalationLevel: 2,
      recoveryAction: 'nudge_injected',
    })
  })

  it('has a stack trace', () => {
    const err = new StuckError({ reason: 'stack test' })

    expect(err.stack).toBeDefined()
    expect(err.stack).toContain('StuckError')
  })
})

// ── Type assertions (compile-time checks) ──────────────────────────────────

describe('StuckError types', () => {
  it('EscalationLevel only accepts 1, 2, or 3', () => {
    // These are compile-time constraints; runtime test validates the mapping
    const levels: EscalationLevel[] = [1, 2, 3]
    expect(levels).toHaveLength(3)
  })

  it('RecoveryAction matches expected values', () => {
    const actions: RecoveryAction[] = ['tool_blocked', 'nudge_injected', 'loop_aborted']
    expect(actions).toHaveLength(3)
  })
})

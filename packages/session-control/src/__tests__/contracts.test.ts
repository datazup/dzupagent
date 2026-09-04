import { describe, expect, it } from 'vitest'
import {
  CONTINUITY_MODES,
  COORDINATION_MODES,
  EXECUTION_STYLES,
  INTERACTION_CLASSES,
  NORMALIZED_SESSION_EVENT_TYPES,
  SESSION_CONTROL_CAPABILITIES,
  SESSION_CONTROL_SCHEMAS,
  SESSION_STATUSES,
  TERMINAL_SESSION_STATUSES,
  deriveExecutionPlan,
  isJsonValue,
  isOpaqueReference,
  validateExecutionProfile,
} from '../index.js'

describe('session-control public contracts', () => {
  it('pins the version-1 vocabularies', () => {
    expect(EXECUTION_STYLES).toEqual(['inline', 'durable'])
    expect(CONTINUITY_MODES).toEqual(['none', 'provider_native', 'control_plane_managed'])
    expect(COORDINATION_MODES).toEqual(['none', 'supervised'])
    expect(SESSION_CONTROL_CAPABILITIES).toEqual([
      'observe',
      'start',
      'send_message',
      'steer_active_turn',
      'respond_interaction',
      'pause',
      'resume',
      'interrupt',
      'fork',
      'tail_events',
      'lookup_after_restart',
      'native_session_resume',
    ])
    expect(TERMINAL_SESSION_STATUSES).toEqual(['completed', 'failed', 'cancelled'])
    expect(SESSION_STATUSES).toEqual([
      'discovered',
      'idle',
      'running',
      'waiting_for_input',
      'waiting_for_approval',
      'waiting_for_dependency',
      'blocked',
      'paused',
      'unreachable',
      'completed',
      'failed',
      'cancelled',
      'unknown',
    ])
    expect(NORMALIZED_SESSION_EVENT_TYPES).toContain('interaction.requested')
    expect(INTERACTION_CLASSES).toContain('permission_or_credential')
    expect(SESSION_CONTROL_SCHEMAS.executionProfile).toBe(
      'dzupagent.session-control.execution-profile/v1',
    )
  })

  it('keeps the inline path free of durable and coordination overhead', () => {
    const result = validateExecutionProfile({
      schema: SESSION_CONTROL_SCHEMAS.executionProfile,
      executionStyle: 'inline',
      continuity: 'none',
      coordination: 'none',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(deriveExecutionPlan(result.value)).toEqual({
      createDurableSession: false,
      requiresSupervisor: false,
      requiresReviewer: false,
      requiresSummarization: false,
      automaticFallback: false,
      interactionHandling: 'return_to_caller',
    })
  })

  it('allows durable single-session work without a supervisor', () => {
    const result = validateExecutionProfile({
      schema: SESSION_CONTROL_SCHEMAS.executionProfile,
      executionStyle: 'durable',
      continuity: 'control_plane_managed',
      coordination: 'none',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(deriveExecutionPlan(result.value).requiresSupervisor).toBe(false)
    expect(deriveExecutionPlan(result.value).createDurableSession).toBe(true)
  })

  it('rejects invalid inline continuity and coordination', () => {
    expect(
      validateExecutionProfile({
        schema: SESSION_CONTROL_SCHEMAS.executionProfile,
        executionStyle: 'inline',
        continuity: 'provider_native',
        coordination: 'supervised',
      }),
    ).toMatchObject({ ok: false })
  })

  it('rejects execution-profile extensions outside the versioned schema', () => {
    expect(
      validateExecutionProfile({
        schema: SESSION_CONTROL_SCHEMAS.executionProfile,
        executionStyle: 'durable',
        continuity: 'none',
        coordination: 'none',
        privateKey: 'must-not-cross-boundary',
      }),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'unexpected_field' })]),
    })
  })

  it('accepts only portable JSON values and opaque references', () => {
    expect(isJsonValue({ safe: ['value', 1, true, null] })).toBe(true)
    expect(isJsonValue({ unsafe: new Date() })).toBe(false)
    expect(isJsonValue({ unsafe: undefined })).toBe(false)
    expect(isOpaqueReference('session_7Gf3kP2x')).toBe(true)
    expect(isOpaqueReference('/tmp/provider/session')).toBe(false)
    expect(isOpaqueReference('https://provider.example/session/1')).toBe(false)
  })
})

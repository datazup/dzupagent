import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolGovernance, DzupEventBus } from '@dzupagent/core'
import { checkPtcAccess, buildBlockedPtcResult } from '../sandbox/ptc/ptc-governance-adapter.js'
import type { PtcRequest } from '../sandbox/ptc/ptc-types.js'

// ---------------------------------------------------------------------------
// Minimal ToolGovernance stub
// ---------------------------------------------------------------------------

function makeGovernance(opts: {
  allowed?: boolean
  requiresApproval?: boolean
  reason?: string
  blocked?: boolean
}): ToolGovernance {
  return {
    checkAccess: vi.fn().mockReturnValue({
      allowed: opts.allowed ?? true,
      requiresApproval: opts.requiresApproval ?? false,
      reason: opts.reason,
    }),
    audit: vi.fn().mockResolvedValue(undefined),
    auditResult: vi.fn().mockResolvedValue(undefined),
    config: {},
    rateCounts: new Map(),
    checkRateLimit: vi.fn().mockReturnValue(true),
    prepareResultAuditEntry: vi.fn(e => e),
    resetRateLimits: vi.fn(),
  } as unknown as ToolGovernance
}

function makeEventBus(): DzupEventBus & { emitted: unknown[] } {
  const emitted: unknown[] = []
  return {
    emitted,
    emit: vi.fn((event: unknown) => { emitted.push(event) }),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as DzupEventBus & { emitted: unknown[] }
}

// ---------------------------------------------------------------------------
// checkPtcAccess
// ---------------------------------------------------------------------------

describe('checkPtcAccess', () => {
  const request: PtcRequest = { code: 'console.log(1)', language: 'javascript', reason: 'test' }

  it('returns allowed:true when governance permits', () => {
    const governance = makeGovernance({ allowed: true })
    const decision = checkPtcAccess(request, { governance })
    expect(decision.allowed).toBe(true)
    expect(governance.checkAccess).toHaveBeenCalledWith('ptc', expect.objectContaining({ code: request.code }))
  })

  it('returns allowed:false when governance blocks', () => {
    const governance = makeGovernance({ allowed: false, reason: 'blocked by policy' })
    const decision = checkPtcAccess(request, { governance })
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toContain('blocked')
    }
  })

  it('uses custom toolName from ptcConfig', () => {
    const governance = makeGovernance({ allowed: true })
    checkPtcAccess(request, { governance, ptcConfig: { toolName: 'run_code' } })
    expect(governance.checkAccess).toHaveBeenCalledWith('run_code', expect.anything())
  })

  it('blocks immediately when disabled:true without calling governance', () => {
    const governance = makeGovernance({ allowed: true })
    const decision = checkPtcAccess(request, { governance, ptcConfig: { disabled: true } })
    expect(decision.allowed).toBe(false)
    expect(governance.checkAccess).not.toHaveBeenCalled()
  })

  describe('approval-gated tool', () => {
    it('returns allowed:false with approvalPending:true', () => {
      const governance = makeGovernance({ allowed: true, requiresApproval: true })
      const decision = checkPtcAccess(request, { governance })
      expect(decision.allowed).toBe(false)
      if (!decision.allowed) {
        expect(decision.approvalPending).toBe(true)
      }
    })

    it('emits approval:requested event with runId as correlation id', () => {
      const governance = makeGovernance({ allowed: true, requiresApproval: true })
      const bus = makeEventBus()
      checkPtcAccess(request, { governance, eventBus: bus, runId: 'run-42' })
      expect(bus.emitted).toHaveLength(1)
      const event = bus.emitted[0] as Record<string, unknown>
      expect(event['type']).toBe('approval:requested')
      expect(event['runId']).toBe('run-42')
    })

    it('emits approval:requested with callId fallback when runId absent', () => {
      const governance = makeGovernance({ allowed: true, requiresApproval: true })
      const bus = makeEventBus()
      checkPtcAccess(request, { governance, eventBus: bus }, 'call-99')
      const event = bus.emitted[0] as Record<string, unknown>
      expect(event['runId']).toBe('call-99')
    })

    it('does not throw when eventBus.emit throws', () => {
      const governance = makeGovernance({ allowed: true, requiresApproval: true })
      const bus = { emit: vi.fn().mockImplementation(() => { throw new Error('bus error') }) } as unknown as DzupEventBus
      expect(() => checkPtcAccess(request, { governance, eventBus: bus })).not.toThrow()
    })
  })

  it('calls governance.audit on each path', () => {
    const governance = makeGovernance({ allowed: true })
    checkPtcAccess(request, { governance })
    expect(governance.audit).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// buildBlockedPtcResult
// ---------------------------------------------------------------------------

describe('buildBlockedPtcResult', () => {
  it('produces a blocked result with the denial reason', () => {
    const result = buildBlockedPtcResult({ allowed: false, reason: 'rate limit exceeded' })
    expect(result.blocked).toBe(true)
    expect(result.blockReason).toBe('rate limit exceeded')
    expect(result.exitCode).toBe(1)
    expect(result.durationMs).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })
})

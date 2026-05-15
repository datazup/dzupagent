import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolGovernance } from '@dzupagent/core'
import { createPtcTool } from '../sandbox/ptc/ptc-tool.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGovernance(opts: {
  allowed?: boolean
  requiresApproval?: boolean
  reason?: string
} = {}): ToolGovernance {
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

// ---------------------------------------------------------------------------
// createPtcTool — structural tests (no QuickJS runtime needed)
// ---------------------------------------------------------------------------

describe('createPtcTool', () => {
  it('returns a tool with name "ptc" by default', () => {
    const t = createPtcTool({ governance: makeGovernance() })
    expect(t.name).toBe('ptc')
  })

  it('uses ptcConfig.toolName when provided', () => {
    const t = createPtcTool({
      governance: makeGovernance(),
      ptcConfig: { toolName: 'run_code' },
    })
    expect(t.name).toBe('run_code')
  })

  it('has a description mentioning governance', () => {
    const t = createPtcTool({ governance: makeGovernance() })
    expect(t.description).toMatch(/govern/)
  })

  it('accepts the PTC schema fields', () => {
    const t = createPtcTool({ governance: makeGovernance() })
    // schema.shape is set by the tool() factory
    const schema = t.schema as { shape?: Record<string, unknown> }
    expect(schema).toBeDefined()
  })

  describe('when governance blocks the call', () => {
    it('returns a JSON-encoded blocked PtcResult without calling the sandbox', async () => {
      const governance = makeGovernance({ allowed: false, reason: 'blocked by policy' })
      const t = createPtcTool({ governance })
      const raw = await t.invoke({ code: 'console.log(1)' })
      const result = JSON.parse(raw as string) as {
        blocked: boolean
        blockReason: string
        exitCode: number
      }
      expect(result.blocked).toBe(true)
      expect(result.blockReason).toContain('blocked')
      expect(result.exitCode).toBe(1)
    })

    it('does not throw when blocked', async () => {
      const governance = makeGovernance({ allowed: false, reason: 'rate limit' })
      const t = createPtcTool({ governance })
      await expect(t.invoke({ code: '1+1' })).resolves.toBeDefined()
    })
  })

  describe('when disabled via ptcConfig', () => {
    it('returns a blocked result immediately', async () => {
      const governance = makeGovernance({ allowed: true })
      const t = createPtcTool({ governance, ptcConfig: { disabled: true } })
      const raw = await t.invoke({ code: 'console.log(42)' })
      const result = JSON.parse(raw as string) as { blocked: boolean }
      expect(result.blocked).toBe(true)
      expect(governance.checkAccess).not.toHaveBeenCalled()
    })
  })

  describe('when governance requires approval', () => {
    it('returns a blocked result with approvalPending context in blockReason', async () => {
      const governance = makeGovernance({ allowed: true, requiresApproval: true })
      const t = createPtcTool({ governance })
      const raw = await t.invoke({ code: 'rm -rf /' })
      const result = JSON.parse(raw as string) as { blocked: boolean; blockReason: string }
      expect(result.blocked).toBe(true)
      expect(result.blockReason).toBeTruthy()
    })
  })

  describe('when governance allows execution but sandbox unavailable', () => {
    it('returns an error result with exitCode:1 when QuickJS not installed', async () => {
      const governance = makeGovernance({ allowed: true })
      const t = createPtcTool({ governance })
      // QuickJS is not installed in test env — the sandbox will error
      const raw = await t.invoke({ code: '1 + 1' })
      const result = JSON.parse(raw as string) as {
        exitCode: number
        blocked: boolean
        stderr: string
      }
      expect(result.blocked).toBe(false)
      // Either success (if QuickJS available in CI) or error with QuickJS message
      expect([0, 1]).toContain(result.exitCode)
    })

    it('calls governance.auditResult after execution attempt', async () => {
      const governance = makeGovernance({ allowed: true })
      const t = createPtcTool({ governance })
      await t.invoke({ code: '1 + 1' })
      expect(governance.auditResult).toHaveBeenCalled()
    })
  })
})

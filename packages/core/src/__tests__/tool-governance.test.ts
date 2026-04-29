import { describe, it, expect, vi } from 'vitest'
import { ToolGovernance } from '../tools/tool-governance.js'

describe('ToolGovernance', () => {
  it('allows tool calls by default', () => {
    const gov = new ToolGovernance()
    expect(gov.checkAccess('read_file', {}).allowed).toBe(true)
  })

  it('blocks tools in blockedTools list', () => {
    const gov = new ToolGovernance({ blockedTools: ['rm_rf', 'drop_database'] })
    expect(gov.checkAccess('rm_rf', {}).allowed).toBe(false)
    expect(gov.checkAccess('rm_rf', {}).reason).toContain('blocked')
    expect(gov.checkAccess('read_file', {}).allowed).toBe(true)
  })

  it('flags tools requiring approval', () => {
    const gov = new ToolGovernance({ approvalRequired: ['deploy'] })
    const result = gov.checkAccess('deploy', {})
    expect(result.allowed).toBe(true)
    expect(result.requiresApproval).toBe(true)
  })

  it('enforces rate limits', () => {
    const gov = new ToolGovernance({ rateLimits: { 'api_call': 2 } })
    expect(gov.checkAccess('api_call', {}).allowed).toBe(true)
    expect(gov.checkAccess('api_call', {}).allowed).toBe(true)
    expect(gov.checkAccess('api_call', {}).allowed).toBe(false)
    expect(gov.checkAccess('api_call', {}).reason).toContain('rate limit')
  })

  it('calls custom validator', () => {
    const validator = vi.fn().mockReturnValue({ valid: false, reason: 'too dangerous' })
    const gov = new ToolGovernance({ validator })
    const result = gov.checkAccess('hack_tool', { target: 'server' })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('too dangerous')
    expect(validator).toHaveBeenCalledWith('hack_tool', { target: 'server' })
  })

  it('audit handler is called', async () => {
    const onToolCall = vi.fn()
    const gov = new ToolGovernance({ auditHandler: { onToolCall } })
    await gov.audit({ toolName: 'read_file', input: {}, callerAgent: 'test', timestamp: 1, allowed: true })
    expect(onToolCall).toHaveBeenCalledOnce()
  })

  it('forwards raw tool result output by default for backwards compatibility', async () => {
    const onToolCall = vi.fn()
    const onToolResult = vi.fn()
    const gov = new ToolGovernance({ auditHandler: { onToolCall, onToolResult } })
    const output = { secret: 'raw-value', status: 'ok' }

    await gov.auditResult({
      toolName: 'read_file',
      output,
      callerAgent: 'test',
      durationMs: 12,
      success: true,
      timestamp: 1,
    })

    expect(onToolResult).toHaveBeenCalledWith(expect.objectContaining({ output }))
  })

  it('can retain only result metadata for audit handlers', async () => {
    const onToolCall = vi.fn()
    const onToolResult = vi.fn()
    const gov = new ToolGovernance({
      resultAuditRetention: 'metadata-only',
      auditHandler: { onToolCall, onToolResult },
    })

    await gov.auditResult({
      toolName: 'read_file',
      output: { secret: 'raw-value', status: 'ok' },
      callerAgent: 'test',
      durationMs: 12,
      success: true,
      timestamp: 1,
    })

    expect(onToolResult).toHaveBeenCalledWith(expect.objectContaining({
      output: undefined,
      outputMetadata: { outputType: 'object', outputKeys: ['secret', 'status'] },
      resultAuditRetention: 'metadata-only',
    }))
  })

  it('can retain redacted result output for audit handlers', async () => {
    const onToolCall = vi.fn()
    const onToolResult = vi.fn()
    const gov = new ToolGovernance({
      resultAuditRetention: 'redacted',
      resultAuditRedactor: () => '[CUSTOM-REDACTED]',
      auditHandler: { onToolCall, onToolResult },
    })

    await gov.auditResult({
      toolName: 'read_file',
      output: 'raw secret',
      callerAgent: 'test',
      durationMs: 12,
      success: true,
      timestamp: 1,
    })

    expect(onToolResult).toHaveBeenCalledWith(expect.objectContaining({
      output: '[CUSTOM-REDACTED]',
      outputMetadata: { outputType: 'string', outputLength: 10 },
      resultAuditRetention: 'redacted',
    }))
  })

  it('audit failure is non-fatal', async () => {
    const gov = new ToolGovernance({
      auditHandler: {
        onToolCall: () => {
          throw new Error('audit down')
        },
      },
    })
    await expect(
      gov.audit({ toolName: 'x', input: {}, callerAgent: 'y', timestamp: 1, allowed: true }),
    ).resolves.toBeUndefined()
  })

  it('resetRateLimits clears counters', () => {
    const gov = new ToolGovernance({ rateLimits: { 'api_call': 1 } })
    expect(gov.checkAccess('api_call', {}).allowed).toBe(true)
    expect(gov.checkAccess('api_call', {}).allowed).toBe(false)
    gov.resetRateLimits()
    expect(gov.checkAccess('api_call', {}).allowed).toBe(true)
  })

  it('rate limits are per-tool', () => {
    const gov = new ToolGovernance({ rateLimits: { 'a': 1, 'b': 1 } })
    expect(gov.checkAccess('a', {}).allowed).toBe(true)
    expect(gov.checkAccess('b', {}).allowed).toBe(true)
    expect(gov.checkAccess('a', {}).allowed).toBe(false)
    expect(gov.checkAccess('b', {}).allowed).toBe(false)
  })
})

import { describe, it, expect, vi } from 'vitest'
import type { StructuredToolInterface } from '@langchain/core/tools'
import {
  createProductionToolGovernancePreset,
  type ProductionToolGovernancePresetOptions,
} from '../agent/production-tool-governance-preset.js'
import type { ToolGovernance, ToolGovernanceConfig } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string): StructuredToolInterface {
  return {
    name,
    description: `mock tool: ${name}`,
    invoke: vi.fn(),
    schema: {},
  } as unknown as StructuredToolInterface
}

function baseOptions(): ProductionToolGovernancePresetOptions {
  return {
    agentId: 'agent-1',
    runId: 'run-1',
  }
}

// ---------------------------------------------------------------------------
// ptcTools integration into the preset
// ---------------------------------------------------------------------------

describe('createProductionToolGovernancePreset — ptcTools wiring', () => {
  it('returns empty ptcTools when none provided', () => {
    const preset = createProductionToolGovernancePreset(baseOptions())
    expect(preset.ptcTools).toEqual([])
  })

  it('forwards ptcTools on the preset result', () => {
    const ptc = makeTool('ptc')
    const preset = createProductionToolGovernancePreset({
      ...baseOptions(),
      ptcTools: [ptc],
    })
    expect(preset.ptcTools).toHaveLength(1)
    expect(preset.ptcTools[0]!.name).toBe('ptc')
  })

  it('includes ptcTool names in the allowlist derived from tools', () => {
    const regular = makeTool('write_file')
    const ptc = makeTool('ptc')
    const preset = createProductionToolGovernancePreset({
      ...baseOptions(),
      tools: [regular],
      ptcTools: [ptc],
    })
    // The permission policy's allowlist should contain both names.
    // We verify indirectly: the policy must not throw when checking either name.
    const policyRegular = preset.permissionPolicy.hasPermission('agent-1', 'write_file')
    const policyPtc = preset.permissionPolicy.hasPermission('agent-1', 'ptc')
    expect(policyRegular).toBe(true)
    expect(policyPtc).toBe(true)
  })

  it('ptc tool is blocked when it appears in blockedToolNames', () => {
    const ptc = makeTool('ptc')
    const preset = createProductionToolGovernancePreset({
      ...baseOptions(),
      ptcTools: [ptc],
      blockedToolNames: ['ptc'],
    })
    const access = preset.governance.checkAccess('ptc', {})
    expect(access.allowed).toBe(false)
  })

  it('ptc tool requires approval when it appears in approvalRequiredToolNames', () => {
    const ptc = makeTool('ptc')
    const preset = createProductionToolGovernancePreset({
      ...baseOptions(),
      ptcTools: [ptc],
      approvalRequiredToolNames: ['ptc'],
    })
    const access = preset.governance.checkAccess('ptc', {})
    expect(access.allowed).toBe(true)
    expect(access.requiresApproval).toBe(true)
  })

  it('deduplicates allowlist when ptcTool name overlaps with allowedToolNames', () => {
    const ptc = makeTool('ptc')
    const preset = createProductionToolGovernancePreset({
      ...baseOptions(),
      allowedToolNames: ['write_file', 'ptc'],
      ptcTools: [ptc],
    })
    // Should not throw — deduplication is silent
    expect(preset.ptcTools[0]!.name).toBe('ptc')
    expect(preset.permissionPolicy.hasPermission('agent-1', 'ptc')).toBe(true)
  })

  it('multiple ptcTools are all added to the allowlist', () => {
    const ptc1 = makeTool('ptc')
    const ptc2 = makeTool('run_code')
    const preset = createProductionToolGovernancePreset({
      ...baseOptions(),
      ptcTools: [ptc1, ptc2],
    })
    expect(preset.ptcTools).toHaveLength(2)
    expect(preset.permissionPolicy.hasPermission('agent-1', 'ptc')).toBe(true)
    expect(preset.permissionPolicy.hasPermission('agent-1', 'run_code')).toBe(true)
  })
})

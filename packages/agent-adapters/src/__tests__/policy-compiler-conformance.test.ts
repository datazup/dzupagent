import { describe, it, expect, beforeEach } from 'vitest'

import {
  compilePolicyForProvider,
  compilePolicyForAll,
} from '../policy/policy-compiler.js'
import type {
  AdapterPolicy,
  CompiledPolicyOverrides,
} from '../policy/policy-compiler.js'
import { PolicyConformanceChecker } from '../policy/policy-conformance.js'
import type { AdapterProviderId } from '../types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_PROVIDERS: AdapterProviderId[] = [
  'codex',
  'claude',
  'gemini',
  'qwen',
  'crush',
  'goose',
  'openrouter',
]

// ---------------------------------------------------------------------------
// compilePolicyForProvider
// ---------------------------------------------------------------------------

describe('compilePolicyForProvider', () => {
  describe('empty policy', () => {
    it('should produce empty config and inputOptions for every provider', () => {
      const policy: AdapterPolicy = {}

      for (const provider of ALL_PROVIDERS) {
        const result = compilePolicyForProvider(provider, policy)
        expect(result.config).toEqual({})
        expect(result.inputOptions).toEqual({})
        expect(result.guardrails).toEqual({})
      }
    })
  })

  // -------------------------------------------------------------------------
  // Codex
  // -------------------------------------------------------------------------

  describe('codex', () => {
    it('should map sandboxMode into config.sandboxMode', () => {
      const result = compilePolicyForProvider('codex', { sandboxMode: 'read-only' })
      expect(result.config.sandboxMode).toBe('read-only')
    })

    it('should map networkAccess into inputOptions.networkAccessEnabled', () => {
      const enabled = compilePolicyForProvider('codex', { networkAccess: true })
      expect(enabled.inputOptions['networkAccessEnabled']).toBe(true)

      const disabled = compilePolicyForProvider('codex', { networkAccess: false })
      expect(disabled.inputOptions['networkAccessEnabled']).toBe(false)
    })

    it('should map approvalRequired=true to on-failure', () => {
      const result = compilePolicyForProvider('codex', { approvalRequired: true })
      expect(result.inputOptions['approvalPolicy']).toBe('on-failure')
    })

    it('should map approvalRequired=false to never', () => {
      const result = compilePolicyForProvider('codex', { approvalRequired: false })
      expect(result.inputOptions['approvalPolicy']).toBe('never')
    })

    it('should map maxTurns into inputOptions', () => {
      const result = compilePolicyForProvider('codex', { maxTurns: 25 })
      expect(result.inputOptions['maxTurns']).toBe(25)
    })

    it('should not set maxBudgetUsd in inputOptions (codex lacks budget support)', () => {
      const result = compilePolicyForProvider('codex', { maxBudgetUsd: 5.0 })
      expect(result.inputOptions).not.toHaveProperty('maxBudgetUsd')
    })

    it('should extract guardrail hints from full policy', () => {
      const result = compilePolicyForProvider('codex', {
        maxTurns: 10,
        maxBudgetUsd: 2.5,
        blockedTools: ['shell', 'exec'],
      })
      expect(result.guardrails).toEqual({
        maxIterations: 10,
        maxCostCents: 250,
        blockedTools: ['shell', 'exec'],
      })
    })
  })

  // -------------------------------------------------------------------------
  // Claude
  // -------------------------------------------------------------------------

  describe('claude', () => {
    it('should map sandboxMode into config.sandboxMode', () => {
      const result = compilePolicyForProvider('claude', { sandboxMode: 'workspace-write' })
      expect(result.config.sandboxMode).toBe('workspace-write')
    })

    it('should map approvalRequired=true to permissionMode default', () => {
      const result = compilePolicyForProvider('claude', { approvalRequired: true })
      expect(result.config.providerOptions).toEqual({ permissionMode: 'default' })
    })

    it('should map approvalRequired=false to permissionMode bypassPermissions', () => {
      const result = compilePolicyForProvider('claude', { approvalRequired: false })
      expect(result.config.providerOptions).toEqual({ permissionMode: 'bypassPermissions' })
    })

    it('should map maxBudgetUsd into inputOptions', () => {
      const result = compilePolicyForProvider('claude', { maxBudgetUsd: 3.0 })
      expect(result.inputOptions['maxBudgetUsd']).toBe(3.0)
    })

    it('should map maxTurns into inputOptions', () => {
      const result = compilePolicyForProvider('claude', { maxTurns: 15 })
      expect(result.inputOptions['maxTurns']).toBe(15)
    })

    it('should not set networkAccess in inputOptions', () => {
      const result = compilePolicyForProvider('claude', { networkAccess: false })
      expect(result.inputOptions).not.toHaveProperty('networkAccessEnabled')
    })
  })

  // -------------------------------------------------------------------------
  // Gemini
  // -------------------------------------------------------------------------

  describe('gemini', () => {
    it('should map sandboxMode into config.sandboxMode', () => {
      const result = compilePolicyForProvider('gemini', { sandboxMode: 'full-access' })
      expect(result.config.sandboxMode).toBe('full-access')
    })

    it('should map maxTurns into inputOptions', () => {
      const result = compilePolicyForProvider('gemini', { maxTurns: 30 })
      expect(result.inputOptions['maxTurns']).toBe(30)
    })

    it('should not map approval, networkAccess, or budget into options', () => {
      const result = compilePolicyForProvider('gemini', {
        approvalRequired: true,
        networkAccess: false,
        maxBudgetUsd: 1.0,
      })
      expect(result.inputOptions).toEqual({})
      expect(result.config.providerOptions).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Qwen
  // -------------------------------------------------------------------------

  describe('qwen', () => {
    it('should map sandboxMode and maxTurns', () => {
      const result = compilePolicyForProvider('qwen', {
        sandboxMode: 'workspace-write',
        maxTurns: 12,
      })
      expect(result.config.sandboxMode).toBe('workspace-write')
      expect(result.inputOptions['maxTurns']).toBe(12)
    })

    it('should not map approval, networkAccess, or budget', () => {
      const result = compilePolicyForProvider('qwen', {
        approvalRequired: true,
        networkAccess: true,
        maxBudgetUsd: 2.0,
      })
      expect(result.inputOptions).toEqual({})
    })
  })

  // -------------------------------------------------------------------------
  // Crush
  // -------------------------------------------------------------------------

  describe('crush', () => {
    it('should map sandboxMode and maxTurns', () => {
      const result = compilePolicyForProvider('crush', {
        sandboxMode: 'read-only',
        maxTurns: 5,
      })
      expect(result.config.sandboxMode).toBe('read-only')
      expect(result.inputOptions['maxTurns']).toBe(5)
    })
  })

  // -------------------------------------------------------------------------
  // Goose
  // -------------------------------------------------------------------------

  describe('goose', () => {
    it('should map sandboxMode into config and goose-specific permissionMode', () => {
      const modes: Array<{
        input: AdapterPolicy['sandboxMode']
        expected: string
      }> = [
        { input: 'read-only', expected: 'read-only' },
        { input: 'workspace-write', expected: 'workspace' },
        { input: 'full-access', expected: 'full' },
      ]

      for (const { input, expected } of modes) {
        const result = compilePolicyForProvider('goose', { sandboxMode: input })
        expect(result.config.sandboxMode).toBe(input)
        expect(result.inputOptions['permissionMode']).toBe(expected)
      }
    })

    it('should map maxTurns into inputOptions', () => {
      const result = compilePolicyForProvider('goose', { maxTurns: 8 })
      expect(result.inputOptions['maxTurns']).toBe(8)
    })
  })

  // -------------------------------------------------------------------------
  // OpenRouter
  // -------------------------------------------------------------------------

  describe('openrouter', () => {
    it('should not set sandboxMode in config (API-only provider)', () => {
      const result = compilePolicyForProvider('openrouter', { sandboxMode: 'workspace-write' })
      expect(result.config.sandboxMode).toBeUndefined()
    })

    it('should map maxTurns into inputOptions', () => {
      const result = compilePolicyForProvider('openrouter', { maxTurns: 20 })
      expect(result.inputOptions['maxTurns']).toBe(20)
    })

    it('should not set network or approval options', () => {
      const result = compilePolicyForProvider('openrouter', {
        networkAccess: false,
        approvalRequired: true,
      })
      expect(result.inputOptions).toEqual({})
    })
  })

  // -------------------------------------------------------------------------
  // Guardrail hints (shared across providers)
  // -------------------------------------------------------------------------

  describe('guardrail hints', () => {
    it('should convert maxBudgetUsd to maxCostCents with rounding', () => {
      const result = compilePolicyForProvider('codex', { maxBudgetUsd: 1.234 })
      expect(result.guardrails.maxCostCents).toBe(123)
    })

    it('should convert maxBudgetUsd=0 to maxCostCents=0', () => {
      const result = compilePolicyForProvider('codex', { maxBudgetUsd: 0 })
      expect(result.guardrails.maxCostCents).toBe(0)
    })

    it('should copy blockedTools into guardrails as a new array', () => {
      const blocked = ['shell', 'rm']
      const result = compilePolicyForProvider('claude', { blockedTools: blocked })
      expect(result.guardrails.blockedTools).toEqual(['shell', 'rm'])
      // Must be a copy, not the same reference
      expect(result.guardrails.blockedTools).not.toBe(blocked)
    })

    it('should not set blockedTools in guardrails when array is empty', () => {
      const result = compilePolicyForProvider('codex', { blockedTools: [] })
      expect(result.guardrails.blockedTools).toBeUndefined()
    })

    it('should set maxIterations from maxTurns', () => {
      const result = compilePolicyForProvider('gemini', { maxTurns: 42 })
      expect(result.guardrails.maxIterations).toBe(42)
    })

    it('should produce empty guardrails for empty policy', () => {
      const result = compilePolicyForProvider('codex', {})
      expect(result.guardrails).toEqual({})
    })
  })
})

// ---------------------------------------------------------------------------
// compilePolicyForAll
// ---------------------------------------------------------------------------

describe('compilePolicyForAll', () => {
  it('should return entries for all 7 providers', () => {
    const results = compilePolicyForAll({})
    expect(results.size).toBe(7)
    for (const provider of ALL_PROVIDERS) {
      expect(results.has(provider)).toBe(true)
    }
  })

  it('should return a ReadonlyMap', () => {
    const results = compilePolicyForAll({})
    expect(results).toBeInstanceOf(Map)
  })

  it('should compile consistently with per-provider calls', () => {
    const policy: AdapterPolicy = {
      sandboxMode: 'workspace-write',
      networkAccess: false,
      approvalRequired: true,
      maxTurns: 10,
      maxBudgetUsd: 5.0,
      blockedTools: ['shell'],
    }

    const allResults = compilePolicyForAll(policy)

    for (const provider of ALL_PROVIDERS) {
      const individual = compilePolicyForProvider(provider, policy)
      const fromAll = allResults.get(provider)
      expect(fromAll).toEqual(individual)
    }
  })

  it('should compile empty policy to empty overrides for all providers', () => {
    const results = compilePolicyForAll({})
    for (const [, overrides] of results) {
      expect(overrides.config).toEqual({})
      expect(overrides.inputOptions).toEqual({})
      expect(overrides.guardrails).toEqual({})
    }
  })
})

// ---------------------------------------------------------------------------
// PolicyConformanceChecker
// ---------------------------------------------------------------------------

describe('PolicyConformanceChecker', () => {
  let checker: PolicyConformanceChecker

  beforeEach(() => {
    checker = new PolicyConformanceChecker()
  })

  /** Helper: compile then check. */
  function compileAndCheck(
    provider: AdapterProviderId,
    policy: AdapterPolicy,
  ) {
    const compiled = compilePolicyForProvider(provider, policy)
    return checker.check(provider, policy, compiled)
  }

  // -------------------------------------------------------------------------
  // Fully conformant
  // -------------------------------------------------------------------------

  describe('conformant policies', () => {
    it('should return conformant=true for empty policy on any provider', () => {
      for (const provider of ALL_PROVIDERS) {
        const result = compileAndCheck(provider, {})
        expect(result.conformant).toBe(true)
        expect(result.violations).toEqual([])
      }
    })

    it('should return conformant=true for codex with full policy (supported fields)', () => {
      const result = compileAndCheck('codex', {
        sandboxMode: 'workspace-write',
        networkAccess: true,
        approvalRequired: true,
        maxTurns: 20,
      })
      expect(result.conformant).toBe(true)
      // networkAccess=true on a non-toggle provider produces a warning message,
      // but codex actually supports the toggle, so no warning here
      expect(result.violations).toEqual([])
    })

    it('should return conformant=true for claude with sandbox, approval, budget, maxTurns', () => {
      const result = compileAndCheck('claude', {
        sandboxMode: 'read-only',
        approvalRequired: false,
        maxBudgetUsd: 2.0,
        maxTurns: 10,
      })
      expect(result.conformant).toBe(true)
      expect(result.violations).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // sandboxMode violations
  // -------------------------------------------------------------------------

  describe('sandboxMode violation', () => {
    it('should produce an error for openrouter (no sandbox support)', () => {
      const result = compileAndCheck('openrouter', { sandboxMode: 'workspace-write' })
      expect(result.conformant).toBe(false)
      expect(result.violations).toHaveLength(1)
      expect(result.violations[0]).toMatchObject({
        field: 'sandboxMode',
        severity: 'error',
      })
      expect(result.violations[0]!.reason).toContain('openrouter')
      expect(result.violations[0]!.reason).toContain('workspace-write')
    })

    it('should not produce a sandboxMode violation for codex', () => {
      const result = compileAndCheck('codex', { sandboxMode: 'full-access' })
      const sandboxViolation = result.violations.find((v) => v.field === 'sandboxMode')
      expect(sandboxViolation).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // networkAccess violations / warnings
  // -------------------------------------------------------------------------

  describe('networkAccess', () => {
    it('should produce a warning when networkAccess=false on a provider without toggle', () => {
      const result = compileAndCheck('claude', { networkAccess: false })
      expect(result.conformant).toBe(true) // warning, not error
      const violation = result.violations.find((v) => v.field === 'networkAccess')
      expect(violation).toBeDefined()
      expect(violation!.severity).toBe('warning')
      expect(violation!.reason).toContain('claude')
    })

    it('should add a warnings[] entry when networkAccess=true on a provider without toggle', () => {
      const result = compileAndCheck('gemini', { networkAccess: true })
      expect(result.conformant).toBe(true)
      expect(result.warnings.length).toBeGreaterThan(0)
      expect(result.warnings[0]).toContain('gemini')
    })

    it('should not produce a networkAccess violation for codex (supports toggle)', () => {
      const result = compileAndCheck('codex', { networkAccess: false })
      const violation = result.violations.find((v) => v.field === 'networkAccess')
      expect(violation).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // approvalRequired warnings
  // -------------------------------------------------------------------------

  describe('approvalRequired', () => {
    it('should produce a warning for providers without approval support', () => {
      const noApproval: AdapterProviderId[] = ['gemini', 'qwen', 'crush', 'goose', 'openrouter']
      for (const provider of noApproval) {
        const result = compileAndCheck(provider, { approvalRequired: true })
        const violation = result.violations.find((v) => v.field === 'approvalRequired')
        expect(violation).toBeDefined()
        expect(violation!.severity).toBe('warning')
      }
    })

    it('should not produce a warning for codex and claude (support approval)', () => {
      for (const provider of ['codex', 'claude'] as AdapterProviderId[]) {
        const result = compileAndCheck(provider, { approvalRequired: true })
        const violation = result.violations.find((v) => v.field === 'approvalRequired')
        expect(violation).toBeUndefined()
      }
    })

    it('should not produce a warning when approvalRequired=false', () => {
      const result = compileAndCheck('gemini', { approvalRequired: false })
      const violation = result.violations.find((v) => v.field === 'approvalRequired')
      expect(violation).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // allowedTools / blockedTools warnings
  // -------------------------------------------------------------------------

  describe('allowedTools and blockedTools', () => {
    it('should produce a warning for allowedTools on providers without allowlist support', () => {
      // None of the current providers support tool allowlists
      for (const provider of ALL_PROVIDERS) {
        const result = compileAndCheck(provider, { allowedTools: ['read', 'write'] })
        const violation = result.violations.find((v) => v.field === 'allowedTools')
        expect(violation).toBeDefined()
        expect(violation!.severity).toBe('warning')
      }
    })

    it('should not produce a warning for empty allowedTools', () => {
      const result = compileAndCheck('codex', { allowedTools: [] })
      const violation = result.violations.find((v) => v.field === 'allowedTools')
      expect(violation).toBeUndefined()
    })

    it('should produce a warning for blockedTools on providers without blocklist support', () => {
      for (const provider of ALL_PROVIDERS) {
        const result = compileAndCheck(provider, { blockedTools: ['shell'] })
        const violation = result.violations.find((v) => v.field === 'blockedTools')
        expect(violation).toBeDefined()
        expect(violation!.severity).toBe('warning')
      }
    })

    it('should not produce a warning for empty blockedTools', () => {
      const result = compileAndCheck('claude', { blockedTools: [] })
      const violation = result.violations.find((v) => v.field === 'blockedTools')
      expect(violation).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // maxBudgetUsd warnings
  // -------------------------------------------------------------------------

  describe('maxBudgetUsd', () => {
    it('should produce a warning for providers without budget support', () => {
      const noBudget: AdapterProviderId[] = ['codex', 'gemini', 'qwen', 'crush', 'goose', 'openrouter']
      for (const provider of noBudget) {
        const result = compileAndCheck(provider, { maxBudgetUsd: 1.0 })
        const violation = result.violations.find((v) => v.field === 'maxBudgetUsd')
        expect(violation).toBeDefined()
        expect(violation!.severity).toBe('warning')
      }
    })

    it('should not produce a warning for claude (supports budget)', () => {
      const result = compileAndCheck('claude', { maxBudgetUsd: 5.0 })
      const violation = result.violations.find((v) => v.field === 'maxBudgetUsd')
      expect(violation).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Cross-field: overlapping allowedTools + blockedTools
  // -------------------------------------------------------------------------

  describe('cross-field: allowedTools + blockedTools overlap', () => {
    it('should produce an error when tools appear in both lists', () => {
      const result = compileAndCheck('codex', {
        allowedTools: ['read', 'write', 'shell'],
        blockedTools: ['shell', 'exec'],
      })
      const violation = result.violations.find(
        (v) => v.field === 'allowedTools+blockedTools',
      )
      expect(violation).toBeDefined()
      expect(violation!.severity).toBe('error')
      expect(violation!.reason).toContain('shell')
      expect(result.conformant).toBe(false)
    })

    it('should not produce an error when lists are disjoint', () => {
      const result = compileAndCheck('codex', {
        allowedTools: ['read', 'write'],
        blockedTools: ['shell', 'exec'],
      })
      const violation = result.violations.find(
        (v) => v.field === 'allowedTools+blockedTools',
      )
      expect(violation).toBeUndefined()
    })

    it('should report multiple overlapping tools in the reason', () => {
      const result = compileAndCheck('claude', {
        allowedTools: ['a', 'b', 'c'],
        blockedTools: ['b', 'c', 'd'],
      })
      const violation = result.violations.find(
        (v) => v.field === 'allowedTools+blockedTools',
      )
      expect(violation).toBeDefined()
      expect(violation!.reason).toContain('b')
      expect(violation!.reason).toContain('c')
    })
  })

  // -------------------------------------------------------------------------
  // Severity semantics
  // -------------------------------------------------------------------------

  describe('severity semantics', () => {
    it('should set conformant=false when any error-severity violation exists', () => {
      // openrouter + sandboxMode => error
      const result = compileAndCheck('openrouter', { sandboxMode: 'read-only' })
      expect(result.conformant).toBe(false)
      expect(result.violations.some((v) => v.severity === 'error')).toBe(true)
    })

    it('should set conformant=true when only warning-severity violations exist', () => {
      // gemini + approvalRequired => warning, blockedTools => warning
      const result = compileAndCheck('gemini', {
        approvalRequired: true,
        blockedTools: ['shell'],
      })
      expect(result.conformant).toBe(true)
      expect(result.violations.length).toBeGreaterThan(0)
      expect(result.violations.every((v) => v.severity === 'warning')).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Multiple violations in a single check
  // -------------------------------------------------------------------------

  describe('multiple violations', () => {
    it('should detect all violations from a policy with many non-conformant fields', () => {
      // openrouter: no sandbox (error), no network toggle, no approval,
      // no allowlist, no blocklist, no budget
      const result = compileAndCheck('openrouter', {
        sandboxMode: 'full-access',
        networkAccess: false,
        approvalRequired: true,
        allowedTools: ['read'],
        blockedTools: ['shell'],
        maxBudgetUsd: 10.0,
      })

      expect(result.conformant).toBe(false)

      // Collect violation fields
      const fields = result.violations.map((v) => v.field)
      expect(fields).toContain('sandboxMode')
      expect(fields).toContain('networkAccess')
      expect(fields).toContain('approvalRequired')
      expect(fields).toContain('allowedTools')
      expect(fields).toContain('blockedTools')
      expect(fields).toContain('maxBudgetUsd')
    })

    it('should include both errors and warnings in the violations array', () => {
      // openrouter: sandboxMode=error, approvalRequired=warning
      const result = compileAndCheck('openrouter', {
        sandboxMode: 'read-only',
        approvalRequired: true,
      })

      const errors = result.violations.filter((v) => v.severity === 'error')
      const warnings = result.violations.filter((v) => v.severity === 'warning')
      expect(errors.length).toBeGreaterThanOrEqual(1)
      expect(warnings.length).toBeGreaterThanOrEqual(1)
    })

    it('should include cross-field overlap alongside per-field violations', () => {
      const result = compileAndCheck('openrouter', {
        sandboxMode: 'workspace-write',
        allowedTools: ['read', 'shell'],
        blockedTools: ['shell'],
      })

      const fields = result.violations.map((v) => v.field)
      expect(fields).toContain('sandboxMode')
      expect(fields).toContain('allowedTools')
      expect(fields).toContain('blockedTools')
      expect(fields).toContain('allowedTools+blockedTools')
    })
  })

  // -------------------------------------------------------------------------
  // maxTurns (all providers support it)
  // -------------------------------------------------------------------------

  describe('maxTurns', () => {
    it('should not produce a violation for any current provider', () => {
      for (const provider of ALL_PROVIDERS) {
        const result = compileAndCheck(provider, { maxTurns: 50 })
        const violation = result.violations.find((v) => v.field === 'maxTurns')
        expect(violation).toBeUndefined()
      }
    })
  })
})

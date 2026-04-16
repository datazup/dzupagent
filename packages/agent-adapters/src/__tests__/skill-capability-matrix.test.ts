import { describe, it, expect, beforeEach } from 'vitest'

import type { AdapterSkillBundle } from '../skills/adapter-skill-types.js'
import { createDefaultSkillRegistry, AdapterSkillRegistry } from '../skills/adapter-skill-registry.js'
import {
  SkillCapabilityMatrixBuilder,
  type SkillCapabilityMatrix,
  type ProviderCapabilityRow,
} from '../skills/skill-capability-matrix.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBundle(overrides: Partial<AdapterSkillBundle> = {}): AdapterSkillBundle {
  return {
    bundleId: 'bundle-001',
    skillSetId: 'skillset-alpha',
    skillSetVersion: '2.1.0',
    personaId: 'code-reviewer',
    constraints: {
      maxBudgetUsd: 5,
      approvalMode: 'conditional',
      networkPolicy: 'restricted',
      toolPolicy: 'balanced',
    },
    promptSections: [
      { id: 'safety', purpose: 'safety', content: 'Never execute destructive commands.', priority: 1 },
      { id: 'task', purpose: 'task', content: 'Review the pull request for correctness.', priority: 10 },
      { id: 'persona', purpose: 'persona', content: 'You are a senior code reviewer.', priority: 5 },
    ],
    toolBindings: [
      { toolName: 'read_file', mode: 'required' },
      { toolName: 'write_file', mode: 'optional' },
      { toolName: 'exec_command', mode: 'blocked' },
      { toolName: 'search_code', mode: 'required' },
    ],
    metadata: {
      owner: 'platform-team',
      reviewedBy: 'security-lead',
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-04-01T00:00:00Z',
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillCapabilityMatrixBuilder', () => {
  let registry: AdapterSkillRegistry
  let builder: SkillCapabilityMatrixBuilder

  beforeEach(() => {
    registry = createDefaultSkillRegistry()
    builder = new SkillCapabilityMatrixBuilder(registry)
  })

  // -----------------------------------------------------------------------
  // Basic structure
  // -----------------------------------------------------------------------

  describe('buildForSkill', () => {
    it('returns a matrix with skillId and skillName', () => {
      const bundle = makeBundle()
      const matrix = builder.buildForSkill(bundle)

      expect(matrix.skillId).toBe('bundle-001')
      expect(matrix.skillName).toBe('skillset-alpha')
    })

    it('includes rows for all registered providers', () => {
      const bundle = makeBundle()
      const matrix = builder.buildForSkill(bundle)

      const providerIds = Object.keys(matrix.providers)
      expect(providerIds).toContain('claude')
      expect(providerIds).toContain('codex')
      expect(providerIds).toContain('gemini')
      expect(providerIds).toContain('qwen')
      expect(providerIds).toContain('crush')
      expect(providerIds).toContain('goose')
      expect(providerIds).toContain('openrouter')
    })

    it('systemPrompt is always active for all providers', () => {
      const bundle = makeBundle()
      const matrix = builder.buildForSkill(bundle)

      for (const row of Object.values(matrix.providers)) {
        expect(row?.systemPrompt).toBe('active')
      }
    })
  })

  // -----------------------------------------------------------------------
  // Claude provider
  // -----------------------------------------------------------------------

  describe('claude row', () => {
    it('has all capabilities active', () => {
      const bundle = makeBundle()
      const matrix = builder.buildForSkill(bundle)
      const row = matrix.providers['claude'] as ProviderCapabilityRow

      expect(row.systemPrompt).toBe('active')
      expect(row.toolBindings).toBe('active')
      expect(row.approvalMode).toBe('active')
      expect(row.networkPolicy).toBe('active')
      expect(row.budgetLimit).toBe('active')
    })

    it('has no capability-dropped warnings', () => {
      const bundle = makeBundle()
      const matrix = builder.buildForSkill(bundle)
      const row = matrix.providers['claude'] as ProviderCapabilityRow

      const droppedWarnings = row.warnings.filter((w) => w.includes('dropped'))
      expect(droppedWarnings).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // Codex provider
  // -----------------------------------------------------------------------

  describe('codex row', () => {
    it('has budgetLimit dropped, others active', () => {
      const bundle = makeBundle()
      const matrix = builder.buildForSkill(bundle)
      const row = matrix.providers['codex'] as ProviderCapabilityRow

      expect(row.systemPrompt).toBe('active')
      expect(row.toolBindings).toBe('active')
      expect(row.approvalMode).toBe('active')
      expect(row.networkPolicy).toBe('active')
      expect(row.budgetLimit).toBe('dropped')
    })

    it('includes a warning about budgetLimit being dropped', () => {
      const bundle = makeBundle()
      const matrix = builder.buildForSkill(bundle)
      const row = matrix.providers['codex'] as ProviderCapabilityRow

      expect(row.warnings.some((w) => w.includes('budgetLimit'))).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Gemini CLI provider
  // -----------------------------------------------------------------------

  describe('gemini CLI row', () => {
    it('has toolBindings, approvalMode, networkPolicy, budgetLimit all dropped', () => {
      const bundle = makeBundle()
      const matrix = builder.buildForSkill(bundle)
      const row = matrix.providers['gemini'] as ProviderCapabilityRow

      expect(row.systemPrompt).toBe('active')
      expect(row.toolBindings).toBe('dropped')
      expect(row.approvalMode).toBe('dropped')
      expect(row.networkPolicy).toBe('dropped')
      expect(row.budgetLimit).toBe('dropped')
    })

    it('includes warnings for dropped capabilities', () => {
      const bundle = makeBundle()
      const matrix = builder.buildForSkill(bundle)
      const row = matrix.providers['gemini'] as ProviderCapabilityRow

      expect(row.warnings.length).toBeGreaterThan(0)
      expect(row.warnings.some((w) => w.includes('does not support'))).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Other CLI providers
  // -----------------------------------------------------------------------

  describe('CLI providers (qwen, crush, goose, openrouter)', () => {
    const cliProviders = ['qwen', 'crush', 'goose', 'openrouter'] as const

    for (const pid of cliProviders) {
      it(`${pid}: all non-systemPrompt capabilities are dropped`, () => {
        const bundle = makeBundle()
        const matrix = builder.buildForSkill(bundle)
        const row = matrix.providers[pid] as ProviderCapabilityRow

        expect(row.systemPrompt).toBe('active')
        expect(row.toolBindings).toBe('dropped')
        expect(row.approvalMode).toBe('dropped')
        expect(row.networkPolicy).toBe('dropped')
        expect(row.budgetLimit).toBe('dropped')
      })
    }
  })

  // -----------------------------------------------------------------------
  // buildForAll
  // -----------------------------------------------------------------------

  describe('buildForAll', () => {
    it('returns one matrix per bundle', () => {
      const b1 = makeBundle({ bundleId: 'b1' })
      const b2 = makeBundle({ bundleId: 'b2' })
      const matrices = builder.buildForAll([b1, b2])

      expect(matrices).toHaveLength(2)
      expect(matrices[0].skillId).toBe('b1')
      expect(matrices[1].skillId).toBe('b2')
    })

    it('returns empty array for empty input', () => {
      const matrices = builder.buildForAll([])
      expect(matrices).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe('edge cases', () => {
    it('bundle with no constraints still produces valid matrix', () => {
      const bundle = makeBundle({ constraints: {} })
      const matrix = builder.buildForSkill(bundle)

      // Should still have all providers
      expect(Object.keys(matrix.providers).length).toBeGreaterThanOrEqual(7)

      // Claude row should still be all active
      const claude = matrix.providers['claude'] as ProviderCapabilityRow
      expect(claude.systemPrompt).toBe('active')
      expect(claude.toolBindings).toBe('active')
    })

    it('bundle with no tool bindings still produces valid matrix', () => {
      const bundle = makeBundle({ toolBindings: [], constraints: {} })
      const matrix = builder.buildForSkill(bundle)

      expect(Object.keys(matrix.providers).length).toBeGreaterThanOrEqual(7)
    })

    it('bundle with no prompt sections still produces valid matrix', () => {
      const bundle = makeBundle({ promptSections: [] })
      const matrix = builder.buildForSkill(bundle)

      expect(matrix.skillId).toBe('bundle-001')
      expect(Object.keys(matrix.providers).length).toBeGreaterThanOrEqual(7)
    })

    it('warnings array is always present (even if empty)', () => {
      const bundle = makeBundle({ constraints: {}, toolBindings: [] })
      const matrix = builder.buildForSkill(bundle)

      for (const row of Object.values(matrix.providers)) {
        expect(Array.isArray(row?.warnings)).toBe(true)
      }
    })
  })
})

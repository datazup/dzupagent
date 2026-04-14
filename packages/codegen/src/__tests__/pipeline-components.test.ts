/**
 * Tests for pipeline utility modules:
 *   - gen-pipeline-builder
 *   - fix-escalation
 *   - phase-conditions
 *   - skill-resolver
 *   - guardrail-gate
 */

import { describe, it, expect, vi } from 'vitest'
import {
  GenPipelineBuilder,
  type PipelinePhase,
} from '../pipeline/gen-pipeline-builder.js'
import {
  getEscalationStrategy,
  DEFAULT_ESCALATION,
  type EscalationConfig,
} from '../pipeline/fix-escalation.js'
import {
  hasKey,
  previousSucceeded,
  stateEquals,
  hasFilesMatching,
  allOf,
  anyOf,
} from '../pipeline/phase-conditions.js'
import {
  resolveSkills,
  formatResolvedSkillsPrompt,
  injectSkillsIntoState,
  resolveAndInjectSkills,
  type ResolvedSkill,
} from '../pipeline/skill-resolver.js'
import {
  runGuardrailGate,
  summarizeGateResult,
  type GuardrailGateConfig,
} from '../pipeline/guardrail-gate.js'
import type { GuardrailEngine } from '../guardrails/guardrail-engine.js'
import type { GuardrailReport, GuardrailContext } from '../guardrails/guardrail-types.js'

// ---------------------------------------------------------------------------
// GenPipelineBuilder
// ---------------------------------------------------------------------------

describe('GenPipelineBuilder', () => {
  it('starts with no phases', () => {
    const b = new GenPipelineBuilder()
    expect(b.getPhases()).toHaveLength(0)
  })

  it('addPhase appends a generation phase', () => {
    const b = new GenPipelineBuilder()
    b.addPhase({ name: 'gen', promptType: 'code-gen' })
    const phases = b.getPhases()
    expect(phases).toHaveLength(1)
    expect(phases[0]).toMatchObject({ name: 'gen', type: 'generation', promptType: 'code-gen' })
  })

  it('addSubAgentPhase appends a subagent phase', () => {
    const b = new GenPipelineBuilder()
    b.addSubAgentPhase({ name: 'sub', promptType: 'sub-gen' })
    expect(b.getPhases()[0]).toMatchObject({ type: 'subagent' })
  })

  it('addValidationPhase uses default name "validate"', () => {
    const b = new GenPipelineBuilder()
    b.addValidationPhase({ dimensions: ['correctness'], threshold: 80 })
    expect(b.getPhases()[0]).toMatchObject({ name: 'validate', type: 'validation', threshold: 80 })
  })

  it('addValidationPhase accepts a custom name', () => {
    const b = new GenPipelineBuilder()
    b.addValidationPhase({ name: 'lint-check', dimensions: [], threshold: 0 })
    expect(b.getPhases()[0]!.name).toBe('lint-check')
  })

  it('addFixPhase uses defaults', () => {
    const b = new GenPipelineBuilder()
    b.addFixPhase()
    const phase = b.getPhases()[0] as PipelinePhase & { maxAttempts: number }
    expect(phase.name).toBe('fix')
    expect(phase.type).toBe('fix')
    expect(phase.maxAttempts).toBe(3)
    expect(phase.escalation).toBeDefined()
  })

  it('addFixPhase accepts custom config', () => {
    const b = new GenPipelineBuilder()
    b.addFixPhase({ name: 'my-fix', maxAttempts: 5 })
    const phase = b.getPhases()[0] as PipelinePhase
    expect(phase.name).toBe('my-fix')
    expect((phase as PipelinePhase & { maxAttempts: number }).maxAttempts).toBe(5)
  })

  it('addReviewPhase uses defaults', () => {
    const b = new GenPipelineBuilder()
    b.addReviewPhase()
    const phase = b.getPhases()[0]!
    expect(phase.name).toBe('review')
    expect(phase.type).toBe('review')
    expect((phase as PipelinePhase & { autoApprove: boolean }).autoApprove).toBe(false)
  })

  it('addReviewPhase with autoApprove', () => {
    const b = new GenPipelineBuilder()
    b.addReviewPhase({ autoApprove: true })
    expect((b.getPhases()[0] as PipelinePhase & { autoApprove: boolean }).autoApprove).toBe(true)
  })

  it('withGuardrails inserts a guardrail phase and stores config', () => {
    const engine = { evaluate: vi.fn() } as unknown as GuardrailEngine
    const b = new GenPipelineBuilder()
    b.withGuardrails({ engine, strictMode: true })
    expect(b.getPhases()).toHaveLength(1)
    expect(b.getPhases()[0]!.type).toBe('guardrail')
    expect(b.getGuardrailConfig()).toMatchObject({ strictMode: true })
  })

  it('getGuardrailConfig returns undefined when not configured', () => {
    expect(new GenPipelineBuilder().getGuardrailConfig()).toBeUndefined()
  })

  it('getPhase returns correct phase by name', () => {
    const b = new GenPipelineBuilder()
    b.addPhase({ name: 'alpha', promptType: 'x' })
    b.addFixPhase({ name: 'beta' })
    expect(b.getPhase('beta')?.type).toBe('fix')
    expect(b.getPhase('nonexistent')).toBeUndefined()
  })

  it('getPhaseNames returns ordered names', () => {
    const b = new GenPipelineBuilder()
    b.addPhase({ name: 'a', promptType: 'x' })
    b.addValidationPhase({ dimensions: [], threshold: 0 })
    b.addFixPhase({ name: 'c' })
    expect(b.getPhaseNames()).toEqual(['a', 'validate', 'c'])
  })

  it('getGenerationPhases returns only generation and subagent types', () => {
    const b = new GenPipelineBuilder()
    b.addPhase({ name: 'g', promptType: 'x' })
    b.addSubAgentPhase({ name: 's', promptType: 'y' })
    b.addValidationPhase({ dimensions: [], threshold: 0 })
    b.addFixPhase()
    const gen = b.getGenerationPhases()
    expect(gen).toHaveLength(2)
    expect(gen.map(p => p.name)).toEqual(['g', 's'])
  })

  it('builder is fluent (returns this)', () => {
    const b = new GenPipelineBuilder()
    const returned = b.addPhase({ name: 'x', promptType: 'y' })
    expect(returned).toBe(b)
  })
})

// ---------------------------------------------------------------------------
// Fix Escalation
// ---------------------------------------------------------------------------

describe('getEscalationStrategy', () => {
  it('attempt 0 → first strategy (targeted)', () => {
    const s = getEscalationStrategy(0)
    expect(s.name).toBe('targeted')
  })

  it('attempt 1 → second strategy (expanded)', () => {
    const s = getEscalationStrategy(1)
    expect(s.name).toBe('expanded')
    expect(s.includeFullVfs).toBe(true)
  })

  it('attempt 2 → third strategy (escalated)', () => {
    const s = getEscalationStrategy(2)
    expect(s.name).toBe('escalated')
    expect(s.modelTier).toBe('reasoning')
  })

  it('attempt beyond max clamps to last strategy', () => {
    const s = getEscalationStrategy(100)
    expect(s.name).toBe('escalated')
  })

  it('uses custom EscalationConfig', () => {
    const custom: EscalationConfig = {
      maxAttempts: 2,
      strategies: [
        { name: 'targeted' },
        { name: 'expanded' },
      ],
    }
    expect(getEscalationStrategy(0, custom).name).toBe('targeted')
    expect(getEscalationStrategy(1, custom).name).toBe('expanded')
    expect(getEscalationStrategy(5, custom).name).toBe('expanded')
  })

  it('DEFAULT_ESCALATION has 3 strategies', () => {
    expect(DEFAULT_ESCALATION.strategies).toHaveLength(3)
    expect(DEFAULT_ESCALATION.maxAttempts).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Phase Conditions
// ---------------------------------------------------------------------------

describe('phase-conditions', () => {
  describe('hasKey', () => {
    it('returns true when key has a truthy value', () => {
      expect(hasKey('foo')({ foo: 'bar' })).toBe(true)
      expect(hasKey('foo')({ foo: 42 })).toBe(true)
      expect(hasKey('foo')({ foo: [] })).toBe(true)
    })

    it('returns false when key is missing', () => {
      expect(hasKey('foo')({})).toBe(false)
    })

    it('returns false when key is undefined or null', () => {
      expect(hasKey('foo')({ foo: undefined })).toBe(false)
      expect(hasKey('foo')({ foo: null })).toBe(false)
    })
  })

  describe('previousSucceeded', () => {
    it('true when phase marker is true', () => {
      expect(previousSucceeded('gen')({ __phase_gen_completed: true })).toBe(true)
    })

    it('false when marker is missing or false', () => {
      expect(previousSucceeded('gen')({})).toBe(false)
      expect(previousSucceeded('gen')({ __phase_gen_completed: false })).toBe(false)
    })
  })

  describe('stateEquals', () => {
    it('true when value matches strictly', () => {
      expect(stateEquals('status', 'done')({ status: 'done' })).toBe(true)
    })

    it('false for different value', () => {
      expect(stateEquals('status', 'done')({ status: 'pending' })).toBe(false)
    })

    it('false for type mismatch (1 !== "1")', () => {
      expect(stateEquals('n', 1)({ n: '1' })).toBe(false)
    })
  })

  describe('hasFilesMatching', () => {
    it('true when at least one file matches', () => {
      const pred = hasFilesMatching(/\.ts$/)
      expect(pred({ files: ['src/a.ts', 'src/b.js'] })).toBe(true)
    })

    it('false when no file matches', () => {
      const pred = hasFilesMatching(/\.ts$/)
      expect(pred({ files: ['README.md'] })).toBe(false)
    })

    it('false when files is not an array', () => {
      expect(hasFilesMatching(/\.ts$/)({ files: 'src/a.ts' })).toBe(false)
    })

    it('false when files is missing', () => {
      expect(hasFilesMatching(/\.ts$/)({ })).toBe(false)
    })
  })

  describe('allOf', () => {
    const t = (_: Record<string, unknown>) => true
    const f = (_: Record<string, unknown>) => false

    it('true when all conditions hold', () => {
      expect(allOf(t, t, t)({})).toBe(true)
    })

    it('false when any condition fails', () => {
      expect(allOf(t, f, t)({})).toBe(false)
    })

    it('true for empty list', () => {
      expect(allOf()({})).toBe(true)
    })
  })

  describe('anyOf', () => {
    const t = (_: Record<string, unknown>) => true
    const f = (_: Record<string, unknown>) => false

    it('true when at least one condition holds', () => {
      expect(anyOf(f, f, t)({})).toBe(true)
    })

    it('false when all conditions fail', () => {
      expect(anyOf(f, f)({})).toBe(false)
    })

    it('false for empty list', () => {
      expect(anyOf()({})).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// Skill Resolver
// ---------------------------------------------------------------------------

describe('skill-resolver', () => {
  const makeRegistry = (entries: Record<string, string>) => ({
    get: (name: string) => {
      if (name in entries) return { instructions: entries[name]! }
      return undefined
    },
  })

  const makeLoader = (entries: Record<string, string | null>) => ({
    loadSkillContent: async (name: string) => entries[name] ?? null,
  })

  describe('resolveSkills', () => {
    it('resolves from registry first', async () => {
      const registry = makeRegistry({ foo: 'foo-content' })
      const loader = makeLoader({ foo: 'loader-content' })
      const result = await resolveSkills(['foo'], { registry, loader })
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({ name: 'foo', content: 'foo-content', source: 'registry' })
    })

    it('falls back to loader when not in registry', async () => {
      const registry = makeRegistry({})
      const loader = makeLoader({ bar: 'bar-content' })
      const result = await resolveSkills(['bar'], { registry, loader })
      expect(result[0]).toMatchObject({ name: 'bar', content: 'bar-content', source: 'loader' })
    })

    it('skips unresolved skills silently (warns)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const result = await resolveSkills(['unknown'], { registry: makeRegistry({}), loader: makeLoader({}) })
      expect(result).toHaveLength(0)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown'))
      warnSpy.mockRestore()
    })

    it('returns empty array for no skill names', async () => {
      const result = await resolveSkills([], {})
      expect(result).toHaveLength(0)
    })

    it('resolves multiple skills in order', async () => {
      const registry = makeRegistry({ a: 'a-content' })
      const loader = makeLoader({ b: 'b-content' })
      const result = await resolveSkills(['a', 'b'], { registry, loader })
      expect(result.map(r => r.name)).toEqual(['a', 'b'])
    })

    it('handles loader throwing by skipping the skill', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const registry = makeRegistry({})
      const loader = { loadSkillContent: async (_: string) => { throw new Error('disk error') } }
      const result = await resolveSkills(['x'], { registry, loader })
      expect(result).toHaveLength(0)
      warnSpy.mockRestore()
    })
  })

  describe('formatResolvedSkillsPrompt', () => {
    it('returns empty string for no skills', () => {
      expect(formatResolvedSkillsPrompt([])).toBe('')
    })

    it('wraps skills in ## Active Skills header', () => {
      const skills: ResolvedSkill[] = [
        { name: 'my-skill', content: 'Do something\n', source: 'registry' },
      ]
      const prompt = formatResolvedSkillsPrompt(skills)
      expect(prompt).toContain('## Active Skills')
      expect(prompt).toContain('### my-skill')
      expect(prompt).toContain('Do something')
    })

    it('separates multiple skills with double newline', () => {
      const skills: ResolvedSkill[] = [
        { name: 'a', content: 'A', source: 'registry' },
        { name: 'b', content: 'B', source: 'loader' },
      ]
      const prompt = formatResolvedSkillsPrompt(skills)
      expect(prompt).toContain('### a')
      expect(prompt).toContain('### b')
    })
  })

  describe('injectSkillsIntoState', () => {
    it('injects __skills_ and __skills_prompt_ keys', () => {
      const state: Record<string, unknown> = {}
      const skills: ResolvedSkill[] = [{ name: 'x', content: 'X', source: 'registry' }]
      injectSkillsIntoState(state, 'gen', skills)
      expect(state['__skills_gen']).toBe(skills)
      expect(typeof state['__skills_prompt_gen']).toBe('string')
    })

    it('sanitizes phase name for key (special chars → underscore)', () => {
      const state: Record<string, unknown> = {}
      injectSkillsIntoState(state, 'gen-phase', [])
      expect('__skills_gen_phase' in state).toBe(true)
    })

    it('injects __skill_context when provided', () => {
      const state: Record<string, unknown> = {}
      injectSkillsIntoState(state, 'p', [], { agentId: 'a1', projectRoot: '/tmp', skills: [] })
      expect(state['__skill_context']).toMatchObject({ agentId: 'a1' })
    })
  })

  describe('resolveAndInjectSkills', () => {
    it('returns empty array and does nothing for empty names', async () => {
      const state: Record<string, unknown> = {}
      const result = await resolveAndInjectSkills([], 'phase', state, {})
      expect(result).toHaveLength(0)
      expect(state['__skills_phase']).toBeUndefined()
    })

    it('resolves and injects in one call', async () => {
      const registry = makeRegistry({ s: 'content' })
      const state: Record<string, unknown> = {}
      const result = await resolveAndInjectSkills(['s'], 'myPhase', state, { registry })
      expect(result).toHaveLength(1)
      expect(state['__skills_myPhase']).toBeDefined()
    })
  })
})

// ---------------------------------------------------------------------------
// Guardrail Gate
// ---------------------------------------------------------------------------

const EMPTY_REPORT: GuardrailReport = {
  passed: true,
  totalViolations: 0,
  errorCount: 0,
  warningCount: 0,
  infoCount: 0,
  ruleResults: new Map(),
  violations: [],
}

function makeEngine(overrides: Partial<GuardrailReport> = {}): GuardrailEngine {
  return {
    evaluate(_ctx: GuardrailContext): GuardrailReport {
      return { ...EMPTY_REPORT, ...overrides }
    },
  } as GuardrailEngine
}

describe('runGuardrailGate', () => {
  const ctx: GuardrailContext = {
    files: new Map([['src/a.ts', 'const x = 1']]),
    metadata: {},
  }

  it('passes when no violations', () => {
    const result = runGuardrailGate({ engine: makeEngine() }, ctx)
    expect(result.passed).toBe(true)
    expect(result.formattedReport).toBeUndefined()
  })

  it('fails when there are errors', () => {
    const engine = makeEngine({ passed: false, errorCount: 1, totalViolations: 1 })
    const result = runGuardrailGate({ engine }, ctx)
    expect(result.passed).toBe(false)
  })

  it('normal mode: warnings do NOT block', () => {
    const engine = makeEngine({ warningCount: 2 })
    const result = runGuardrailGate({ engine, strictMode: false }, ctx)
    expect(result.passed).toBe(true)
  })

  it('strict mode: warnings block', () => {
    const engine = makeEngine({ warningCount: 1 })
    const result = runGuardrailGate({ engine, strictMode: true }, ctx)
    expect(result.passed).toBe(false)
  })

  it('calls reporter when provided', () => {
    const reporter = { format: vi.fn(() => 'report-output') }
    const config: GuardrailGateConfig = {
      engine: makeEngine(),
      reporter,
    }
    const result = runGuardrailGate(config, ctx)
    expect(reporter.format).toHaveBeenCalledOnce()
    expect(result.formattedReport).toBe('report-output')
  })
})

describe('summarizeGateResult', () => {
  it('includes PASSED for clean result', () => {
    const result = runGuardrailGate({ engine: makeEngine() }, {
      files: new Map(),
      metadata: {},
    })
    const summary = summarizeGateResult(result)
    expect(summary).toContain('PASSED')
    expect(summary).toContain('0 error(s)')
  })

  it('includes FAILED and violation details when failed', () => {
    const engine = makeEngine({
      passed: false,
      errorCount: 1,
      totalViolations: 1,
      violations: [
        { ruleId: 'r1', file: 'src/x.ts', message: 'bad pattern', severity: 'error', autoFixable: false },
      ],
    })
    const result = runGuardrailGate({ engine }, { files: new Map(), metadata: {} })
    const summary = summarizeGateResult(result)
    expect(summary).toContain('FAILED')
    expect(summary).toContain('[ERROR]')
    expect(summary).toContain('bad pattern')
  })

  it('shows "and N more" when violations exceed 10', () => {
    const violations = Array.from({ length: 15 }, (_, i) => ({
      ruleId: `r${i}`,
      file: `src/${i}.ts`,
      message: `msg ${i}`,
      severity: 'error' as const,
      autoFixable: false,
    }))
    const engine = makeEngine({ passed: false, errorCount: 15, totalViolations: 15, violations })
    const result = runGuardrailGate({ engine }, { files: new Map(), metadata: {} })
    const summary = summarizeGateResult(result)
    expect(summary).toContain('and 5 more')
  })
})

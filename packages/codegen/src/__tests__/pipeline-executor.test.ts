import { describe, it, expect, vi } from 'vitest'
import { PipelineExecutor, type PhaseConfig } from '../pipeline/pipeline-executor.js'
import type { GuardrailEngine } from '../guardrails/guardrail-engine.js'
import type { GuardrailReport, GuardrailContext } from '../guardrails/guardrail-types.js'

function makePhase(
  id: string,
  execute: (state: Record<string, unknown>) => Promise<Record<string, unknown>>,
  overrides?: Partial<PhaseConfig>,
): PhaseConfig {
  return {
    id,
    name: id,
    execute,
    ...overrides,
  }
}

const EMPTY_REPORT: GuardrailReport = {
  passed: true,
  totalViolations: 0,
  errorCount: 0,
  warningCount: 0,
  infoCount: 0,
  ruleResults: new Map(),
  violations: [],
}

function makeFailingGuardrailEngine(): GuardrailEngine {
  return {
    evaluate(_context: GuardrailContext): GuardrailReport {
      return {
        ...EMPTY_REPORT,
        passed: false,
        totalViolations: 1,
        errorCount: 1,
        violations: [
          {
            ruleId: 'security-rule',
            file: 'src/a.ts',
            message: 'Forbidden pattern',
            severity: 'error',
            autoFixable: false,
          },
        ],
      }
    },
  } as GuardrailEngine
}

describe('PipelineExecutor (runtime-backed compatibility)', () => {
  it('executes phases sequentially and merges state', async () => {
    const ex = new PipelineExecutor()
    const phases: PhaseConfig[] = [
      makePhase('a', async (s) => ({ ...s, a: 1 })),
      makePhase('b', async (s) => ({ ...s, b: (s['a'] as number) + 1 })),
    ]

    const result = await ex.execute(phases, { seed: true })

    expect(result.status).toBe('completed')
    expect(result.phases.map(p => p.phaseId)).toEqual(['a', 'b'])
    expect(result.phases.every(p => p.status === 'completed')).toBe(true)
    expect(result.state['a']).toBe(1)
    expect(result.state['b']).toBe(2)
    expect(result.state['seed']).toBe(true)
    expect(result.state['__phase_a_completed']).toBe(true)
    expect(result.state['__phase_b_completed']).toBe(true)
  })

  it('marks conditional phases as skipped and continues', async () => {
    const ex = new PipelineExecutor()
    const phases: PhaseConfig[] = [
      makePhase('a', async () => ({ mode: 'fast' })),
      makePhase(
        'b',
        async () => ({ shouldNotRun: true }),
        { condition: () => false },
      ),
      makePhase('c', async () => ({ c: true })),
    ]

    const result = await ex.execute(phases, {})

    expect(result.status).toBe('completed')
    expect(result.phases[1]?.status).toBe('skipped')
    expect(result.state['__phase_b_skipped']).toBe(true)
    expect(result.state['shouldNotRun']).toBeUndefined()
    expect(result.state['c']).toBe(true)
  })

  it('returns failed result on phase failure', async () => {
    const ex = new PipelineExecutor()
    const phases: PhaseConfig[] = [
      makePhase('ok', async () => ({ ok: true })),
      makePhase('fail', async () => {
        throw new Error('boom')
      }),
      makePhase('never', async () => ({ never: true })),
    ]

    const result = await ex.execute(phases, {})

    expect(result.status).toBe('failed')
    expect(result.phases).toHaveLength(2)
    expect(result.phases[1]?.phaseId).toBe('fail')
    expect(result.phases[1]?.status).toBe('failed')
    expect(result.phases[1]?.error).toContain('boom')
    expect(result.state['never']).toBeUndefined()
  })

  it('runs guardrail gate and fails when gate blocks', async () => {
    const onCheckpoint = vi.fn(async () => {})
    const ex = new PipelineExecutor({
      onCheckpoint,
      guardrailGate: {
        engine: makeFailingGuardrailEngine(),
      },
      buildGuardrailContext: () => ({
        files: [],
        projectStructure: {
          packages: new Map(),
          rootDir: '/',
        },
        conventions: {
          fileNaming: 'kebab-case',
          exportNaming: {
            classCase: 'PascalCase',
            functionCase: 'camelCase',
            constCase: 'camelCase',
          },
          importStyle: {
            indexOnly: true,
            separateTypeImports: true,
          },
          requiredPatterns: [],
        },
      }),
    })

    const phases: PhaseConfig[] = [
      makePhase('a', async () => ({ a: true })),
    ]

    const result = await ex.execute(phases, {})

    expect(result.status).toBe('failed')
    expect(result.phases[0]?.status).toBe('failed')
    expect(result.phases[0]?.error).toContain('Guardrail gate FAILED')
    expect(result.state['__phase_a_guardrail']).toEqual({
      passed: false,
      errorCount: 1,
      warningCount: 0,
    })
    expect(onCheckpoint).not.toHaveBeenCalled()
  })
})


import { describe, it, expect, vi } from 'vitest'
import { runBudgetGate, type BudgetGateConfig } from '../pipeline/budget-gate.js'
import { PipelineExecutor, type PhaseConfig } from '../pipeline/pipeline-executor.js'

describe('runBudgetGate', () => {
  it('passes when within budget', async () => {
    const config: BudgetGateConfig = {
      checkBudget: vi.fn().mockResolvedValue({
        withinBudget: true,
        usedCents: 30,
        remainingCents: 70,
      }),
      workflowRunId: 'wf-1',
      budgetLimitCents: 100,
    }

    const result = await runBudgetGate(config)
    expect(result.passed).toBe(true)
    expect(result.usedCents).toBe(30)
    expect(result.remainingCents).toBe(70)
    expect(config.checkBudget).toHaveBeenCalledWith('wf-1', 100)
  })

  it('fails when budget exceeded', async () => {
    const config: BudgetGateConfig = {
      checkBudget: vi.fn().mockResolvedValue({
        withinBudget: false,
        usedCents: 120,
        remainingCents: 0,
      }),
      workflowRunId: 'wf-1',
      budgetLimitCents: 100,
    }

    const result = await runBudgetGate(config)
    expect(result.passed).toBe(false)
    expect(result.usedCents).toBe(120)
  })
})

describe('PipelineExecutor with budgetGate', () => {
  function makePhase(
    id: string,
    execute: (state: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ): PhaseConfig {
    return { id, name: id, execute }
  }

  it('skips phase when budget is exceeded', async () => {
    const checkBudget = vi.fn().mockResolvedValue({
      withinBudget: false,
      usedCents: 200,
      remainingCents: 0,
    })

    const executor = new PipelineExecutor({
      budgetGate: {
        checkBudget,
        workflowRunId: 'wf-1',
        budgetLimitCents: 100,
      },
    })

    const executeFn = vi.fn().mockResolvedValue({ done: true })
    const result = await executor.execute(
      [makePhase('gen', executeFn)],
      {},
    )

    expect(executeFn).not.toHaveBeenCalled()
    expect(result.phases).toHaveLength(1)
    expect(result.phases[0]!.status).toBe('failed')
    expect(result.phases[0]!.error).toContain('Budget exceeded')
  })

  it('allows phase when within budget', async () => {
    const checkBudget = vi.fn().mockResolvedValue({
      withinBudget: true,
      usedCents: 30,
      remainingCents: 70,
    })

    const executor = new PipelineExecutor({
      budgetGate: {
        checkBudget,
        workflowRunId: 'wf-1',
        budgetLimitCents: 100,
      },
    })

    const result = await executor.execute(
      [makePhase('gen', async (s) => ({ ...s, generated: true }))],
      {},
    )

    expect(result.status).toBe('completed')
    expect(result.state['generated']).toBe(true)
    expect(result.state['__phase_gen_budget']).toEqual({
      passed: true,
      usedCents: 30,
      remainingCents: 70,
    })
  })

  it('runs budget check before each phase', async () => {
    let callCount = 0
    const checkBudget = vi.fn().mockImplementation(async () => {
      callCount++
      return {
        withinBudget: callCount <= 1,
        usedCents: callCount * 60,
        remainingCents: Math.max(0, 100 - callCount * 60),
      }
    })

    const executor = new PipelineExecutor({
      budgetGate: {
        checkBudget,
        workflowRunId: 'wf-1',
        budgetLimitCents: 100,
      },
    })

    const result = await executor.execute(
      [
        makePhase('a', async (s) => ({ ...s, a: true })),
        makePhase('b', async (s) => ({ ...s, b: true })),
      ],
      {},
    )

    expect(checkBudget).toHaveBeenCalledTimes(2)
    expect(result.phases[0]!.status).toBe('completed')
    expect(result.phases[1]!.status).toBe('failed')
  })
})

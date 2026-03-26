import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@forgeagent/core'
import type { ForgeEventBus } from '@forgeagent/core'
import { RecoveryCopilot } from '../recovery/recovery-copilot.js'
import type {
  FailureContext,
  RecoveryStrategy,
} from '../recovery/recovery-types.js'
import type { FailureAnalysis } from '../recovery/failure-analyzer.js'

function makeFailure(overrides: Partial<FailureContext> = {}): FailureContext {
  return {
    type: 'build_failure',
    error: 'Build failed with TypeScript error',
    runId: 'run-1',
    timestamp: new Date(),
    previousAttempts: 0,
    ...overrides,
  }
}

describe('RecoveryCopilot', () => {
  let eventBus: ForgeEventBus
  let actionHandler: ReturnType<typeof vi.fn>

  beforeEach(() => {
    eventBus = createEventBus()
    actionHandler = vi.fn().mockResolvedValue('Action completed')
  })

  function createCopilot(opts: {
    dryRun?: boolean
    maxAttempts?: number
    strategyGenerator?: (analysis: FailureAnalysis, ctx: FailureContext) => RecoveryStrategy[]
  } = {}) {
    return new RecoveryCopilot({
      eventBus,
      actionHandler,
      config: {
        dryRun: opts.dryRun ?? false,
        maxAttempts: opts.maxAttempts ?? 3,
      },
      strategyGenerator: opts.strategyGenerator,
    })
  }

  // -------------------------------------------------------------------------
  // createPlan
  // -------------------------------------------------------------------------

  describe('createPlan', () => {
    it('creates a plan with strategies for a build failure', () => {
      const copilot = createCopilot()
      const plan = copilot.createPlan(makeFailure())

      expect(plan.id).toMatch(/^recovery_/)
      expect(plan.status).toBe('proposed')
      expect(plan.strategies.length).toBeGreaterThan(0)
      expect(plan.failureContext.type).toBe('build_failure')
    })

    it('selects a strategy automatically', () => {
      const copilot = createCopilot()
      const plan = copilot.createPlan(makeFailure())

      expect(plan.selectedStrategy).not.toBeNull()
      expect(plan.selectedStrategy!.confidence).toBeGreaterThan(0)
    })

    it('creates plans for different failure types', () => {
      const copilot = createCopilot()

      const types = ['build_failure', 'test_failure', 'timeout', 'resource_exhaustion', 'generation_failure'] as const
      for (const type of types) {
        const plan = copilot.createPlan(makeFailure({ type, error: `${type} error`, runId: `run-${type}` }))
        expect(plan.strategies.length).toBeGreaterThan(0)
      }
    })

    it('escalates when max attempts exceeded', () => {
      const copilot = createCopilot({ maxAttempts: 2 })
      const plan = copilot.createPlan(makeFailure({ previousAttempts: 2 }))

      expect(plan.status).toBe('failed')
      expect(plan.executionError).toContain('Max recovery attempts')
      expect(plan.strategies[0]!.name).toBe('human_escalation')
    })

    it('uses custom strategy generator when provided', () => {
      const customGenerator = vi.fn().mockReturnValue([
        {
          name: 'custom_fix',
          description: 'Custom domain fix',
          confidence: 0.95,
          risk: 'low' as const,
          estimatedSteps: 1,
          actions: [{ type: 'retry' as const, params: {}, description: 'Custom retry' }],
        },
      ])

      const copilot = createCopilot({ strategyGenerator: customGenerator })
      const plan = copilot.createPlan(makeFailure())

      expect(customGenerator).toHaveBeenCalled()
      expect(plan.strategies[0]!.name).toBe('custom_fix')
    })

    it('limits strategies to maxStrategies config', () => {
      const manyStrategies = Array.from({ length: 10 }, (_, i) => ({
        name: `strategy_${i}`,
        description: `Strategy ${i}`,
        confidence: 0.5,
        risk: 'low' as const,
        estimatedSteps: 1,
        actions: [],
      }))

      const copilot = createCopilot({
        strategyGenerator: () => manyStrategies,
      })

      const plan = copilot.createPlan(makeFailure())
      expect(plan.strategies.length).toBeLessThanOrEqual(5) // default maxStrategies
    })
  })

  // -------------------------------------------------------------------------
  // executePlan
  // -------------------------------------------------------------------------

  describe('executePlan', () => {
    it('executes a plan successfully', async () => {
      const copilot = createCopilot()
      const plan = copilot.createPlan(makeFailure())
      const result = await copilot.executePlan(plan)

      expect(result.success).toBe(true)
      expect(result.plan.status).toBe('completed')
      expect(actionHandler).toHaveBeenCalled()
    })

    it('records failure in analyzer after execution', async () => {
      const copilot = createCopilot()
      const plan = copilot.createPlan(makeFailure())
      await copilot.executePlan(plan)

      const history = copilot.getAnalyzer().getHistory()
      expect(history.length).toBeGreaterThan(0)
    })

    it('marks strategy as attempted after execution', async () => {
      const copilot = createCopilot()
      const plan = copilot.createPlan(makeFailure())
      const strategyName = plan.selectedStrategy!.name

      await copilot.executePlan(plan)

      expect(copilot.getRanker().wasAttempted(strategyName)).toBe(true)
    })

    it('works in dry-run mode', async () => {
      const copilot = createCopilot({ dryRun: true })
      const plan = copilot.createPlan(makeFailure())
      const result = await copilot.executePlan(plan)

      expect(result.success).toBe(true)
      expect(result.summary).toContain('DRY RUN')
      expect(actionHandler).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // recover (one-shot)
  // -------------------------------------------------------------------------

  describe('recover', () => {
    it('creates and executes a plan in one call', async () => {
      const copilot = createCopilot()
      const result = await copilot.recover(makeFailure())

      expect(result.success).toBe(true)
      expect(result.plan.status).toBe('completed')
    })

    it('returns failure when max attempts exceeded', async () => {
      const copilot = createCopilot({ maxAttempts: 1 })
      const result = await copilot.recover(makeFailure({ previousAttempts: 1 }))

      expect(result.success).toBe(false)
      expect(result.summary).toContain('Max recovery attempts')
    })

    it('handles action failure gracefully', async () => {
      actionHandler.mockRejectedValue(new Error('Network error'))
      const copilot = createCopilot()
      const result = await copilot.recover(makeFailure())

      expect(result.success).toBe(false)
      expect(result.plan.status).toBe('failed')
    })
  })

  // -------------------------------------------------------------------------
  // handleStuckSignal
  // -------------------------------------------------------------------------

  describe('handleStuckSignal', () => {
    it('creates a plan when stuck signal is positive', () => {
      const copilot = createCopilot()
      const plan = copilot.handleStuckSignal(
        { stuck: true, reason: 'Tool "read_file" called 3 times with identical input' },
        'run-1',
        'node-x',
      )

      expect(plan).not.toBeNull()
      expect(plan!.failureContext.runId).toBe('run-1')
      expect(plan!.failureContext.nodeId).toBe('node-x')
      expect(plan!.failureContext.error).toContain('read_file')
    })

    it('returns null when stuck signal is negative', () => {
      const copilot = createCopilot()
      const plan = copilot.handleStuckSignal(
        { stuck: false },
        'run-1',
      )

      expect(plan).toBeNull()
    })

    it('counts previous attempts from same run', () => {
      const copilot = createCopilot({ maxAttempts: 2 })

      // First stuck signal
      copilot.handleStuckSignal(
        { stuck: true, reason: 'stuck 1' },
        'run-1',
      )

      // Second stuck signal — should detect this is attempt #2
      const plan = copilot.handleStuckSignal(
        { stuck: true, reason: 'stuck 2' },
        'run-1',
      )

      expect(plan).not.toBeNull()
      expect(plan!.failureContext.previousAttempts).toBe(1)
    })

    it('escalates after max stuck signals for a run', () => {
      const copilot = createCopilot({ maxAttempts: 2 })

      copilot.handleStuckSignal({ stuck: true, reason: 'stuck 1' }, 'run-1')
      copilot.handleStuckSignal({ stuck: true, reason: 'stuck 2' }, 'run-1')

      const plan = copilot.handleStuckSignal({ stuck: true, reason: 'stuck 3' }, 'run-1')
      expect(plan).not.toBeNull()
      expect(plan!.status).toBe('failed')
      expect(plan!.executionError).toContain('Max recovery attempts')
    })
  })

  // -------------------------------------------------------------------------
  // Plan management
  // -------------------------------------------------------------------------

  describe('plan management', () => {
    it('retrieves plans by ID', () => {
      const copilot = createCopilot()
      const plan = copilot.createPlan(makeFailure())

      const retrieved = copilot.getPlan(plan.id)
      expect(retrieved).toBe(plan)
    })

    it('retrieves plans by run ID', () => {
      const copilot = createCopilot()
      copilot.createPlan(makeFailure({ runId: 'run-A' }))
      copilot.createPlan(makeFailure({ runId: 'run-A' }))
      copilot.createPlan(makeFailure({ runId: 'run-B' }))

      const plansA = copilot.getPlansForRun('run-A')
      expect(plansA).toHaveLength(2)

      const plansB = copilot.getPlansForRun('run-B')
      expect(plansB).toHaveLength(1)
    })

    it('returns undefined for unknown plan ID', () => {
      const copilot = createCopilot()
      expect(copilot.getPlan('nonexistent')).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // reset
  // -------------------------------------------------------------------------

  describe('reset', () => {
    it('clears all internal state', () => {
      const copilot = createCopilot()
      copilot.createPlan(makeFailure())
      copilot.createPlan(makeFailure())

      copilot.reset()

      expect(copilot.getPlansForRun('run-1')).toHaveLength(0)
      expect(copilot.getAnalyzer().getHistory()).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------

  describe('event emission', () => {
    it('emits events when creating and executing plans', async () => {
      const events: Array<{ type: string }> = []
      eventBus.onAny((e) => events.push(e))

      const copilot = createCopilot()
      const result = await copilot.recover(makeFailure())

      expect(result.success).toBe(true)
      // Should have emitted plan creation event + execution events
      expect(events.length).toBeGreaterThan(0)
    })
  })
})

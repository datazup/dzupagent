import { describe, expect, it, vi } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import { RecoveryCopilot } from '../recovery/recovery-copilot.js'
import { RecoveryExecutor } from '../recovery/recovery-executor.js'
import { StrategyRanker } from '../recovery/strategy-ranker.js'
import type {
  FailureContext,
  FailureType,
  RecoveryCopilotConfig,
  RecoveryPlan,
  RecoveryStrategy,
} from '../recovery/recovery-types.js'
import { attemptRecovery } from '../pipeline/executor-internals/node-side-effects.js'
import type {
  PipelineRuntimeConfig,
  PipelineRuntimeEvent,
} from '../pipeline/pipeline-runtime-types.js'

function makeFailure(
  type: FailureType = 'build_failure',
  overrides: Partial<FailureContext> = {},
): FailureContext {
  const errors: Record<FailureType, string> = {
    build_failure: 'Build failed with TypeScript error',
    test_failure: 'Test failure: expected value to match',
    timeout: 'Operation timed out before completion',
    resource_exhaustion: 'Out of memory while executing the node',
    generation_failure: 'Generation failed with an invalid response',
  }
  return {
    type,
    error: errors[type],
    runId: `run-${type}`,
    nodeId: 'shared-node',
    timestamp: new Date('2026-08-18T11:00:00.000Z'),
    previousAttempts: 0,
    ...overrides,
  }
}

function automatedStrategy(
  name: string,
  confidence: number,
  risk: RecoveryStrategy['risk'] = 'low',
): RecoveryStrategy {
  return {
    name,
    description: `${name} recovery`,
    confidence,
    risk,
    estimatedSteps: 1,
    actions: [{ type: 'retry', params: {}, description: 'Retry automatically' }],
  }
}

function humanStrategy(name = 'custom_human_fallback'): RecoveryStrategy {
  return {
    name,
    description: 'Escalate to a human operator',
    confidence: 1,
    risk: 'low',
    estimatedSteps: 1,
    actions: [{
      type: 'human_escalation',
      params: {},
      description: 'Request human intervention',
    }],
  }
}

function executorConfig(
  overrides: Partial<RecoveryCopilotConfig> = {},
): RecoveryCopilotConfig {
  return {
    maxAttempts: 3,
    requireApprovalForHighRisk: true,
    dryRun: false,
    maxStrategies: 5,
    minAutoExecuteConfidence: 0.6,
    ...overrides,
  }
}

function planWith(strategy: RecoveryStrategy): RecoveryPlan {
  return {
    id: 'plan-direct-human',
    failureContext: makeFailure(),
    strategies: [strategy],
    selectedStrategy: strategy,
    status: 'approved',
    createdAt: new Date('2026-08-18T11:00:00.000Z'),
  }
}

describe('T2-5 recovery ranking and admission', () => {
  it('selects the error-aware automated build strategy instead of human escalation', () => {
    const copilot = new RecoveryCopilot({
      eventBus: createEventBus(),
      actionHandler: vi.fn().mockResolvedValue('done'),
    })

    const plan = copilot.createPlan(makeFailure())

    expect(plan.selectedStrategy?.name).toBe('retry_with_fix_prompt')
    expect(plan.selectedStrategy?.actions).not.toContainEqual(
      expect.objectContaining({ type: 'human_escalation' }),
    )
  })

  it('selects admitted non-human automation for every default failure type', () => {
    const types: FailureType[] = [
      'build_failure',
      'test_failure',
      'timeout',
      'resource_exhaustion',
      'generation_failure',
    ]

    for (const type of types) {
      const copilot = new RecoveryCopilot({
        eventBus: createEventBus(),
        actionHandler: vi.fn().mockResolvedValue('done'),
      })
      const selected = copilot.createPlan(makeFailure(type)).selectedStrategy

      expect(selected, type).not.toBeNull()
      expect(selected?.confidence, type).toBeGreaterThanOrEqual(0.6)
      expect(
        selected?.actions.some(action => action.type === 'human_escalation'),
        type,
      ).toBe(false)
    }
  })

  it('keeps human escalation visible as the terminal fallback after automation', () => {
    const copilot = new RecoveryCopilot({
      eventBus: createEventBus(),
      actionHandler: vi.fn().mockResolvedValue('done'),
      strategyGenerator: () => [humanStrategy(), automatedStrategy('safe_fix', 0.9)],
    })

    const plan = copilot.createPlan(makeFailure())

    expect(plan.selectedStrategy?.name).toBe('safe_fix')
    expect(plan.strategies.at(-1)?.actions).toContainEqual(
      expect.objectContaining({ type: 'human_escalation' }),
    )
  })

  it('returns null when every unattempted strategy is below the threshold', () => {
    const ranker = new StrategyRanker()

    expect(ranker.selectBest([
      automatedStrategy('low-a', 0.59),
      automatedStrategy('low-b', 0.2),
    ], 0.6)).toBeNull()
  })

  it('admits a strategy whose confidence exactly equals the threshold', () => {
    const ranker = new StrategyRanker()
    const boundary = automatedStrategy('boundary', 0.6)

    expect(ranker.selectBest([boundary], 0.6)).toBe(boundary)
  })

  it('terminalizes an all-below-threshold plan without executing an action', async () => {
    const actionHandler = vi.fn().mockResolvedValue('should not run')
    const copilot = new RecoveryCopilot({
      eventBus: createEventBus(),
      actionHandler,
      strategyGenerator: () => [automatedStrategy('low_only', 0.59)],
    })

    const result = await copilot.recover(makeFailure())

    expect(result.success).toBe(false)
    expect(result.plan.status).toBe('failed')
    expect(result.plan.selectedStrategy).toBeNull()
    expect(result.plan.executionError).toContain('minAutoExecuteConfidence')
    expect(result.summary).toContain('minAutoExecuteConfidence')
    expect(result.plan.strategies.at(-1)?.actions).toContainEqual(
      expect.objectContaining({ type: 'human_escalation' }),
    )
    expect(actionHandler).not.toHaveBeenCalled()
  })

  it('rejects direct human-escalation execution without reporting success', async () => {
    const actionHandler = vi.fn().mockResolvedValue('escalation delivered')
    const executor = new RecoveryExecutor({
      eventBus: createEventBus(),
      copilotConfig: executorConfig(),
      actionHandler,
    })

    const result = await executor.execute(planWith(humanStrategy()))

    expect(result.success).toBe(false)
    expect(result.plan.status).toBe('failed')
    expect(result.summary).toMatch(/human|escalat/i)
    expect(actionHandler).not.toHaveBeenCalled()
  })

  it('keeps direct human escalation unsuccessful in dry-run mode', async () => {
    const actionHandler = vi.fn()
    const executor = new RecoveryExecutor({
      eventBus: createEventBus(),
      copilotConfig: executorConfig({ dryRun: true }),
      actionHandler,
    })

    const result = await executor.execute(planWith(humanStrategy()))

    expect(result.success).toBe(false)
    expect(result.plan.status).toBe('failed')
    expect(result.summary).not.toContain('[DRY RUN] Would execute')
    expect(actionHandler).not.toHaveBeenCalled()
  })

  it('does not mark terminal escalation as attempted automation', async () => {
    const copilot = new RecoveryCopilot({
      eventBus: createEventBus(),
      actionHandler: vi.fn().mockResolvedValue('should not run'),
    })
    const terminal = humanStrategy('terminal-not-attempted')

    const result = await copilot.executePlan(planWith(terminal))

    expect(result.success).toBe(false)
    expect(copilot.getRanker().wasAttempted(terminal.name)).toBe(false)
  })

  it('treats mixed human and automated actions as terminal', () => {
    const mixed: RecoveryStrategy = {
      ...automatedStrategy('ambiguous_mixed', 0.99),
      actions: [
        { type: 'retry', params: {}, description: 'Retry automatically' },
        { type: 'human_escalation', params: {}, description: 'Escalate' },
      ],
    }
    const copilot = new RecoveryCopilot({
      eventBus: createEventBus(),
      actionHandler: vi.fn().mockResolvedValue('should not run'),
      strategyGenerator: () => [mixed],
    })

    const plan = copilot.createPlan(makeFailure())

    expect(plan.selectedStrategy).toBeNull()
    expect(plan.status).toBe('failed')
    expect(plan.strategies.at(-1)).toBe(mixed)
  })

  it('keeps max-attempt escalation terminal and action-free', async () => {
    const actionHandler = vi.fn().mockResolvedValue('should not run')
    const copilot = new RecoveryCopilot({
      eventBus: createEventBus(),
      actionHandler,
      config: { maxAttempts: 1 },
    })

    const result = await copilot.recover(makeFailure('build_failure', {
      previousAttempts: 1,
    }))

    expect(result.success).toBe(false)
    expect(result.plan.status).toBe('failed')
    expect(result.plan.selectedStrategy).toBeNull()
    expect(actionHandler).not.toHaveBeenCalled()
  })

  it('does not tell the pipeline to retry after terminal escalation', async () => {
    const actionHandler = vi.fn().mockResolvedValue('should not run')
    const copilot = new RecoveryCopilot({
      eventBus: createEventBus(),
      actionHandler,
      strategyGenerator: () => [
        automatedStrategy('low_only', 0.59),
        humanStrategy(),
      ],
    })
    const events: PipelineRuntimeEvent[] = []
    let attempts = 0
    const config = {
      definition: {},
      nodeExecutor: async (nodeId: string) => ({
        nodeId,
        output: null,
        durationMs: 0,
      }),
      recoveryCopilot: { copilot, maxRecoveryAttempts: 3 },
    } as unknown as PipelineRuntimeConfig

    const recovered = await attemptRecovery(
      config,
      event => events.push(event),
      {
        get: () => attempts,
        increment: () => ++attempts,
      },
      'shared-node',
      'agent',
      'generation failed',
      'run-pipeline-terminal',
    )

    expect(recovered).toBe(false)
    expect(events.some(event => event.type === 'pipeline:recovery_failed')).toBe(true)
    expect(events.some(event => event.type === 'pipeline:recovery_succeeded')).toBe(false)
    expect(actionHandler).not.toHaveBeenCalled()
  })

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid confidence threshold %s during construction',
    threshold => {
      expect(() => new RecoveryCopilot({
        eventBus: createEventBus(),
        actionHandler: vi.fn().mockResolvedValue('done'),
        config: { minAutoExecuteConfidence: threshold },
      })).toThrow(/minAutoExecuteConfidence.*between 0 and 1/i)
    },
  )
})

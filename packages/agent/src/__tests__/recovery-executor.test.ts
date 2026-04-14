import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createEventBus } from '@dzupagent/core'
import type { DzupEventBus } from '@dzupagent/core'
import { ApprovalGate } from '../approval/approval-gate.js'
import { RecoveryExecutor } from '../recovery/recovery-executor.js'
import type { RecoveryPlan, RecoveryCopilotConfig } from '../recovery/recovery-types.js'

function makeConfig(overrides: Partial<RecoveryCopilotConfig> = {}): RecoveryCopilotConfig {
  return {
    maxAttempts: 3,
    requireApprovalForHighRisk: true,
    dryRun: false,
    maxStrategies: 5,
    minAutoExecuteConfidence: 0.6,
    ...overrides,
  }
}

function makePlan(overrides: Partial<RecoveryPlan> = {}): RecoveryPlan {
  return {
    id: 'plan-1',
    failureContext: {
      type: 'build_failure',
      error: 'Build failed',
      runId: 'run-1',
      timestamp: new Date(),
      previousAttempts: 0,
    },
    strategies: [],
    selectedStrategy: {
      name: 'retry',
      description: 'Retry the build',
      confidence: 0.8,
      risk: 'low',
      estimatedSteps: 1,
      actions: [
        { type: 'retry', params: {}, description: 'Retry the build' },
      ],
    },
    status: 'approved',
    createdAt: new Date(),
    ...overrides,
  }
}

describe('RecoveryExecutor', () => {
  let eventBus: DzupEventBus

  beforeEach(() => {
    eventBus = createEventBus()
  })

  // -------------------------------------------------------------------------
  // Basic execution
  // -------------------------------------------------------------------------

  it('executes a plan with a single action successfully', async () => {
    const actionHandler = vi.fn().mockResolvedValue('Action completed')

    const executor = new RecoveryExecutor({
      eventBus,
      copilotConfig: makeConfig(),
      actionHandler,
    })

    const plan = makePlan()
    const result = await executor.execute(plan)

    expect(result.success).toBe(true)
    expect(result.plan.status).toBe('completed')
    expect(result.plan.completedAt).toBeInstanceOf(Date)
    expect(actionHandler).toHaveBeenCalledOnce()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('executes multiple actions sequentially', async () => {
    const callOrder: number[] = []
    const actionHandler = vi.fn().mockImplementation(async (_action, _plan) => {
      callOrder.push(callOrder.length)
      return `Action ${callOrder.length} completed`
    })

    const executor = new RecoveryExecutor({
      eventBus,
      copilotConfig: makeConfig(),
      actionHandler,
    })

    const plan = makePlan({
      selectedStrategy: {
        name: 'multi_step',
        description: 'Multi-step recovery',
        confidence: 0.7,
        risk: 'low',
        estimatedSteps: 3,
        actions: [
          { type: 'modify_params', params: {}, description: 'Step 1' },
          { type: 'retry', params: {}, description: 'Step 2' },
          { type: 'retry', params: {}, description: 'Step 3' },
        ],
      },
    })

    const result = await executor.execute(plan)

    expect(result.success).toBe(true)
    expect(actionHandler).toHaveBeenCalledTimes(3)
    expect(callOrder).toEqual([0, 1, 2])
  })

  // -------------------------------------------------------------------------
  // Failure handling
  // -------------------------------------------------------------------------

  it('fails if no strategy is selected', async () => {
    const executor = new RecoveryExecutor({
      eventBus,
      copilotConfig: makeConfig(),
      actionHandler: vi.fn(),
    })

    const plan = makePlan({ selectedStrategy: null })
    const result = await executor.execute(plan)

    expect(result.success).toBe(false)
    expect(result.plan.status).toBe('failed')
    expect(result.summary).toContain('No recovery strategy')
  })

  it('fails when an action throws', async () => {
    const actionHandler = vi.fn().mockRejectedValue(new Error('Action exploded'))

    const executor = new RecoveryExecutor({
      eventBus,
      copilotConfig: makeConfig(),
      actionHandler,
    })

    const plan = makePlan()
    const result = await executor.execute(plan)

    expect(result.success).toBe(false)
    expect(result.plan.status).toBe('failed')
    expect(result.plan.executionError).toContain('Action exploded')
    expect(result.summary).toContain('Action exploded')
  })

  it('stops at first failing action in a multi-step plan', async () => {
    let callCount = 0
    const actionHandler = vi.fn().mockImplementation(async () => {
      callCount++
      if (callCount === 2) throw new Error('Step 2 failed')
      return 'ok'
    })

    const executor = new RecoveryExecutor({
      eventBus,
      copilotConfig: makeConfig(),
      actionHandler,
    })

    const plan = makePlan({
      selectedStrategy: {
        name: 'multi',
        description: 'Multi',
        confidence: 0.7,
        risk: 'low',
        estimatedSteps: 3,
        actions: [
          { type: 'retry', params: {}, description: 'Step 1' },
          { type: 'retry', params: {}, description: 'Step 2' },
          { type: 'retry', params: {}, description: 'Step 3' },
        ],
      },
    })

    const result = await executor.execute(plan)

    expect(result.success).toBe(false)
    expect(actionHandler).toHaveBeenCalledTimes(2) // stopped after step 2
  })

  // -------------------------------------------------------------------------
  // Dry-run mode
  // -------------------------------------------------------------------------

  it('does not execute actions in dry-run mode', async () => {
    const actionHandler = vi.fn()

    const executor = new RecoveryExecutor({
      eventBus,
      copilotConfig: makeConfig({ dryRun: true }),
      actionHandler,
    })

    const plan = makePlan()
    const result = await executor.execute(plan)

    expect(result.success).toBe(true)
    expect(result.summary).toContain('DRY RUN')
    expect(actionHandler).not.toHaveBeenCalled()
    expect(result.plan.status).toBe('completed')
  })

  // -------------------------------------------------------------------------
  // Approval gate integration
  // -------------------------------------------------------------------------

  it('requests approval for high-risk strategies', async () => {
    const gate = new ApprovalGate({ mode: 'required', timeoutMs: 100 }, eventBus)
    const actionHandler = vi.fn().mockResolvedValue('ok')

    const executor = new RecoveryExecutor({
      eventBus,
      approvalGate: gate,
      copilotConfig: makeConfig({ requireApprovalForHighRisk: true }),
      actionHandler,
    })

    const plan = makePlan({
      selectedStrategy: {
        name: 'risky',
        description: 'A risky strategy',
        confidence: 0.5,
        risk: 'high',
        estimatedSteps: 1,
        actions: [{ type: 'rollback', params: {}, description: 'Rollback' }],
      },
    })

    // Approve immediately
    setTimeout(() => {
      eventBus.emit({ type: 'approval:granted', runId: 'run-1' })
    }, 10)

    const result = await executor.execute(plan)

    expect(result.success).toBe(true)
    expect(actionHandler).toHaveBeenCalledOnce()
  })

  it('skips plan when high-risk approval is rejected', async () => {
    const gate = new ApprovalGate({ mode: 'required', timeoutMs: 100 }, eventBus)
    const actionHandler = vi.fn()

    const executor = new RecoveryExecutor({
      eventBus,
      approvalGate: gate,
      copilotConfig: makeConfig({ requireApprovalForHighRisk: true }),
      actionHandler,
    })

    const plan = makePlan({
      selectedStrategy: {
        name: 'risky',
        description: 'A risky strategy',
        confidence: 0.5,
        risk: 'high',
        estimatedSteps: 1,
        actions: [{ type: 'rollback', params: {}, description: 'Rollback' }],
      },
    })

    // Reject
    setTimeout(() => {
      eventBus.emit({ type: 'approval:rejected', runId: 'run-1', reason: 'too risky' })
    }, 10)

    const result = await executor.execute(plan)

    expect(result.success).toBe(false)
    expect(result.plan.status).toBe('skipped')
    expect(actionHandler).not.toHaveBeenCalled()
  })

  it('skips approval for low/medium risk strategies', async () => {
    const gate = new ApprovalGate({ mode: 'required', timeoutMs: 50 }, eventBus)
    const actionHandler = vi.fn().mockResolvedValue('ok')

    const executor = new RecoveryExecutor({
      eventBus,
      approvalGate: gate,
      copilotConfig: makeConfig({ requireApprovalForHighRisk: true }),
      actionHandler,
    })

    const plan = makePlan() // default is low risk
    const result = await executor.execute(plan)

    expect(result.success).toBe(true)
    // Should NOT have waited for approval
    expect(actionHandler).toHaveBeenCalledOnce()
  })

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------

  it('emits events during execution', async () => {
    const events: Array<{ type: string }> = []
    eventBus.onAny((e) => events.push(e))

    const executor = new RecoveryExecutor({
      eventBus,
      copilotConfig: makeConfig(),
      actionHandler: vi.fn().mockResolvedValue('ok'),
    })

    const plan = makePlan()
    await executor.execute(plan)

    // Should have emitted multiple events (execution_started, action events, execution_completed)
    expect(events.length).toBeGreaterThan(0)
    const reasons = events
      .filter(e => e.type === 'agent:stuck_detected')
      .map(e => (e as { reason: string }).reason)

    expect(reasons.some(r => r.includes('execution_started'))).toBe(true)
    expect(reasons.some(r => r.includes('execution_completed'))).toBe(true)
  })
})

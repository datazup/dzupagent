/**
 * Recovery executor — executes an approved recovery plan by running
 * its actions sequentially, integrating with approval gates for
 * high-risk strategies and emitting lifecycle events.
 *
 * @module recovery/recovery-executor
 */

import type { DzipEventBus } from '@dzipagent/core'
import type { ApprovalGate } from '../approval/approval-gate.js'
import type {
  RecoveryPlan,
  RecoveryAction,
  RecoveryResult,
  RecoveryCopilotConfig,
} from './recovery-types.js'

// ---------------------------------------------------------------------------
// Action handler
// ---------------------------------------------------------------------------

/**
 * User-supplied function that executes a single RecoveryAction.
 * Returns a result summary string (or throws on failure).
 */
export type ActionHandler = (
  action: RecoveryAction,
  plan: RecoveryPlan,
) => Promise<string>

// ---------------------------------------------------------------------------
// Recovery executor config
// ---------------------------------------------------------------------------

export interface RecoveryExecutorConfig {
  /** The event bus for emitting lifecycle events. */
  eventBus: DzipEventBus
  /** Optional approval gate for high-risk strategies. */
  approvalGate?: ApprovalGate
  /** Copilot config for thresholds and flags. */
  copilotConfig: RecoveryCopilotConfig
  /** Handler that knows how to execute each action type. */
  actionHandler: ActionHandler
}

// ---------------------------------------------------------------------------
// RecoveryExecutor
// ---------------------------------------------------------------------------

export class RecoveryExecutor {
  private readonly config: RecoveryExecutorConfig

  constructor(config: RecoveryExecutorConfig) {
    this.config = config
  }

  /**
   * Execute a recovery plan. Runs actions sequentially and
   * updates the plan status as it progresses.
   *
   * In dry-run mode, actions are validated but not executed.
   */
  async execute(plan: RecoveryPlan): Promise<RecoveryResult> {
    const startTime = Date.now()

    if (!plan.selectedStrategy) {
      plan.status = 'failed'
      plan.executionError = 'No strategy selected'
      return {
        plan,
        success: false,
        summary: 'No recovery strategy was selected',
        durationMs: Date.now() - startTime,
      }
    }

    const strategy = plan.selectedStrategy

    // --- Approval gate for high-risk strategies ---
    if (
      strategy.risk === 'high' &&
      this.config.copilotConfig.requireApprovalForHighRisk &&
      this.config.approvalGate
    ) {
      this.emitEvent(plan, 'recovery:approval_requested')

      const approvalResult = await this.config.approvalGate.waitForApproval(
        plan.failureContext.runId,
        {
          type: 'recovery_plan',
          planId: plan.id,
          strategy: strategy.name,
          risk: strategy.risk,
          actions: strategy.actions.map(a => a.description),
        },
      )

      if (approvalResult !== 'approved') {
        plan.status = 'skipped'
        this.emitEvent(plan, 'recovery:approval_denied')
        return {
          plan,
          success: false,
          summary: `Recovery plan rejected: approval result was "${approvalResult}"`,
          durationMs: Date.now() - startTime,
        }
      }

      this.emitEvent(plan, 'recovery:approval_granted')
    }

    // --- Dry-run: validate but don't execute ---
    if (this.config.copilotConfig.dryRun) {
      plan.status = 'completed'
      plan.completedAt = new Date()
      this.emitEvent(plan, 'recovery:dry_run_completed')
      return {
        plan,
        success: true,
        summary: `[DRY RUN] Would execute ${strategy.actions.length} actions via strategy "${strategy.name}"`,
        durationMs: Date.now() - startTime,
      }
    }

    // --- Execute actions ---
    plan.status = 'executing'
    this.emitEvent(plan, 'recovery:execution_started')

    const actionResults: string[] = []

    for (let i = 0; i < strategy.actions.length; i++) {
      const action = strategy.actions[i]!
      this.emitActionEvent(plan, action, i, 'started')

      try {
        const result = await this.config.actionHandler(action, plan)
        actionResults.push(result)
        this.emitActionEvent(plan, action, i, 'completed')
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        plan.status = 'failed'
        plan.executionError = `Action ${i} (${action.type}) failed: ${errorMessage}`
        plan.completedAt = new Date()

        this.emitActionEvent(plan, action, i, 'failed')
        this.emitEvent(plan, 'recovery:execution_failed')

        return {
          plan,
          success: false,
          summary: `Recovery failed at action ${i + 1}/${strategy.actions.length} (${action.type}): ${errorMessage}`,
          durationMs: Date.now() - startTime,
        }
      }
    }

    // --- Success ---
    plan.status = 'completed'
    plan.completedAt = new Date()
    this.emitEvent(plan, 'recovery:execution_completed')

    return {
      plan,
      success: true,
      summary: `Recovery succeeded via strategy "${strategy.name}" (${strategy.actions.length} actions)`,
      durationMs: Date.now() - startTime,
    }
  }

  // ---------------------------------------------------------------------------
  // Event helpers
  // ---------------------------------------------------------------------------

  private emitEvent(plan: RecoveryPlan, eventSuffix: string): void {
    this.config.eventBus.emit({
      type: 'agent:stuck_detected',
      agentId: plan.failureContext.runId,
      reason: `${eventSuffix}: plan=${plan.id}, strategy=${plan.selectedStrategy?.name ?? 'none'}`,
      recovery: eventSuffix,
      timestamp: Date.now(),
    })
  }

  private emitActionEvent(
    plan: RecoveryPlan,
    action: RecoveryAction,
    index: number,
    status: 'started' | 'completed' | 'failed',
  ): void {
    this.config.eventBus.emit({
      type: 'agent:stuck_detected',
      agentId: plan.failureContext.runId,
      reason: `recovery:action_${status}: action=${action.type} (${index + 1}/${plan.selectedStrategy?.actions.length ?? 0})`,
      recovery: `action_${status}`,
      timestamp: Date.now(),
    })
  }
}

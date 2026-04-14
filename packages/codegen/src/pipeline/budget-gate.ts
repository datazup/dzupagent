/**
 * Budget gate for pipeline execution.
 *
 * Checks remaining budget via the ExecutionLedger before each pipeline phase.
 * If the budget is exceeded, the phase is skipped with a budget error.
 */

export interface BudgetGateConfig {
  /** Function to check budget. Returns { withinBudget, usedCents, remainingCents } */
  checkBudget: (
    workflowRunId: string,
    budgetLimitCents: number,
  ) => Promise<{ withinBudget: boolean; usedCents: number; remainingCents: number }>
  /** Workflow run ID to check budget for */
  workflowRunId: string
  /** Budget limit in cents */
  budgetLimitCents: number
}

export interface BudgetGateResult {
  passed: boolean
  usedCents: number
  remainingCents: number
}

/**
 * Run the budget gate check. Returns whether the pipeline should proceed.
 */
export async function runBudgetGate(config: BudgetGateConfig): Promise<BudgetGateResult> {
  const result = await config.checkBudget(config.workflowRunId, config.budgetLimitCents)
  return {
    passed: result.withinBudget,
    usedCents: result.usedCents,
    remainingCents: result.remainingCents,
  }
}

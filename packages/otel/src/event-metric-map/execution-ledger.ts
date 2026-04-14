import { asEvent, counter, histogram } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const executionLedgerMetricMap = {
  'ledger:execution_recorded': [
    counter(
      'dzip_ledger_executions_recorded_total',
      'Total execution runs recorded in the ledger',
      ['provider_id'],
      (e) => {
        const ev = asEvent<'ledger:execution_recorded'>(e)
        return { value: 1, labels: { provider_id: ev.providerId } }
      },
    ),
  ],

  'ledger:prompt_recorded': [
    counter(
      'dzip_ledger_prompts_recorded_total',
      'Total prompt records saved to the ledger',
      ['execution_run_id'],
      (e) => {
        const ev = asEvent<'ledger:prompt_recorded'>(e)
        return { value: 1, labels: { execution_run_id: ev.executionRunId } }
      },
    ),
  ],

  'ledger:tool_recorded': [
    counter(
      'dzip_ledger_tool_invocations_recorded_total',
      'Total tool invocations recorded in the ledger',
      ['tool_name'],
      (e) => {
        const ev = asEvent<'ledger:tool_recorded'>(e)
        return { value: 1, labels: { tool_name: ev.toolName } }
      },
    ),
  ],

  'ledger:cost_recorded': [
    counter(
      'dzip_ledger_cost_entries_recorded_total',
      'Total cost entries recorded in the ledger',
      [],
      () => ({ value: 1, labels: {} }),
    ),
    histogram(
      'dzip_ledger_cost_cents',
      'Cost in cents per recorded cost entry',
      [],
      (e) => {
        const ev = asEvent<'ledger:cost_recorded'>(e)
        return { value: ev.costCents, labels: {} }
      },
    ),
  ],

  'ledger:artifact_recorded': [
    counter(
      'dzip_ledger_artifacts_recorded_total',
      'Total artifacts recorded in the ledger',
      ['artifact_type'],
      (e) => {
        const ev = asEvent<'ledger:artifact_recorded'>(e)
        return { value: 1, labels: { artifact_type: ev.artifactType } }
      },
    ),
  ],

  'ledger:budget_warning': [
    counter(
      'dzip_ledger_budget_warnings_total',
      'Total budget warning events from the ledger',
      ['workflow_run_id'],
      (e) => {
        const ev = asEvent<'ledger:budget_warning'>(e)
        return { value: 1, labels: { workflow_run_id: ev.workflowRunId } }
      },
    ),
    histogram(
      'dzip_ledger_budget_used_cents',
      'Budget used in cents at the time of a warning event',
      ['workflow_run_id'],
      (e) => {
        const ev = asEvent<'ledger:budget_warning'>(e)
        return { value: ev.usedCents, labels: { workflow_run_id: ev.workflowRunId } }
      },
    ),
    histogram(
      'dzip_ledger_budget_utilization_ratio',
      'Ratio of used budget to limit (0–1+) at the time of a warning event',
      ['workflow_run_id'],
      (e) => {
        const ev = asEvent<'ledger:budget_warning'>(e)
        const ratio = ev.limitCents > 0 ? ev.usedCents / ev.limitCents : 0
        return { value: ratio, labels: { workflow_run_id: ev.workflowRunId } }
      },
    ),
  ],

  'ledger:budget_exceeded': [
    counter(
      'dzip_ledger_budget_exceeded_total',
      'Total budget exceeded events from the ledger',
      ['workflow_run_id'],
      (e) => {
        const ev = asEvent<'ledger:budget_exceeded'>(e)
        return { value: 1, labels: { workflow_run_id: ev.workflowRunId } }
      },
    ),
    histogram(
      'dzip_ledger_budget_overage_cents',
      'Amount in cents by which the budget was exceeded',
      ['workflow_run_id'],
      (e) => {
        const ev = asEvent<'ledger:budget_exceeded'>(e)
        const overage = Math.max(0, ev.usedCents - ev.limitCents)
        return { value: overage, labels: { workflow_run_id: ev.workflowRunId } }
      },
    ),
  ],
} satisfies MetricMapFragment

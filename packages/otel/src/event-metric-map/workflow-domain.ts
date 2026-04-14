import { asEvent, counter, histogram } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const workflowDomainMetricMap = {
  // --- Workflow lifecycle ---
  'workflow:brief_created': [
    {
      metricName: 'dzip_workflow_briefs_total',
      type: 'counter',
      description: 'Total feature briefs created',
      labelKeys: [],
      extract: () => ({ value: 1, labels: {} }),
    },
  ],

  'workflow:spec_created': [
    {
      metricName: 'dzip_workflow_specs_total',
      type: 'counter',
      description: 'Total feature specs created',
      labelKeys: [],
      extract: () => ({ value: 1, labels: {} }),
    },
  ],

  'workflow:spec_revised': [],

  'workflow:template_created': [
    {
      metricName: 'dzip_workflow_templates_total',
      type: 'counter',
      description: 'Total workflow templates created',
      labelKeys: ['mode'],
      extract: (e) => {
        const ev = asEvent<'workflow:template_created'>(e)
        return { value: 1, labels: { mode: ev.mode } }
      },
    },
  ],

  'workflow:run_started': [
    {
      metricName: 'dzip_workflow_runs_started_total',
      type: 'counter',
      description: 'Total workflow runs started',
      labelKeys: [],
      extract: () => ({ value: 1, labels: {} }),
    },
  ],

  'workflow:run_status_changed': [
    {
      metricName: 'dzip_workflow_run_status_changes_total',
      type: 'counter',
      description: 'Total workflow run status changes',
      labelKeys: ['new_status'],
      extract: (e) => {
        const ev = asEvent<'workflow:run_status_changed'>(e)
        return { value: 1, labels: { new_status: ev.newStatus } }
      },
    },
  ],

  'workflow:phase_entered': [
    {
      metricName: 'dzip_workflow_phase_entries_total',
      type: 'counter',
      description: 'Total workflow phase entries',
      labelKeys: [],
      extract: () => ({ value: 1, labels: {} }),
    },
  ],

  'workflow:run_completed': [
    {
      metricName: 'dzip_workflow_runs_completed_total',
      type: 'counter',
      description: 'Total workflow runs completed',
      labelKeys: [],
      extract: () => ({ value: 1, labels: {} }),
    },
    {
      metricName: 'dzip_workflow_run_duration_ms',
      type: 'histogram',
      description: 'Workflow run duration in milliseconds',
      labelKeys: [],
      extract: (e) => {
        const ev = asEvent<'workflow:run_completed'>(e)
        return { value: ev.durationMs, labels: {} }
      },
    },
  ],

  'workflow:run_failed': [
    {
      metricName: 'dzip_workflow_runs_failed_total',
      type: 'counter',
      description: 'Total workflow runs failed',
      labelKeys: [],
      extract: () => ({ value: 1, labels: {} }),
    },
  ],

  // --- Task lifecycle ---
  'workflow:task_created': [
    {
      metricName: 'dzip_workflow_tasks_created_total',
      type: 'counter',
      description: 'Total workflow tasks created',
      labelKeys: [],
      extract: () => ({ value: 1, labels: {} }),
    },
  ],

  'workflow:task_assigned': [
    {
      metricName: 'dzip_workflow_tasks_assigned_total',
      type: 'counter',
      description: 'Total workflow tasks assigned',
      labelKeys: [],
      extract: () => ({ value: 1, labels: {} }),
    },
  ],

  'workflow:task_status_changed': [
    {
      metricName: 'dzip_workflow_task_status_changes_total',
      type: 'counter',
      description: 'Total workflow task status changes',
      labelKeys: ['new_status'],
      extract: (e) => {
        const ev = asEvent<'workflow:task_status_changed'>(e)
        return { value: 1, labels: { new_status: ev.newStatus } }
      },
    },
  ],

  'workflow:task_completed': [
    {
      metricName: 'dzip_workflow_tasks_completed_total',
      type: 'counter',
      description: 'Total workflow tasks completed',
      labelKeys: [],
      extract: () => ({ value: 1, labels: {} }),
    },
    {
      metricName: 'dzip_workflow_task_duration_ms',
      type: 'histogram',
      description: 'Workflow task duration in milliseconds',
      labelKeys: [],
      extract: (e) => {
        const ev = asEvent<'workflow:task_completed'>(e)
        return { value: ev.durationMs, labels: {} }
      },
    },
  ],

  // --- Execution tracking ---
  'workflow:execution_started': [
    {
      metricName: 'dzip_workflow_executions_started_total',
      type: 'counter',
      description: 'Total workflow executions started',
      labelKeys: ['provider_id'],
      extract: (e) => {
        const ev = asEvent<'workflow:execution_started'>(e)
        return { value: 1, labels: { provider_id: ev.providerId } }
      },
    },
  ],

  'workflow:execution_completed': [
    {
      metricName: 'dzip_workflow_executions_completed_total',
      type: 'counter',
      description: 'Total workflow executions completed',
      labelKeys: [],
      extract: () => ({ value: 1, labels: {} }),
    },
    {
      metricName: 'dzip_workflow_execution_duration_ms',
      type: 'histogram',
      description: 'Workflow execution duration in milliseconds',
      labelKeys: [],
      extract: (e) => {
        const ev = asEvent<'workflow:execution_completed'>(e)
        return { value: ev.durationMs, labels: {} }
      },
    },
  ],

  'workflow:execution_failed': [
    {
      metricName: 'dzip_workflow_executions_failed_total',
      type: 'counter',
      description: 'Total workflow executions failed',
      labelKeys: [],
      extract: () => ({ value: 1, labels: {} }),
    },
  ],

  // --- Audit & cost ---
  'workflow:prompt_recorded': [
    counter(
      'dzip_workflow_prompts_recorded_total',
      'Total workflow prompt records',
      ['prompt_type'],
      (e) => {
        const ev = asEvent<'workflow:prompt_recorded'>(e)
        return { value: 1, labels: { prompt_type: ev.promptType } }
      },
    ),
  ],

  'workflow:cost_recorded': [
    counter(
      'dzip_workflow_cost_entries_total',
      'Total workflow cost entries recorded',
      ['budget_bucket'],
      (e) => {
        const ev = asEvent<'workflow:cost_recorded'>(e)
        return { value: 1, labels: { budget_bucket: ev.budgetBucket } }
      },
    ),
    histogram(
      'dzip_workflow_cost_cents',
      'Cost in cents per workflow cost entry',
      ['budget_bucket'],
      (e) => {
        const ev = asEvent<'workflow:cost_recorded'>(e)
        return { value: ev.costCents, labels: { budget_bucket: ev.budgetBucket } }
      },
    ),
  ],

  'workflow:cost_budget_warning': [
    {
      metricName: 'dzip_workflow_budget_warnings_total',
      type: 'counter',
      description: 'Total workflow budget warnings',
      labelKeys: [],
      extract: () => ({ value: 1, labels: {} }),
    },
  ],

  'workflow:cost_budget_exceeded': [
    {
      metricName: 'dzip_workflow_budget_exceeded_total',
      type: 'counter',
      description: 'Total workflow budget exceeded events',
      labelKeys: [],
      extract: () => ({ value: 1, labels: {} }),
    },
  ],

  // --- Artifacts, suggestions, schedules ---
  'workflow:artifact_saved': [
    counter(
      'dzip_workflow_artifacts_saved_total',
      'Total workflow artifacts saved',
      ['artifact_type'],
      (e) => {
        const ev = asEvent<'workflow:artifact_saved'>(e)
        return { value: 1, labels: { artifact_type: ev.artifactType } }
      },
    ),
  ],

  'workflow:suggestion_created': [
    counter(
      'dzip_workflow_suggestions_created_total',
      'Total workflow suggestions created',
      ['category'],
      (e) => {
        const ev = asEvent<'workflow:suggestion_created'>(e)
        return { value: 1, labels: { category: ev.category } }
      },
    ),
  ],

  'workflow:schedule_triggered': [
    counter(
      'dzip_workflow_schedule_triggers_total',
      'Total workflow schedule trigger events',
      ['schedule_id'],
      (e) => {
        const ev = asEvent<'workflow:schedule_triggered'>(e)
        return { value: 1, labels: { schedule_id: ev.scheduleId } }
      },
    ),
  ],
} satisfies MetricMapFragment

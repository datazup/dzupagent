/**
 * Additional tests covering uncovered extract functions in event-metric-map fragments.
 *
 * Targets:
 * - agent-lifecycle: run:paused, run:resumed, run:cancelled
 * - platform-identity: mcp:server_added extract
 * - supervisor: routing_decision, merge_complete
 * - scheduler: all scheduler events
 * - execution-ledger: budget_warning histograms, budget_exceeded histogram
 * - workflow-domain: all workflow events with extract functions
 * - empty-events: mail:received
 * - approval: human_contact events
 */

import { describe, it, expect } from 'vitest'
import { agentLifecycleMetricMap } from '../event-metric-map/agent-lifecycle.js'
import { platformIdentityMetricMap } from '../event-metric-map/platform-identity.js'
import { supervisorMetricMap } from '../event-metric-map/supervisor.js'
import { schedulerMetricMap } from '../event-metric-map/scheduler.js'
import { executionLedgerMetricMap } from '../event-metric-map/execution-ledger.js'
import { workflowDomainMetricMap } from '../event-metric-map/workflow-domain.js'
import { emptyEventMetricMap } from '../event-metric-map/empty-events.js'
import { approvalMetricMap } from '../event-metric-map/approval.js'
import type { DzupEvent } from '@dzupagent/core'

function extractAll(
  mappings: { extract: (e: DzupEvent) => { value: number; labels: Record<string, string> } }[],
  event: DzupEvent,
) {
  return mappings.map((m) => m.extract(event))
}

// ------------------------------------------------------------------ agent-lifecycle

describe('agent-lifecycle: run lifecycle events', () => {
  it('run:paused produces counter with agent_id', () => {
    const mappings = agentLifecycleMetricMap['run:paused']
    expect(mappings).toHaveLength(1)
    const result = mappings[0]!.extract({
      type: 'run:paused',
      agentId: 'planner',
      runId: 'r1',
      reason: 'user',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.agent_id).toBe('planner')
    expect(mappings[0]!.metricName).toBe('dzip_run_paused_total')
  })

  it('run:resumed produces counter with agent_id', () => {
    const mappings = agentLifecycleMetricMap['run:resumed']
    expect(mappings).toHaveLength(1)
    const result = mappings[0]!.extract({
      type: 'run:resumed',
      agentId: 'coder',
      runId: 'r2',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.agent_id).toBe('coder')
    expect(mappings[0]!.metricName).toBe('dzip_run_resumed_total')
  })

  it('run:cancelled produces counter with agent_id', () => {
    const mappings = agentLifecycleMetricMap['run:cancelled']
    expect(mappings).toHaveLength(1)
    const result = mappings[0]!.extract({
      type: 'run:cancelled',
      agentId: 'reviewer',
      runId: 'r3',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.agent_id).toBe('reviewer')
    expect(mappings[0]!.metricName).toBe('dzip_run_cancelled_total')
  })
})

// ------------------------------------------------------------------ platform-identity

describe('platform-identity: mcp:server_added extract', () => {
  it('mcp:server_added produces counter with transport label', () => {
    const mappings = platformIdentityMetricMap['mcp:server_added']
    expect(mappings).toHaveLength(1)
    const result = mappings[0]!.extract({
      type: 'mcp:server_added',
      serverName: 'my-server',
      transport: 'stdio',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.operation).toBe('added')
    expect(result.labels.transport).toBe('stdio')
  })
})

// ------------------------------------------------------------------ supervisor

describe('supervisor: routing_decision and merge_complete', () => {
  it('supervisor:routing_decision labels by strategy', () => {
    const mappings = supervisorMetricMap['supervisor:routing_decision']
    expect(mappings).toHaveLength(1)
    const result = mappings[0]!.extract({
      type: 'supervisor:routing_decision',
      strategy: 'round_robin',
      selectedAgentId: 'agent-1',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.strategy).toBe('round_robin')
    expect(mappings[0]!.metricName).toBe('dzip_supervisor_routing_decisions_total')
  })

  it('supervisor:merge_complete labels by merge_status', () => {
    const mappings = supervisorMetricMap['supervisor:merge_complete']
    expect(mappings).toHaveLength(1)
    const result = mappings[0]!.extract({
      type: 'supervisor:merge_complete',
      mergeStatus: 'success',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.merge_status).toBe('success')
    expect(mappings[0]!.metricName).toBe('dzip_supervisor_merge_completions_total')
  })

  it('supervisor:circuit_breaker_filtered produces counter with empty labels', () => {
    const mappings = supervisorMetricMap['supervisor:circuit_breaker_filtered']
    expect(mappings).toHaveLength(1)
    const result = mappings[0]!.extract({
      type: 'supervisor:circuit_breaker_filtered',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels).toEqual({})
  })
})

// ------------------------------------------------------------------ scheduler

describe('scheduler: all scheduler events extract functions', () => {
  it('scheduler:started labels by poll_interval_ms', () => {
    const mappings = schedulerMetricMap['scheduler:started']
    const result = mappings[0]!.extract({
      type: 'scheduler:started',
      pollIntervalMs: 5000,
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.poll_interval_ms).toBe('5000')
  })

  it('scheduler:stopped produces counter with empty labels', () => {
    const mappings = schedulerMetricMap['scheduler:stopped']
    const result = mappings[0]!.extract({
      type: 'scheduler:stopped',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels).toEqual({})
  })

  it('scheduler:triggered labels by schedule_id', () => {
    const mappings = schedulerMetricMap['scheduler:triggered']
    const result = mappings[0]!.extract({
      type: 'scheduler:triggered',
      scheduleId: 'sched-1',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.schedule_id).toBe('sched-1')
  })

  it('scheduler:trigger_failed labels by schedule_id', () => {
    const mappings = schedulerMetricMap['scheduler:trigger_failed']
    const result = mappings[0]!.extract({
      type: 'scheduler:trigger_failed',
      scheduleId: 'sched-2',
      error: 'timeout',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.schedule_id).toBe('sched-2')
  })

  it('scheduler:schedule_created labels by schedule_type', () => {
    const mappings = schedulerMetricMap['scheduler:schedule_created']
    const result = mappings[0]!.extract({
      type: 'scheduler:schedule_created',
      scheduleId: 'sched-3',
      scheduleType: 'cron',
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.schedule_type).toBe('cron')
  })

  it('scheduler:schedule_enabled produces counter', () => {
    const mappings = schedulerMetricMap['scheduler:schedule_enabled']
    const result = mappings[0]!.extract({
      type: 'scheduler:schedule_enabled',
      scheduleId: 'sched-4',
    } as DzupEvent)
    expect(result.value).toBe(1)
  })

  it('scheduler:schedule_disabled produces counter', () => {
    const mappings = schedulerMetricMap['scheduler:schedule_disabled']
    const result = mappings[0]!.extract({
      type: 'scheduler:schedule_disabled',
      scheduleId: 'sched-5',
    } as DzupEvent)
    expect(result.value).toBe(1)
  })
})

// ------------------------------------------------------------------ execution-ledger

describe('execution-ledger: budget warning and exceeded histograms', () => {
  it('ledger:budget_warning histogram records usedCents', () => {
    const mappings = executionLedgerMetricMap['ledger:budget_warning']
    expect(mappings).toHaveLength(3)

    // Second mapping: histogram of used cents
    const histResult = mappings[1]!.extract({
      type: 'ledger:budget_warning',
      workflowRunId: 'wf-1',
      usedCents: 80,
      limitCents: 100,
      threshold: 0.8,
    } as DzupEvent)
    expect(histResult.value).toBe(80)
    expect(histResult.labels.workflow_run_id).toBe('wf-1')
  })

  it('ledger:budget_warning histogram records utilization ratio', () => {
    const mappings = executionLedgerMetricMap['ledger:budget_warning']

    // Third mapping: budget utilization ratio
    const ratioResult = mappings[2]!.extract({
      type: 'ledger:budget_warning',
      workflowRunId: 'wf-2',
      usedCents: 90,
      limitCents: 100,
      threshold: 0.8,
    } as DzupEvent)
    expect(ratioResult.value).toBeCloseTo(0.9)
    expect(ratioResult.labels.workflow_run_id).toBe('wf-2')
  })

  it('ledger:budget_warning ratio is 0 when limitCents is 0', () => {
    const mappings = executionLedgerMetricMap['ledger:budget_warning']
    const ratioResult = mappings[2]!.extract({
      type: 'ledger:budget_warning',
      workflowRunId: 'wf-3',
      usedCents: 50,
      limitCents: 0,
      threshold: 0.8,
    } as DzupEvent)
    expect(ratioResult.value).toBe(0)
  })

  it('ledger:budget_exceeded histogram records overage', () => {
    const mappings = executionLedgerMetricMap['ledger:budget_exceeded']
    expect(mappings).toHaveLength(2)

    // Second mapping: overage histogram
    const overageResult = mappings[1]!.extract({
      type: 'ledger:budget_exceeded',
      workflowRunId: 'wf-4',
      usedCents: 150,
      limitCents: 100,
    } as DzupEvent)
    expect(overageResult.value).toBe(50)
    expect(overageResult.labels.workflow_run_id).toBe('wf-4')
  })

  it('ledger:budget_exceeded overage is 0 when under limit', () => {
    const mappings = executionLedgerMetricMap['ledger:budget_exceeded']
    const overageResult = mappings[1]!.extract({
      type: 'ledger:budget_exceeded',
      workflowRunId: 'wf-5',
      usedCents: 80,
      limitCents: 100,
    } as DzupEvent)
    expect(overageResult.value).toBe(0)
  })
})

// ------------------------------------------------------------------ workflow-domain

describe('workflow-domain: all extract functions', () => {
  it('workflow:brief_created produces counter', () => {
    const mappings = workflowDomainMetricMap['workflow:brief_created']
    const result = mappings[0]!.extract({ type: 'workflow:brief_created' } as DzupEvent)
    expect(result.value).toBe(1)
  })

  it('workflow:spec_created produces counter', () => {
    const mappings = workflowDomainMetricMap['workflow:spec_created']
    const result = mappings[0]!.extract({ type: 'workflow:spec_created' } as DzupEvent)
    expect(result.value).toBe(1)
  })

  it('workflow:spec_revised maps to empty array', () => {
    const mappings = workflowDomainMetricMap['workflow:spec_revised']
    expect(mappings).toHaveLength(0)
  })

  it('workflow:template_created labels by mode', () => {
    const mappings = workflowDomainMetricMap['workflow:template_created']
    const result = mappings[0]!.extract({
      type: 'workflow:template_created',
      mode: 'interactive',
    } as DzupEvent)
    expect(result.labels.mode).toBe('interactive')
  })

  it('workflow:run_started produces counter', () => {
    const mappings = workflowDomainMetricMap['workflow:run_started']
    const result = mappings[0]!.extract({ type: 'workflow:run_started' } as DzupEvent)
    expect(result.value).toBe(1)
  })

  it('workflow:run_status_changed labels by new_status', () => {
    const mappings = workflowDomainMetricMap['workflow:run_status_changed']
    const result = mappings[0]!.extract({
      type: 'workflow:run_status_changed',
      newStatus: 'running',
    } as DzupEvent)
    expect(result.labels.new_status).toBe('running')
  })

  it('workflow:phase_entered produces counter', () => {
    const mappings = workflowDomainMetricMap['workflow:phase_entered']
    const result = mappings[0]!.extract({ type: 'workflow:phase_entered' } as DzupEvent)
    expect(result.value).toBe(1)
  })

  it('workflow:run_completed produces counter and duration histogram', () => {
    const mappings = workflowDomainMetricMap['workflow:run_completed']
    expect(mappings).toHaveLength(2)
    const results = extractAll(mappings, {
      type: 'workflow:run_completed',
      durationMs: 15000,
    } as DzupEvent)
    expect(results[0]!.value).toBe(1)
    expect(results[1]!.value).toBe(15000)
  })

  it('workflow:run_failed produces counter', () => {
    const mappings = workflowDomainMetricMap['workflow:run_failed']
    const result = mappings[0]!.extract({ type: 'workflow:run_failed' } as DzupEvent)
    expect(result.value).toBe(1)
  })

  it('workflow:task_created produces counter', () => {
    const mappings = workflowDomainMetricMap['workflow:task_created']
    const result = mappings[0]!.extract({ type: 'workflow:task_created' } as DzupEvent)
    expect(result.value).toBe(1)
  })

  it('workflow:task_assigned produces counter', () => {
    const mappings = workflowDomainMetricMap['workflow:task_assigned']
    const result = mappings[0]!.extract({ type: 'workflow:task_assigned' } as DzupEvent)
    expect(result.value).toBe(1)
  })

  it('workflow:task_status_changed labels by new_status', () => {
    const mappings = workflowDomainMetricMap['workflow:task_status_changed']
    const result = mappings[0]!.extract({
      type: 'workflow:task_status_changed',
      newStatus: 'in_progress',
    } as DzupEvent)
    expect(result.labels.new_status).toBe('in_progress')
  })

  it('workflow:task_completed produces counter and duration histogram', () => {
    const mappings = workflowDomainMetricMap['workflow:task_completed']
    expect(mappings).toHaveLength(2)
    const results = extractAll(mappings, {
      type: 'workflow:task_completed',
      durationMs: 8000,
    } as DzupEvent)
    expect(results[0]!.value).toBe(1)
    expect(results[1]!.value).toBe(8000)
  })

  it('workflow:execution_started labels by provider_id', () => {
    const mappings = workflowDomainMetricMap['workflow:execution_started']
    const result = mappings[0]!.extract({
      type: 'workflow:execution_started',
      providerId: 'anthropic',
    } as DzupEvent)
    expect(result.labels.provider_id).toBe('anthropic')
  })

  it('workflow:execution_completed produces counter and duration histogram', () => {
    const mappings = workflowDomainMetricMap['workflow:execution_completed']
    expect(mappings).toHaveLength(2)
    const results = extractAll(mappings, {
      type: 'workflow:execution_completed',
      durationMs: 3000,
    } as DzupEvent)
    expect(results[0]!.value).toBe(1)
    expect(results[1]!.value).toBe(3000)
  })

  it('workflow:execution_failed produces counter', () => {
    const mappings = workflowDomainMetricMap['workflow:execution_failed']
    const result = mappings[0]!.extract({ type: 'workflow:execution_failed' } as DzupEvent)
    expect(result.value).toBe(1)
  })

  it('workflow:prompt_recorded labels by prompt_type', () => {
    const mappings = workflowDomainMetricMap['workflow:prompt_recorded']
    const result = mappings[0]!.extract({
      type: 'workflow:prompt_recorded',
      promptType: 'system',
    } as DzupEvent)
    expect(result.labels.prompt_type).toBe('system')
  })

  it('workflow:cost_recorded produces counter and histogram with budget_bucket', () => {
    const mappings = workflowDomainMetricMap['workflow:cost_recorded']
    expect(mappings).toHaveLength(2)
    const results = extractAll(mappings, {
      type: 'workflow:cost_recorded',
      budgetBucket: 'llm',
      costCents: 12,
    } as DzupEvent)
    expect(results[0]!.labels.budget_bucket).toBe('llm')
    expect(results[1]!.value).toBe(12)
  })

  it('workflow:cost_budget_warning produces counter', () => {
    const mappings = workflowDomainMetricMap['workflow:cost_budget_warning']
    const result = mappings[0]!.extract({ type: 'workflow:cost_budget_warning' } as DzupEvent)
    expect(result.value).toBe(1)
  })

  it('workflow:cost_budget_exceeded produces counter', () => {
    const mappings = workflowDomainMetricMap['workflow:cost_budget_exceeded']
    const result = mappings[0]!.extract({ type: 'workflow:cost_budget_exceeded' } as DzupEvent)
    expect(result.value).toBe(1)
  })

  it('workflow:artifact_saved labels by artifact_type', () => {
    const mappings = workflowDomainMetricMap['workflow:artifact_saved']
    const result = mappings[0]!.extract({
      type: 'workflow:artifact_saved',
      artifactType: 'code',
    } as DzupEvent)
    expect(result.labels.artifact_type).toBe('code')
  })

  it('workflow:suggestion_created labels by category', () => {
    const mappings = workflowDomainMetricMap['workflow:suggestion_created']
    const result = mappings[0]!.extract({
      type: 'workflow:suggestion_created',
      category: 'improvement',
    } as DzupEvent)
    expect(result.labels.category).toBe('improvement')
  })

  it('workflow:schedule_triggered labels by schedule_id', () => {
    const mappings = workflowDomainMetricMap['workflow:schedule_triggered']
    const result = mappings[0]!.extract({
      type: 'workflow:schedule_triggered',
      scheduleId: 'ws-1',
    } as DzupEvent)
    expect(result.labels.schedule_id).toBe('ws-1')
  })
})

// ------------------------------------------------------------------ empty-events

describe('empty-events: mail:received', () => {
  it('mail:received labels by to', () => {
    const mappings = emptyEventMetricMap['mail:received']
    expect(mappings).toHaveLength(1)
    const result = mappings[0]!.extract({
      type: 'mail:received',
      message: { from: 'agent-a', to: 'agent-b', body: 'hello' },
    } as DzupEvent)
    expect(result.value).toBe(1)
    expect(result.labels.to).toBe('agent-b')
  })
})

// ------------------------------------------------------------------ approval

describe('approval: human_contact events', () => {
  it('human_contact:requested produces counter', () => {
    const mappings = approvalMetricMap['human_contact:requested']
    expect(mappings).toHaveLength(1)
    const result = mappings[0]!.extract({ type: 'human_contact:requested' } as DzupEvent)
    expect(result.value).toBe(1)
  })

  it('human_contact:responded produces counter', () => {
    const mappings = approvalMetricMap['human_contact:responded']
    const result = mappings[0]!.extract({ type: 'human_contact:responded' } as DzupEvent)
    expect(result.value).toBe(1)
  })

  it('human_contact:timed_out produces counter', () => {
    const mappings = approvalMetricMap['human_contact:timed_out']
    const result = mappings[0]!.extract({ type: 'human_contact:timed_out' } as DzupEvent)
    expect(result.value).toBe(1)
  })
})

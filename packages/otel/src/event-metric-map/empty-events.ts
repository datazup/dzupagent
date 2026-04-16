import { asEvent, counter, gauge, histogram } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const emptyEventMetricMap = {
  // --- Hooks / plugins ---
  'hook:error': [
    counter(
      'dzip_hook_errors_total',
      'Total errors raised by lifecycle hooks',
      ['hook_name'],
      (e) => {
        const ev = asEvent<'hook:error'>(e)
        return { value: 1, labels: { hook_name: ev.hookName } }
      },
    ),
  ],
  'plugin:registered': [
    counter(
      'dzip_plugins_registered_total',
      'Total plugins registered',
      ['plugin_name'],
      (e) => {
        const ev = asEvent<'plugin:registered'>(e)
        return { value: 1, labels: { plugin_name: ev.pluginName } }
      },
    ),
  ],

  // --- Agent streaming and progress ---
  'agent:stream_delta': [
    counter(
      'dzip_agent_stream_deltas_total',
      'Total streaming deltas emitted',
      ['agent_id'],
      (e) => {
        const ev = asEvent<'agent:stream_delta'>(e)
        return { value: 1, labels: { agent_id: ev.agentId } }
      },
    ),
  ],
  'agent:stream_done': [
    counter(
      'dzip_agent_stream_done_total',
      'Total stream completions',
      ['agent_id'],
      (e) => {
        const ev = asEvent<'agent:stream_done'>(e)
        return { value: 1, labels: { agent_id: ev.agentId } }
      },
    ),
  ],
  'agent:progress': [
    gauge(
      'dzip_agent_progress_percentage',
      'Current agent progress percentage',
      ['agent_id', 'phase'],
      (e) => {
        const ev = asEvent<'agent:progress'>(e)
        return { value: ev.percentage, labels: { agent_id: ev.agentId, phase: ev.phase } }
      },
    ),
  ],

  // --- Recovery ---
  'recovery:cancelled': [
    counter(
      'dzip_recovery_cancelled_total',
      'Total recovery attempts cancelled',
      ['agent_id'],
      (e) => {
        const ev = asEvent<'recovery:cancelled'>(e)
        return { value: 1, labels: { agent_id: ev.agentId } }
      },
    ),
    histogram(
      'dzip_recovery_cancelled_duration_ms',
      'Duration in ms of cancelled recovery attempts',
      ['agent_id'],
      (e) => {
        const ev = asEvent<'recovery:cancelled'>(e)
        return { value: ev.durationMs, labels: { agent_id: ev.agentId } }
      },
    ),
  ],
  'recovery:attempt_started': [
    counter(
      'dzip_recovery_attempts_started_total',
      'Total recovery attempts started',
      ['agent_id', 'strategy'],
      (e) => {
        const ev = asEvent<'recovery:attempt_started'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, strategy: ev.strategy } }
      },
    ),
  ],
  'recovery:succeeded': [
    counter(
      'dzip_recovery_succeeded_total',
      'Total successful recovery attempts',
      ['agent_id', 'strategy'],
      (e) => {
        const ev = asEvent<'recovery:succeeded'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, strategy: ev.strategy } }
      },
    ),
    histogram(
      'dzip_recovery_succeeded_duration_ms',
      'Duration in ms of successful recovery',
      ['agent_id'],
      (e) => {
        const ev = asEvent<'recovery:succeeded'>(e)
        return { value: ev.durationMs, labels: { agent_id: ev.agentId } }
      },
    ),
  ],
  'recovery:exhausted': [
    counter(
      'dzip_recovery_exhausted_total',
      'Total recovery exhaustions (all strategies failed)',
      ['agent_id'],
      (e) => {
        const ev = asEvent<'recovery:exhausted'>(e)
        return { value: 1, labels: { agent_id: ev.agentId } }
      },
    ),
    histogram(
      'dzip_recovery_exhausted_duration_ms',
      'Duration in ms before recovery was exhausted',
      ['agent_id'],
      (e) => {
        const ev = asEvent<'recovery:exhausted'>(e)
        return { value: ev.durationMs, labels: { agent_id: ev.agentId } }
      },
    ),
  ],

  // --- Correction & quality ---
  'correction:iteration': [
    counter(
      'dzip_correction_iterations_total',
      'Total correction iterations executed',
      ['node_id', 'passed'],
      (e) => {
        const ev = asEvent<'correction:iteration'>(e)
        return { value: 1, labels: { node_id: ev.nodeId, passed: String(ev.passed) } }
      },
    ),
    histogram(
      'dzip_correction_iteration_duration_ms',
      'Duration in ms per correction iteration',
      ['node_id'],
      (e) => {
        const ev = asEvent<'correction:iteration'>(e)
        return { value: ev.durationMs, labels: { node_id: ev.nodeId } }
      },
    ),
    histogram(
      'dzip_correction_quality_score',
      'Quality score per correction iteration',
      ['node_id'],
      (e) => {
        const ev = asEvent<'correction:iteration'>(e)
        return { value: ev.qualityScore, labels: { node_id: ev.nodeId } }
      },
    ),
  ],
  'quality:degraded': [
    counter(
      'dzip_quality_degraded_total',
      'Total quality degradation events',
      ['metric'],
      (e) => {
        const ev = asEvent<'quality:degraded'>(e)
        return { value: 1, labels: { metric: ev.metric } }
      },
    ),
    gauge(
      'dzip_quality_degraded_value',
      'Current value of degraded quality metric',
      ['metric'],
      (e) => {
        const ev = asEvent<'quality:degraded'>(e)
        return { value: ev.value, labels: { metric: ev.metric } }
      },
    ),
  ],
  'quality:adjusted': [
    counter(
      'dzip_quality_adjustments_total',
      'Total quality adjustments applied',
      ['adjustment', 'reversible'],
      (e) => {
        const ev = asEvent<'quality:adjusted'>(e)
        return { value: 1, labels: { adjustment: ev.adjustment, reversible: String(ev.reversible) } }
      },
    ),
  ],

  // --- System consolidation ---
  'system:degraded': [
    counter(
      'dzip_system_degraded_total',
      'Total system degradation events',
      ['subsystem', 'recoverable'],
      (e) => {
        const ev = asEvent<'system:degraded'>(e)
        return { value: 1, labels: { subsystem: ev.subsystem, recoverable: String(ev.recoverable) } }
      },
    ),
  ],
  'system:consolidation_started': [
    counter(
      'dzip_consolidation_started_total',
      'Total memory consolidation runs started',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],
  'system:consolidation_completed': [
    counter(
      'dzip_consolidation_completed_total',
      'Total memory consolidation runs completed',
      [],
      () => ({ value: 1, labels: {} }),
    ),
    histogram(
      'dzip_consolidation_duration_ms',
      'Duration in ms of memory consolidation',
      [],
      (e) => {
        const ev = asEvent<'system:consolidation_completed'>(e)
        return { value: ev.durationMs, labels: {} }
      },
    ),
    histogram(
      'dzip_consolidation_records_processed',
      'Number of records processed per consolidation',
      [],
      (e) => {
        const ev = asEvent<'system:consolidation_completed'>(e)
        return { value: ev.recordsProcessed, labels: {} }
      },
    ),
  ],
  'system:consolidation_failed': [
    counter(
      'dzip_consolidation_failed_total',
      'Total memory consolidation failures',
      [],
      () => ({ value: 1, labels: {} }),
    ),
    histogram(
      'dzip_consolidation_failed_duration_ms',
      'Duration in ms before consolidation failure',
      [],
      (e) => {
        const ev = asEvent<'system:consolidation_failed'>(e)
        return { value: ev.durationMs, labels: {} }
      },
    ),
  ],

  // --- Degraded operation diagnostics ---
  'cache:degraded': [
    counter(
      'dzip_cache_degraded_total',
      'Total cache degradation events',
      ['operation', 'recoverable'],
      (e) => {
        const ev = asEvent<'cache:degraded'>(e)
        return { value: 1, labels: { operation: ev.operation, recoverable: String(ev.recoverable) } }
      },
    ),
  ],
  'memory:index_failed': [
    counter(
      'dzip_memory_index_failed_total',
      'Total memory index failures',
      ['namespace', 'recoverable'],
      (e) => {
        const ev = asEvent<'memory:index_failed'>(e)
        return { value: 1, labels: { namespace: ev.namespace, recoverable: String(ev.recoverable) } }
      },
    ),
  ],
  'context:transfer_partial': [
    counter(
      'dzip_context_transfer_partial_total',
      'Total partial context transfers',
      ['recoverable'],
      (e) => {
        const ev = asEvent<'context:transfer_partial'>(e)
        return { value: 1, labels: { recoverable: String(ev.recoverable) } }
      },
    ),
  ],
  // --- Mailbox ---
  'mail:received': [
    counter(
      'dzip_mail_received_total',
      'Total mail messages received by agents',
      ['to'],
      (e) => {
        const ev = asEvent<'mail:received'>(e)
        return { value: 1, labels: { to: ev.message.to } }
      },
    ),
  ],
} satisfies MetricMapFragment

import { asEvent, counter, gauge, histogram } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const emptyAgentMetricMap = {
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

  // --- Agent context fallback telemetry ---
  'agent:context_fallback': [
    counter(
      'dzip_agent_context_fallback_total',
      'Total context fallback events (memory or compression truncation)',
      ['agent_id', 'reason'],
      (e) => {
        const ev = asEvent<'agent:context_fallback'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, reason: ev.reason } }
      },
    ),
  ],
  'agent:structured_schema_prepared': [
    counter(
      'dzip_agent_structured_schema_prepared_total',
      'Total structured-output schema preparations',
      ['agent_id', 'provider'],
      (e) => {
        const ev = asEvent<'agent:structured_schema_prepared'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, provider: ev.provider } }
      },
    ),
  ],
  'agent:structured_native_rejected': [
    counter(
      'dzip_agent_structured_native_rejected_total',
      'Total native structured-output schema rejections',
      ['agent_id', 'provider', 'model'],
      (e) => {
        const ev = asEvent<'agent:structured_native_rejected'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, provider: ev.provider, model: ev.model } }
      },
    ),
  ],
  'agent:structured_fallback_used': [
    counter(
      'dzip_agent_structured_fallback_used_total',
      'Total structured-output fallbacks used after native rejection',
      ['agent_id', 'provider', 'model', 'from', 'to'],
      (e) => {
        const ev = asEvent<'agent:structured_fallback_used'>(e)
        return {
          value: 1,
          labels: {
            agent_id: ev.agentId,
            provider: ev.provider,
            model: ev.model,
            from: ev.from,
            to: ev.to,
          },
        }
      },
    ),
  ],
  'agent:structured_validation_failed': [
    counter(
      'dzip_agent_structured_validation_failed_total',
      'Total structured-output validation failures',
      ['agent_id', 'provider', 'model'],
      (e) => {
        const ev = asEvent<'agent:structured_validation_failed'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, provider: ev.provider, model: ev.model } }
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

  // --- Run outcome scoring (closed-loop self-improvement) ---
  'run:scored': [
    counter(
      'dzip_run_scored_total',
      'Total runs scored by the run outcome analyzer',
      ['passed'],
      (e) => {
        const ev = asEvent<'run:scored'>(e)
        return { value: 1, labels: { passed: String(ev.passed) } }
      },
    ),
    histogram(
      'dzip_run_scored_score',
      'Aggregate run outcome score in [0,1]',
      ['passed'],
      (e) => {
        const ev = asEvent<'run:scored'>(e)
        return { value: ev.score, labels: { passed: String(ev.passed) } }
      },
    ),
  ],
} satisfies MetricMapFragment

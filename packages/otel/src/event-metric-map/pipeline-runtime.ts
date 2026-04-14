import { asEvent } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const pipelineRuntimeMetricMap = {
  // --- Pipeline Runtime ---
  'pipeline:run_started': [
    {
      metricName: 'forge_pipeline_runs_total',
      type: 'counter',
      description: 'Total pipeline run starts',
      labelKeys: ['pipeline_id', 'status'],
      extract: (e) => {
        const ev = asEvent<'pipeline:run_started'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId, status: 'started' } }
      },
    },
  ],

  'pipeline:node_started': [
    {
      metricName: 'forge_pipeline_node_executions_total',
      type: 'counter',
      description: 'Total pipeline node starts',
      labelKeys: ['pipeline_id', 'node_type', 'status'],
      extract: (e) => {
        const ev = asEvent<'pipeline:node_started'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId, node_type: ev.nodeType, status: 'started' } }
      },
    },
  ],

  'pipeline:node_completed': [
    {
      metricName: 'forge_pipeline_node_duration_seconds',
      type: 'histogram',
      description: 'Pipeline node execution duration in seconds',
      labelKeys: ['pipeline_id', 'node_id'],
      extract: (e) => {
        const ev = asEvent<'pipeline:node_completed'>(e)
        return { value: ev.durationMs / 1000, labels: { pipeline_id: ev.pipelineId, node_id: ev.nodeId } }
      },
    },
  ],

  'pipeline:node_failed': [
    {
      metricName: 'forge_pipeline_node_failures_total',
      type: 'counter',
      description: 'Total pipeline node failures',
      labelKeys: ['pipeline_id', 'node_id'],
      extract: (e) => {
        const ev = asEvent<'pipeline:node_failed'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId, node_id: ev.nodeId } }
      },
    },
  ],

  'pipeline:node_skipped': [
    {
      metricName: 'forge_pipeline_node_skips_total',
      type: 'counter',
      description: 'Total pipeline node skips',
      labelKeys: ['pipeline_id', 'node_id'],
      extract: (e) => {
        const ev = asEvent<'pipeline:node_skipped'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId, node_id: ev.nodeId } }
      },
    },
  ],

  'pipeline:suspended': [
    {
      metricName: 'forge_pipeline_suspensions_total',
      type: 'counter',
      description: 'Total pipeline suspension events',
      labelKeys: ['pipeline_id'],
      extract: (e) => {
        const ev = asEvent<'pipeline:suspended'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId } }
      },
    },
  ],

  'pipeline:resumed': [
    {
      metricName: 'forge_pipeline_resumptions_total',
      type: 'counter',
      description: 'Total pipeline resumption events',
      labelKeys: ['pipeline_id'],
      extract: (e) => {
        const ev = asEvent<'pipeline:resumed'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId } }
      },
    },
  ],

  'pipeline:loop_iteration': [
    {
      metricName: 'forge_pipeline_loop_iterations_total',
      type: 'counter',
      description: 'Total pipeline loop iterations',
      labelKeys: ['pipeline_id', 'node_id'],
      extract: (e) => {
        const ev = asEvent<'pipeline:loop_iteration'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId, node_id: ev.nodeId } }
      },
    },
  ],

  'pipeline:checkpoint_saved': [
    {
      metricName: 'forge_pipeline_checkpoints_total',
      type: 'counter',
      description: 'Total pipeline checkpoint saves',
      labelKeys: ['pipeline_id'],
      extract: (e) => {
        const ev = asEvent<'pipeline:checkpoint_saved'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId } }
      },
    },
  ],

  'pipeline:run_completed': [
    {
      metricName: 'forge_pipeline_runs_total',
      type: 'counter',
      description: 'Total pipeline run completions',
      labelKeys: ['pipeline_id', 'status'],
      extract: (e) => {
        const ev = asEvent<'pipeline:run_completed'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId, status: 'completed' } }
      },
    },
    {
      metricName: 'forge_pipeline_run_duration_seconds',
      type: 'histogram',
      description: 'Pipeline run duration in seconds',
      labelKeys: ['pipeline_id'],
      extract: (e) => {
        const ev = asEvent<'pipeline:run_completed'>(e)
        return { value: ev.durationMs / 1000, labels: { pipeline_id: ev.pipelineId } }
      },
    },
  ],

  'pipeline:run_failed': [
    {
      metricName: 'forge_pipeline_runs_total',
      type: 'counter',
      description: 'Total pipeline run failures',
      labelKeys: ['pipeline_id', 'status'],
      extract: (e) => {
        const ev = asEvent<'pipeline:run_failed'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId, status: 'failed' } }
      },
    },
  ],

  'pipeline:run_cancelled': [
    {
      metricName: 'forge_pipeline_runs_total',
      type: 'counter',
      description: 'Total pipeline run cancellations',
      labelKeys: ['pipeline_id', 'status'],
      extract: (e) => {
        const ev = asEvent<'pipeline:run_cancelled'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId, status: 'cancelled' } }
      },
    },
  ],

} satisfies MetricMapFragment

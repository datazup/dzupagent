import { asEvent, counter, gauge, histogram } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const adapterRuntimeMetricMap = {
  'adapter:progress': [
    gauge(
      'dzip_adapter_progress_percent',
      'Latest adapter progress percentage',
      ['phase', 'provider_id'],
      (e) => {
        const ev = asEvent<'adapter:progress'>(e)
        return {
          value: ev.percentage ?? 0,
          labels: { phase: ev.phase, provider_id: ev.providerId ?? 'unknown' },
        }
      },
    ),
  ],

  'mapreduce:started': [
    counter(
      'dzip_mapreduce_runs_started_total',
      'Total map-reduce runs started',
      ['max_concurrency'],
      (e) => {
        const ev = asEvent<'mapreduce:started'>(e)
        return { value: 1, labels: { max_concurrency: String(ev.maxConcurrency) } }
      },
    ),
    gauge(
      'dzip_mapreduce_chunks_total',
      'Total chunks scheduled for map-reduce runs',
      ['phase'],
      (e) => {
        const ev = asEvent<'mapreduce:started'>(e)
        return { value: ev.totalChunks, labels: { phase: 'started' } }
      },
    ),
  ],

  'mapreduce:map_completed': [
    counter(
      'dzip_mapreduce_map_completed_total',
      'Total map-reduce map phases completed',
      [],
      () => ({ value: 1, labels: {} }),
    ),
    gauge(
      'dzip_mapreduce_chunks_successful',
      'Successful chunks reported by map-reduce map phases',
      ['phase'],
      (e) => {
        const ev = asEvent<'mapreduce:map_completed'>(e)
        return { value: ev.successfulChunks, labels: { phase: 'map' } }
      },
    ),
    gauge(
      'dzip_mapreduce_chunks_failed',
      'Failed chunks reported by map-reduce map phases',
      ['phase'],
      (e) => {
        const ev = asEvent<'mapreduce:map_completed'>(e)
        return { value: ev.failedChunks, labels: { phase: 'map' } }
      },
    ),
  ],

  'mapreduce:completed': [
    counter(
      'dzip_mapreduce_runs_completed_total',
      'Total map-reduce runs completed',
      [],
      () => ({ value: 1, labels: {} }),
    ),
    histogram(
      'dzip_mapreduce_duration_ms',
      'Map-reduce total duration in milliseconds',
      [],
      (e) => {
        const ev = asEvent<'mapreduce:completed'>(e)
        return { value: ev.totalDurationMs, labels: {} }
      },
    ),
    histogram(
      'dzip_mapreduce_reduce_duration_ms',
      'Map-reduce reduce phase duration in milliseconds',
      [],
      (e) => {
        const ev = asEvent<'mapreduce:completed'>(e)
        return { value: ev.reduceDurationMs, labels: {} }
      },
    ),
  ],

  'mapreduce:chunk_completed': [
    counter(
      'dzip_mapreduce_chunks_completed_total',
      'Total map-reduce chunks completed',
      ['provider_id', 'success'],
      (e) => {
        const ev = asEvent<'mapreduce:chunk_completed'>(e)
        return { value: 1, labels: { provider_id: ev.providerId, success: String(ev.success) } }
      },
    ),
    histogram(
      'dzip_mapreduce_chunk_duration_ms',
      'Map-reduce chunk duration in milliseconds',
      ['provider_id', 'success'],
      (e) => {
        const ev = asEvent<'mapreduce:chunk_completed'>(e)
        return {
          value: ev.durationMs,
          labels: { provider_id: ev.providerId, success: String(ev.success) },
        }
      },
    ),
  ],

  'mapreduce:chunk_failed': [
    counter(
      'dzip_mapreduce_chunks_failed_total',
      'Total map-reduce chunks failed',
      [],
      () => ({ value: 1, labels: {} }),
    ),
    histogram(
      'dzip_mapreduce_chunk_failure_duration_ms',
      'Map-reduce failed chunk duration in milliseconds',
      [],
      (e) => {
        const ev = asEvent<'mapreduce:chunk_failed'>(e)
        return { value: ev.durationMs, labels: {} }
      },
    ),
  ],

  // --- Adapter run lifecycle ---
  'adapter:run_pending': [
    counter(
      'dzip_adapter_run_status_total',
      'Total adapter run status transitions',
      ['provider_id', 'status'],
      (e) => {
        const ev = asEvent<'adapter:run_pending'>(e)
        return { value: 1, labels: { provider_id: ev.providerId ?? 'unknown', status: 'pending' } }
      },
    ),
  ],
  'adapter:run_queued': [
    counter(
      'dzip_adapter_run_status_total',
      'Total adapter run status transitions',
      ['provider_id', 'status'],
      (e) => {
        const ev = asEvent<'adapter:run_queued'>(e)
        return { value: 1, labels: { provider_id: ev.providerId ?? 'unknown', status: 'queued' } }
      },
    ),
  ],
  'adapter:run_running': [
    counter(
      'dzip_adapter_run_status_total',
      'Total adapter run status transitions',
      ['provider_id', 'status'],
      (e) => {
        const ev = asEvent<'adapter:run_running'>(e)
        return { value: 1, labels: { provider_id: ev.providerId ?? 'unknown', status: 'running' } }
      },
    ),
  ],
  'adapter:run_executing': [
    counter(
      'dzip_adapter_run_status_total',
      'Total adapter run status transitions',
      ['provider_id', 'status'],
      (e) => {
        const ev = asEvent<'adapter:run_executing'>(e)
        return { value: 1, labels: { provider_id: ev.providerId ?? 'unknown', status: 'executing' } }
      },
    ),
  ],
  'adapter:run_awaiting_approval': [
    counter(
      'dzip_adapter_run_status_total',
      'Total adapter run status transitions',
      ['provider_id', 'status'],
      (e) => {
        const ev = asEvent<'adapter:run_awaiting_approval'>(e)
        return { value: 1, labels: { provider_id: ev.providerId ?? 'unknown', status: 'awaiting_approval' } }
      },
    ),
  ],
  'adapter:run_approved': [
    counter(
      'dzip_adapter_run_status_total',
      'Total adapter run status transitions',
      ['provider_id', 'status'],
      (e) => {
        const ev = asEvent<'adapter:run_approved'>(e)
        return { value: 1, labels: { provider_id: ev.providerId ?? 'unknown', status: 'approved' } }
      },
    ),
  ],
  'adapter:run_paused': [
    counter(
      'dzip_adapter_run_status_total',
      'Total adapter run status transitions',
      ['provider_id', 'status'],
      (e) => {
        const ev = asEvent<'adapter:run_paused'>(e)
        return { value: 1, labels: { provider_id: ev.providerId ?? 'unknown', status: 'paused' } }
      },
    ),
  ],
  'adapter:run_suspended': [
    counter(
      'dzip_adapter_run_status_total',
      'Total adapter run status transitions',
      ['provider_id', 'status'],
      (e) => {
        const ev = asEvent<'adapter:run_suspended'>(e)
        return { value: 1, labels: { provider_id: ev.providerId ?? 'unknown', status: 'suspended' } }
      },
    ),
  ],
  'adapter:run_completed': [
    counter(
      'dzip_adapter_run_status_total',
      'Total adapter run status transitions',
      ['provider_id', 'status'],
      (e) => {
        const ev = asEvent<'adapter:run_completed'>(e)
        return { value: 1, labels: { provider_id: ev.providerId ?? 'unknown', status: 'completed' } }
      },
    ),
  ],
  'adapter:run_halted': [
    counter(
      'dzip_adapter_run_status_total',
      'Total adapter run status transitions',
      ['provider_id', 'status'],
      (e) => {
        const ev = asEvent<'adapter:run_halted'>(e)
        return { value: 1, labels: { provider_id: ev.providerId ?? 'unknown', status: 'halted' } }
      },
    ),
  ],
  'adapter:run_failed': [
    counter(
      'dzip_adapter_run_status_total',
      'Total adapter run status transitions',
      ['provider_id', 'status'],
      (e) => {
        const ev = asEvent<'adapter:run_failed'>(e)
        return { value: 1, labels: { provider_id: ev.providerId ?? 'unknown', status: 'failed' } }
      },
    ),
  ],
  'adapter:run_cancelled': [
    counter(
      'dzip_adapter_run_status_total',
      'Total adapter run status transitions',
      ['provider_id', 'status'],
      (e) => {
        const ev = asEvent<'adapter:run_cancelled'>(e)
        return { value: 1, labels: { provider_id: ev.providerId ?? 'unknown', status: 'cancelled' } }
      },
    ),
  ],
  'adapter:run_rejected': [
    counter(
      'dzip_adapter_run_status_total',
      'Total adapter run status transitions',
      ['provider_id', 'status'],
      (e) => {
        const ev = asEvent<'adapter:run_rejected'>(e)
        return { value: 1, labels: { provider_id: ev.providerId ?? 'unknown', status: 'rejected' } }
      },
    ),
  ],

  // --- Adapter memory recall ---
  'adapter:memory_recalled': [
    counter(
      'dzip_adapter_memory_recalled_total',
      'Total adapter memory recall events',
      ['provider_id'],
      (e) => {
        const ev = asEvent<'adapter:memory_recalled'>(e)
        return { value: 1, labels: { provider_id: ev.providerId } }
      },
    ),
    histogram(
      'dzip_adapter_memory_recalled_tokens',
      'Total tokens recalled from adapter memory',
      ['provider_id'],
      (e) => {
        const ev = asEvent<'adapter:memory_recalled'>(e)
        return { value: ev.totalTokens, labels: { provider_id: ev.providerId } }
      },
    ),
    histogram(
      'dzip_adapter_memory_recalled_duration_ms',
      'Duration in ms of adapter memory recall',
      ['provider_id'],
      (e) => {
        const ev = asEvent<'adapter:memory_recalled'>(e)
        return { value: ev.durationMs, labels: { provider_id: ev.providerId } }
      },
    ),
  ],

  // --- Adapter skills compiled ---
  'adapter:skills_compiled': [
    counter(
      'dzip_adapter_skills_compiled_total',
      'Total adapter skill compilation events',
      ['provider_id'],
      (e) => {
        const ev = asEvent<'adapter:skills_compiled'>(e)
        return { value: 1, labels: { provider_id: ev.providerId } }
      },
    ),
    histogram(
      'dzip_adapter_skills_compiled_duration_ms',
      'Duration in ms of adapter skill compilation',
      ['provider_id'],
      (e) => {
        const ev = asEvent<'adapter:skills_compiled'>(e)
        return { value: ev.durationMs, labels: { provider_id: ev.providerId } }
      },
    ),
  ],

  // --- Prompt cache efficiency telemetry ---
  'adapter:cache_stats': [
    counter(
      'dzip_adapter_cache_stats_total',
      'Total prompt cache stat events emitted per session',
      ['provider_id'],
      (e) => {
        const ev = asEvent<'adapter:cache_stats'>(e)
        return { value: 1, labels: { provider_id: ev.providerId } }
      },
    ),
    gauge(
      'dzip_adapter_cache_hit_ratio',
      'Latest prompt cache hit ratio (0–1) per session',
      ['provider_id'],
      (e) => {
        const ev = asEvent<'adapter:cache_stats'>(e)
        return { value: ev.cacheHitRatio, labels: { provider_id: ev.providerId } }
      },
    ),
    histogram(
      'dzip_adapter_cache_read_tokens',
      'Cache-read tokens (served from cache) per session',
      ['provider_id'],
      (e) => {
        const ev = asEvent<'adapter:cache_stats'>(e)
        return { value: ev.cacheReadTokens, labels: { provider_id: ev.providerId } }
      },
    ),
    histogram(
      'dzip_adapter_cache_write_tokens',
      'Cache-write tokens (written to cache) per session',
      ['provider_id'],
      (e) => {
        const ev = asEvent<'adapter:cache_stats'>(e)
        return { value: ev.cacheWriteTokens, labels: { provider_id: ev.providerId } }
      },
    ),
  ],
} satisfies MetricMapFragment

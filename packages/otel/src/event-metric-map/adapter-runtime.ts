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
} satisfies MetricMapFragment

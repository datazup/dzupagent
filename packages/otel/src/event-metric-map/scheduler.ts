import { asEvent, counter } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const schedulerMetricMap = {
  'scheduler:started': [
    counter(
      'dzip_scheduler_starts_total',
      'Total scheduler start events',
      ['poll_interval_ms'],
      (e) => {
        const ev = asEvent<'scheduler:started'>(e)
        return { value: 1, labels: { poll_interval_ms: String(ev.pollIntervalMs) } }
      },
    ),
  ],

  'scheduler:stopped': [
    counter(
      'dzip_scheduler_stops_total',
      'Total scheduler stop events',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],

  'scheduler:triggered': [
    counter(
      'dzip_scheduler_triggers_total',
      'Total schedule trigger events',
      ['schedule_id'],
      (e) => {
        const ev = asEvent<'scheduler:triggered'>(e)
        return { value: 1, labels: { schedule_id: ev.scheduleId } }
      },
    ),
  ],

  'scheduler:trigger_failed': [
    counter(
      'dzip_scheduler_trigger_failures_total',
      'Total schedule trigger failures',
      ['schedule_id'],
      (e) => {
        const ev = asEvent<'scheduler:trigger_failed'>(e)
        return { value: 1, labels: { schedule_id: ev.scheduleId } }
      },
    ),
  ],

  'scheduler:schedule_created': [
    counter(
      'dzip_scheduler_schedules_created_total',
      'Total schedules created',
      ['schedule_type'],
      (e) => {
        const ev = asEvent<'scheduler:schedule_created'>(e)
        return { value: 1, labels: { schedule_type: ev.scheduleType } }
      },
    ),
  ],

  'scheduler:schedule_enabled': [
    counter(
      'dzip_scheduler_schedules_enabled_total',
      'Total schedules enabled',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],

  'scheduler:schedule_disabled': [
    counter(
      'dzip_scheduler_schedules_disabled_total',
      'Total schedules disabled',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],
} satisfies MetricMapFragment

import { asEvent, counter, histogram } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const flowCompileMetricMap = {
  'flow:compile_started': [
    counter(
      'dzip_flow_compile_started_total',
      'Total flow compile sessions started',
      ['input_kind'],
      (e) => {
        const ev = asEvent<'flow:compile_started'>(e)
        return { value: 1, labels: { input_kind: ev.inputKind } }
      },
    ),
  ],
  'flow:compile_parsed': [
    counter(
      'dzip_flow_compile_parsed_total',
      'Total flow compile parse stages completed',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],
  'flow:compile_shape_validated': [
    counter(
      'dzip_flow_compile_shape_validated_total',
      'Total flow compile shape validation stages completed',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],
  'flow:compile_semantic_resolved': [
    counter(
      'dzip_flow_compile_semantic_resolved_total',
      'Total flow compile semantic resolution stages completed',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],
  'flow:compile_lowered': [
    counter(
      'dzip_flow_compile_lowered_total',
      'Total flow compile lowering stages completed',
      ['target'],
      (e) => {
        const ev = asEvent<'flow:compile_lowered'>(e)
        return { value: 1, labels: { target: ev.target } }
      },
    ),
  ],
  'flow:compile_completed': [
    counter(
      'dzip_flow_compile_completed_total',
      'Total flow compiles completed successfully',
      ['target'],
      (e) => {
        const ev = asEvent<'flow:compile_completed'>(e)
        return { value: 1, labels: { target: ev.target } }
      },
    ),
    histogram(
      'dzip_flow_compile_duration_ms',
      'Duration in ms of successful flow compiles',
      ['target'],
      (e) => {
        const ev = asEvent<'flow:compile_completed'>(e)
        return { value: ev.durationMs, labels: { target: ev.target } }
      },
    ),
  ],
  'flow:compile_result': [
    counter(
      'dzip_flow_compile_results_total',
      'Total flow compile result payloads emitted',
      ['target'],
      (e) => {
        const ev = asEvent<'flow:compile_result'>(e)
        return { value: 1, labels: { target: ev.target } }
      },
    ),
    histogram(
      'dzip_flow_compile_result_warning_count',
      'Number of warnings attached to flow compile result payloads',
      ['target'],
      (e) => {
        const ev = asEvent<'flow:compile_result'>(e)
        return { value: ev.warnings.length, labels: { target: ev.target } }
      },
    ),
    histogram(
      'dzip_flow_compile_result_reason_count',
      'Number of route-selection reasons attached to flow compile result payloads',
      ['target'],
      (e) => {
        const ev = asEvent<'flow:compile_result'>(e)
        return { value: ev.reasons.length, labels: { target: ev.target } }
      },
    ),
  ],
  'flow:compile_failed': [
    counter(
      'dzip_flow_compile_failed_total',
      'Total flow compile failures',
      ['stage'],
      (e) => {
        const ev = asEvent<'flow:compile_failed'>(e)
        return { value: 1, labels: { stage: String(ev.stage) } }
      },
    ),
    counter(
      'dzip_flow_compile_failed_errors_total',
      'Total errors reported by failed flow compiles',
      ['stage'],
      (e) => {
        const ev = asEvent<'flow:compile_failed'>(e)
        return { value: ev.errorCount, labels: { stage: String(ev.stage) } }
      },
    ),
    histogram(
      'dzip_flow_compile_failed_duration_ms',
      'Duration in ms before flow compile failure',
      ['stage'],
      (e) => {
        const ev = asEvent<'flow:compile_failed'>(e)
        return { value: ev.durationMs, labels: { stage: String(ev.stage) } }
      },
    ),
  ],
} satisfies MetricMapFragment

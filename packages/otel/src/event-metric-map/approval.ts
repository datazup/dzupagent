import type { MetricMapFragment } from './types.js'

export const approvalMetricMap = {
  // --- Approval ---
  'approval:requested': [
    {
      metricName: 'forge_approval_requests_total',
      type: 'counter',
      description: 'Total approval requests',
      labelKeys: ['status'],
      extract: () => ({ value: 1, labels: { status: 'requested' } }),
    },
  ],

  'approval:granted': [
    {
      metricName: 'forge_approval_requests_total',
      type: 'counter',
      description: 'Total approval grants',
      labelKeys: ['status'],
      extract: () => ({ value: 1, labels: { status: 'granted' } }),
    },
  ],

  'approval:rejected': [
    {
      metricName: 'forge_approval_requests_total',
      type: 'counter',
      description: 'Total approval rejections',
      labelKeys: ['status'],
      extract: () => ({ value: 1, labels: { status: 'rejected' } }),
    },
  ],


  // --- Human Contact ---
  'human_contact:requested': [
    {
      metricName: 'dzip_human_contact_requests_total',
      type: 'counter',
      description: 'Total human contact requests',
      labelKeys: ['contact_type', 'channel'],
      extract: () => ({ value: 1, labels: { contact_type: 'unknown', channel: 'unknown' } }),
    },
  ],

  'human_contact:responded': [
    {
      metricName: 'dzip_human_contact_responses_total',
      type: 'counter',
      description: 'Total human contact responses received',
      labelKeys: [],
      extract: () => ({ value: 1, labels: {} }),
    },
  ],

  'human_contact:timed_out': [
    {
      metricName: 'dzip_human_contact_timeouts_total',
      type: 'counter',
      description: 'Total human contact requests that timed out',
      labelKeys: [],
      extract: () => ({ value: 1, labels: {} }),
    },
  ],

} satisfies MetricMapFragment

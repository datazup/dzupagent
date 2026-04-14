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

} satisfies MetricMapFragment

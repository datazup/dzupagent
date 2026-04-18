import { asEvent } from './shared.js'
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

  // --- Adapter Interactions (mid-execution questions/permissions) ---
  'adapter:interaction_required': [
    {
      metricName: 'dzip_adapter_interactions_total',
      type: 'counter',
      description: 'Total adapter interactions raised',
      labelKeys: ['provider_id', 'kind', 'status'],
      extract: (e) => {
        const ev = asEvent<'adapter:interaction_required'>(e)
        return {
          value: 1,
          labels: { provider_id: ev.providerId, kind: ev.kind, status: 'required' },
        }
      },
    },
  ],

  'adapter:interaction_resolved': [
    {
      metricName: 'dzip_adapter_interactions_total',
      type: 'counter',
      description: 'Total adapter interactions resolved',
      labelKeys: ['provider_id', 'resolved_by', 'status'],
      extract: (e) => {
        const ev = asEvent<'adapter:interaction_resolved'>(e)
        return {
          value: 1,
          labels: { provider_id: ev.providerId, resolved_by: ev.resolvedBy, status: 'resolved' },
        }
      },
    },
  ],

} satisfies MetricMapFragment

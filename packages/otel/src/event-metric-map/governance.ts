import { asEvent } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const governanceMetricMap = {
  // --- Security ---
  'policy:evaluated': [
    {
      metricName: 'forge_policy_evaluations_total',
      type: 'counter',
      description: 'Total policy evaluations',
      labelKeys: ['policy_set_id', 'effect'],
      extract: (e) => {
        const ev = asEvent<'policy:evaluated'>(e)
        return { value: 1, labels: { policy_set_id: ev.policySetId, effect: ev.effect } }
      },
    },
    {
      metricName: 'forge_policy_evaluation_duration_us',
      type: 'histogram',
      description: 'Policy evaluation duration in microseconds',
      labelKeys: ['policy_set_id'],
      extract: (e) => {
        const ev = asEvent<'policy:evaluated'>(e)
        return { value: ev.durationUs, labels: { policy_set_id: ev.policySetId } }
      },
    },
  ],

  'policy:denied': [
    {
      metricName: 'forge_policy_denials_total',
      type: 'counter',
      description: 'Total policy denial events',
      labelKeys: ['policy_set_id', 'action'],
      extract: (e) => {
        const ev = asEvent<'policy:denied'>(e)
        return { value: 1, labels: { policy_set_id: ev.policySetId, action: ev.action } }
      },
    },
  ],

  'policy:set_updated': [
    {
      metricName: 'forge_policy_updates_total',
      type: 'counter',
      description: 'Total policy set update events',
      labelKeys: ['policy_set_id'],
      extract: (e) => {
        const ev = asEvent<'policy:set_updated'>(e)
        return { value: 1, labels: { policy_set_id: ev.policySetId } }
      },
    },
  ],

  'safety:violation': [
    {
      metricName: 'forge_safety_violations_total',
      type: 'counter',
      description: 'Total safety violation events',
      labelKeys: ['category', 'severity'],
      extract: (e) => {
        const ev = asEvent<'safety:violation'>(e)
        return { value: 1, labels: { category: ev.category, severity: ev.severity } }
      },
    },
  ],

  'safety:blocked': [
    {
      metricName: 'forge_safety_blocks_total',
      type: 'counter',
      description: 'Total safety block events',
      labelKeys: ['category', 'action'],
      extract: (e) => {
        const ev = asEvent<'safety:blocked'>(e)
        return { value: 1, labels: { category: ev.category, action: ev.action } }
      },
    },
  ],

  'safety:kill_requested': [
    {
      metricName: 'forge_safety_kill_requests_total',
      type: 'counter',
      description: 'Total agent kill requests',
      labelKeys: ['agent_id'],
      extract: (e) => {
        const ev = asEvent<'safety:kill_requested'>(e)
        return { value: 1, labels: { agent_id: ev.agentId } }
      },
    },
  ],

  'memory:threat_detected': [
    {
      metricName: 'forge_memory_threats_total',
      type: 'counter',
      description: 'Total memory threat detection events',
      labelKeys: ['threat_type', 'namespace'],
      extract: (e) => {
        const ev = asEvent<'memory:threat_detected'>(e)
        return { value: 1, labels: { threat_type: ev.threatType, namespace: ev.namespace } }
      },
    },
  ],

  'memory:quarantined': [
    {
      metricName: 'forge_memory_quarantines_total',
      type: 'counter',
      description: 'Total memory quarantine events',
      labelKeys: ['namespace'],
      extract: (e) => {
        const ev = asEvent<'memory:quarantined'>(e)
        return { value: 1, labels: { namespace: ev.namespace } }
      },
    },
  ],

} satisfies MetricMapFragment

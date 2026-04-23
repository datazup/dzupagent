import { asEvent } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const platformRegistryProtocolMetricMap = {
  // --- Adapter Registry ---
  'adapter_registry:provider_registered': [
    {
      metricName: 'forge_adapter_registry_operations_total',
      type: 'counter',
      description: 'Total adapter provider registration events',
      labelKeys: ['operation'],
      extract: () => ({ value: 1, labels: { operation: 'registered' } }),
    },
  ],

  'adapter_registry:provider_deregistered': [
    {
      metricName: 'forge_adapter_registry_operations_total',
      type: 'counter',
      description: 'Total adapter provider deregistration events',
      labelKeys: ['operation'],
      extract: () => ({ value: 1, labels: { operation: 'deregistered' } }),
    },
  ],

  // --- Registry ---
  'registry:agent_registered': [
    {
      metricName: 'forge_registry_operations_total',
      type: 'counter',
      description: 'Total agent registration events',
      labelKeys: ['operation'],
      extract: () => ({ value: 1, labels: { operation: 'registered' } }),
    },
  ],

  'registry:agent_deregistered': [
    {
      metricName: 'forge_registry_operations_total',
      type: 'counter',
      description: 'Total agent deregistration events',
      labelKeys: ['operation'],
      extract: () => ({ value: 1, labels: { operation: 'deregistered' } }),
    },
  ],

  'registry:agent_updated': [
    {
      metricName: 'forge_registry_operations_total',
      type: 'counter',
      description: 'Total agent update events',
      labelKeys: ['operation'],
      extract: () => ({ value: 1, labels: { operation: 'updated' } }),
    },
  ],

  'registry:health_changed': [
    {
      metricName: 'forge_registry_health_changes_total',
      type: 'counter',
      description: 'Total agent health status changes',
      labelKeys: ['agent_id', 'new_status'],
      extract: (e) => {
        const ev = asEvent<'registry:health_changed'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, new_status: ev.newStatus } }
      },
    },
  ],

  'registry:capability_added': [
    {
      metricName: 'forge_registry_operations_total',
      type: 'counter',
      description: 'Total capability addition events',
      labelKeys: ['operation'],
      extract: () => ({ value: 1, labels: { operation: 'capability_added' } }),
    },
  ],

  // --- Protocol ---
  'protocol:message_sent': [
    {
      metricName: 'forge_protocol_messages_total',
      type: 'counter',
      description: 'Total protocol messages sent',
      labelKeys: ['protocol', 'direction'],
      extract: (e) => {
        const ev = asEvent<'protocol:message_sent'>(e)
        return { value: 1, labels: { protocol: ev.protocol, direction: 'sent' } }
      },
    },
  ],

  'protocol:message_received': [
    {
      metricName: 'forge_protocol_messages_total',
      type: 'counter',
      description: 'Total protocol messages received',
      labelKeys: ['protocol', 'direction'],
      extract: (e) => {
        const ev = asEvent<'protocol:message_received'>(e)
        return { value: 1, labels: { protocol: ev.protocol, direction: 'received' } }
      },
    },
  ],

  'protocol:error': [
    {
      metricName: 'forge_protocol_errors_total',
      type: 'counter',
      description: 'Total protocol errors',
      labelKeys: ['protocol'],
      extract: (e) => {
        const ev = asEvent<'protocol:error'>(e)
        return { value: 1, labels: { protocol: ev.protocol } }
      },
    },
  ],

  'protocol:connected': [
    {
      metricName: 'forge_protocol_connections_total',
      type: 'counter',
      description: 'Total protocol connection events',
      labelKeys: ['protocol', 'status'],
      extract: (e) => {
        const ev = asEvent<'protocol:connected'>(e)
        return { value: 1, labels: { protocol: ev.protocol, status: 'connected' } }
      },
    },
  ],

  'protocol:disconnected': [
    {
      metricName: 'forge_protocol_connections_total',
      type: 'counter',
      description: 'Total protocol disconnection events',
      labelKeys: ['protocol', 'status'],
      extract: (e) => {
        const ev = asEvent<'protocol:disconnected'>(e)
        return { value: 1, labels: { protocol: ev.protocol, status: 'disconnected' } }
      },
    },
  ],

  'protocol:state_changed': [
    {
      metricName: 'forge_protocol_state_changes_total',
      type: 'counter',
      description: 'Total protocol state transitions',
      labelKeys: ['protocol', 'new_state'],
      extract: (e) => {
        const ev = asEvent<'protocol:state_changed'>(e)
        return { value: 1, labels: { protocol: ev.protocol, new_state: ev.newState } }
      },
    },
  ],

} satisfies MetricMapFragment

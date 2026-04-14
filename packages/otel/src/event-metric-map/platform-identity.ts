import { asEvent } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const platformIdentityMetricMap = {
  // --- MCP ---
  'mcp:connected': [
    {
      metricName: 'forge_mcp_connections_total',
      type: 'counter',
      description: 'Total MCP connection events',
      labelKeys: ['server', 'status'],
      extract: (e) => {
        const ev = asEvent<'mcp:connected'>(e)
        return { value: 1, labels: { server: ev.serverName, status: 'connected' } }
      },
    },
  ],

  'mcp:disconnected': [
    {
      metricName: 'forge_mcp_connections_total',
      type: 'counter',
      description: 'Total MCP disconnection events',
      labelKeys: ['server', 'status'],
      extract: (e) => {
        const ev = asEvent<'mcp:disconnected'>(e)
        return { value: 1, labels: { server: ev.serverName, status: 'disconnected' } }
      },
    },
  ],

  // --- MCP registry lifecycle ---
  'mcp:server_added': [
    {
      metricName: 'forge_mcp_registry_mutations_total',
      type: 'counter',
      description: 'Total MCP server registry mutation events',
      labelKeys: ['operation', 'transport'],
      extract: (e) => {
        const ev = asEvent<'mcp:server_added'>(e)
        return { value: 1, labels: { operation: 'added', transport: ev.transport } }
      },
    },
  ],

  'mcp:server_updated': [
    {
      metricName: 'forge_mcp_registry_mutations_total',
      type: 'counter',
      description: 'Total MCP server registry mutation events',
      labelKeys: ['operation', 'transport'],
      extract: () => ({ value: 1, labels: { operation: 'updated', transport: 'unknown' } }),
    },
  ],

  'mcp:server_removed': [
    {
      metricName: 'forge_mcp_registry_mutations_total',
      type: 'counter',
      description: 'Total MCP server registry mutation events',
      labelKeys: ['operation', 'transport'],
      extract: () => ({ value: 1, labels: { operation: 'removed', transport: 'unknown' } }),
    },
  ],

  'mcp:server_enabled': [
    {
      metricName: 'forge_mcp_registry_mutations_total',
      type: 'counter',
      description: 'Total MCP server registry mutation events',
      labelKeys: ['operation', 'transport'],
      extract: () => ({ value: 1, labels: { operation: 'enabled', transport: 'unknown' } }),
    },
  ],

  'mcp:server_disabled': [
    {
      metricName: 'forge_mcp_registry_mutations_total',
      type: 'counter',
      description: 'Total MCP server registry mutation events',
      labelKeys: ['operation', 'transport'],
      extract: () => ({ value: 1, labels: { operation: 'disabled', transport: 'unknown' } }),
    },
  ],

  'mcp:test_passed': [
    {
      metricName: 'forge_mcp_connectivity_tests_total',
      type: 'counter',
      description: 'Total MCP server connectivity test results',
      labelKeys: ['result'],
      extract: () => ({ value: 1, labels: { result: 'passed' } }),
    },
  ],

  'mcp:test_failed': [
    {
      metricName: 'forge_mcp_connectivity_tests_total',
      type: 'counter',
      description: 'Total MCP server connectivity test results',
      labelKeys: ['result'],
      extract: () => ({ value: 1, labels: { result: 'failed' } }),
    },
  ],

  // --- Provider ---
  'provider:failed': [
    {
      metricName: 'forge_provider_failures_total',
      type: 'counter',
      description: 'Total provider failure events',
      labelKeys: ['provider', 'tier'],
      extract: (e) => {
        const ev = asEvent<'provider:failed'>(e)
        return { value: 1, labels: { provider: ev.provider, tier: ev.tier } }
      },
    },
  ],

  'provider:circuit_opened': [
    {
      metricName: 'forge_provider_circuit_state',
      type: 'gauge',
      description: 'Provider circuit breaker state (1=open, 0=closed)',
      labelKeys: ['provider'],
      extract: (e) => {
        const ev = asEvent<'provider:circuit_opened'>(e)
        return { value: 1, labels: { provider: ev.provider } }
      },
    },
  ],

  'provider:circuit_closed': [
    {
      metricName: 'forge_provider_circuit_state',
      type: 'gauge',
      description: 'Provider circuit breaker state (1=open, 0=closed)',
      labelKeys: ['provider'],
      extract: (e) => {
        const ev = asEvent<'provider:circuit_closed'>(e)
        return { value: 0, labels: { provider: ev.provider } }
      },
    },
  ],

  // --- Identity ---
  'identity:resolved': [
    {
      metricName: 'forge_identity_operations_total',
      type: 'counter',
      description: 'Total identity resolution successes',
      labelKeys: ['agent_id', 'status'],
      extract: (e) => {
        const ev = asEvent<'identity:resolved'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, status: 'resolved' } }
      },
    },
  ],

  'identity:failed': [
    {
      metricName: 'forge_identity_operations_total',
      type: 'counter',
      description: 'Total identity resolution failures',
      labelKeys: ['agent_id', 'status'],
      extract: (e) => {
        const ev = asEvent<'identity:failed'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, status: 'failed' } }
      },
    },
  ],

  'identity:credential_expired': [
    {
      metricName: 'forge_identity_credential_expirations_total',
      type: 'counter',
      description: 'Total credential expiration events',
      labelKeys: ['agent_id', 'credential_type'],
      extract: (e) => {
        const ev = asEvent<'identity:credential_expired'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, credential_type: ev.credentialType } }
      },
    },
  ],

  'identity:trust_updated': [
    {
      metricName: 'forge_identity_trust_updates_total',
      type: 'counter',
      description: 'Total trust score update events',
      labelKeys: ['agent_id'],
      extract: (e) => {
        const ev = asEvent<'identity:trust_updated'>(e)
        return { value: 1, labels: { agent_id: ev.agentId } }
      },
    },
  ],

  'identity:delegation_issued': [
    {
      metricName: 'forge_identity_delegations_total',
      type: 'counter',
      description: 'Total delegation token issuances',
      labelKeys: ['delegator'],
      extract: (e) => {
        const ev = asEvent<'identity:delegation_issued'>(e)
        return { value: 1, labels: { delegator: ev.delegator } }
      },
    },
  ],

} satisfies MetricMapFragment

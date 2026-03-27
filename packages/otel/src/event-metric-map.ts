/**
 * Event-to-metric mapping rules.
 *
 * Each ForgeEvent type maps to zero or more metric operations.
 * This table drives the OTelBridge's metric recording.
 */

import type { ForgeEvent, ForgeEventOf } from '@forgeagent/core'

/**
 * A single metric mapping rule: defines how a ForgeEvent translates
 * to a metric observation (counter increment or histogram record).
 */
export interface MetricMapping {
  /** Metric name (e.g. 'forge_agent_runs_total') */
  metricName: string
  /** Metric type */
  type: 'counter' | 'histogram' | 'gauge'
  /** Human-readable description for the metric */
  description: string
  /** Label keys used by this metric */
  labelKeys: string[]
  /**
   * Extract metric value and labels from an event.
   * For counters, value defaults to 1 if not specified.
   */
  extract: (event: ForgeEvent) => { value: number; labels: Record<string, string> }
}

/** Helper to safely narrow event types */
function as<T extends ForgeEvent['type']>(event: ForgeEvent): ForgeEventOf<T> {
  return event as ForgeEventOf<T>
}

/**
 * Complete mapping of ForgeEvent types to their metric representations.
 *
 * Events not listed here (mapped to empty arrays) produce no metrics.
 */
export const EVENT_METRIC_MAP: Record<ForgeEvent['type'], MetricMapping[]> = {
  // --- Agent lifecycle ---
  'agent:started': [
    {
      metricName: 'forge_agent_runs_total',
      type: 'counter',
      description: 'Total agent run starts',
      labelKeys: ['agent_id', 'status'],
      extract: (e) => {
        const ev = as<'agent:started'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, status: 'started' } }
      },
    },
  ],

  'agent:completed': [
    {
      metricName: 'forge_agent_runs_total',
      type: 'counter',
      description: 'Total agent run completions',
      labelKeys: ['agent_id', 'status'],
      extract: (e) => {
        const ev = as<'agent:completed'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, status: 'completed' } }
      },
    },
    {
      metricName: 'forge_agent_duration_seconds',
      type: 'histogram',
      description: 'Agent run duration in seconds',
      labelKeys: ['agent_id'],
      extract: (e) => {
        const ev = as<'agent:completed'>(e)
        return { value: ev.durationMs / 1000, labels: { agent_id: ev.agentId } }
      },
    },
  ],

  'agent:failed': [
    {
      metricName: 'forge_agent_errors_total',
      type: 'counter',
      description: 'Total agent run failures',
      labelKeys: ['agent_id', 'error_code'],
      extract: (e) => {
        const ev = as<'agent:failed'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, error_code: ev.errorCode } }
      },
    },
  ],

  // --- Tool lifecycle ---
  'tool:called': [
    {
      metricName: 'forge_tool_calls_total',
      type: 'counter',
      description: 'Total tool invocations',
      labelKeys: ['tool_name'],
      extract: (e) => {
        const ev = as<'tool:called'>(e)
        return { value: 1, labels: { tool_name: ev.toolName } }
      },
    },
  ],

  'tool:result': [
    {
      metricName: 'forge_tool_duration_seconds',
      type: 'histogram',
      description: 'Tool execution duration in seconds',
      labelKeys: ['tool_name'],
      extract: (e) => {
        const ev = as<'tool:result'>(e)
        return { value: ev.durationMs / 1000, labels: { tool_name: ev.toolName } }
      },
    },
  ],

  'tool:error': [
    {
      metricName: 'forge_tool_errors_total',
      type: 'counter',
      description: 'Total tool execution errors',
      labelKeys: ['tool_name', 'error_code'],
      extract: (e) => {
        const ev = as<'tool:error'>(e)
        return { value: 1, labels: { tool_name: ev.toolName, error_code: ev.errorCode } }
      },
    },
  ],

  // --- Memory ---
  'memory:written': [
    {
      metricName: 'forge_memory_writes_total',
      type: 'counter',
      description: 'Total memory write operations',
      labelKeys: ['namespace'],
      extract: (e) => {
        const ev = as<'memory:written'>(e)
        return { value: 1, labels: { namespace: ev.namespace } }
      },
    },
  ],

  'memory:searched': [
    {
      metricName: 'forge_memory_searches_total',
      type: 'counter',
      description: 'Total memory search operations',
      labelKeys: ['namespace'],
      extract: (e) => {
        const ev = as<'memory:searched'>(e)
        return { value: 1, labels: { namespace: ev.namespace } }
      },
    },
  ],

  'memory:error': [
    {
      metricName: 'forge_memory_errors_total',
      type: 'counter',
      description: 'Total memory operation errors',
      labelKeys: ['namespace'],
      extract: (e) => {
        const ev = as<'memory:error'>(e)
        return { value: 1, labels: { namespace: ev.namespace } }
      },
    },
  ],

  // --- Budget ---
  'budget:warning': [
    {
      metricName: 'forge_budget_warnings_total',
      type: 'counter',
      description: 'Total budget warning events',
      labelKeys: ['level'],
      extract: (e) => {
        const ev = as<'budget:warning'>(e)
        return { value: 1, labels: { level: ev.level } }
      },
    },
  ],

  'budget:exceeded': [
    {
      metricName: 'forge_budget_exceeded_total',
      type: 'counter',
      description: 'Total budget exceeded events',
      labelKeys: ['reason'],
      extract: (e) => {
        const ev = as<'budget:exceeded'>(e)
        return { value: 1, labels: { reason: ev.reason } }
      },
    },
  ],

  // --- Pipeline ---
  'pipeline:phase_changed': [
    {
      metricName: 'forge_pipeline_phase_transitions_total',
      type: 'counter',
      description: 'Total pipeline phase transitions',
      labelKeys: ['from', 'to'],
      extract: (e) => {
        const ev = as<'pipeline:phase_changed'>(e)
        return { value: 1, labels: { from: ev.previousPhase, to: ev.phase } }
      },
    },
  ],

  'pipeline:validation_failed': [
    {
      metricName: 'forge_pipeline_validation_failures_total',
      type: 'counter',
      description: 'Total pipeline validation failures',
      labelKeys: ['phase'],
      extract: (e) => {
        const ev = as<'pipeline:validation_failed'>(e)
        return { value: 1, labels: { phase: ev.phase } }
      },
    },
  ],

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

  // --- MCP ---
  'mcp:connected': [
    {
      metricName: 'forge_mcp_connections_total',
      type: 'counter',
      description: 'Total MCP connection events',
      labelKeys: ['server', 'status'],
      extract: (e) => {
        const ev = as<'mcp:connected'>(e)
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
        const ev = as<'mcp:disconnected'>(e)
        return { value: 1, labels: { server: ev.serverName, status: 'disconnected' } }
      },
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
        const ev = as<'provider:failed'>(e)
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
        const ev = as<'provider:circuit_opened'>(e)
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
        const ev = as<'provider:circuit_closed'>(e)
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
        const ev = as<'identity:resolved'>(e)
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
        const ev = as<'identity:failed'>(e)
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
        const ev = as<'identity:credential_expired'>(e)
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
        const ev = as<'identity:trust_updated'>(e)
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
        const ev = as<'identity:delegation_issued'>(e)
        return { value: 1, labels: { delegator: ev.delegator } }
      },
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
        const ev = as<'registry:health_changed'>(e)
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
        const ev = as<'protocol:message_sent'>(e)
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
        const ev = as<'protocol:message_received'>(e)
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
        const ev = as<'protocol:error'>(e)
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
        const ev = as<'protocol:connected'>(e)
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
        const ev = as<'protocol:disconnected'>(e)
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
        const ev = as<'protocol:state_changed'>(e)
        return { value: 1, labels: { protocol: ev.protocol, new_state: ev.newState } }
      },
    },
  ],

  // --- Pipeline Runtime ---
  'pipeline:run_started': [
    {
      metricName: 'forge_pipeline_runs_total',
      type: 'counter',
      description: 'Total pipeline run starts',
      labelKeys: ['pipeline_id', 'status'],
      extract: (e) => {
        const ev = as<'pipeline:run_started'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId, status: 'started' } }
      },
    },
  ],

  'pipeline:node_started': [
    {
      metricName: 'forge_pipeline_node_executions_total',
      type: 'counter',
      description: 'Total pipeline node starts',
      labelKeys: ['pipeline_id', 'node_type', 'status'],
      extract: (e) => {
        const ev = as<'pipeline:node_started'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId, node_type: ev.nodeType, status: 'started' } }
      },
    },
  ],

  'pipeline:node_completed': [
    {
      metricName: 'forge_pipeline_node_duration_seconds',
      type: 'histogram',
      description: 'Pipeline node execution duration in seconds',
      labelKeys: ['pipeline_id', 'node_id'],
      extract: (e) => {
        const ev = as<'pipeline:node_completed'>(e)
        return { value: ev.durationMs / 1000, labels: { pipeline_id: ev.pipelineId, node_id: ev.nodeId } }
      },
    },
  ],

  'pipeline:node_failed': [
    {
      metricName: 'forge_pipeline_node_failures_total',
      type: 'counter',
      description: 'Total pipeline node failures',
      labelKeys: ['pipeline_id', 'node_id'],
      extract: (e) => {
        const ev = as<'pipeline:node_failed'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId, node_id: ev.nodeId } }
      },
    },
  ],

  'pipeline:node_skipped': [
    {
      metricName: 'forge_pipeline_node_skips_total',
      type: 'counter',
      description: 'Total pipeline node skips',
      labelKeys: ['pipeline_id', 'node_id'],
      extract: (e) => {
        const ev = as<'pipeline:node_skipped'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId, node_id: ev.nodeId } }
      },
    },
  ],

  'pipeline:suspended': [
    {
      metricName: 'forge_pipeline_suspensions_total',
      type: 'counter',
      description: 'Total pipeline suspension events',
      labelKeys: ['pipeline_id'],
      extract: (e) => {
        const ev = as<'pipeline:suspended'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId } }
      },
    },
  ],

  'pipeline:resumed': [
    {
      metricName: 'forge_pipeline_resumptions_total',
      type: 'counter',
      description: 'Total pipeline resumption events',
      labelKeys: ['pipeline_id'],
      extract: (e) => {
        const ev = as<'pipeline:resumed'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId } }
      },
    },
  ],

  'pipeline:loop_iteration': [
    {
      metricName: 'forge_pipeline_loop_iterations_total',
      type: 'counter',
      description: 'Total pipeline loop iterations',
      labelKeys: ['pipeline_id', 'node_id'],
      extract: (e) => {
        const ev = as<'pipeline:loop_iteration'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId, node_id: ev.nodeId } }
      },
    },
  ],

  'pipeline:checkpoint_saved': [
    {
      metricName: 'forge_pipeline_checkpoints_total',
      type: 'counter',
      description: 'Total pipeline checkpoint saves',
      labelKeys: ['pipeline_id'],
      extract: (e) => {
        const ev = as<'pipeline:checkpoint_saved'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId } }
      },
    },
  ],

  'pipeline:run_completed': [
    {
      metricName: 'forge_pipeline_runs_total',
      type: 'counter',
      description: 'Total pipeline run completions',
      labelKeys: ['pipeline_id', 'status'],
      extract: (e) => {
        const ev = as<'pipeline:run_completed'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId, status: 'completed' } }
      },
    },
    {
      metricName: 'forge_pipeline_run_duration_seconds',
      type: 'histogram',
      description: 'Pipeline run duration in seconds',
      labelKeys: ['pipeline_id'],
      extract: (e) => {
        const ev = as<'pipeline:run_completed'>(e)
        return { value: ev.durationMs / 1000, labels: { pipeline_id: ev.pipelineId } }
      },
    },
  ],

  'pipeline:run_failed': [
    {
      metricName: 'forge_pipeline_runs_total',
      type: 'counter',
      description: 'Total pipeline run failures',
      labelKeys: ['pipeline_id', 'status'],
      extract: (e) => {
        const ev = as<'pipeline:run_failed'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId, status: 'failed' } }
      },
    },
  ],

  'pipeline:run_cancelled': [
    {
      metricName: 'forge_pipeline_runs_total',
      type: 'counter',
      description: 'Total pipeline run cancellations',
      labelKeys: ['pipeline_id', 'status'],
      extract: (e) => {
        const ev = as<'pipeline:run_cancelled'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId, status: 'cancelled' } }
      },
    },
  ],

  // --- Security ---
  'policy:evaluated': [
    {
      metricName: 'forge_policy_evaluations_total',
      type: 'counter',
      description: 'Total policy evaluations',
      labelKeys: ['policy_set_id', 'effect'],
      extract: (e) => {
        const ev = as<'policy:evaluated'>(e)
        return { value: 1, labels: { policy_set_id: ev.policySetId, effect: ev.effect } }
      },
    },
    {
      metricName: 'forge_policy_evaluation_duration_us',
      type: 'histogram',
      description: 'Policy evaluation duration in microseconds',
      labelKeys: ['policy_set_id'],
      extract: (e) => {
        const ev = as<'policy:evaluated'>(e)
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
        const ev = as<'policy:denied'>(e)
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
        const ev = as<'policy:set_updated'>(e)
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
        const ev = as<'safety:violation'>(e)
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
        const ev = as<'safety:blocked'>(e)
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
        const ev = as<'safety:kill_requested'>(e)
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
        const ev = as<'memory:threat_detected'>(e)
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
        const ev = as<'memory:quarantined'>(e)
        return { value: 1, labels: { namespace: ev.namespace } }
      },
    },
  ],

  // --- Vector Store ---
  'vector:search_completed': [
    {
      metricName: 'forge_vector_searches_total',
      type: 'counter',
      description: 'Total vector search operations',
      labelKeys: ['provider', 'collection'],
      extract: (e) => {
        const ev = as<'vector:search_completed'>(e)
        return { value: 1, labels: { provider: ev.provider, collection: ev.collection } }
      },
    },
    {
      metricName: 'forge_vector_search_duration_seconds',
      type: 'histogram',
      description: 'Vector search duration in seconds',
      labelKeys: ['provider', 'collection'],
      extract: (e) => {
        const ev = as<'vector:search_completed'>(e)
        return { value: ev.latencyMs / 1000, labels: { provider: ev.provider, collection: ev.collection } }
      },
    },
    {
      metricName: 'forge_vector_search_result_count',
      type: 'histogram',
      description: 'Number of results returned per vector search',
      labelKeys: ['provider', 'collection'],
      extract: (e) => {
        const ev = as<'vector:search_completed'>(e)
        return { value: ev.resultCount, labels: { provider: ev.provider, collection: ev.collection } }
      },
    },
  ],

  'vector:upsert_completed': [
    {
      metricName: 'forge_vector_upserts_total',
      type: 'counter',
      description: 'Total vector upsert operations',
      labelKeys: ['provider', 'collection'],
      extract: (e) => {
        const ev = as<'vector:upsert_completed'>(e)
        return { value: ev.count, labels: { provider: ev.provider, collection: ev.collection } }
      },
    },
    {
      metricName: 'forge_vector_upsert_duration_seconds',
      type: 'histogram',
      description: 'Vector upsert duration in seconds',
      labelKeys: ['provider', 'collection'],
      extract: (e) => {
        const ev = as<'vector:upsert_completed'>(e)
        return { value: ev.latencyMs / 1000, labels: { provider: ev.provider, collection: ev.collection } }
      },
    },
  ],

  'vector:embedding_completed': [
    {
      metricName: 'forge_vector_embeddings_total',
      type: 'counter',
      description: 'Total embedding generation operations',
      labelKeys: ['provider'],
      extract: (e) => {
        const ev = as<'vector:embedding_completed'>(e)
        return { value: 1, labels: { provider: ev.provider } }
      },
    },
    {
      metricName: 'forge_vector_embedding_duration_seconds',
      type: 'histogram',
      description: 'Embedding generation duration in seconds',
      labelKeys: ['provider'],
      extract: (e) => {
        const ev = as<'vector:embedding_completed'>(e)
        return { value: ev.latencyMs / 1000, labels: { provider: ev.provider } }
      },
    },
  ],

  'vector:error': [
    {
      metricName: 'forge_vector_errors_total',
      type: 'counter',
      description: 'Total vector store errors',
      labelKeys: ['provider', 'collection', 'operation'],
      extract: (e) => {
        const ev = as<'vector:error'>(e)
        return { value: 1, labels: { provider: ev.provider, collection: ev.collection, operation: ev.operation } }
      },
    },
  ],

  // --- Memory Retrieval Sources ---
  'memory:retrieval_source_failed': [
    {
      metricName: 'forge_memory_retrieval_source_failures_total',
      type: 'counter',
      description: 'Total memory retrieval source failures',
      labelKeys: ['source'],
      extract: (e) => {
        const ev = as<'memory:retrieval_source_failed'>(e)
        return { value: 1, labels: { source: ev.source } }
      },
    },
    {
      metricName: 'forge_memory_retrieval_source_duration_ms',
      type: 'histogram',
      description: 'Memory retrieval source duration in milliseconds',
      labelKeys: ['source'],
      extract: (e) => {
        const ev = as<'memory:retrieval_source_failed'>(e)
        return { value: ev.durationMs, labels: { source: ev.source } }
      },
    },
  ],

  'memory:retrieval_source_succeeded': [
    {
      metricName: 'forge_memory_retrieval_source_successes_total',
      type: 'counter',
      description: 'Total memory retrieval source successes',
      labelKeys: ['source'],
      extract: (e) => {
        const ev = as<'memory:retrieval_source_succeeded'>(e)
        return { value: 1, labels: { source: ev.source } }
      },
    },
    {
      metricName: 'forge_memory_retrieval_source_duration_ms',
      type: 'histogram',
      description: 'Memory retrieval source duration in milliseconds',
      labelKeys: ['source'],
      extract: (e) => {
        const ev = as<'memory:retrieval_source_succeeded'>(e)
        return { value: ev.durationMs, labels: { source: ev.source } }
      },
    },
  ],

  // --- Pipeline Retry ---
  'pipeline:node_retry': [
    {
      metricName: 'forge_pipeline_node_retries_total',
      type: 'counter',
      description: 'Total pipeline node retry attempts',
      labelKeys: ['pipeline_id', 'node_id', 'attempt'],
      extract: (e) => {
        const ev = as<'pipeline:node_retry'>(e)
        return { value: 1, labels: { pipeline_id: ev.pipelineId, node_id: ev.nodeId, attempt: String(ev.attempt) } }
      },
    },
  ],

  // --- Telemetry ---
  'tool:latency': [
    {
      metricName: 'forge_tool_latency_ms',
      type: 'histogram',
      description: 'Tool execution latency in milliseconds',
      labelKeys: ['tool_name'],
      extract: (e) => {
        const ev = as<'tool:latency'>(e)
        return { value: ev.durationMs, labels: { tool_name: ev.toolName } }
      },
    },
  ],

  'agent:stop_reason': [
    {
      metricName: 'forge_agent_stop_total',
      type: 'counter',
      description: 'Total agent stop events by reason',
      labelKeys: ['agent_id', 'reason'],
      extract: (e) => {
        const ev = as<'agent:stop_reason'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, reason: ev.reason } }
      },
    },
  ],

  'agent:stuck_detected': [
    {
      metricName: 'forge_agent_stuck_detected_total',
      type: 'counter',
      description: 'Total agent stuck detection events',
      labelKeys: ['agent_id', 'reason'],
      extract: (e) => {
        const ev = as<'agent:stuck_detected'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, reason: ev.reason } }
      },
    },
  ],

  // --- Delegation ---
  'delegation:started': [
    {
      metricName: 'forge_delegation_started_total',
      type: 'counter',
      description: 'Total delegation start events',
      labelKeys: ['target_agent_id'],
      extract: (e) => {
        const ev = as<'delegation:started'>(e)
        return { value: 1, labels: { target_agent_id: ev.targetAgentId } }
      },
    },
  ],

  'delegation:completed': [
    {
      metricName: 'forge_delegation_completed_total',
      type: 'counter',
      description: 'Total delegation completion events',
      labelKeys: ['target_agent_id', 'success'],
      extract: (e) => {
        const ev = as<'delegation:completed'>(e)
        return { value: 1, labels: { target_agent_id: ev.targetAgentId, success: String(ev.success) } }
      },
    },
    {
      metricName: 'forge_delegation_duration_ms',
      type: 'histogram',
      description: 'Delegation duration in milliseconds',
      labelKeys: ['target_agent_id'],
      extract: (e) => {
        const ev = as<'delegation:completed'>(e)
        return { value: ev.durationMs, labels: { target_agent_id: ev.targetAgentId } }
      },
    },
  ],

  'delegation:failed': [
    {
      metricName: 'forge_delegation_failed_total',
      type: 'counter',
      description: 'Total delegation failure events',
      labelKeys: ['target_agent_id'],
      extract: (e) => {
        const ev = as<'delegation:failed'>(e)
        return { value: 1, labels: { target_agent_id: ev.targetAgentId } }
      },
    },
  ],

  'delegation:timeout': [
    {
      metricName: 'forge_delegation_timeout_total',
      type: 'counter',
      description: 'Total delegation timeout events',
      labelKeys: ['target_agent_id'],
      extract: (e) => {
        const ev = as<'delegation:timeout'>(e)
        return { value: 1, labels: { target_agent_id: ev.targetAgentId } }
      },
    },
  ],

  'delegation:cancelled': [
    {
      metricName: 'forge_delegation_cancelled_total',
      type: 'counter',
      description: 'Total delegation cancellation events',
      labelKeys: ['target_agent_id'],
      extract: (e) => {
        const ev = as<'delegation:cancelled'>(e)
        return { value: 1, labels: { target_agent_id: ev.targetAgentId } }
      },
    },
  ],

  // --- Supervisor ---
  'supervisor:delegating': [
    {
      metricName: 'forge_supervisor_delegations_total',
      type: 'counter',
      description: 'Total supervisor delegation events',
      labelKeys: ['specialist_id'],
      extract: (e) => {
        const ev = as<'supervisor:delegating'>(e)
        return { value: 1, labels: { specialist_id: ev.specialistId } }
      },
    },
  ],

  'supervisor:delegation_complete': [
    {
      metricName: 'forge_supervisor_delegation_completions_total',
      type: 'counter',
      description: 'Total supervisor delegation completions',
      labelKeys: ['specialist_id', 'success'],
      extract: (e) => {
        const ev = as<'supervisor:delegation_complete'>(e)
        return { value: 1, labels: { specialist_id: ev.specialistId, success: String(ev.success) } }
      },
    },
  ],

  'supervisor:plan_created': [
    {
      metricName: 'forge_supervisor_plans_created_total',
      type: 'counter',
      description: 'Total supervisor plan creation events',
      labelKeys: ['source'],
      extract: (e) => {
        const ev = as<'supervisor:plan_created'>(e)
        return { value: 1, labels: { source: ev.source ?? 'unknown' } }
      },
    },
  ],

  'supervisor:llm_decompose_fallback': [
    {
      metricName: 'forge_supervisor_llm_fallbacks_total',
      type: 'counter',
      description: 'Total supervisor LLM decomposition fallback events',
      labelKeys: [],
      extract: () => ({ value: 1, labels: {} }),
    },
  ],

  // --- Hooks / plugins (no metrics, just span events) ---
  'hook:error': [],
  'plugin:registered': [],

  // --- Agent streaming ---
  'agent:stream_delta': [],
  'agent:stream_done': [],

  // --- Correction & quality ---
  'correction:iteration': [],
  'quality:degraded': [],
  'quality:adjusted': [],
}

/**
 * Get all unique metric names defined in the mapping.
 */
export function getAllMetricNames(): string[] {
  const names = new Set<string>()
  for (const mappings of Object.values(EVENT_METRIC_MAP)) {
    for (const m of mappings) {
      names.add(m.metricName)
    }
  }
  return [...names]
}

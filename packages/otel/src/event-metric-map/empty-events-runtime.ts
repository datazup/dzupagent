import { asEvent, counter, histogram } from './shared.js'
import type { MetricMapFragment } from './types.js'

export const emptyRuntimeMetricMap = {
  // --- System consolidation ---
  'system:degraded': [
    counter(
      'dzip_system_degraded_total',
      'Total system degradation events',
      ['subsystem', 'recoverable'],
      (e) => {
        const ev = asEvent<'system:degraded'>(e)
        return { value: 1, labels: { subsystem: ev.subsystem, recoverable: String(ev.recoverable) } }
      },
    ),
  ],
  'system:consolidation_started': [
    counter(
      'dzip_consolidation_started_total',
      'Total memory consolidation runs started',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],
  'system:consolidation_completed': [
    counter(
      'dzip_consolidation_completed_total',
      'Total memory consolidation runs completed',
      [],
      () => ({ value: 1, labels: {} }),
    ),
    histogram(
      'dzip_consolidation_duration_ms',
      'Duration in ms of memory consolidation',
      [],
      (e) => {
        const ev = asEvent<'system:consolidation_completed'>(e)
        return { value: ev.durationMs, labels: {} }
      },
    ),
    histogram(
      'dzip_consolidation_records_processed',
      'Number of records processed per consolidation',
      [],
      (e) => {
        const ev = asEvent<'system:consolidation_completed'>(e)
        return { value: ev.recordsProcessed, labels: {} }
      },
    ),
  ],
  'system:consolidation_failed': [
    counter(
      'dzip_consolidation_failed_total',
      'Total memory consolidation failures',
      [],
      () => ({ value: 1, labels: {} }),
    ),
    histogram(
      'dzip_consolidation_failed_duration_ms',
      'Duration in ms before consolidation failure',
      [],
      (e) => {
        const ev = asEvent<'system:consolidation_failed'>(e)
        return { value: ev.durationMs, labels: {} }
      },
    ),
  ],

  // --- Degraded operation diagnostics ---
  'cache:degraded': [
    counter(
      'dzip_cache_degraded_total',
      'Total cache degradation events',
      ['operation', 'recoverable'],
      (e) => {
        const ev = asEvent<'cache:degraded'>(e)
        return { value: 1, labels: { operation: ev.operation, recoverable: String(ev.recoverable) } }
      },
    ),
  ],
  'memory:index_failed': [
    counter(
      'dzip_memory_index_failed_total',
      'Total memory index failures',
      ['namespace', 'recoverable'],
      (e) => {
        const ev = asEvent<'memory:index_failed'>(e)
        return { value: 1, labels: { namespace: ev.namespace, recoverable: String(ev.recoverable) } }
      },
    ),
  ],
  'context:transfer_partial': [
    counter(
      'dzip_context_transfer_partial_total',
      'Total partial context transfers',
      ['recoverable'],
      (e) => {
        const ev = asEvent<'context:transfer_partial'>(e)
        return { value: 1, labels: { recoverable: String(ev.recoverable) } }
      },
    ),
  ],
  'context:compress_failed': [
    counter(
      'dzip_context_compress_failed_total',
      'Total context compression failures (summarizer error)',
      ['phase'],
      (e) => {
        const ev = asEvent<'context:compress_failed'>(e)
        return { value: 1, labels: { phase: ev.phase } }
      },
    ),
  ],
  // --- LLM invocation (compliance/audit traceability) ---
  'llm:invoked': [
    counter(
      'dzip_llm_invoked_total',
      'Total LLM invocations recorded for compliance',
      ['agent_id', 'model'],
      (e) => {
        const ev = asEvent<'llm:invoked'>(e)
        return { value: 1, labels: { agent_id: ev.agentId, model: ev.model } }
      },
    ),
    histogram(
      'dzip_llm_input_tokens',
      'Input tokens per LLM invocation',
      ['agent_id', 'model'],
      (e) => {
        const ev = asEvent<'llm:invoked'>(e)
        return { value: ev.inputTokens, labels: { agent_id: ev.agentId, model: ev.model } }
      },
    ),
    histogram(
      'dzip_llm_output_tokens',
      'Output tokens per LLM invocation',
      ['agent_id', 'model'],
      (e) => {
        const ev = asEvent<'llm:invoked'>(e)
        return { value: ev.outputTokens, labels: { agent_id: ev.agentId, model: ev.model } }
      },
    ),
    histogram(
      'dzip_llm_cost_cents',
      'Cost in cents per LLM invocation',
      ['agent_id', 'model'],
      (e) => {
        const ev = asEvent<'llm:invoked'>(e)
        return { value: ev.costCents, labels: { agent_id: ev.agentId, model: ev.model } }
      },
    ),
  ],
  // --- LLM invocation recorded (audit log) ---
  'llm:invocation_recorded': [
    counter(
      'dzip_llm_invocation_recorded_total',
      'Total LLM invocations recorded to the audit log',
      ['provider_id', 'model', 'status'],
      (e) => {
        const ev = asEvent<'llm:invocation_recorded'>(e)
        return {
          value: 1,
          labels: {
            provider_id: ev.providerId,
            model: ev.model,
            status: ev.status,
          },
        }
      },
    ),
  ],
  'audit:sink_failure': [
    counter(
      'dzip_audit_sink_failure_total',
      'Total audit sink write failures',
      ['sink', 'redaction_mode'],
      (e) => {
        const ev = asEvent<'audit:sink_failure'>(e)
        return {
          value: 1,
          labels: {
            sink: ev.sink,
            redaction_mode: ev.redactionMode ?? 'unknown',
          },
        }
      },
    ),
  ],
  // --- Memory PII redaction ---
  'memory:pii_redacted': [
    counter(
      'dzip_memory_pii_redacted_total',
      'Total memory writes where PII was detected and redacted',
      ['agent_id'],
      (e) => {
        const ev = asEvent<'memory:pii_redacted'>(e)
        return { value: 1, labels: { agent_id: ev.agentId } }
      },
    ),
  ],
  'memory:put_failed': [
    counter(
      'dzip_memory_put_failed_total',
      'Total failed memory write-back attempts',
      ['namespace'],
      (e) => {
        const ev = asEvent<'memory:put_failed'>(e)
        return { value: 1, labels: { namespace: ev.namespace } }
      },
    ),
  ],
  // --- Mailbox ---
  'mail:received': [
    counter(
      'dzip_mail_received_total',
      'Total mail messages received by agents',
      ['to'],
      (e) => {
        const ev = asEvent<'mail:received'>(e)
        return { value: 1, labels: { to: ev.message.to } }
      },
    ),
  ],
  // --- Checkpoint / Restore ---
  'checkpoint:created': [
    counter(
      'dzip_checkpoints_created_total',
      'Total checkpoints captured during DSL flow execution',
      ['run_id'],
      (e) => {
        const ev = asEvent<'checkpoint:created'>(e)
        return { value: 1, labels: { run_id: ev.runId } }
      },
    ),
  ],
  'checkpoint:restored': [
    counter(
      'dzip_checkpoints_restored_total',
      'Total checkpoint restore attempts (including misses)',
      ['run_id', 'restored'],
      (e) => {
        const ev = asEvent<'checkpoint:restored'>(e)
        return { value: 1, labels: { run_id: ev.runId, restored: String(ev.restored) } }
      },
    ),
  ],

  // --- Recovery escalation ---
  'recovery:escalation_requested': [
    counter(
      'dzip_recovery_escalation_requested_total',
      'Total recovery escalation requests (all strategies exhausted)',
      ['failed_provider_id'],
      (e) => {
        const ev = asEvent<'recovery:escalation_requested'>(e)
        return { value: 1, labels: { failed_provider_id: ev.failedProviderId } }
      },
    ),
  ],

  // --- Session lifecycle ---
  'session:workflow_created': [
    counter(
      'dzip_session_workflows_created_total',
      'Total session workflows created',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],
  'session:workflow_deleted': [
    counter(
      'dzip_session_workflows_deleted_total',
      'Total session workflows deleted',
      [],
      () => ({ value: 1, labels: {} }),
    ),
  ],
  'session:provider_linked': [
    counter(
      'dzip_session_providers_linked_total',
      'Total provider links established for session workflows',
      ['provider_id'],
      (e) => {
        const ev = asEvent<'session:provider_linked'>(e)
        return { value: 1, labels: { provider_id: ev.providerId } }
      },
    ),
  ],
  'session:provider_switched': [
    counter(
      'dzip_session_providers_switched_total',
      'Total provider switches within session workflows',
      ['to'],
      (e) => {
        const ev = asEvent<'session:provider_switched'>(e)
        return { value: 1, labels: { to: ev.to } }
      },
    ),
  ],
  'session:multi_turn_completed': [
    counter(
      'dzip_session_multi_turn_completed_total',
      'Total multi-turn session completions',
      ['provider_id'],
      (e) => {
        const ev = asEvent<'session:multi_turn_completed'>(e)
        return { value: 1, labels: { provider_id: ev.providerId ?? 'unknown' } }
      },
    ),
    histogram(
      'dzip_session_multi_turn_duration_ms',
      'Duration in ms of multi-turn sessions',
      ['provider_id'],
      (e) => {
        const ev = asEvent<'session:multi_turn_completed'>(e)
        return { value: ev.durationMs, labels: { provider_id: ev.providerId ?? 'unknown' } }
      },
    ),
  ],
  'session:pruned': [
    counter(
      'dzip_session_pruned_total',
      'Total sessions pruned',
      [],
      () => ({ value: 1, labels: {} }),
    ),
    histogram(
      'dzip_session_pruned_count',
      'Number of sessions pruned per prune event',
      [],
      (e) => {
        const ev = asEvent<'session:pruned'>(e)
        return { value: ev.count, labels: {} }
      },
    ),
  ],

  // --- Structured output ---
  'structured_output:parsed': [
    counter(
      'dzip_structured_output_parsed_total',
      'Total structured output parse successes',
      ['schema_name', 'provider_id'],
      (e) => {
        const ev = asEvent<'structured_output:parsed'>(e)
        return { value: 1, labels: { schema_name: ev.schemaName, provider_id: ev.providerId } }
      },
    ),
  ],
  'structured_output:parse_failed': [
    counter(
      'dzip_structured_output_parse_failed_total',
      'Total structured output parse failures',
      ['schema_name', 'provider_id'],
      (e) => {
        const ev = asEvent<'structured_output:parse_failed'>(e)
        return { value: 1, labels: { schema_name: ev.schemaName, provider_id: ev.providerId } }
      },
    ),
  ],
  'structured_output:all_failed': [
    counter(
      'dzip_structured_output_all_failed_total',
      'Total structured output all-attempts failures',
      ['schema_name'],
      (e) => {
        const ev = asEvent<'structured_output:all_failed'>(e)
        return { value: 1, labels: { schema_name: ev.schemaName } }
      },
    ),
  ],
  'tool:output:invalid': [
    counter(
      'dzip_tool_output_invalid_total',
      'Total tool output validation failures',
      ['tool_name'],
      (e) => {
        const ev = asEvent<'tool:output:invalid'>(e)
        return { value: 1, labels: { tool_name: ev.toolName } }
      },
    ),
  ],
  'approval:webhook_failed': [
    counter(
      'dzip_approval_webhook_failed_total',
      'Total approval webhook delivery failures after retries',
      ['webhook_url'],
      (e) => {
        const ev = asEvent<'approval:webhook_failed'>(e)
        return { value: 1, labels: { webhook_url: ev.webhookUrl } }
      },
    ),
  ],
} satisfies MetricMapFragment

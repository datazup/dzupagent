/**
 * Orchestration telemetry helpers.
 *
 * Provides structured logging/span helpers for routing decisions,
 * merge operations, and circuit breaker state changes.
 *
 * Uses OpenTelemetry-compatible span attributes when @opentelemetry/api
 * is available, falls back to structured console.debug otherwise.
 */

export interface RoutingSpanData {
  runId?: string
  taskId: string
  strategy: string
  selectedAgents: string[]
  reason: string
  candidateCount: number
  filteredByCircuitBreaker?: number
}

export interface MergeSpanData {
  runId?: string
  strategy: string
  totalAgents: number
  successCount: number
  timeoutCount: number
  errorCount: number
  mergedStatus: string
}

/**
 * Log a routing decision as a structured span/log entry.
 * OTel-compatible attribute names used.
 */
export function recordRoutingDecision(data: RoutingSpanData): void {
  console.debug('[orchestration:routing]', {
    'orchestration.task_id': data.taskId,
    'orchestration.routing.strategy': data.strategy,
    'orchestration.routing.selected_agents': data.selectedAgents.join(','),
    'orchestration.routing.reason': data.reason,
    'orchestration.routing.candidate_count': data.candidateCount,
    'orchestration.routing.filtered_count': data.filteredByCircuitBreaker ?? 0,
  })
}

/**
 * Log a merge operation result as a structured span/log entry.
 */
export function recordMergeOperation(data: MergeSpanData): void {
  console.debug('[orchestration:merge]', {
    'orchestration.merge.strategy': data.strategy,
    'orchestration.merge.total_agents': data.totalAgents,
    'orchestration.merge.success_count': data.successCount,
    'orchestration.merge.timeout_count': data.timeoutCount,
    'orchestration.merge.error_count': data.errorCount,
    'orchestration.merge.status': data.mergedStatus,
  })
}

/**
 * Log a circuit breaker state change.
 */
export function recordCircuitBreakerEvent(
  agentId: string,
  event: 'timeout' | 'success' | 'trip' | 'reset',
  consecutiveTimeouts?: number,
): void {
  console.debug('[orchestration:circuit_breaker]', {
    'orchestration.circuit_breaker.agent_id': agentId,
    'orchestration.circuit_breaker.event': event,
    'orchestration.circuit_breaker.consecutive_timeouts': consecutiveTimeouts ?? 0,
  })
}

/**
 * Event-to-metric mapping rules.
 *
 * Each DzupEvent type maps to zero or more metric operations.
 * This table drives the OTelBridge's metric recording.
 */

import type { DzupEvent } from '@dzupagent/core'

import {
  agentLifecycleMetricMap,
  approvalMetricMap,
  budgetMetricMap,
  delegationMetricMap,
  emptyEventMetricMap,
  executionLedgerMetricMap,
  governanceMetricMap,
  memoryCoreMetricMap,
  memoryRetrievalSourcesMetricMap,
  personaRegistryMetricMap,
  pipelineCoreMetricMap,
  pipelineRetryMetricMap,
  pipelineRuntimeMetricMap,
  platformIdentityMetricMap,
  platformRegistryProtocolMetricMap,
  schedulerMetricMap,
  skillLifecycleMetricMap,
  supervisorMetricMap,
  telemetryMetricMap,
  toolLifecycleMetricMap,
  vectorMetricMap,
  workflowDomainMetricMap,
} from './event-metric-map/index.js'
import type { MetricMapping } from './event-metric-map/index.js'

/**
 * Complete mapping of DzupEvent types to their metric representations.
 *
 * Events not listed here (mapped to empty arrays) produce no metrics.
 */
export const EVENT_METRIC_MAP = {
  ...agentLifecycleMetricMap,
  ...toolLifecycleMetricMap,
  ...memoryCoreMetricMap,
  ...budgetMetricMap,
  ...pipelineCoreMetricMap,
  ...approvalMetricMap,
  ...platformIdentityMetricMap,
  ...platformRegistryProtocolMetricMap,
  ...pipelineRuntimeMetricMap,
  ...governanceMetricMap,
  ...vectorMetricMap,
  ...memoryRetrievalSourcesMetricMap,
  ...pipelineRetryMetricMap,
  ...telemetryMetricMap,
  ...delegationMetricMap,
  ...supervisorMetricMap,
  ...executionLedgerMetricMap,
  ...schedulerMetricMap,
  ...skillLifecycleMetricMap,
  ...personaRegistryMetricMap,
  ...emptyEventMetricMap,
  ...workflowDomainMetricMap,
} satisfies Record<DzupEvent['type'], MetricMapping[]>

/**
 * Get all unique metric names defined in the mapping.
 */
export function getAllMetricNames(): string[] {
  const names = new Set<string>()
  for (const mappings of Object.values(EVENT_METRIC_MAP)) {
    for (const mapping of mappings) {
      names.add(mapping.metricName)
    }
  }
  return [...names]
}

export type { MetricMapping } from './event-metric-map/index.js'

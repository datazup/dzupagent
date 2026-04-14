/**
 * Types for dynamic topology analysis and execution.
 *
 * Topologies describe how multiple agents communicate during task execution:
 * - hierarchical: coordinator delegates to workers
 * - pipeline: sequential handoff (A -> B -> C)
 * - star: all agents work in parallel, results gathered centrally
 * - mesh: all agents communicate with all others
 * - ring: circular pass with iterative refinement
 */
import type { DzupAgent } from '../../agent/dzip-agent.js'

export type TopologyType = 'hierarchical' | 'pipeline' | 'star' | 'mesh' | 'ring'

export interface TaskCharacteristics {
  /** Number of subtasks */
  subtaskCount: number
  /** Are subtasks interdependent? (0-1, higher = more interdependent) */
  interdependence: number
  /** Does it need iterative refinement? (0-1) */
  iterativeRefinement: number
  /** Is coordination complexity high? (0-1) */
  coordinationComplexity: number
  /** Is speed critical? (0-1) */
  speedPriority: number
  /** Are subtasks sequential by nature? (0-1) */
  sequentialNature: number
}

export interface TopologyRecommendation {
  recommended: TopologyType
  confidence: number // 0-1
  reason: string
  alternatives: Array<{ topology: TopologyType; score: number; reason: string }>
}

export interface TopologyMetrics {
  topology: TopologyType
  totalDurationMs: number
  agentCount: number
  messageCount: number
  errorCount: number
  switchedFrom?: TopologyType
  /** Provider ID when execution was routed through a provider adapter */
  providerId?: string
  /** Number of fallback attempts when using provider adapter execution */
  fallbackAttempts?: number
  /** All providers attempted (in order) when using provider adapter execution */
  attemptedProviders?: string[]
}

export interface TopologyExecutorConfig {
  agents: DzupAgent[]
  task: string
  /** Maximum rounds for ring topology (default: 3) */
  maxRounds?: number
  /** Auto-switch topology on high error rate (default: false) */
  autoSwitch?: boolean
  /** Error rate threshold to trigger switch (default: 0.5) */
  errorThreshold?: number
  /** Abort signal for cancellation */
  signal?: AbortSignal
}

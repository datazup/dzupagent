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
import type { DzupAgent } from "../../agent/dzip-agent.js";

export type TopologyType =
  | "hierarchical"
  | "pipeline"
  | "star"
  | "mesh"
  | "ring";

export interface TaskCharacteristics {
  /** Number of subtasks */
  subtaskCount: number;
  /** Are subtasks interdependent? (0-1, higher = more interdependent) */
  interdependence: number;
  /** Does it need iterative refinement? (0-1) */
  iterativeRefinement: number;
  /** Is coordination complexity high? (0-1) */
  coordinationComplexity: number;
  /** Is speed critical? (0-1) */
  speedPriority: number;
  /** Are subtasks sequential by nature? (0-1) */
  sequentialNature: number;
}

export interface TopologyRecommendation {
  recommended: TopologyType;
  confidence: number; // 0-1
  reason: string;
  alternatives: Array<{
    topology: TopologyType;
    score: number;
    reason: string;
  }>;
}

export interface TopologyMetrics {
  topology: TopologyType;
  totalDurationMs: number;
  agentCount: number;
  messageCount: number;
  errorCount: number;
  switchedFrom?: TopologyType;
  /**
   * ID of the routing decision when the hierarchical topology's supervisor
   * applied a routing/circuit-breaker selection step. Surfaced for
   * observability/audit; undefined when no selection step ran.
   * (W7 routing-decision tracing.)
   */
  routingDecisionId?: string;
}

export interface TopologyExecutorConfig {
  agents: DzupAgent[];
  task: string;
  /** Maximum rounds for ring topology (default: 3) */
  maxRounds?: number;
  /** Auto-switch topology on high error rate (default: false) */
  autoSwitch?: boolean;
  /** Error rate threshold to trigger switch (default: 0.5) */
  errorThreshold?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Post-Run Analyzer — public type contracts.
 *
 * The run/analysis/config/history shapes consumed by the {@link PostRunAnalyzer}
 * coordinator and its serialization helpers. Extracted into a leaf so both the
 * composition root and `serialization.ts` can depend on the types without
 * forming an import cycle.
 *
 * @module self-correction/post-run-analyzer/types
 */

import type { BaseStore } from "@langchain/langgraph";

/** Analysis of a completed pipeline run. */
export interface RunAnalysis {
  runId: string;
  /** Per-node quality scores */
  nodeScores: Map<string, number>;
  /** Errors that occurred and their resolutions */
  errors: Array<{
    nodeId: string;
    error: string;
    resolved: boolean;
    resolution?: string;
    fixAttempt?: number;
  }>;
  /** Overall quality score (0-1) */
  overallScore: number;
  /** Total cost in cents */
  totalCostCents: number;
  /** Total duration in ms */
  totalDurationMs: number;
  /** Task type (e.g., 'crud', 'auth', 'dashboard') */
  taskType: string;
  /** Risk class */
  riskClass: "critical" | "sensitive" | "standard" | "cosmetic";
  /** Whether the run was approved by user */
  approved: boolean;
  /** User feedback (if rejected) */
  feedback?: string;
}

/** A stage of `analyze()` that threw instead of completing. */
export type AnalysisStage =
  | "trajectory"
  | "errorLessons"
  | "successPatterns"
  | "rules"
  | "suboptimalNodes"
  | "history";

/** An analysis stage that failed, and why. */
export interface AnalysisFailure {
  stage: AnalysisStage;
  error: string;
}

/** Result of analyzing a pipeline run. */
export interface AnalysisResult {
  /** Lessons extracted from this run */
  lessonsCreated: number;
  /** Rules generated from errors */
  rulesCreated: number;
  /** Whether trajectory was stored (only for high-quality runs) */
  trajectoryStored: boolean;
  /** Suboptimal nodes detected */
  suboptimalNodes: string[];
  /** Summary for logging */
  summary: string;
  /**
   * Stages that threw instead of completing; empty on a clean analysis.
   *
   * `analyze()` is best-effort and never throws, which meant a run where every
   * write failed returned `lessonsCreated: 0, rulesCreated: 0,
   * trajectoryStored: false` — identical to a run that was simply unremarkable.
   * A self-learning system with a broken store would report "nothing to learn"
   * forever, and the zero counts were the only symptom.
   *
   * Non-empty means the counts above are floors, not measurements.
   */
  failures: AnalysisFailure[];
}

/** Configuration for the PostRunAnalyzer. */
export interface PostRunAnalyzerConfig {
  /** Store for persisting analysis data and lessons */
  store: BaseStore;
  /** Namespace prefix (default: ['post_run']) */
  namespace?: string[];
}

/** A persisted analysis history entry. */
export interface AnalysisHistoryEntry {
  runId: string;
  result: AnalysisResult;
  timestamp: Date;
}

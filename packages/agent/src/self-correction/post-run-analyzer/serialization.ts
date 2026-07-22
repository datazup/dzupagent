/**
 * Post-Run Analyzer — serialization helpers and scoring thresholds.
 *
 * Module-private support code extracted from `post-run-analyzer.ts` to keep the
 * composition root under the file-line ceiling. Converts {@link AnalysisResult}
 * to/from plain store records and defines the score thresholds that gate
 * trajectory storage, success-pattern extraction, and high-node detection.
 *
 * @module self-correction/post-run-analyzer/serialization
 */

import type {
  AnalysisResult,
  AnalysisHistoryEntry,
} from "../post-run-analyzer.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum overall score to store a trajectory */
export const TRAJECTORY_THRESHOLD = 0.7;

/** Minimum overall score to extract success patterns */
export const SUCCESS_PATTERN_THRESHOLD = 0.85;

/** Minimum node score to be considered a "high-scoring" node */
export const HIGH_NODE_SCORE_THRESHOLD = 0.9;

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

export function analysisResultToRecord(
  runId: string,
  result: AnalysisResult
): Record<string, unknown> {
  return {
    runId,
    lessonsCreated: result.lessonsCreated,
    rulesCreated: result.rulesCreated,
    trajectoryStored: result.trajectoryStored,
    suboptimalNodes: result.suboptimalNodes,
    summary: result.summary,
    timestamp: new Date().toISOString(),
    text: `analysis ${runId} lessons=${result.lessonsCreated} rules=${result.rulesCreated}`,
  };
}

export function recordToHistoryEntry(
  value: Record<string, unknown>
): AnalysisHistoryEntry | null {
  if (typeof value["runId"] !== "string") return null;
  return {
    runId: value["runId"] as string,
    result: {
      lessonsCreated:
        typeof value["lessonsCreated"] === "number"
          ? value["lessonsCreated"]
          : 0,
      rulesCreated:
        typeof value["rulesCreated"] === "number" ? value["rulesCreated"] : 0,
      trajectoryStored:
        typeof value["trajectoryStored"] === "boolean"
          ? value["trajectoryStored"]
          : false,
      suboptimalNodes: Array.isArray(value["suboptimalNodes"])
        ? (value["suboptimalNodes"] as string[])
        : [],
      summary: typeof value["summary"] === "string" ? value["summary"] : "",
    },
    timestamp:
      typeof value["timestamp"] === "string"
        ? new Date(value["timestamp"])
        : new Date(),
  };
}

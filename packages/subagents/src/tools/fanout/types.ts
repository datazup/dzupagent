import type {
  InlineAgentDefinition,
  SubagentSpec,
  TaskStatus,
} from "../../contracts/background-task.js";
import type { Clock } from "../../contracts/clock.js";
import type { FanoutBatchStore } from "../../contracts/fanout-batch-store.js";
import type { BackgroundSubagentRuntime } from "../../runtime/background-subagent-runtime.js";

/**
 * Type contracts for the `fanout_template` batch fan-out tool
 * (dynamic-subagents Spec 01). Kept dependency-light so scorers, stores, and
 * eval harnesses can `type`-import the fan-out shapes without pulling in the
 * coordinator implementation.
 */

/** Aggregate limits for a single fan-out invocation (Spec 01 §2). */
export interface FanoutLimits {
  /** Max declared items per batch. Default 200. */
  maxBatchSize: number;
  /** Max in-flight dispatch/settle workers. Default 4. */
  maxConcurrent: number;
  /** Aggregate output-token budget across items (advisory if adapters report no usage). */
  maxTotalOutputTokens?: number;
  /** Aggregate USD budget across items (advisory if adapters report no cost). */
  maxTotalBudgetUsd?: number;
  /** Whole-fan-out wall clock. Default 15 min. */
  maxWallClockMs: number;
  /** Per-item returned output cap in bytes. Default 2 KiB. */
  maxResultBytes: number;
}

export const DEFAULT_FANOUT_LIMITS: FanoutLimits = {
  maxBatchSize: 200,
  maxConcurrent: 4,
  maxWallClockMs: 15 * 60 * 1000, // 15 minutes
  maxResultBytes: 2048, // 2 KiB
};

export interface FanoutToolConfig {
  runtime: BackgroundSubagentRuntime;
  /** Resolves the parent run id for the current tool invocation. */
  resolveParentRunId: () => string;
  /** Deterministic batch-id generator; defaults to a clock+counter id. */
  generateBatchId?: () => string;
  /** Overrides merged over {@link DEFAULT_FANOUT_LIMITS}. */
  limits?: Partial<FanoutLimits>;
  /** Injected clock (no `Date.now()` in core paths); defaults to systemClock. */
  clock?: Clock;
  /**
   * Optional durable ledger for per-item fan-out progress (Phase B hardening).
   * When supplied, the coordinator records the batch and every item lifecycle
   * transition (dispatched → settled/denied/aborted) so a batch's progress and
   * per-item reports survive coordinator loss and remain queryable by `batchId`.
   * Omit for pure in-memory fan-out (the returned {@link FanoutReport} is still
   * complete regardless).
   */
  fanoutBatchStore?: FanoutBatchStore;
}

/** A declared fan-out item. Keys must be unique within a batch. */
export interface FanoutItem {
  key: string;
  input: string | Record<string, unknown>;
}

/** Template-mode arguments (Spec 01 §2.1). */
export type FanoutTemplateArgs = {
  items: FanoutItem[];
  spec: {
    agentId: string;
    /** Inline persona definition, required only when agentId is "inline". */
    definition?: InlineAgentDefinition;
    /** May contain `{{key}}` / `{{input}}` placeholders. */
    instructions?: string;
    outboundScope?: string[];
    memoryScope?: SubagentSpec["memoryScope"];
  };
  /** Clamped to `limits.maxConcurrent`. */
  concurrency?: number;
  ttlMs?: number;
  budget?: {
    maxTotalOutputTokens?: number;
    maxTotalBudgetUsd?: number;
    maxWallClockMs?: number;
  };
};

/** Honest terminal status of a declared item (NFR4). */
export type FanoutItemStatus =
  | TaskStatus
  | "denied"
  | "aborted_budget"
  | "never_dispatched";

export interface FanoutReportItem {
  key: string;
  taskId?: string;
  status: FanoutItemStatus;
  /** Truncated to `limits.maxResultBytes`; retrieve full output via check_subagent. */
  result?: unknown;
  /** Set when the cap trimmed `result`. */
  resultTruncated?: boolean;
  /** Adapter actually used. Left undefined in v1 (routing is Phase C). */
  provider?: string;
  error?: string;
  durationMs?: number;
  outputTokens?: number;
  /** Actual USD cost reported by the adapter for this item, when known. */
  costUsd?: number;
}

/** Structured fan-out result (Spec 01 §5). */
export interface FanoutReport {
  batchId: string;
  mode: "template" | "script";
  declared: number;
  dispatched: number;
  settled: {
    succeeded: number;
    failed: number;
    cancelled: number;
    expired: number;
    denied: number;
    aborted_budget: number;
  };
  /** Declared keys never dispatched — MUST be [] for a clean run. */
  uncovered: string[];
  /** Every declared item, exactly once, in declared order. */
  items: FanoutReportItem[];
  /** Script mode only; always [] in template mode. */
  extraDispatches: Array<{ key: string; taskId: string; status: string }>;
  budget: {
    outputTokensUsed?: number;
    /** Aggregate USD budget reserved up front / per item before dispatch. */
    budgetUsdReserved?: number;
    /** Aggregate USD actually consumed across settled items. */
    budgetUsdActual?: number;
    wallClockMs: number;
    aborted: boolean;
    /** Set when the batch aborted — mirrors the ledger's `abortedReason`. */
    abortedReason?: string;
  };
  /** Script `log()` lines; always [] in template mode. */
  logs: string[];
}

/** Typed validation failure — returned (never thrown) with zero spawns performed. */
export interface FanoutValidationError {
  error: "invalid_batch";
  detail: string;
}

export function isFanoutValidationError(
  value: FanoutReport | FanoutValidationError
): value is FanoutValidationError {
  return "error" in value;
}

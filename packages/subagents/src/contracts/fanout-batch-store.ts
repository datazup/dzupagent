import type { SubagentResult, TaskId, TaskStatus } from "./background-task.js";

export type FanoutBatchMode = "template" | "script";
export type FanoutBatchStatus = "running" | "completed" | "aborted";
export type FanoutBatchItemStatus =
  | TaskStatus
  | "denied"
  | "aborted_budget"
  | "never_dispatched";

export interface FanoutBatchItemRecord {
  key: string;
  taskId?: TaskId;
  status: FanoutBatchItemStatus;
  result?: SubagentResult;
  resultTruncated?: boolean;
  provider?: string;
  error?: string;
  durationMs?: number;
  outputTokens?: number;
  costUsd?: number;
  updatedAt: number;
}

export interface FanoutBatchRecord {
  batchId: string;
  parentRunId: string;
  mode: FanoutBatchMode;
  status: FanoutBatchStatus;
  declared: string[];
  items: FanoutBatchItemRecord[];
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  wallClockMs?: number;
  outputTokensUsed?: number;
  budgetUsdReserved?: number;
  budgetUsdActual?: number;
  abortedReason?: string;
  budgetAborted?: boolean;
}

export interface FanoutBatchCreate {
  batchId: string;
  parentRunId: string;
  mode: FanoutBatchMode;
  declared: string[];
  startedAt: number;
}

export interface FanoutBatchItemUpdate {
  taskId?: TaskId;
  status?: FanoutBatchItemStatus;
  result?: SubagentResult;
  resultTruncated?: boolean;
  provider?: string;
  error?: string;
  durationMs?: number;
  outputTokens?: number;
  costUsd?: number;
  updatedAt: number;
}

export interface FanoutBatchCompleteUpdate {
  status: "completed" | "aborted";
  completedAt: number;
  wallClockMs: number;
  outputTokensUsed?: number;
  budgetUsdReserved?: number;
  budgetUsdActual?: number;
  abortedReason?: string;
  budgetAborted?: boolean;
}

export interface FanoutBatchStore {
  create(batch: FanoutBatchCreate): Promise<void>;
  get(batchId: string): Promise<FanoutBatchRecord | null>;
  recordItem(
    batchId: string,
    itemKey: string,
    update: FanoutBatchItemUpdate
  ): Promise<void>;
  complete(batchId: string, update: FanoutBatchCompleteUpdate): Promise<void>;
}

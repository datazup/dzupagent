import type { AgentResult } from "../ports/agent-port.js";
import type {
  WorkspaceEffect,
  WorkspaceSnapshot,
} from "../ports/workspace-port.js";
import type { AgentRunRequest } from "../types/agent-run-request.js";
import type { BudgetSpec, RunSpec, RunTurnSpec } from "../types/run-spec.js";
import type { TurnEventWorkspace } from "../types/turn-event.js";

/**
 * Internal-only guard/helper functions used by the dialogue scheduler for
 * budget/boundary evaluation, workspace event mapping, schedule-item narrowing,
 * and error normalization. Extracted from `dialogue-scheduler.ts` with zero
 * behavior change; not part of the frozen public API surface (see
 * `CONTRACT_FREEZE.md`).
 */

export interface BudgetUsage {
  inputTokens: number;
  outputTokens: number;
}

export function getTurnBoundaryStopReason(
  runSpec: RunSpec,
  turnIndex: number,
  budgetUsage: BudgetUsage
): string | undefined {
  if (
    runSpec.maxIterations !== undefined &&
    turnIndex >= runSpec.maxIterations
  ) {
    return "maxIterations";
  }

  return getBudgetStopReason(runSpec.budget, budgetUsage);
}

function getBudgetStopReason(
  budget: BudgetSpec | undefined,
  usage: BudgetUsage
): string | undefined {
  if (budget?.maxUsd !== undefined && budget.maxUsd <= 0) {
    return "budget=maxUsd";
  }

  if (
    budget?.maxInputTokens !== undefined &&
    usage.inputTokens >= budget.maxInputTokens
  ) {
    return "budget=maxInputTokens";
  }

  if (
    budget?.maxOutputTokens !== undefined &&
    usage.outputTokens >= budget.maxOutputTokens
  ) {
    return "budget=maxOutputTokens";
  }

  return undefined;
}

export function toTurnEventWorkspace(
  snapshot: WorkspaceSnapshot,
  effect: WorkspaceEffect
): TurnEventWorkspace {
  return {
    baseRevision: snapshot.baseRevision,
    postRevision: effect.postRevision,
    baseTreeHash: snapshot.treeHash,
    postTreeHash: effect.treeHash,
    changedFiles: effect.changedFiles,
    diff: effect.diff,
    applyStatus: effect.applyStatus,
  };
}

export function isAgentRunRequest(
  item: RunTurnSpec | AgentRunRequest
): item is AgentRunRequest {
  return "input" in item && "turnType" in item;
}

export function errorToAgentResult(error: unknown): AgentResult {
  return {
    raw: errorToMessage(error),
  };
}

export function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

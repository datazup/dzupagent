import { selectBranchPath } from "./branch-state.js";
import {
  advanceLoopState,
  createLoopState,
  evaluateLoopAdvance,
} from "./loop-state.js";
import type { RunLoopSpec, RunSpec, RunTurnSpec } from "../types/run-spec.js";

/**
 * Internal-only helpers that flatten a {@link RunSpec}'s declarative turn graph
 * (branches + loops) into a linear schedule. Extracted from
 * `dialogue-scheduler.ts` with zero behavior change; not part of the frozen
 * public API surface (see `CONTRACT_FREEZE.md`).
 */

export interface SchedulePlan {
  items: RunTurnSpec[];
  stopReason?: string | undefined;
}

export function expandRunSpecSchedule(runSpec: RunSpec): SchedulePlan {
  const turnsById = new Map<string, RunTurnSpec>(
    runSpec.turns.map((turn) => [turn.id, turn])
  );
  const branchPathTurnIds = collectBranchPathTurnIds(runSpec.turns);
  const loopMemberIds = collectLoopMemberTurnIds(runSpec.loops ?? []);
  const loopsByFirstTurnId = new Map<string, RunLoopSpec>();

  for (const loop of runSpec.loops ?? []) {
    const firstTurnId = loop.turnIds[0];

    if (firstTurnId !== undefined) {
      loopsByFirstTurnId.set(firstTurnId, loop);
    }
  }

  const expandedTurns: RunTurnSpec[] = [];
  const consumedLoopIds = new Set<string>();
  let stopReason: string | undefined;

  for (const turn of runSpec.turns) {
    if (branchPathTurnIds.has(turn.id)) {
      continue;
    }

    const loop = loopsByFirstTurnId.get(turn.id);

    if (loop !== undefined && !consumedLoopIds.has(loop.id)) {
      consumedLoopIds.add(loop.id);
      stopReason ??= expandLoop(loop, turnsById, expandedTurns);
      continue;
    }

    if (loopMemberIds.has(turn.id)) {
      continue;
    }

    appendTurnWithBranch(turn, turnsById, expandedTurns, new Set<string>());
  }

  return {
    items: expandedTurns,
    stopReason,
  };
}

function expandLoop(
  loop: RunLoopSpec,
  turnsById: Map<string, RunTurnSpec>,
  expandedTurns: RunTurnSpec[]
): string | undefined {
  let loopState = createLoopState(loop.id, loop.maxIterations);
  let advanceDecision = evaluateLoopAdvance(loopState, loop.condition);

  while (advanceDecision.shouldEnter) {
    for (const turnId of loop.turnIds) {
      const turn = turnsById.get(turnId);

      if (turn !== undefined) {
        appendTurnWithBranch(turn, turnsById, expandedTurns, new Set<string>());
      }
    }

    loopState = advanceLoopState(loopState);
    advanceDecision = evaluateLoopAdvance(loopState, loop.condition);
  }

  return advanceDecision.stopReason === "loop=maxIterations"
    ? advanceDecision.stopReason
    : undefined;
}

function appendTurnWithBranch(
  turn: RunTurnSpec,
  turnsById: Map<string, RunTurnSpec>,
  expandedTurns: RunTurnSpec[],
  branchStack: Set<string>
): void {
  expandedTurns.push(turn);

  if (turn.branch === undefined || branchStack.has(turn.branch.id)) {
    return;
  }

  branchStack.add(turn.branch.id);

  for (const turnId of selectBranchPath(turn.branch).turnIds) {
    const branchTurn = turnsById.get(turnId);

    if (branchTurn !== undefined) {
      appendTurnWithBranch(branchTurn, turnsById, expandedTurns, branchStack);
    }
  }

  branchStack.delete(turn.branch.id);
}

function collectBranchPathTurnIds(turns: RunTurnSpec[]): Set<string> {
  const turnIds = new Set<string>();

  for (const turn of turns) {
    for (const path of turn.branch?.paths ?? []) {
      for (const turnId of path.turnIds) {
        turnIds.add(turnId);
      }
    }
  }

  return turnIds;
}

function collectLoopMemberTurnIds(loops: RunLoopSpec[]): Set<string> {
  const turnIds = new Set<string>();

  for (const loop of loops) {
    for (const turnId of loop.turnIds) {
      turnIds.add(turnId);
    }
  }

  return turnIds;
}

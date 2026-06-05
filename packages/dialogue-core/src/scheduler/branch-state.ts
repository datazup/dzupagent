import type {
  DialogueBranch,
  DialogueBranchPath,
} from "../types/dialogue-branch.js";
import { evaluateConditionExpression } from "./loop-state.js";

export interface BranchSelection {
  branchId: string;
  pathId?: string;
  turnIds: string[];
  reason: "condition" | "default" | "none";
}

export function selectBranchPath(branch: DialogueBranch): BranchSelection {
  const matchedPath = branch.paths.find((path) =>
    evaluateConditionExpression(path.condition.expression),
  );

  if (matchedPath !== undefined) {
    return toSelection(branch, matchedPath, "condition");
  }

  if (branch.defaultPathId !== undefined) {
    const defaultPath = branch.paths.find(
      (path) => path.id === branch.defaultPathId,
    );

    if (defaultPath !== undefined) {
      return toSelection(branch, defaultPath, "default");
    }
  }

  return {
    branchId: branch.id,
    turnIds: [],
    reason: "none",
  };
}

function toSelection(
  branch: DialogueBranch,
  path: DialogueBranchPath,
  reason: "condition" | "default",
): BranchSelection {
  return {
    branchId: branch.id,
    pathId: path.id,
    turnIds: path.turnIds,
    reason,
  };
}

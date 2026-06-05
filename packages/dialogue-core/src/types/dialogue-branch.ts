export interface BranchCondition {
  sourceTurnId?: string;
  expression: string;
}

export interface DialogueBranchPath {
  id: string;
  condition: BranchCondition;
  turnIds: string[];
}

export interface DialogueBranch {
  id: string;
  fromTurnId: string;
  paths: DialogueBranchPath[];
  defaultPathId?: string;
}

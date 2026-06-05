export type DirtyPolicy = "reject" | "isolate" | "allow";

export interface WorkspaceSnapshot {
  baseRevision: string;
  treeHash: string;
}

export interface WorkspaceEffect {
  diff: string;
  changedFiles: string[];
  postRevision: string;
  treeHash: string;
  applyStatus: "clean" | "partial" | "failed" | "no-op";
}

export interface WorkspacePort {
  snapshot(): Promise<WorkspaceSnapshot>;
  captureEffect(beforeSnapshot: WorkspaceSnapshot): Promise<WorkspaceEffect>;
}

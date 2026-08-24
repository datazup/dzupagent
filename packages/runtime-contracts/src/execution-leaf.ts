/** Dependency-neutral vocabulary shared by execution requests and evidence. */
export const EXECUTION_LEAF_KINDS = [
  "prompt",
  "agent",
  "adapter.run",
  "worker.dispatch",
] as const;

export type ExecutionLeafKind = (typeof EXECUTION_LEAF_KINDS)[number];

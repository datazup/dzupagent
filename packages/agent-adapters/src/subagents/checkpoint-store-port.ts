import type { CheckpointerPort } from "@dzupagent/subagents";
import type {
  CheckpointStore,
  WorkflowCheckpoint,
} from "../session/workflow-checkpointer.js";

/**
 * Adapts the subagents {@link CheckpointerPort} (opaque snapshot keyed by an
 * arbitrary ref) over the workflow-shaped {@link CheckpointStore} used elsewhere
 * in agent-adapters (in-memory today, Postgres-backed in production). The opaque
 * subagent snapshot is carried in the checkpoint's `state` field; `taskId` maps
 * to `workflowId` and a monotonic version produces the `checkpointRef`.
 *
 * Keeping the mapping here (layer 4) means the subagents package (layer 2) never
 * depends on the concrete checkpoint store — it only knows the port.
 */
export class CheckpointStorePort implements CheckpointerPort {
  private readonly versions = new Map<string, number>();

  constructor(
    private readonly store: CheckpointStore,
    /** Injected for deterministic tests; defaults to the wall clock. */
    private readonly now: () => Date = () => new Date()
  ) {}

  async save(taskId: string, snapshot: unknown): Promise<string> {
    const version = (this.versions.get(taskId) ?? 0) + 1;
    this.versions.set(taskId, version);

    const checkpoint: WorkflowCheckpoint = {
      checkpointId: `${taskId}:${version}`,
      workflowId: taskId,
      version,
      createdAt: this.now(),
      currentStep: "subagent",
      totalSteps: 1,
      completedSteps: [],
      pendingSteps: [],
      providerSessions: [],
      state: { subagentSnapshot: snapshot },
    };
    await this.store.save(checkpoint);
    return checkpoint.checkpointId;
  }

  async load(checkpointRef: string): Promise<unknown | null> {
    const parsed = parseRef(checkpointRef);
    if (!parsed) {
      return null;
    }
    const checkpoint = await this.store.load(parsed.workflowId, parsed.version);
    if (!checkpoint) {
      return null;
    }
    return (
      (checkpoint.state as { subagentSnapshot?: unknown }).subagentSnapshot ??
      null
    );
  }
}

function parseRef(ref: string): { workflowId: string; version: number } | null {
  const idx = ref.lastIndexOf(":");
  if (idx <= 0) {
    return null;
  }
  const workflowId = ref.slice(0, idx);
  const version = Number(ref.slice(idx + 1));
  if (!Number.isInteger(version)) {
    return null;
  }
  return { workflowId, version };
}

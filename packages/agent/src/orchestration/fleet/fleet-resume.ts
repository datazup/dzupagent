import type {
  KnowledgeStore,
  TaskId,
  TaskStatePayload,
} from "@dzupagent/agent-types/fleet";

export interface ResumePlan {
  runId: string;
  /** Tasks whose latest state is non-terminal (claimed/in-progress/etc.). */
  resumableTaskIds: TaskId[];
  completedTaskIds: TaskId[];
  /** Tasks whose latest state is terminal-but-unsuccessful (failed/surrendered). */
  failedTaskIds: TaskId[];
}

export interface ComputeResumePlanOptions {
  knowledge: KnowledgeStore;
  runId: string;
}

interface LatestEntry {
  version: number;
  payload: TaskStatePayload;
}

/**
 * Builds a {@link ResumePlan} from the task-state history recorded in the shared
 * {@link KnowledgeStore} for a run. For each task we resolve the **highest
 * version** task-state envelope (KnowledgeStore.query yields the full append log
 * in write order, not a deduped snapshot, so we cannot rely on order — the
 * monotonic `version` is the authority). A task is resumable when its latest
 * state is non-terminal; `completed` and `failed`/`surrendered` are terminal.
 */
export async function computeResumePlan(
  opts: ComputeResumePlanOptions
): Promise<ResumePlan> {
  const latest = new Map<TaskId, LatestEntry>();

  for await (const env of opts.knowledge.query({
    scope: `run:${opts.runId}`,
    kind: "task-state",
  })) {
    const payload = env.payload as TaskStatePayload;
    const current = latest.get(payload.taskId);
    if (!current || env.version > current.version) {
      latest.set(payload.taskId, { version: env.version, payload });
    }
  }

  const resumable: TaskId[] = [];
  const done: TaskId[] = [];
  const failed: TaskId[] = [];

  for (const [taskId, entry] of latest) {
    const state = entry.payload.state;
    if (state === "completed") {
      done.push(taskId);
    } else if (state === "failed" || state === "surrendered") {
      failed.push(taskId);
    } else {
      // queued | claimed | in-progress | blocked — still needs a run.
      resumable.push(taskId);
    }
  }

  return {
    runId: opts.runId,
    resumableTaskIds: resumable,
    completedTaskIds: done,
    failedTaskIds: failed,
  };
}

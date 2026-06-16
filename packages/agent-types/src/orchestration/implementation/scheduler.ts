import type { ImplementationBatch, ImplementationPlan } from "./types.js";

export interface ScheduledRepoLane {
  repoId: string;
  taskIds: string[];
}

export interface ScheduledBatch {
  id: string;
  title: string;
  mode: ImplementationBatch["mode"];
  lanes: ScheduledRepoLane[];
}

export function buildImplementationSchedule(
  plan: ImplementationPlan,
  completedTaskIds: ReadonlySet<string>,
): ScheduledBatch[] {
  const tasksById = new Map(plan.tasks.map((task) => [task.id, task]));

  return plan.batches.map((batch) => ({
    id: batch.id,
    title: batch.title,
    mode: batch.mode,
    lanes: buildBatchLanes(batch, tasksById, completedTaskIds),
  }));
}

function buildBatchLanes(
  batch: ImplementationBatch,
  tasksById: ReadonlyMap<string, ImplementationPlan["tasks"][number]>,
  completedTaskIds: ReadonlySet<string>,
): ScheduledRepoLane[] {
  const lanes = new Map<string, string[]>();

  for (const taskId of batch.taskIds) {
    const task = tasksById.get(taskId);
    if (!task || completedTaskIds.has(task.id)) {
      continue;
    }

    if (!isRunnable(task.dependsOn, completedTaskIds)) {
      continue;
    }

    const taskIds = lanes.get(task.repoId);
    if (taskIds) {
      taskIds.push(task.id);
    } else {
      lanes.set(task.repoId, [task.id]);
    }
  }

  return Array.from(lanes, ([repoId, taskIds]) => ({ repoId, taskIds }));
}

function isRunnable(
  dependsOn: readonly string[] | undefined,
  completedTaskIds: ReadonlySet<string>,
): boolean {
  if (!dependsOn || dependsOn.length === 0 || completedTaskIds.size === 0) {
    return true;
  }

  return dependsOn.every((taskId) => completedTaskIds.has(taskId));
}

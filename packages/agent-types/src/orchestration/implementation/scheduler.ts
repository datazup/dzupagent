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
  const batchesById = new Map(plan.batches.map((batch) => [batch.id, batch]));

  return plan.batches.map((batch) => ({
    id: batch.id,
    title: batch.title,
    mode: batch.mode,
    lanes: isBatchRunnable(batch, batchesById, completedTaskIds)
      ? buildBatchLanes(batch, tasksById, completedTaskIds)
      : [],
  }));
}

function buildBatchLanes(
  batch: ImplementationBatch,
  tasksById: ReadonlyMap<string, ImplementationPlan["tasks"][number]>,
  completedTaskIds: ReadonlySet<string>,
): ScheduledRepoLane[] {
  if (batch.mode === "serial") {
    return buildSerialBatchLanes(batch, tasksById, completedTaskIds);
  }

  const lanes = new Map<string, string[]>();

  for (const taskId of batch.taskIds) {
    const task = tasksById.get(taskId);
    if (!task || !isTaskRunnable(task, completedTaskIds)) {
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

function buildSerialBatchLanes(
  batch: ImplementationBatch,
  tasksById: ReadonlyMap<string, ImplementationPlan["tasks"][number]>,
  completedTaskIds: ReadonlySet<string>,
): ScheduledRepoLane[] {
  for (const taskId of batch.taskIds) {
    const task = tasksById.get(taskId);
    if (!task || !isTaskRunnable(task, completedTaskIds)) {
      continue;
    }

    return [
      {
        repoId: task.repoId,
        taskIds: [task.id],
      },
    ];
  }

  return [];
}

function isBatchRunnable(
  batch: ImplementationBatch,
  batchesById: ReadonlyMap<string, ImplementationBatch>,
  completedTaskIds: ReadonlySet<string>,
): boolean {
  if (!batch.dependsOn || batch.dependsOn.length === 0) {
    return true;
  }

  return batch.dependsOn.every((batchId) => {
    const dependencyBatch = batchesById.get(batchId);
    return (
      !!dependencyBatch &&
      dependencyBatch.taskIds.every((taskId) => completedTaskIds.has(taskId))
    );
  });
}

function isTaskRunnable(
  task: ImplementationPlan["tasks"][number],
  completedTaskIds: ReadonlySet<string>,
): boolean {
  return (
    !completedTaskIds.has(task.id) &&
    areDependenciesComplete(task.dependsOn, completedTaskIds)
  );
}

function areDependenciesComplete(
  dependsOn: readonly string[] | undefined,
  completedTaskIds: ReadonlySet<string>,
): boolean {
  if (!dependsOn || dependsOn.length === 0) {
    return true;
  }

  return dependsOn.every((taskId) => completedTaskIds.has(taskId));
}

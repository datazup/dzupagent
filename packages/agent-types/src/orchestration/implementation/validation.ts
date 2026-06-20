import type { ImplementationPlan } from "./types.js";

export interface PlanValidationIssue {
  path: string;
  code: string;
  message: string;
}

export interface PlanValidationResult {
  ok: boolean;
  issues: PlanValidationIssue[];
}

export function validateImplementationPlan(
  plan: ImplementationPlan,
): PlanValidationResult {
  const issues: PlanValidationIssue[] = [];
  const repoIds = new Set<string>();

  plan.repos.forEach((repo, index) => {
    if (repoIds.has(repo.id)) {
      issues.push({
        path: `repos[${index}].id`,
        code: "duplicate-repo-id",
        message: `Repo id '${repo.id}' is already used.`,
      });
      return;
    }

    repoIds.add(repo.id);
  });

  const taskIds = new Set<string>();

  plan.tasks.forEach((task, index) => {
    if (taskIds.has(task.id)) {
      issues.push({
        path: `tasks[${index}].id`,
        code: "duplicate-task-id",
        message: `Task id '${task.id}' is already used.`,
      });
    } else {
      taskIds.add(task.id);
    }

    if (!repoIds.has(task.repoId)) {
      issues.push({
        path: `tasks[${index}].repoId`,
        code: "unknown-task-repo",
        message: `Task '${task.id}' references unknown repo '${task.repoId}'.`,
      });
    }

    if (task.acceptanceCriteria.length === 0) {
      issues.push({
        path: `tasks[${index}].acceptanceCriteria`,
        code: "missing-acceptance-criteria",
        message: `Task '${task.id}' must define at least one acceptance criterion.`,
      });
    }

    if (task.validationCommands.length === 0) {
      issues.push({
        path: `tasks[${index}].validationCommands`,
        code: "missing-validation-commands",
        message: `Task '${task.id}' must define at least one validation command.`,
      });
    }

    task.validationCommands.forEach((command, commandIndex) => {
      if (command.cwd !== undefined && !isRepoRelativePath(command.cwd)) {
        issues.push({
          path: `tasks[${index}].validationCommands[${commandIndex}].cwd`,
          code: "validation-cwd-escapes-repo",
          message: "Validation command cwd must stay within the task repo.",
        });
      }
    });
  });

  const batchIds = new Set(plan.batches.map((batch) => batch.id));
  const seenBatchIds = new Set<string>();
  const assignedTaskIds = new Set<string>();

  plan.batches.forEach((batch, batchIndex) => {
    if (seenBatchIds.has(batch.id)) {
      issues.push({
        path: `batches[${batchIndex}].id`,
        code: "duplicate-batch-id",
        message: `Batch id '${batch.id}' is already used.`,
      });
    } else {
      seenBatchIds.add(batch.id);
    }

    batch.taskIds.forEach((taskId, taskIndex) => {
      if (!taskIds.has(taskId)) {
        issues.push({
          path: `batches[${batchIndex}].taskIds[${taskIndex}]`,
          code: "unknown-batch-task",
          message: `Batch '${batch.id}' references unknown task '${taskId}'.`,
        });
        return;
      }

      if (assignedTaskIds.has(taskId)) {
        issues.push({
          path: `batches[${batchIndex}].taskIds[${taskIndex}]`,
          code: "duplicate-batch-task",
          message: `Task '${taskId}' is already assigned to a batch.`,
        });
        return;
      }

      assignedTaskIds.add(taskId);
    });

    batch.dependsOn?.forEach((dependencyId, dependencyIndex) => {
      if (!batchIds.has(dependencyId)) {
        issues.push({
          path: `batches[${batchIndex}].dependsOn[${dependencyIndex}]`,
          code: "unknown-batch-dependency",
          message: `Batch '${batch.id}' depends on unknown batch '${dependencyId}'.`,
        });
      }
    });
  });

  plan.tasks.forEach((task, taskIndex) => {
    if (!assignedTaskIds.has(task.id)) {
      issues.push({
        path: `tasks[${taskIndex}].id`,
        code: "unbatched-task",
        message: `Task '${task.id}' is not assigned to any batch.`,
      });
    }
  });

  plan.tasks.forEach((task, taskIndex) => {
    task.dependsOn?.forEach((dependencyId, dependencyIndex) => {
      if (!taskIds.has(dependencyId)) {
        issues.push({
          path: `tasks[${taskIndex}].dependsOn[${dependencyIndex}]`,
          code: "unknown-task-dependency",
          message: `Task '${task.id}' depends on unknown task '${dependencyId}'.`,
        });
      }
    });
  });

  return {
    ok: issues.length === 0,
    issues,
  };
}

function isRepoRelativePath(value: string): boolean {
  if (value.startsWith("/") || value.startsWith("\\")) {
    return false;
  }

  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return false;
  }

  let depth = 0;
  for (const segment of value.split(/[\\/]+/)) {
    if (segment === "" || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (depth === 0) {
        return false;
      }
      depth -= 1;
      continue;
    }

    depth += 1;
  }

  return true;
}

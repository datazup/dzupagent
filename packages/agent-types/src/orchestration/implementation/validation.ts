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

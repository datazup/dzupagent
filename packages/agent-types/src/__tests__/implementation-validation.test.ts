import { describe, expect, it } from "vitest";

import {
  IMPLEMENTATION_ORCHESTRATION_SCHEMA_VERSION,
  validateImplementationPlan,
} from "../implementation.js";
import type { ImplementationPlan } from "../implementation.js";

function validPlan(): ImplementationPlan {
  return {
    schemaVersion: IMPLEMENTATION_ORCHESTRATION_SCHEMA_VERSION,
    id: "implementation-plan-1",
    goal: "Validate implementation plans.",
    repos: [
      {
        id: "codev",
        path: "apps/codev-app",
        instructions: ["Follow apps/codev-app/AGENTS.md."],
      },
    ],
    batches: [
      {
        id: "batch-1",
        title: "Validation batch",
        mode: "serial",
        taskIds: ["task-1"],
      },
    ],
    tasks: [
      {
        id: "task-1",
        repoId: "codev",
        title: "Add plan validation",
        prompt: "Validate implementation plan structure.",
        scopeFiles: [
          "packages/agent-types/src/orchestration/implementation/validation.ts",
        ],
        acceptanceCriteria: ["Implementation plans are validated."],
        validationCommands: [
          {
            command: "yarn workspace @dzupagent/agent-types typecheck",
            cwd: ".",
            scope: "task",
          },
        ],
      },
    ],
    policy: {
      maxAttemptsPerTask: 2,
      repoConcurrency: 1,
      highRiskRequiresApproval: true,
    },
  };
}

describe("implementation plan validation", () => {
  it("accepts a valid plan", () => {
    expect(validateImplementationPlan(validPlan())).toEqual({
      ok: true,
      issues: [],
    });
  });

  it("rejects duplicate repo ids", () => {
    const plan = validPlan();
    plan.repos.push({
      id: "codev",
      path: "apps/codev-app-copy",
    });

    expect(validateImplementationPlan(plan).issues).toContainEqual({
      path: "repos[1].id",
      code: "duplicate-repo-id",
      message: "Repo id 'codev' is already used.",
    });
  });

  it("rejects duplicate task ids", () => {
    const plan = validPlan();
    plan.tasks.push({
      ...plan.tasks[0]!,
      title: "Duplicate plan validation task",
    });

    expect(validateImplementationPlan(plan).issues).toContainEqual({
      path: "tasks[1].id",
      code: "duplicate-task-id",
      message: "Task id 'task-1' is already used.",
    });
  });

  it("rejects tasks for unknown repos", () => {
    const plan = validPlan();
    plan.tasks[0]!.repoId = "missing-repo";

    expect(validateImplementationPlan(plan).issues).toContainEqual({
      path: "tasks[0].repoId",
      code: "unknown-task-repo",
      message: "Task 'task-1' references unknown repo 'missing-repo'.",
    });
  });

  it("rejects unknown task dependencies", () => {
    const plan = validPlan();
    plan.tasks[0]!.dependsOn = ["missing-task"];

    expect(validateImplementationPlan(plan).issues).toContainEqual({
      path: "tasks[0].dependsOn[0]",
      code: "unknown-task-dependency",
      message: "Task 'task-1' depends on unknown task 'missing-task'.",
    });
  });

  it("rejects tasks without acceptance criteria", () => {
    const plan = validPlan();
    plan.tasks[0]!.acceptanceCriteria = [];

    expect(validateImplementationPlan(plan).issues).toContainEqual({
      path: "tasks[0].acceptanceCriteria",
      code: "missing-acceptance-criteria",
      message: "Task 'task-1' must define at least one acceptance criterion.",
    });
  });

  it("rejects tasks without validation commands", () => {
    const plan = validPlan();
    plan.tasks[0]!.validationCommands = [];

    expect(validateImplementationPlan(plan).issues).toContainEqual({
      path: "tasks[0].validationCommands",
      code: "missing-validation-commands",
      message: "Task 'task-1' must define at least one validation command.",
    });
  });
});

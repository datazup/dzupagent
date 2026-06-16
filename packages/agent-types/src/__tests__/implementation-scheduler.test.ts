import { describe, expect, it } from "vitest";

import {
  buildImplementationSchedule,
  IMPLEMENTATION_ORCHESTRATION_SCHEMA_VERSION,
} from "../implementation.js";
import type { ImplementationPlan } from "../implementation.js";

function plan(): ImplementationPlan {
  return {
    schemaVersion: IMPLEMENTATION_ORCHESTRATION_SCHEMA_VERSION,
    id: "implementation-plan-1",
    goal: "Schedule implementation work.",
    repos: [
      {
        id: "codev",
        path: "apps/codev-app",
      },
      {
        id: "shared-kit",
        path: "shared-kit",
      },
    ],
    batches: [
      {
        id: "batch-1",
        title: "Parallel repo work",
        mode: "parallel-repos",
        taskIds: ["task-codev", "task-shared"],
      },
      {
        id: "batch-2",
        title: "Serial follow-up",
        mode: "serial",
        taskIds: ["task-codev-2"],
      },
    ],
    tasks: [
      {
        id: "task-codev",
        repoId: "codev",
        title: "Implement Codev task",
        prompt: "Change Codev.",
        scopeFiles: ["apps/codev-app/src/index.ts"],
        acceptanceCriteria: ["Codev task is complete."],
        validationCommands: [
          {
            command: "yarn workspace @codev-app/web typecheck",
            cwd: "apps/codev-app",
            scope: "task",
          },
        ],
      },
      {
        id: "task-shared",
        repoId: "shared-kit",
        title: "Implement shared kit task",
        prompt: "Change shared kit.",
        scopeFiles: ["shared-kit/src/index.ts"],
        acceptanceCriteria: ["Shared kit task is complete."],
        validationCommands: [
          {
            command: "yarn typecheck",
            cwd: "shared-kit",
            scope: "task",
          },
        ],
      },
      {
        id: "task-codev-2",
        repoId: "codev",
        title: "Implement Codev follow-up",
        prompt: "Change Codev after the first task.",
        scopeFiles: ["apps/codev-app/src/follow-up.ts"],
        acceptanceCriteria: ["Codev follow-up is complete."],
        validationCommands: [
          {
            command: "yarn workspace @codev-app/web test",
            cwd: "apps/codev-app",
            scope: "task",
          },
        ],
        dependsOn: ["task-codev"],
      },
    ],
    policy: {
      maxAttemptsPerTask: 2,
      repoConcurrency: 2,
      highRiskRequiresApproval: true,
    },
  };
}

describe("implementation schedule builder", () => {
  it("groups runnable tasks into deterministic repo lanes by batch", () => {
    expect(buildImplementationSchedule(plan(), new Set())).toEqual([
      {
        id: "batch-1",
        title: "Parallel repo work",
        mode: "parallel-repos",
        lanes: [
          {
            repoId: "codev",
            taskIds: ["task-codev"],
          },
          {
            repoId: "shared-kit",
            taskIds: ["task-shared"],
          },
        ],
      },
      {
        id: "batch-2",
        title: "Serial follow-up",
        mode: "serial",
        lanes: [
          {
            repoId: "codev",
            taskIds: ["task-codev-2"],
          },
        ],
      },
    ]);
  });

  it("omits tasks with incomplete dependencies from runnable lanes", () => {
    const schedule = buildImplementationSchedule(plan(), new Set(["task-shared"]));

    expect(schedule[1]).toEqual({
      id: "batch-2",
      title: "Serial follow-up",
      mode: "serial",
      lanes: [],
    });
  });

  it("skips missing task ids referenced by a batch", () => {
    const planWithMissingTask = plan();
    planWithMissingTask.batches[0]!.taskIds = [
      "missing-task",
      "task-codev",
      "task-shared",
    ];

    expect(buildImplementationSchedule(planWithMissingTask, new Set())[0]).toEqual({
      id: "batch-1",
      title: "Parallel repo work",
      mode: "parallel-repos",
      lanes: [
        {
          repoId: "codev",
          taskIds: ["task-codev"],
        },
        {
          repoId: "shared-kit",
          taskIds: ["task-shared"],
        },
      ],
    });
  });
});

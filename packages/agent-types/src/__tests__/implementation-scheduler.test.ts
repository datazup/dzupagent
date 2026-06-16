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
        lanes: [],
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

  it("blocks batches until dependency batch tasks are complete", () => {
    const gatedPlan = plan();
    gatedPlan.batches[1]!.dependsOn = ["batch-1"];

    expect(buildImplementationSchedule(gatedPlan, new Set(["task-codev"]))[1]).toEqual({
      id: "batch-2",
      title: "Serial follow-up",
      mode: "serial",
      lanes: [],
    });
  });

  it("unblocks batches when dependency batch tasks are complete", () => {
    const gatedPlan = plan();
    gatedPlan.batches[1]!.dependsOn = ["batch-1"];

    expect(
      buildImplementationSchedule(
        gatedPlan,
        new Set(["task-codev", "task-shared"]),
      )[1],
    ).toEqual({
      id: "batch-2",
      title: "Serial follow-up",
      mode: "serial",
      lanes: [
        {
          repoId: "codev",
          taskIds: ["task-codev-2"],
        },
      ],
    });
  });

  it("returns only the next runnable task for serial batches", () => {
    const serialPlan = plan();
    serialPlan.batches[1]!.taskIds = ["task-shared-2", "task-codev-2"];
    serialPlan.tasks.push({
      id: "task-shared-2",
      repoId: "shared-kit",
      title: "Implement shared follow-up",
      prompt: "Change shared kit after the first task.",
      scopeFiles: ["shared-kit/src/follow-up.ts"],
      acceptanceCriteria: ["Shared follow-up is complete."],
      validationCommands: [
        {
          command: "yarn test",
          cwd: "shared-kit",
          scope: "task",
        },
      ],
    });

    expect(buildImplementationSchedule(serialPlan, new Set(["task-codev"]))[1]).toEqual({
      id: "batch-2",
      title: "Serial follow-up",
      mode: "serial",
      lanes: [
        {
          repoId: "shared-kit",
          taskIds: ["task-shared-2"],
        },
      ],
    });
  });
});

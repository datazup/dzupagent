import { describe, expect, it } from "vitest";

import type { ImplementationPlan, ImplementationTask } from "../implementation.js";

describe("implementation orchestration contracts", () => {
  it("exports versioned implementation plan contracts", async () => {
    const implementation = await import("../implementation.js");

    const task: ImplementationTask = {
      id: "task-1",
      repoId: "dzupagent",
      title: "Define implementation plan contracts",
      prompt: "Add implementation plan contract types.",
      scopeFiles: [
        "packages/agent-types/src/orchestration/implementation/types.ts",
      ],
      acceptanceCriteria: ["Implementation plan contracts are exported."],
      validationCommands: [
        {
          command: "yarn workspace @dzupagent/agent-types typecheck",
          cwd: ".",
          scope: "task",
        },
      ],
      risk: "high",
    };

    const plan: ImplementationPlan = {
      schemaVersion: implementation.IMPLEMENTATION_ORCHESTRATION_SCHEMA_VERSION,
      id: "implementation-plan-1",
      goal: "Define implementation orchestration contracts.",
      repos: [
        {
          id: "dzupagent",
          path: ".",
          instructions: ["Follow dzupagent AGENTS.md."],
        },
      ],
      batches: [
        {
          id: "batch-1",
          title: "Contract definitions",
          mode: "serial",
          taskIds: [task.id],
        },
      ],
      tasks: [task],
      policy: {
        maxAttemptsPerTask: 2,
        repoConcurrency: 1,
        highRiskRequiresApproval: true,
      },
    };

    expect(plan.schemaVersion).toBe(1);
    expect(plan.tasks[0]?.validationCommands[0]?.scope).toBe("task");
    expect(plan.policy.highRiskRequiresApproval).toBe(true);
  });
});

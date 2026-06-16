import { describe, expect, it } from "vitest";
import { mapImplementationTaskToAgentTask } from "../implementation.js";
import type { ImplementationRepoRef, ImplementationTask } from "../implementation.js";

describe("implementation agent task mapper", () => {
  it("maps an implementation task to an agent task", () => {
    const repo = {
      id: "dzupagent",
      path: "/workspaces/dzupagent",
      instructions: "Follow dzupagent package boundaries.",
    } satisfies ImplementationRepoRef;

    const task = {
      id: "task-4",
      repoId: repo.id,
      title: "Add implementation task mapper",
      prompt: "Create mapper from ImplementationTask to AgentTask.",
      scopeFiles: [
        "packages/agent-types/src/orchestration/implementation/agent-task-mapper.ts",
      ],
      acceptanceCriteria: ["Mapper returns the expected AgentTask shape."],
      validationCommands: [
        {
          command:
            "yarn workspace @dzupagent/agent-types test src/__tests__/implementation-agent-task-mapper.test.ts",
          cwd: repo.path,
          scope: "task",
        },
      ],
      dependsOn: ["task-3"],
      maxAttempts: 2,
      risk: "medium",
      tags: ["implementation", "orchestration"],
      provider: "codex",
      runtimePolicy: {
        sandboxMode: "workspace-write",
        networkAccess: false,
        approvalRequired: false,
      },
    } satisfies ImplementationTask;

    expect(mapImplementationTaskToAgentTask({ task, repo })).toEqual({
      id: task.id,
      title: task.title,
      prompt: task.prompt,
      workingDirectory: repo.path,
      targetRepo: repo.id,
      scopeFiles: task.scopeFiles,
      acceptanceCriteria: task.acceptanceCriteria,
      validationCommands: task.validationCommands,
      dependsOn: task.dependsOn,
      maxAttempts: task.maxAttempts,
      risk: task.risk,
      tags: task.tags,
      provider: task.provider,
      runtimePolicy: task.runtimePolicy,
      payload: {
        implementation: {
          repoId: task.repoId,
          repoPath: repo.path,
          instructions: repo.instructions ?? [],
        },
      },
    });
  });
});

import { describe, expect, it } from "vitest";
import type {
  AgentTask,
  AgentTaskResult,
  ReviewDecision,
  ValidationCommand,
} from "../orchestration/fleet/index.js";

describe("fleet agent task contracts", () => {
  it("models adapter-backed execution metadata for scripts and product hosts", async () => {
    await import("../orchestration/fleet/agent-task.js");

    const validationCommand = {
      command: "yarn test",
      cwd: "packages/agent-types",
      timeoutMs: 120_000,
      scope: "task",
      allowFailure: false,
    } satisfies ValidationCommand;

    const task = {
      id: "task-1",
      title: "Add fleet task contracts",
      prompt: "Define provider-neutral task contracts.",
      systemPrompt: "You are implementing DzupAgent contracts.",
      personaId: "contract-engineer",
      templateId: "fleet-task",
      templateVariables: { packageName: "@dzupagent/agent-types" },
      workingDirectory: "/workspaces/dzupagent",
      targetRepo: "dzupagent",
      scopeFiles: ["packages/agent-types/src/orchestration/fleet/agent-task.ts"],
      payload: { planTask: 1 },
      acceptanceCriteria: ["exports AgentTask contracts"],
      outputSchema: { type: "object", required: ["summary"] },
      validationCommands: [validationCommand],
      dependsOn: ["task-0"],
      maxAttempts: 2,
      risk: "medium",
      tags: ["fleet", "contracts"],
      provider: "codex",
      model: "gpt-5",
      runtimePolicy: {
        sandboxMode: "workspace-write",
        networkAccess: false,
        approvalRequired: false,
        maxTurns: 8,
      },
    } satisfies AgentTask;

    const result = {
      taskId: task.id,
      status: "completed",
      providerId: task.provider,
      sessionId: "session-1",
      changedFiles: task.scopeFiles,
      declaredArtifacts: ["dist/index.d.ts"],
      validationResults: [
        {
          command: validationCommand.command,
          status: "passed",
          exitCode: 0,
          durationMs: 530,
          outputPath: "artifacts/task-1/test.log",
          summary: "Focused test passed",
        },
      ],
      blockers: [],
      summary: "Contracts exported for adapter-backed fleet execution.",
      eventsPath: "artifacts/task-1/events.jsonl",
    } satisfies AgentTaskResult;

    const minimalResult = {
      taskId: task.id,
      status: "completed",
    } satisfies AgentTaskResult;

    const review = {
      taskId: task.id,
      attempt: 1,
      decision: "accepted",
      reasons: ["Contract includes execution metadata for host orchestration."],
    } satisfies ReviewDecision;

    expect(result.status).toBe("completed");
    expect(minimalResult).toEqual({ taskId: task.id, status: "completed" });
    expect(review.decision).toBe("accepted");
  });
});

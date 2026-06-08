import { describe, expect, it } from "vitest";
import {
  DYNAMIC_WORKFLOW_SCHEMA_VERSION,
  type DynamicWorkflowEvent,
  type DynamicWorkflowSpec,
} from "../types.js";

describe("dynamic workflow types", () => {
  it("supports a minimal read-only research workflow", () => {
    const spec: DynamicWorkflowSpec = {
      schemaVersion: DYNAMIC_WORKFLOW_SCHEMA_VERSION,
      runIntent: {
        topic: "dynamic-workflow-research",
        targetRepos: ["dzupagent"],
        objective: "Synthesize current dynamic workflow requirements.",
        successCriteria: ["Research summary is written."],
        nonGoals: ["Modify product behavior."],
      },
      policy: {
        sandboxMode: "read-only",
        approvalPolicy: "on-request",
        networkAccess: "disabled",
        allowedCommands: [],
        allowedMcpTools: [],
      },
      providers: [
        {
          provider: "codex",
          roles: ["research-synthesizer"],
          model: "gpt-5",
        },
      ],
      workers: [
        {
          workerId: "research-1",
          role: "research-synthesizer",
          provider: "codex",
          objective: "Read the relevant plan and summarize requirements.",
          targetRepos: ["dzupagent"],
          toolScope: {
            commands: [],
            mcpTools: [],
          },
        },
      ],
      graph: {
        nodes: ["research-1"],
        edges: [],
      },
      artifacts: [
        {
          path: "out/dynamic-workflow/research-summary.json",
          kind: "json",
          required: true,
        },
      ],
      checkpoints: {
        mode: "after-each-worker",
        required: true,
      },
    };

    expect(spec.schemaVersion).toBe("dzup.dynamic-workflow.v1");
  });

  it("supports a workflow.completed event without worker or node identifiers", () => {
    const event: DynamicWorkflowEvent = {
      runId: "run-1",
      timestamp: "2026-06-08T00:00:00.000Z",
      type: "workflow.completed",
      payload: {
        artifactsWritten: 1,
      },
    };

    expect(event.type).toBe("workflow.completed");
  });
});

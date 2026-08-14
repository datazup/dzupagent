import { describe, expect, it } from "vitest";

import {
  PipelineDefinitionSchema,
  type PipelineDefinition,
} from "@dzupagent/core/orchestration";
import { validatePipelineInteractionSpecV1 } from "@dzupagent/runtime-contracts";

import { createFlowCompiler } from "../index.js";

const toolResolver = {
  resolve: () => null,
  listAvailable: () => [],
};

async function compile(root: Record<string, unknown>): Promise<{
  artifact: PipelineDefinition;
  suspensionSites: readonly string[];
}> {
  const result = await createFlowCompiler({ toolResolver }).compileDocument({
    dsl: "dzupflow/v1",
    id: "interaction-lowering",
    version: 1,
    root: { id: "root", ...root },
  });
  expect("errors" in result ? JSON.stringify(result.errors) : "ok").toBe("ok");
  if ("errors" in result) throw new Error(JSON.stringify(result.errors));
  const parsed = PipelineDefinitionSchema.safeParse(result.artifact);
  expect(
    parsed.success,
    parsed.success ? "ok" : JSON.stringify(parsed.error.issues),
  ).toBe(true);
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
  return {
    artifact: parsed.data,
    suspensionSites: result.ports?.suspensionSites ?? [],
  };
}

function approval(id: string): Record<string, unknown> {
  return {
    type: "approval",
    id,
    question: "Proceed?",
    onApprove: [
      { type: "set", id: `${id}-yes`, assign: { [`${id}Approved`]: true } },
    ],
    onReject: [
      { type: "set", id: `${id}-no`, assign: { [`${id}Rejected`]: true } },
    ],
  };
}

function clarification(id: string): Record<string, unknown> {
  return {
    type: "clarification",
    id,
    question: "What should happen next?",
    expected: "text",
    outputKey: `${id}Answer`,
  };
}

describe("pipeline interaction lowering", () => {
  it("emits a direct approval with an exact decision-to-successor map", async () => {
    const { artifact, suspensionSites } = await compile({
      type: "sequence",
      nodes: [approval("review"), { type: "complete", id: "done" }],
    });

    expect(artifact.schemaVersion).toBe("1.1.0");
    const gate = artifact.nodes.find((node) => node.type === "gate");
    expect(gate?.type).toBe("gate");
    if (gate?.type !== "gate" || gate.interaction === undefined) return;
    expect(validatePipelineInteractionSpecV1(gate.interaction)).toMatchObject({
      valid: true,
      issues: [],
    });
    const decisionEdge = artifact.edges.find(
      (edge) => edge.type === "conditional" && edge.sourceNodeId === gate.id,
    );
    expect(decisionEdge?.type).toBe("conditional");
    if (decisionEdge?.type !== "conditional") return;
    expect(decisionEdge.branches).toEqual(
      gate.interaction.kind === "approval"
        ? gate.interaction.outcomeToSuccessor
        : undefined,
    );
    expect(Object.keys(decisionEdge.branches).sort()).toEqual([
      "approved",
      "rejected",
    ]);
    expect(suspensionSites).toEqual([gate.id]);
  });

  it("propagates interaction sites through branch and try/catch composites", async () => {
    const { artifact, suspensionSites } = await compile({
      type: "sequence",
      nodes: [
        {
          type: "branch",
          id: "decision",
          condition: "true",
          then: [approval("branchReview")],
          else: [{ type: "set", id: "skip", assign: { skipped: true } }],
        },
        {
          type: "try_catch",
          id: "recoveryBlock",
          body: [clarification("recovery")],
          catch: [
            { type: "set", id: "caught", assign: { caughtFailure: true } },
          ],
        },
        { type: "complete", id: "done" },
      ],
    });

    type InteractionNode = Extract<
      PipelineDefinition["nodes"][number],
      { type: "gate" | "suspend" }
    >;
    const interactions = artifact.nodes.filter(
      (node): node is InteractionNode =>
        (node.type === "gate" || node.type === "suspend") &&
        node.interaction !== undefined,
    );
    expect(interactions).toHaveLength(2);
    expect(suspensionSites).toEqual(interactions.map((node) => node.id));
    const clarificationNode = interactions.find(
      (node) => node.interaction?.kind === "clarification",
    );
    expect(clarificationNode?.interaction).toMatchObject({
      kind: "clarification",
      outputKey: "recoveryAnswer",
    });
  });

  it.each([
    ["approval", approval("forkReview")],
    ["clarification", clarification("forkQuestion")],
  ])("denies %s under parallel", async (_kind, interaction) => {
    const result = await createFlowCompiler({ toolResolver }).compileDocument({
      dsl: "dzupflow/v1",
      id: "fork-interaction-denied",
      version: 1,
      root: {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "parallel",
            id: "fork",
            branches: [
              [interaction],
              [{ type: "set", id: "other", assign: { other: true } }],
            ],
          },
        ],
      },
    });

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 2,
          code: "PARALLEL_INTERACTION_UNSUPPORTED",
          nodePath: "root.nodes[0].branches[0][0]",
        }),
      ]),
    );
  });
});

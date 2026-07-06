import { describe, it, expect } from "vitest";
import { parseSpddAgentSwarm } from "../spdd.js";
import type { ParseContext } from "../shared.js";
import { parseNodeArray } from "../dispatch.js";

function makeCtx(): ParseContext {
  return { errors: [], hasPositions: false, parseNodeArray };
}

describe("parseSpddAgentSwarm", () => {
  it("parses a valid agent_swarm node with subTasks", () => {
    const ctx = makeCtx();
    const result = parseSpddAgentSwarm(
      {
        spddRunId: "run-1",
        outputKey: "swarmResult",
        subTasks: [
          { role: "review", input: { artifactRef: "artifact-1" } },
          {
            role: "security",
            personaRef: "custom-sec",
            input: { artifactRef: "artifact-1" },
          },
        ],
      },
      "$.root.nodes[0]",
      ctx
    );

    expect(ctx.errors).toEqual([]);
    expect(result).toMatchObject({
      type: "spdd.agent_swarm",
      spddRunId: "run-1",
      outputKey: "swarmResult",
      subTasks: [
        { role: "review", input: { artifactRef: "artifact-1" } },
        {
          role: "security",
          personaRef: "custom-sec",
          input: { artifactRef: "artifact-1" },
        },
      ],
    });
  });

  it("rejects a node with non-array subTasks", () => {
    const ctx = makeCtx();
    const result = parseSpddAgentSwarm(
      { spddRunId: "run-1", outputKey: "swarmResult", subTasks: "nope" },
      "$.root.nodes[0]",
      ctx
    );

    expect(result).toBeNull();
    expect(ctx.errors.length).toBeGreaterThan(0);
    expect(ctx.errors[0]?.code).toBe("EXPECTED_ARRAY");
  });

  it("rejects a subTask missing role", () => {
    const ctx = makeCtx();
    const result = parseSpddAgentSwarm(
      {
        spddRunId: "run-1",
        outputKey: "swarmResult",
        subTasks: [{ input: {} }],
      },
      "$.root.nodes[0]",
      ctx
    );

    expect(result).toBeNull();
    expect(ctx.errors.length).toBeGreaterThan(0);
  });

  it("rejects a node missing spddRunId or outputKey", () => {
    const ctx = makeCtx();
    const result = parseSpddAgentSwarm(
      { outputKey: "swarmResult", subTasks: [] },
      "$.root.nodes[0]",
      ctx
    );

    expect(result).toBeNull();
    expect(ctx.errors.length).toBeGreaterThan(0);
  });
});

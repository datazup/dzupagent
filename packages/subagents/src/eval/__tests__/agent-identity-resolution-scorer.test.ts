import { describe, it, expect } from "vitest";
import { createAgentIdentityResolutionScorer } from "../agent-identity-resolution-scorer.js";
import { runFanoutEvalSuite } from "../harness.js";
import {
  AGENT_IDENTITY_RESOLUTION_SCENARIOS,
  AGENT_IDENTITY_RESOLUTION_KNOWN_BAD_CASE,
} from "../scenarios/agent-identity-resolution-scenarios.js";

describe("createAgentIdentityResolutionScorer", () => {
  it("passes every known-good scenario with score 1", async () => {
    const scorer = createAgentIdentityResolutionScorer();
    const report = await runFanoutEvalSuite(
      "agent-identity-resolution",
      AGENT_IDENTITY_RESOLUTION_SCENARIOS,
      scorer
    );

    expect(report.allPassed).toBe(true);
    expect(report.aggregateScore).toBe(1);
    expect(report.totalCount).toBe(AGENT_IDENTITY_RESOLUTION_SCENARIOS.length);
  });

  it("fails a known-bad case with a wrong expected agentId", async () => {
    const scorer = createAgentIdentityResolutionScorer();
    const result = await scorer.score(
      AGENT_IDENTITY_RESOLUTION_KNOWN_BAD_CASE.input
    );

    expect(result).toMatchObject({ pass: false, score: 0 });
  });

  it("scores partial mismatches proportionally across multiple items", async () => {
    const scorer = createAgentIdentityResolutionScorer();
    const result = await scorer.score({
      template: { agentId: "worker", instructions: "do {{key}}" },
      items: [
        { key: "a", input: "1" },
        { key: "b", input: "2" },
      ],
      expected: {
        a: { agentId: "worker", instructions: "do a" },
        // Wrong instruction expectation for "b".
        b: { agentId: "worker", instructions: "do WRONG" },
      },
    });

    expect(result.pass).toBe(false);
    expect(result.score).toBeCloseTo(0.5, 5);
  });

  it("flags an item with no declared expectation", async () => {
    const scorer = createAgentIdentityResolutionScorer();
    const result = await scorer.score({
      template: { agentId: "worker" },
      items: [{ key: "unexpected", input: "x" }],
      expected: {},
    });

    expect(result.pass).toBe(false);
    expect(result.metadata).toMatchObject({
      mismatches: [
        expect.objectContaining({ key: "unexpected", field: "agentId" }),
      ],
    });
  });

  it("substitutes object inputs as JSON in instructions, matching fanout-tool.ts", async () => {
    const scorer = createAgentIdentityResolutionScorer();
    const result = await scorer.score({
      template: { agentId: "worker", instructions: "payload={{input}}" },
      items: [{ key: "o", input: { a: 1 } }],
      expected: { o: { agentId: "worker", instructions: 'payload={"a":1}' } },
    });

    expect(result).toMatchObject({ pass: true, score: 1 });
  });
});

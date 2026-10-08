import { describe, expect, it } from "vitest";

import type { NodeExecutionPolicy } from "../definition.js";
import { PipelineNodeSchema } from "../schema.js";

// DZA-DSL-V2-EXECUTOR-S5-20261008-P1: the node execution policy is a
// persisted, optional part of a pipeline node.
function toolNode(executionPolicy: unknown): Record<string, unknown> {
  return {
    id: "adapter_0",
    type: "tool",
    toolName: "dzup.runtime.adapter.run",
    arguments: {},
    executionPolicy,
  };
}

function parses(executionPolicy: unknown): boolean {
  return PipelineNodeSchema.safeParse(toolNode(executionPolicy)).success;
}

describe("PipelineNodeBase.executionPolicy", () => {
  it("admits requireApproval: true and keeps it", () => {
    const policy: NodeExecutionPolicy = { requireApproval: true };
    const parsed = PipelineNodeSchema.safeParse(toolNode(policy));
    expect(parsed.success).toBe(true);
    expect(
      parsed.success ? parsed.data.executionPolicy : undefined,
    ).toEqual(policy);
  });

  it("refuses requireApproval other than true and unknown keys", () => {
    expect(parses({ requireApproval: false })).toBe(false);
    expect(parses({ requireApproval: "yes" })).toBe(false);
    expect(parses({ requireApproval: true, budgetCents: 5 })).toBe(false);
  });

  it("keeps nodes without the field valid", () => {
    expect(
      PipelineNodeSchema.safeParse({
        id: "adapter_0",
        type: "tool",
        toolName: "dzup.runtime.adapter.run",
      }).success,
    ).toBe(true);
  });
});

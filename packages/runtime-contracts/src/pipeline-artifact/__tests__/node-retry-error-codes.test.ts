import { describe, expect, it } from "vitest";

import type { NodeRetryPolicy } from "../definition.js";
import { PipelineNodeSchema } from "../schema.js";

// DZA-DSL-V2-EXECUTOR-S5-20261008-R1: exact error-code retry matching is a
// persisted, optional part of the node retry policy.
function toolNode(retryPolicy: unknown): Record<string, unknown> {
  return {
    id: "adapter_0",
    type: "tool",
    toolName: "dzup.runtime.adapter.run",
    arguments: {},
    retries: 2,
    retryPolicy,
  };
}

describe("NodeRetryPolicy.retryableErrorCodes", () => {
  it("admits exact error codes on the node retry policy", () => {
    const policy: NodeRetryPolicy = {
      retryableErrorCodes: ["RATE_LIMITED", "UPSTREAM_TIMEOUT"],
    };
    const parsed = PipelineNodeSchema.safeParse(toolNode(policy));
    expect(parsed.success).toBe(true);
    expect(
      parsed.success ? parsed.data.retryPolicy?.retryableErrorCodes : undefined,
    ).toEqual(["RATE_LIMITED", "UPSTREAM_TIMEOUT"]);
  });

  it("refuses empty or non-string codes", () => {
    expect(PipelineNodeSchema.safeParse(toolNode({ retryableErrorCodes: [""] })).success).toBe(false);
    expect(PipelineNodeSchema.safeParse(toolNode({ retryableErrorCodes: [42] })).success).toBe(false);
    expect(PipelineNodeSchema.safeParse(toolNode({ retryableErrorCodes: "RATE_LIMITED" })).success).toBe(false);
  });

  it("keeps policies without the field valid and still rejects unknown keys", () => {
    expect(PipelineNodeSchema.safeParse(toolNode({ retryableErrors: ["429"] })).success).toBe(true);
    expect(PipelineNodeSchema.safeParse(toolNode({ retryableCodes: ["X"] })).success).toBe(false);
  });
});

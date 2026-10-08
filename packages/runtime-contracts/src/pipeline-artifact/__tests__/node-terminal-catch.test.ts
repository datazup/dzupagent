import { describe, expect, it } from "vitest";

import type { NodeTerminalCatchPolicy } from "../definition.js";
import { PipelineNodeSchema } from "../schema.js";

// DZA-DSL-V2-EXECUTOR-S5-20261008-C1: exact-code terminal catch is a
// persisted, optional part of a pipeline node.
function toolNode(terminalCatch: unknown): Record<string, unknown> {
  return {
    id: "adapter_0",
    type: "tool",
    toolName: "dzup.runtime.adapter.run",
    arguments: {},
    terminalCatch,
  };
}

function parses(terminalCatch: unknown): boolean {
  return PipelineNodeSchema.safeParse(toolNode(terminalCatch)).success;
}

describe("PipelineNodeBase.terminalCatch", () => {
  it("admits continue, complete and fail clauses", () => {
    const policy: NodeTerminalCatchPolicy = {
      clauses: [
        { errorCodes: ["NOT_FOUND"], action: "continue" },
        { errorCodes: ["ALREADY_DONE"], action: "complete" },
        { errorCodes: ["BAD_INPUT", "FORBIDDEN"], action: "fail", failureCode: "DRAFT_REJECTED" },
      ],
    };
    const parsed = PipelineNodeSchema.safeParse(toolNode(policy));
    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.terminalCatch : undefined).toEqual(policy);
  });

  it("requires a failure code exactly when the action is fail", () => {
    expect(parses({ clauses: [{ errorCodes: ["X"], action: "fail" }] })).toBe(false);
    expect(parses({ clauses: [{ errorCodes: ["X"], action: "fail", failureCode: "" }] })).toBe(false);
    expect(
      parses({ clauses: [{ errorCodes: ["X"], action: "continue", failureCode: "Y" }] }),
    ).toBe(false);
  });

  it("refuses empty policies, empty code lists, empty codes and unknown actions", () => {
    expect(parses({ clauses: [] })).toBe(false);
    expect(parses({ clauses: [{ errorCodes: [], action: "continue" }] })).toBe(false);
    expect(parses({ clauses: [{ errorCodes: [""], action: "continue" }] })).toBe(false);
    expect(parses({ clauses: [{ errorCodes: ["X"], action: "retry" }] })).toBe(false);
    expect(parses({ clauses: [{ errorCodes: ["X"], action: "continue", extra: 1 }] })).toBe(false);
    expect(parses({ clauses: [{ errorCodes: ["X"], action: "continue" }], extra: 1 })).toBe(false);
  });

  it("refuses a code claimed by two clauses", () => {
    expect(
      parses({
        clauses: [
          { errorCodes: ["X"], action: "continue" },
          { errorCodes: ["Y", "X"], action: "complete" },
        ],
      }),
    ).toBe(false);
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

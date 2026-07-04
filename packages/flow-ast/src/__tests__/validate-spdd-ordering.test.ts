import { describe, expect, it } from "vitest";
import { validateFlowDocument } from "../validate/document.js";
import type { SchemaIssue } from "../validate/shared.js";

function baseDoc(nodes: Record<string, unknown>[]) {
  return {
    dsl: "dzupflow/v1",
    id: "doc-1",
    version: 1,
    root: { type: "sequence", nodes },
  };
}

describe("spdd.* document-level ordering validation", () => {
  it("rejects spdd.arm_dispatch appearing before its matching spdd.project_plan", () => {
    const issues: SchemaIssue[] = [];
    const doc = baseDoc([
      {
        type: "spdd.arm_dispatch",
        spddRunId: "run-1",
        planRunId: "plan-1",
        outputKey: "dispatchResult",
      },
      {
        type: "spdd.project_plan",
        spddRunId: "run-1",
        promptAssetVersionId: "ver-1",
        outputKey: "planResult",
      },
    ]);
    const result = validateFlowDocument(doc, "root", issues);
    expect(result).toBeNull();
    expect(issues.some((i) => i.code === "SPDD_ORDERING_VIOLATION")).toBe(true);
  });

  it("accepts spdd.arm_dispatch appearing after its matching spdd.project_plan", () => {
    const issues: SchemaIssue[] = [];
    const doc = baseDoc([
      {
        type: "spdd.project_plan",
        spddRunId: "run-1",
        promptAssetVersionId: "ver-1",
        outputKey: "planResult",
      },
      {
        type: "spdd.arm_dispatch",
        spddRunId: "run-1",
        planRunId: "plan-1",
        outputKey: "dispatchResult",
      },
    ]);
    const result = validateFlowDocument(doc, "root", issues);
    expect(issues.some((i) => i.code === "SPDD_ORDERING_VIOLATION")).toBe(
      false,
    );
    expect(result).not.toBeNull();
  });
});

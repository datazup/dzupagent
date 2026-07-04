import { describe, expect, it } from "vitest";
import { validateFlowNode } from "../validate/dispatch.js";
import type { SchemaIssue } from "../validate/shared.js";

function validate(node: Record<string, unknown>) {
  const issues: SchemaIssue[] = [];
  const result = validateFlowNode(node, "root", issues);
  return { result, issues };
}

describe("spdd.* node validators", () => {
  it("accepts a valid spdd.import_sources node", () => {
    const { result, issues } = validate({
      type: "spdd.import_sources",
      spddRunId: "run-1",
      sourceRefs: [{ kind: "repository_artifact", id: "a1" }],
      outputKey: "importedSources",
    });
    expect(issues).toHaveLength(0);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("spdd.import_sources");
  });

  it("rejects spdd.import_sources missing spddRunId", () => {
    const { result, issues } = validate({
      type: "spdd.import_sources",
      sourceRefs: [],
      outputKey: "importedSources",
    });
    expect(result).toBeNull();
    expect(issues.some((i) => i.path.includes("spddRunId"))).toBe(true);
  });

  it("accepts a valid spdd.project_plan node", () => {
    const { result, issues } = validate({
      type: "spdd.project_plan",
      spddRunId: "run-1",
      promptAssetVersionId: "ver-1",
      outputKey: "planResult",
    });
    expect(issues).toHaveLength(0);
    expect(result?.type).toBe("spdd.project_plan");
  });

  it("rejects spdd.arm_dispatch missing planRunId", () => {
    const { result, issues } = validate({
      type: "spdd.arm_dispatch",
      spddRunId: "run-1",
      outputKey: "dispatchResult",
    });
    expect(result).toBeNull();
    expect(issues.some((i) => i.path.includes("planRunId"))).toBe(true);
  });

  it("accepts a valid spdd.run_validation node", () => {
    const { result, issues } = validate({
      type: "spdd.run_validation",
      spddRunId: "run-1",
      planRunId: "plan-1",
      executionRunId: "exec-1",
      outputKey: "validationResult",
    });
    expect(issues).toHaveLength(0);
    expect(result?.type).toBe("spdd.run_validation");
  });
});

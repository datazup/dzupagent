/**
 * Document `dsl` version acceptance.
 *
 * The AST type `FlowDocumentDsl` allows both "dzupflow/v1" and
 * "dzupflow/v1alpha-agent", and the flow-dsl normalizer accepts both. The
 * document validator must accept the same set — otherwise an agent/validate
 * flow authored as "dzupflow/v1alpha-agent" parses but fails validation.
 * Regression for finding M-1 (adapter-dsl-study).
 */
import { describe, expect, it } from "vitest";

import { flowDocumentSchema } from "../validate.js";

const validRoot = {
  type: "sequence",
  id: "root",
  nodes: [{ type: "complete", id: "done" }],
};

describe("document.dsl — version acceptance", () => {
  it("accepts dzupflow/v1", () => {
    const result = flowDocumentSchema.safeParse({
      dsl: "dzupflow/v1",
      id: "wf-v1",
      version: 1,
      root: validRoot,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dsl).toBe("dzupflow/v1");
    }
  });

  it("accepts dzupflow/v1alpha-agent", () => {
    const result = flowDocumentSchema.safeParse({
      dsl: "dzupflow/v1alpha-agent",
      id: "wf-v1alpha",
      version: 1,
      root: validRoot,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.dsl).toBe("dzupflow/v1alpha-agent");
    }
  });

  it("rejects an unknown dsl version with a clear diagnostic", () => {
    const result = flowDocumentSchema.safeParse({
      dsl: "dzupflow/v2-bogus",
      id: "wf-bad",
      version: 1,
      root: validRoot,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toContain("dsl");
    }
  });
});

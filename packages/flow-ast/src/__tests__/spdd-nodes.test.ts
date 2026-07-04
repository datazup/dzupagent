import { describe, expect, it } from "vitest";
import {
  FLOW_NODE_KIND_REGISTRY,
  FLOW_NODE_KINDS,
  isFlowNodeKind,
} from "../types.js";

const SPDD_NODE_KINDS = [
  "spdd.import_sources",
  "spdd.build_source_pack",
  "spdd.run_analysis",
  "spdd.generate_canvas",
  "spdd.validate_canvas",
  "spdd.review_canvas",
  "spdd.project_plan",
  "spdd.arm_dispatch",
  "spdd.run_validation",
  "spdd.collect_proof",
  "spdd.scan_drift",
  "spdd.create_sync_proposal",
] as const;

describe("spdd.* node kinds", () => {
  it("registers all 12 spdd node kinds in FLOW_NODE_KIND_REGISTRY", () => {
    for (const kind of SPDD_NODE_KINDS) {
      expect(FLOW_NODE_KIND_REGISTRY).toHaveProperty(kind, true);
      expect(FLOW_NODE_KINDS).toContain(kind);
      expect(isFlowNodeKind(kind)).toBe(true);
    }
  });
});

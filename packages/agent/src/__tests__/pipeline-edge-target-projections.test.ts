import { describe, expect, it } from "vitest";

import type { PipelineEdge } from "@dzupagent/runtime-contracts/pipeline-artifact";

import {
  projectLoopBodyContainmentTargets,
  projectValidationEdgeTargets,
} from "../pipeline/loop-executor/edge-target-projections.js";
import {
  getErrorTarget,
  getNextNodeIds,
} from "../pipeline/pipeline-shared/edge-resolution.js";

describe("pipeline edge-target projections", () => {
  const sequential: PipelineEdge = {
    type: "sequential",
    sourceNodeId: "source",
    targetNodeId: "next",
  };
  const conditional: PipelineEdge = {
    type: "conditional",
    sourceNodeId: "source",
    predicateName: "route",
    branches: { left: "left", right: "right" },
  };
  const error: PipelineEdge = {
    type: "error",
    sourceNodeId: "source",
    targetNodeId: "recover",
    errorCodes: ["RETRYABLE"],
  };

  it("projects every structural target during definition validation", () => {
    expect(projectValidationEdgeTargets(sequential)).toEqual(["next"]);
    expect(projectValidationEdgeTargets(conditional)).toEqual([
      "left",
      "right",
    ]);
    expect(projectValidationEdgeTargets(error)).toEqual(["recover"]);
  });

  it("projects every target when proving a loop body cannot escape", () => {
    expect(projectLoopBodyContainmentTargets(sequential)).toEqual(["next"]);
    expect(projectLoopBodyContainmentTargets(conditional)).toEqual([
      "left",
      "right",
    ]);
    expect(projectLoopBodyContainmentTargets(error)).toEqual(["recover"]);
  });

  it("keeps traversal successors and error routing in distinct indexes", () => {
    const normalEdges = new Map<string, PipelineEdge[]>([
      ["source", [sequential, conditional, error]],
    ]);
    const errorEdges = new Map<string, PipelineEdge[]>([["source", [error]]]);
    expect(
      getNextNodeIds(
        "source",
        normalEdges,
        // Returns the BRANCH KEY, not a boolean: `getNextNodeIds` stringifies
        // the result and looks it up in `branches`, which here is keyed
        // `left`/`right`. Narrowing this to `true` selected no branch and
        // dropped "right" from the expected targets.
        { route: () => "right" },
        {}
      )
    ).toEqual(["next", "right"]);
    expect(getErrorTarget("source", errorEdges, "RETRYABLE")).toBe("recover");
  });
});

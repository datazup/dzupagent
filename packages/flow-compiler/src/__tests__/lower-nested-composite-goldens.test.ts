/**
 * Nested-composite golden graphs (doc 14 §7 R2 acceptance): each case pins
 * the COMPLETE lowered node set, edge set and port sets for a nested shape —
 * not individual edges — so an added, dropped or rewired edge anywhere in the
 * composition fails loudly. Every prior lowering miscompile (DSL-02 family)
 * shipped behind targeted-edge tests that could not see the whole graph.
 *
 * Projection is by node NAME (ids are run-variant); edges are sorted, so
 * these goldens pin the semantic graph, not emission order.
 */
import { describe, it, expect } from "vitest";

import type { FlowNode } from "@dzupagent/flow-ast";

import type {
  LowerPipelineContext,
  LowerPipelineResult,
} from "../lower/_shared.js";
import { lowerNodeToPipeline } from "../lower/_shared.js";

function makeCtx(): LowerPipelineContext {
  let n = 0;
  return {
    resolved: new Map(),
    resolvedPersonas: new Map(),
    allowForEach: true,
    mode: "diagnostic",
    idGen: () => `n-${++n}`,
  };
}

function makeAction(toolRef: string): FlowNode {
  return { type: "action", id: toolRef, toolRef, input: {} };
}

interface GraphGolden {
  nodes: string[];
  edges: string[];
  ports: {
    entry: string[];
    normal: string[];
    suspended: string[];
    terminal: string[];
    error: string[];
  };
}

function projectGraph(result: LowerPipelineResult): GraphGolden {
  const nameOf = (id: string): string =>
    result.nodes.find((n) => n.id === id)?.name ?? `<unknown:${id}>`;
  const names = (ids: string[]): string[] => ids.map(nameOf).sort();
  return {
    nodes: result.nodes.map((n) => `${n.type}:${n.name}`).sort(),
    edges: result.edges
      .map((e) => {
        if (e.type === "sequential") {
          return `${nameOf(e.sourceNodeId)} -> ${nameOf(e.targetNodeId)}`;
        }
        if (e.type === "conditional") {
          const branches = Object.entries(e.branches)
            .map(([label, target]) => `${label}=${nameOf(target)}`)
            .sort()
            .join(", ");
          return `${nameOf(e.sourceNodeId)} ?(${branches})`;
        }
        return `${nameOf(e.sourceNodeId)} !-> ${nameOf(e.targetNodeId)}`;
      })
      .sort(),
    ports: {
      entry: names(result.ports?.entryNodeIds ?? []),
      normal: names(result.ports?.normalExits ?? []),
      suspended: names(result.ports?.suspendedExits ?? []),
      terminal: names(result.ports?.terminalExits ?? []),
      error: names(result.ports?.errorExits ?? []),
    },
  };
}

function lowerGolden(node: FlowNode): GraphGolden {
  return projectGraph(lowerNodeToPipeline(node, makeCtx(), "root"));
}

describe("nested-composite lowering goldens", () => {
  it("approval inside an else-less branch arm", () => {
    const golden = lowerGolden({
      type: "sequence",
      nodes: [
        {
          type: "branch",
          condition: "needsReview",
          then: [
            {
              type: "approval",
              question: "ship it?",
              onApprove: [makeAction("ship")],
              onReject: [makeAction("revise")],
            },
          ],
        },
        makeAction("after"),
      ],
    });
    expect(golden).toEqual({
      nodes: [
        "gate:approval:root.nodes[0].then[0]",
        "gate:branch:root.nodes[0]",
        "tool:after",
        "tool:revise",
        "tool:ship",
      ],
      edges: [
        "approval:root.nodes[0].then[0] ?(approved=ship, rejected=revise)",
        "branch:root.nodes[0] -> after",
        "branch:root.nodes[0] ?(true=approval:root.nodes[0].then[0])",
        "revise -> after",
        "ship -> after",
      ],
      ports: {
        entry: ["branch:root.nodes[0]"],
        normal: ["after"],
        suspended: [],
        terminal: [],
        error: [],
      },
    });
  });

  it("branch nested inside a branch then-arm", () => {
    const golden = lowerGolden({
      type: "sequence",
      nodes: [
        {
          type: "branch",
          condition: "outer",
          then: [
            {
              type: "branch",
              condition: "inner",
              then: [makeAction("deep")],
              else: [makeAction("shallow")],
            },
          ],
          else: [makeAction("flat")],
        },
        makeAction("after"),
      ],
    });
    expect(golden).toEqual({
      nodes: [
        "gate:branch:root.nodes[0]",
        "gate:branch:root.nodes[0].then[0]",
        "tool:after",
        "tool:deep",
        "tool:flat",
        "tool:shallow",
      ],
      edges: [
        "branch:root.nodes[0] ?(false=flat, true=branch:root.nodes[0].then[0])",
        "branch:root.nodes[0].then[0] ?(false=shallow, true=deep)",
        "deep -> after",
        "flat -> after",
        "shallow -> after",
      ],
      ports: {
        entry: ["branch:root.nodes[0]"],
        normal: ["after"],
        suspended: [],
        terminal: [],
        error: [],
      },
    });
  });

  it("parallel inside a branch arm, with a terminal parallel branch", () => {
    const golden = lowerGolden({
      type: "sequence",
      nodes: [
        {
          type: "branch",
          condition: "fanOut",
          then: [
            {
              type: "parallel",
              branches: [
                [makeAction("work")],
                [{ type: "complete", id: "bail", result: "done" }],
              ],
            },
          ],
        },
        makeAction("after"),
      ],
    });
    expect(golden).toEqual({
      nodes: [
        "fork:parallel-fork:root.nodes[0].then[0]",
        "gate:branch:root.nodes[0]",
        "join:parallel-join:root.nodes[0].then[0]",
        "suspend:complete:root.nodes[0].then[0].branches[1][0]",
        "tool:after",
        "tool:work",
      ],
      edges: [
        "branch:root.nodes[0] -> after",
        "branch:root.nodes[0] ?(true=parallel-fork:root.nodes[0].then[0])",
        "parallel-fork:root.nodes[0].then[0] -> complete:root.nodes[0].then[0].branches[1][0]",
        "parallel-fork:root.nodes[0].then[0] -> work",
        "parallel-join:root.nodes[0].then[0] -> after",
        "work -> parallel-join:root.nodes[0].then[0]",
      ],
      ports: {
        entry: ["branch:root.nodes[0]"],
        normal: ["after"],
        suspended: [],
        terminal: ["complete:root.nodes[0].then[0].branches[1][0]"],
        error: [],
      },
    });
  });

  it("persona wrapping a parallel body", () => {
    const golden = lowerGolden({
      type: "persona",
      personaId: "qa",
      body: [
        {
          type: "parallel",
          branches: [[makeAction("a")], [makeAction("b")]],
        },
      ],
    });
    expect(golden).toEqual({
      nodes: [
        "fork:parallel-fork:root.body[0]",
        "join:parallel-join:root.body[0]",
        "suspend:persona:qa",
        "tool:a",
        "tool:b",
      ],
      edges: [
        "a -> parallel-join:root.body[0]",
        "b -> parallel-join:root.body[0]",
        "parallel-fork:root.body[0] -> a",
        "parallel-fork:root.body[0] -> b",
        "persona:qa -> parallel-fork:root.body[0]",
      ],
      ports: {
        entry: ["persona:qa"],
        normal: ["parallel-join:root.body[0]"],
        suspended: [],
        terminal: [],
        error: [],
      },
    });
  });

  it("rejects for_each whose body contains an interaction", () => {
    expect(() => lowerGolden({
      type: "for_each",
      source: "items",
      as: "item",
      body: [
        {
          type: "approval",
          question: "keep going?",
          onApprove: [makeAction("proceed")],
          onReject: [makeAction("stop")],
        },
      ],
    })).toThrow("requires a durable per-item bodyGraph");
  });
});

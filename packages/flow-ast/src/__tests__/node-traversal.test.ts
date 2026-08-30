import { describe, expect, it } from "vitest";

import {
  FLOW_BRANCH_CONTAINER_FIELD,
  FLOW_CHILD_CONTAINER_FIELDS,
  FLOW_CHILD_NODE_FIELDS,
  RAW_CHILD_NODE_FIELDS,
  RAW_SNAKE_CASE_CHILD_FIELD_ALIASES,
  RAW_STEP_CONTAINER_FIELD,
  flowChildArrays,
  walkFlowNodes,
  walkRawNodes,
  type FlowChildNodeField,
} from "../node-traversal.js";
import type { FlowNode } from "../types.js";

// ─── Type-level two-way pin against the FlowNode union ─────────────────────
// Derives the child-bearing keys from the union itself, so adding a node type
// with a NEW FlowNode[] field fails compilation until the canonical list
// learns it — and a list entry no union member carries also fails.

type ChildArrayFieldsOf<T> = T extends unknown
  ? {
      [K in keyof T]-?: NonNullable<T[K]> extends FlowNode[] ? K : never;
    }[keyof T]
  : never;

type BranchArrayFieldsOf<T> = T extends unknown
  ? {
      [K in keyof T]-?: NonNullable<T[K]> extends FlowNode[][] ? K : never;
    }[keyof T]
  : never;

const _everyUnionChildFieldIsListed: [ChildArrayFieldsOf<FlowNode>] extends [
  FlowChildNodeField,
]
  ? true
  : false = true;
const _everyListedFieldExistsInUnion: [FlowChildNodeField] extends [
  ChildArrayFieldsOf<FlowNode>,
]
  ? true
  : false = true;
const _branchesIsTheOnlyBranchContainer: [
  BranchArrayFieldsOf<FlowNode>,
] extends ["branches"]
  ? true
  : false = true;
void _everyUnionChildFieldIsListed;
void _everyListedFieldExistsInUnion;
void _branchesIsTheOnlyBranchContainer;

describe("canonical child-field constants", () => {
  // Literal pins: a test derived from its own subject cannot detect it
  // shrinking, so the expected lists are spelled out.
  it("pins FLOW_CHILD_NODE_FIELDS literally", () => {
    expect([...FLOW_CHILD_NODE_FIELDS]).toEqual([
      "nodes",
      "body",
      "then",
      "else",
      "onApprove",
      "onReject",
      "catch",
    ]);
  });

  it("pins the container and raw-dialect derivations literally", () => {
    expect(FLOW_BRANCH_CONTAINER_FIELD).toBe("branches");
    expect([...FLOW_CHILD_CONTAINER_FIELDS]).toEqual([
      "nodes",
      "body",
      "then",
      "else",
      "onApprove",
      "onReject",
      "catch",
      "branches",
    ]);
    expect(RAW_STEP_CONTAINER_FIELD).toBe("steps");
    expect([...RAW_CHILD_NODE_FIELDS]).toEqual([
      "nodes",
      "steps",
      "body",
      "then",
      "else",
      "onApprove",
      "onReject",
      "catch",
    ]);
    expect(RAW_SNAKE_CASE_CHILD_FIELD_ALIASES).toEqual({
      on_approve: "onApprove",
      on_reject: "onReject",
    });
  });
});

describe("walkFlowNodes", () => {
  it("visits every child container of the canonical AST pre-order with paths", () => {
    const ast: FlowNode = {
      type: "sequence",
      id: "root",
      nodes: [
        {
          type: "branch",
          id: "b",
          condition: "true",
          then: [{ type: "complete", id: "t0" }],
          else: [{ type: "complete", id: "e0" }],
        },
        {
          type: "approval",
          id: "a",
          question: "ok?",
          onApprove: [{ type: "complete", id: "ap0" }],
          onReject: [{ type: "complete", id: "rj0" }],
        },
        {
          type: "try_catch",
          id: "tc",
          body: [
            {
              type: "for_each",
              id: "fe",
              source: "items",
              as: "item",
              body: [{ type: "complete", id: "fe0" }],
            },
          ],
          catch: [{ type: "complete", id: "c0" }],
        },
        {
          type: "parallel",
          id: "p",
          branches: [
            [{ type: "complete", id: "p00" }],
            [{ type: "complete", id: "p10" }],
          ],
        },
      ],
    };

    const visited: Array<[string | undefined, string]> = [];
    walkFlowNodes(ast, (node, path) => {
      visited.push([node.id, path]);
    });

    expect(visited).toEqual([
      ["root", "root"],
      ["b", "root.nodes[0]"],
      ["t0", "root.nodes[0].then[0]"],
      ["e0", "root.nodes[0].else[0]"],
      ["a", "root.nodes[1]"],
      ["ap0", "root.nodes[1].onApprove[0]"],
      ["rj0", "root.nodes[1].onReject[0]"],
      ["tc", "root.nodes[2]"],
      ["fe", "root.nodes[2].body[0]"],
      ["fe0", "root.nodes[2].body[0].body[0]"],
      ["c0", "root.nodes[2].catch[0]"],
      ["p", "root.nodes[3]"],
      ["p00", "root.nodes[3].branches[0][0]"],
      ["p10", "root.nodes[3].branches[1][0]"],
    ]);
  });
});

describe("flowChildArrays", () => {
  it("returns child arrays with suffixes in canonical field order, branches last", () => {
    const thenChild: FlowNode = { type: "complete", id: "t0" };
    const p00: FlowNode = { type: "complete", id: "p00" };
    const p10: FlowNode = { type: "complete", id: "p10" };
    expect(
      flowChildArrays({
        type: "branch",
        id: "b",
        condition: "true",
        then: [thenChild],
        else: [],
      }),
    ).toEqual([
      { nodes: [thenChild], suffix: "then" },
      { nodes: [], suffix: "else" },
    ]);
    expect(
      flowChildArrays({
        type: "parallel",
        id: "p",
        branches: [[p00], [p10]],
      }),
    ).toEqual([
      { nodes: [p00], suffix: "branches[0]" },
      { nodes: [p10], suffix: "branches[1]" },
    ]);
  });

  it("omits absent optional containers and returns nothing for leaf nodes", () => {
    expect(
      flowChildArrays({
        type: "branch",
        id: "b",
        condition: "true",
        then: [],
      }),
    ).toEqual([{ nodes: [], suffix: "then" }]);
    expect(
      flowChildArrays({
        type: "approval",
        id: "a",
        question: "ok?",
        onApprove: [],
      }),
    ).toEqual([{ nodes: [], suffix: "onApprove" }]);
    expect(flowChildArrays({ type: "complete", id: "done" })).toEqual([]);
  });
});

describe("walkRawNodes", () => {
  it("follows steps, single-object children, and branch contents on raw values", () => {
    const raw = {
      id: "doc-root",
      steps: [
        {
          id: "s0",
          onApprove: [{ id: "s0-ap0" }],
        },
        {
          id: "s1",
          body: { id: "s1-body" },
          branches: [[{ id: "s1-b00" }], { id: "s1-b1" }],
        },
      ],
    };

    const visited: Array<[unknown, string]> = [];
    walkRawNodes(raw, (node, path) => {
      visited.push([node["id"], path]);
    });

    expect(visited).toEqual([
      ["doc-root", "root"],
      ["s0", "root.steps[0]"],
      ["s0-ap0", "root.steps[0].onApprove[0]"],
      ["s1", "root.steps[1]"],
      ["s1-body", "root.steps[1].body"],
      ["s1-b00", "root.steps[1].branches[0][0]"],
      ["s1-b1", "root.steps[1].branches[1]"],
    ]);
  });

  it("ignores non-object leaves and does not follow snake_case aliases", () => {
    const visited: string[] = [];
    walkRawNodes(
      {
        id: "r",
        then: ["not-a-node", 42, null],
        on_approve: [{ id: "hidden" }],
      },
      (node) => {
        visited.push(String(node["id"]));
      },
    );
    expect(visited).toEqual(["r"]);
  });
});

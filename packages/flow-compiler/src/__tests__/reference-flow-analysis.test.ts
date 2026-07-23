import type { FlowNode } from "@dzupagent/flow-ast";
import type { FlowReferenceBindings } from "@dzupagent/flow-ast/expressions";
import { describe, expect, it } from "vitest";

import {
  deriveNodeReferencePortBindings,
  deriveNodeReferenceTypeBindings,
  mergeReferencePortBindings,
  mergeReferenceTypeBindings,
} from "../stages/reference-symbol-contracts.js";
import {
  deriveNodeReferenceBindings,
  mergeReferenceBindings,
} from "../stages/reference-symbols.js";
import { analyzeReferenceFlow } from "../stages/reference-flow-analysis.js";
import type {
  FlowReferencePortBindings,
  FlowReferenceTypeBindings,
} from "../types.js";

function analyze(
  root: FlowNode,
  options: {
    initial?: FlowReferenceBindings;
    ports?: FlowReferencePortBindings;
    types?: FlowReferenceTypeBindings;
  } = {},
) {
  return analyzeReferenceFlow(root, {
    policy: "strict",
    declarationBindings: mergeReferenceBindings(
      deriveNodeReferenceBindings(root),
      options.initial,
    ),
    initialBindings: options.initial,
    typeBindings: mergeReferenceTypeBindings(
      deriveNodeReferenceTypeBindings(root),
      options.types,
    ),
    portBindings: mergeReferencePortBindings(
      deriveNodeReferencePortBindings(root),
      options.ports,
    ),
  });
}

describe("reference control-flow availability", () => {
  it("keeps state produced by every branch available after the join", () => {
    const result = analyze(
      {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "branch",
            id: "choose",
            condition: "state.flag === true",
            then: [
              { type: "set", id: "left", assign: { shared: "left" } },
            ],
            else: [
              { type: "set", id: "right", assign: { shared: "right" } },
            ],
          },
          {
            type: "complete",
            id: "done",
            result: "{{ state.shared }}",
          },
        ],
      },
      { initial: { state: ["flag"] } },
    );

    expect(result.errors).toEqual([]);
  });

  it("does not promote condition-loop body writes past a zero-iteration loop", () => {
    const result = analyze(
      {
        type: "sequence",
        id: "root",
        nodes: [
          {
            type: "loop",
            id: "retry",
            condition: "state.keepGoing === true",
            body: [
              { type: "set", id: "attempt", assign: { loopValue: true } },
            ],
          },
          {
            type: "complete",
            id: "done",
            result: "{{ state.loopValue }}",
          },
        ],
      },
      { initial: { state: ["keepGoing"] } },
    );

    expect(result.errors).toContainEqual(
      expect.objectContaining({
        nodePath: "root.nodes[1].result",
        message: expect.stringContaining("[REFERENCE_NOT_AVAILABLE]"),
      }),
    );
  });

  it("scopes catch errors to the catch branch", () => {
    const result = analyze({
      type: "sequence",
      id: "root",
      nodes: [
        {
          type: "try_catch",
          id: "recover",
          errorVar: "failure",
          body: [{ type: "wait", id: "work", durationMs: 1 }],
          catch: [
            {
              type: "set",
              id: "record",
              assign: { message: "{{ state.failure }}" },
            },
          ],
        },
        {
          type: "complete",
          id: "done",
          result: "{{ state.failure }}",
        },
      ],
    });

    expect(
      result.errors.filter(
        (error) =>
          error.nodePath === "root.nodes[0].catch[0].assign.message",
      ),
    ).toEqual([]);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        nodePath: "root.nodes[1].result",
        message: expect.stringContaining("[REFERENCE_NOT_AVAILABLE]"),
      }),
    );
  });

  it("checks control references for both step order and declared ports", () => {
    const root: FlowNode = {
      type: "sequence",
      id: "root",
      nodes: [
        {
          type: "branch",
          id: "gate",
          condition: "steps.prepare.result !== null",
          then: [{ type: "wait", id: "inside", durationMs: 1 }],
        },
        { type: "set", id: "prepare", assign: { ready: true } },
      ],
    };

    const unavailable = analyze(root, {
      ports: { prepare: { result: "object" } },
    });
    expect(unavailable.errors).toContainEqual(
      expect.objectContaining({
        nodePath: "root.nodes[0].condition",
        message: expect.stringContaining("[REFERENCE_NOT_AVAILABLE]"),
      }),
    );

    const missingPort = analyze(root, {
      ports: { prepare: { summary: "string" } },
    });
    expect(missingPort.errors).toContainEqual(
      expect.objectContaining({
        nodePath: "root.nodes[0].condition",
        message: expect.stringContaining("[MISSING_REFERENCE_PORT]"),
      }),
    );
  });
});

/**
 * Structured port model (doc 14 §7 R2): `LowerPipelineResult.ports` refines
 * the tails contract without replacing it. These tests pin
 *
 *  1. the invariant `ports.normalExits === effectiveTails(result)` on every
 *     composite shape,
 *  2. the outcome classes the flat tail array erases: an approval gate
 *     without `onReject` is a SUSPENDED exit (not a normal continuation and
 *     not invisible), `complete` is a TERMINAL exit that propagates upward
 *     through branch arms, parallel branches and even `for_each` bodies
 *     (whose normal tails the loop contract deliberately discards), and
 *  3. the reserved, always-empty error port (no ErrorEdge is produced today;
 *     `try_catch.catch` is runtime-only).
 *
 * The complement file `lower-tails-terminal.test.ts` pins the edge-level
 * behaviour; it is migrated alongside, never deleted.
 */
import { describe, it, expect } from "vitest";

import type { FlowNode } from "@dzupagent/flow-ast";

import type {
  LowerPipelineContext,
  LowerPipelineResult,
} from "../lower/_shared.js";
import {
  effectiveTails,
  lowerNodeToPipeline,
  portsOf,
} from "../lower/_shared.js";

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

function lower(node: FlowNode): LowerPipelineResult {
  return lowerNodeToPipeline(node, makeCtx(), "root");
}

function idOfNamePrefix(result: LowerPipelineResult, prefix: string): string {
  const node = result.nodes.find((n) => n.name?.startsWith(prefix));
  if (node === undefined) {
    throw new Error(
      `expected node with name prefix '${prefix}' in [${result.nodes
        .map((n) => n.name)
        .join(", ")}]`
    );
  }
  return node.id;
}

describe("ports refine the tails contract (invariant)", () => {
  const shapes: Array<[string, FlowNode]> = [
    [
      "sequence of actions",
      { type: "sequence", nodes: [makeAction("a"), makeAction("b")] },
    ],
    [
      "else-less branch",
      { type: "branch", condition: "x", then: [makeAction("a")] },
    ],
    [
      "approval without onReject",
      { type: "approval", question: "ok?", onApprove: [makeAction("a")] },
    ],
    [
      "approval with onReject",
      {
        type: "approval",
        question: "ok?",
        onApprove: [makeAction("a")],
        onReject: [makeAction("b")],
      },
    ],
    [
      "parallel with a terminal branch",
      {
        type: "parallel",
        branches: [
          [makeAction("a")],
          [{ type: "complete", id: "done", result: "ok" }],
        ],
      },
    ],
    [
      "persona wrapping a body",
      { type: "persona", personaId: "qa", body: [makeAction("a")] },
    ],
    [
      "for_each over items",
      {
        type: "for_each",
        source: "items",
        as: "item",
        body: [makeAction("a")],
      },
    ],
  ];

  it.each(shapes)("normalExits equals effective tails: %s", (_name, node) => {
    const result = lower(node);
    const ports = result.ports;
    expect(ports).toBeDefined();
    expect(ports?.normalExits).toEqual(effectiveTails(result));
  });

  it("synthesizes single-entry/single-exit ports for a plain leaf", () => {
    const result = lower(makeAction("solo"));
    expect(result.ports).toEqual({
      entryNodeIds: [result.nodes[0]?.id],
      normalExits: [result.nodes[0]?.id],
      suspendedExits: [],
      suspensionSites: [],
      terminalExits: [],
      errorExits: [],
    });
  });

  it("keeps runtime-transparent leaves port-empty", () => {
    const result = lower({
      type: "http",
      id: "fetch",
      url: "https://example.test",
    });
    expect(result.nodes).toHaveLength(0);
    expect(portsOf(result)).toEqual({
      entryNodeIds: [],
      normalExits: [],
      suspendedExits: [],
      suspensionSites: [],
      terminalExits: [],
      errorExits: [],
    });
  });
});

describe("suspended exits (approval gate without onReject)", () => {
  it("classifies the rejected dead-end as a suspended exit, not a normal one", () => {
    const result = lower({
      type: "approval",
      question: "deploy?",
      onApprove: [makeAction("ship")],
    });
    const gateId = idOfNamePrefix(result, "approval:");
    expect(result.ports?.suspendedExits).toEqual([gateId]);
    expect(result.ports?.normalExits).not.toContain(gateId);
    expect(result.ports?.normalExits).toHaveLength(1);
  });

  it("clears the suspended exit when onReject exists (one-dimension control)", () => {
    const result = lower({
      type: "approval",
      question: "deploy?",
      onApprove: [makeAction("ship")],
      onReject: [makeAction("rollback")],
    });
    expect(result.ports?.suspendedExits).toEqual([]);
    expect(result.ports?.normalExits).toHaveLength(2);
  });
});

describe("terminal exits propagate upward", () => {
  it("classifies a lowered complete as a terminal exit", () => {
    const result = lower({ type: "complete", id: "done", result: "ok" });
    const completeId = idOfNamePrefix(result, "complete:");
    expect(result.ports).toEqual({
      entryNodeIds: [completeId],
      normalExits: [],
      suspendedExits: [],
      suspensionSites: [],
      terminalExits: [completeId],
      errorExits: [],
    });
  });

  it("bubbles a complete inside a branch arm to the branch ports", () => {
    const result = lower({
      type: "branch",
      condition: "risky",
      then: [{ type: "complete", id: "halt", result: "stopped" }],
      else: [makeAction("continue")],
    });
    const completeId = idOfNamePrefix(result, "complete:");
    expect(result.ports?.terminalExits).toEqual([completeId]);
    expect(result.ports?.normalExits).not.toContain(completeId);
  });

  it("keeps a terminal parallel branch out of the join but visible as terminal", () => {
    const result = lower({
      type: "parallel",
      branches: [
        [makeAction("work")],
        [{ type: "complete", id: "done", result: "ok" }],
      ],
    });
    const joinId = idOfNamePrefix(result, "parallel-join:");
    const completeId = idOfNamePrefix(result, "complete:");
    expect(result.ports?.normalExits).toEqual([joinId]);
    expect(result.ports?.terminalExits).toEqual([completeId]);
  });

  it("surfaces a complete swallowed by a for_each body (latent DSL-02 gap)", () => {
    const result = lower({
      type: "for_each",
      source: "items",
      as: "item",
      body: [makeAction("work"), { type: "complete", id: "bail", result: "x" }],
    });
    const loopId = idOfNamePrefix(result, "forEach:");
    const completeId = idOfNamePrefix(result, "complete:");
    expect(result.ports?.normalExits).toEqual([loopId]);
    expect(result.ports?.terminalExits).toEqual([completeId]);
  });
});

describe("entry ports", () => {
  it("enters a branch at its gate and a parallel at its fork", () => {
    const branch = lower({
      type: "branch",
      condition: "x",
      then: [makeAction("a")],
    });
    expect(branch.ports?.entryNodeIds).toEqual([
      idOfNamePrefix(branch, "branch:"),
    ]);

    const parallel = lower({
      type: "parallel",
      branches: [[makeAction("a")], [makeAction("b")]],
    });
    expect(parallel.ports?.entryNodeIds).toEqual([
      idOfNamePrefix(parallel, "parallel-fork:"),
    ]);
  });
});

describe("error exits are produced by try_catch (F-R2c, deliberate)", () => {
  // This block previously pinned errorExits as reserved-empty and the catch
  // list as never-lowered; error-path lowering shipped, so the pin is now the
  // positive claim. Full behaviour lives in lower-try-catch.test.ts.
  it("lowers the catch list and classifies its tail as the error exit", () => {
    const result = lower({
      type: "try_catch",
      body: [makeAction("attempt")],
      catch: [makeAction("recover")],
    });
    const recover = result.nodes.find((n) => n.name === "recover");
    expect(recover).toBeDefined();
    expect(result.ports?.errorExits).toEqual([recover?.id]);
    expect(result.edges.some((e) => e.type === "error")).toBe(true);
  });
});

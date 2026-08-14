/**
 * try_catch error-path lowering (F-R2c): the first deliberate production of
 * ErrorEdge. The catch branch is lowered into the graph and every node the
 * body fragment produced gets a catch-all error edge to the catch entry, so
 * the generic runtime's error routing (`getErrorTarget`) lands in the catch
 * fragment instead of failing the run.
 *
 * Port semantics pinned here:
 *  - a handled error RESUMES through the catch tail, which is therefore a
 *    normal exit only; public exit inventories remain pairwise disjoint.
 *  - suspended/terminal exits inside body or catch compose upward unchanged;
 *    a catch ending in `complete` contributes a terminal exit, not an error
 *    exit (it does not continue).
 */
import { describe, it, expect } from "vitest";

import type { FlowNode } from "@dzupagent/flow-ast";

import type {
  LowerPipelineContext,
  LowerPipelineResult,
} from "../lower/_shared.js";
import { effectiveTails, lowerNodeToPipeline } from "../lower/_shared.js";

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

function idOfName(result: LowerPipelineResult, name: string): string {
  const node = result.nodes.find((n) => n.name === name);
  if (node === undefined) {
    throw new Error(
      `expected node named '${name}' in [${result.nodes
        .map((n) => n.name)
        .join(", ")}]`
    );
  }
  return node.id;
}

function errorEdges(result: LowerPipelineResult) {
  return result.edges.filter((e) => e.type === "error");
}

describe("try_catch lowers the catch branch onto the error path", () => {
  const TRY_CATCH: FlowNode = {
    type: "try_catch",
    body: [makeAction("attempt"), makeAction("verify")],
    catch: [makeAction("recover")],
  };

  it("lowers catch nodes into the graph", () => {
    const result = lower(TRY_CATCH);
    expect(result.nodes.map((n) => n.name)).toEqual([
      "attempt",
      "verify",
      "recover",
    ]);
  });

  it("gives EVERY body node a catch-all error edge to the catch entry", () => {
    const result = lower(TRY_CATCH);
    const recoverId = idOfName(result, "recover");
    const errs = errorEdges(result);
    expect(errs).toHaveLength(2);
    for (const name of ["attempt", "verify"]) {
      const edge = errs.find(
        (e) => e.sourceNodeId === idOfName(result, name)
      );
      expect(edge).toBeDefined();
      expect(edge?.targetNodeId).toBe(recoverId);
      // Catch-all: no errorCodes filter.
      expect(
        edge !== undefined && "errorCodes" in edge ? edge.errorCodes : undefined
      ).toBeUndefined();
    }
  });

  it("keeps the catch entry OFF the sequential path (reachable only via error)", () => {
    const result = lower(TRY_CATCH);
    const recoverId = idOfName(result, "recover");
    const sequentialIntoCatch = result.edges.filter(
      (e) => e.type !== "error" && "targetNodeId" in e && e.targetNodeId === recoverId
    );
    expect(sequentialIntoCatch).toHaveLength(0);
  });

  it("exposes body AND catch tails as the fragment tails (handled errors resume)", () => {
    const result = lower(TRY_CATCH);
    expect(result.tailNodeIds).toEqual([
      idOfName(result, "verify"),
      idOfName(result, "recover"),
    ]);
  });

  it("classifies handled catch tails only as normal exits", () => {
    const result = lower(TRY_CATCH);
    expect(result.ports?.errorExits).toEqual([]);
    expect(result.ports?.normalExits).toEqual(effectiveTails(result));
    expect(result.ports?.entryNodeIds).toEqual([idOfName(result, "attempt")]);
    expect(result.ports?.suspendedExits).toEqual([]);
    expect(result.ports?.terminalExits).toEqual([]);
  });

  it("wires both tails to the next sibling inside a sequence", () => {
    const result = lower({
      type: "sequence",
      nodes: [TRY_CATCH, makeAction("after")],
    });
    const afterId = idOfName(result, "after");
    const into = result.edges
      .filter(
        (e) =>
          e.type === "sequential" &&
          "targetNodeId" in e &&
          e.targetNodeId === afterId
      )
      .map((e) => e.sourceNodeId);
    expect(into.sort()).toEqual(
      [idOfName(result, "verify"), idOfName(result, "recover")].sort()
    );
  });
});

describe("try_catch port composition through the catch fragment", () => {
  it("a catch ending in complete contributes a terminal exit, not an error exit", () => {
    const result = lower({
      type: "try_catch",
      body: [makeAction("attempt")],
      catch: [{ type: "complete", id: "halt", result: "gave up" }],
    });
    const completeNode = result.nodes.find((n) =>
      n.name?.startsWith("complete:")
    );
    expect(completeNode).toBeDefined();
    expect(result.ports?.terminalExits).toEqual([completeNode?.id]);
    // The catch path deliberately ends the flow: nothing continues, so the
    // error-exit set is empty and only the body tail remains a normal exit.
    expect(result.ports?.errorExits).toEqual([]);
    expect(result.tailNodeIds).toEqual([idOfName(result, "attempt")]);
  });

  it("interaction sites inside the catch compose upward without a suspended dead-end", () => {
    const result = lower({
      type: "try_catch",
      body: [makeAction("attempt")],
      catch: [
        {
          type: "approval",
          question: "retry manually?",
          onApprove: [makeAction("manual")],
          onReject: [makeAction("decline")],
        },
      ],
    });
    const gate = result.nodes.find((n) => n.name?.startsWith("approval:"));
    expect(gate).toBeDefined();
    expect(result.ports?.suspendedExits).toEqual([]);
    expect(result.ports?.suspensionSites).toEqual([gate?.id]);
  });

  it("nested try_catch: the inner error edge precedes the outer one so the inner catch wins", () => {
    const result = lower({
      type: "try_catch",
      body: [
        {
          type: "try_catch",
          body: [makeAction("inner-attempt")],
          catch: [makeAction("inner-recover")],
        },
      ],
      catch: [makeAction("outer-recover")],
    });
    const innerAttemptId = idOfName(result, "inner-attempt");
    const fromInnerAttempt = errorEdges(result).filter(
      (e) => e.sourceNodeId === innerAttemptId
    );
    // Both handlers cover the inner body node; insertion order resolves the
    // ambiguity — the runtime's getErrorTarget takes the FIRST catch-all.
    expect(fromInnerAttempt.map((e) => e.targetNodeId)).toEqual([
      idOfName(result, "inner-recover"),
      idOfName(result, "outer-recover"),
    ]);
    // The inner catch node is itself covered by the OUTER handler: an error
    // while handling propagates outward, exactly like language-level nesting.
    expect(
      errorEdges(result).some(
        (e) =>
          e.sourceNodeId === idOfName(result, "inner-recover") &&
          e.targetNodeId === idOfName(result, "outer-recover")
      )
    ).toBe(true);
  });
});

describe("try_catch degenerate shapes stay fail-safe", () => {
  it("a catch that lowers to zero nodes produces no error edges and no error exits", () => {
    const result = lower({
      type: "try_catch",
      body: [makeAction("attempt")],
      // http is runtime-transparent: it lowers to zero pipeline nodes.
      catch: [{ type: "http", id: "ping", url: "https://example.test" }],
    });
    expect(errorEdges(result)).toHaveLength(0);
    expect(result.ports?.errorExits).toEqual([]);
    expect(result.nodes.map((n) => n.name)).toEqual(["attempt"]);
  });

  it("a body that lowers to zero nodes drops the catch and warns (nothing can fail)", () => {
    const result = lower({
      type: "try_catch",
      body: [{ type: "http", id: "ping", url: "https://example.test" }],
      catch: [makeAction("recover")],
    });
    expect(result.nodes).toHaveLength(0);
    expect(errorEdges(result)).toHaveLength(0);
    expect(
      result.warnings.some((w) => w.includes("catch branch is unreachable"))
    ).toBe(true);
  });

  it("declaring errorVar warns: the generic runtime does not write it yet", () => {
    const result = lower({
      type: "try_catch",
      body: [makeAction("attempt")],
      catch: [makeAction("recover")],
      errorVar: "boom",
    });
    expect(
      result.warnings.some((w) => w.includes("errorVar"))
    ).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import {
  validateCanonicalNodeIds,
  type ValidationTraversalIssue,
} from "../validate/validation-traversal.js";
import type { FlowNode } from "../types.js";

// ---------------------------------------------------------------------------
// DZUPAGENT-TEST-M1: validate.test.ts only drove validateCanonicalNodeIds
// through a two-node sequence, leaving most of the node-kind switch (for_each,
// branch then/else, approval onApprove/onReject, persona/route body,
// parallel branches, try_catch body/catch, loop body, and every childless
// leaf kind) uncovered. This file walks every recursive-child branch plus a
// representative leaf node, and confirms missing/duplicate ids are reported
// at the correct nested path regardless of nesting depth.
// ---------------------------------------------------------------------------

function run(node: FlowNode): ValidationTraversalIssue[] {
  const issues: ValidationTraversalIssue[] = [];
  validateCanonicalNodeIds(node, "root", issues, new Map());
  return issues;
}

describe("validateCanonicalNodeIds — recursive child traversal", () => {
  it("walks for_each.body", () => {
    const issues = run({
      type: "for_each",
      id: "loop_items",
      source: "items",
      as: "item",
      body: [{ type: "complete", id: "dup" }, { type: "complete", id: "dup" }],
    });
    expect(issues).toContainEqual(
      expect.objectContaining({
        path: "root.body[1].id",
        code: "DUPLICATE_NODE_ID",
      }),
    );
  });

  it("walks branch.then and branch.else", () => {
    const issues = run({
      type: "branch",
      id: "check",
      condition: "true",
      then: [{ type: "complete", id: "then_done" }],
      else: [{ type: "complete" } as unknown as FlowNode],
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ path: "root.else[0].id", code: "MISSING_REQUIRED_FIELD" }),
    );
  });

  it("walks approval.onApprove and approval.onReject", () => {
    const issues = run({
      type: "approval",
      id: "gate",
      question: "Proceed?",
      onApprove: [{ type: "complete", id: "approved" }],
      onReject: [{ type: "complete", id: "approved" }],
    });
    expect(issues).toContainEqual(
      expect.objectContaining({
        path: "root.onReject[0].id",
        code: "DUPLICATE_NODE_ID",
        message: expect.stringContaining("root.onApprove[0]"),
      }),
    );
  });

  it("walks persona.body", () => {
    const issues = run({
      type: "persona",
      id: "as_reviewer",
      personaId: "reviewer",
      body: [{ type: "complete" } as unknown as FlowNode],
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ path: "root.body[0].id" }),
    );
  });

  it("walks route.body", () => {
    const issues = run({
      type: "route",
      id: "route1",
      strategy: "fixed-provider",
      provider: "openai",
      body: [{ type: "complete" } as unknown as FlowNode],
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ path: "root.body[0].id" }),
    );
  });

  it("walks every branch of a parallel node", () => {
    const issues = run({
      type: "parallel",
      id: "fanout",
      branches: [
        [{ type: "complete", id: "left" }],
        [{ type: "complete", id: "left" }],
      ],
    });
    expect(issues).toContainEqual(
      expect.objectContaining({
        path: "root.branches[1][0].id",
        code: "DUPLICATE_NODE_ID",
      }),
    );
  });

  it("walks try_catch.body and try_catch.catch", () => {
    const issues = run({
      type: "try_catch",
      id: "guard",
      body: [{ type: "complete", id: "ok" }],
      catch: [{ type: "complete", id: "ok" }],
    });
    expect(issues).toContainEqual(
      expect.objectContaining({
        path: "root.catch[0].id",
        code: "DUPLICATE_NODE_ID",
      }),
    );
  });

  it("walks loop.body", () => {
    const issues = run({
      type: "loop",
      id: "retry",
      condition: "true",
      body: [{ type: "complete" } as unknown as FlowNode],
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ path: "root.body[0].id" }),
    );
  });

  it("reports no issues for a childless leaf node with a valid id", () => {
    const issues = run({ type: "wait", id: "pause", durationMs: 10 });
    expect(issues).toEqual([]);
  });

  it("reports a missing id for a childless leaf node", () => {
    const issues = run({ type: "wait", durationMs: 10 } as unknown as FlowNode);
    expect(issues).toEqual([
      expect.objectContaining({
        path: "root.id",
        code: "MISSING_REQUIRED_FIELD",
      }),
    ]);
  });

  it("treats an empty string id the same as a missing id", () => {
    const issues = run({ type: "complete", id: "" });
    expect(issues).toEqual([
      expect.objectContaining({ path: "root.id", code: "MISSING_REQUIRED_FIELD" }),
    ]);
  });
});

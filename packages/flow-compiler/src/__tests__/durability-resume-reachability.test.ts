/**
 * D3 resume-point reachability (ARCH27-T-13 candidate 2 follow-up).
 *
 * D3 is a two-sided condition: "durable flow that contains a mutating node AND
 * has no reachable resume point". Each side used to run its own hand-rolled
 * recursion, and the two disagreed about the `branches` container — the
 * mutation search descended an object entry, the resume search accepted only
 * arrays. A checkpoint sitting in an object-form branch was therefore visible
 * to one half of the condition and invisible to the other, so the flow was
 * told it had no resume point when it plainly had one. Under
 * `requireResumePoint: true` that was not advice but a failed compile.
 *
 * Both sides now share the canonical raw traversal, which makes the
 * disagreement unrepresentable. These cases pin the asymmetry closed; the D1
 * container-placement cases live in durability-diagnostics.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  computeDurabilityDiagnostics,
  computeDurabilityErrors,
} from "../stages/durability-diagnostics.js";

function mutatingNode(id: string): Record<string, unknown> {
  return { type: "action", id, effectClass: "db_write" };
}

function checkpointNode(id: string): Record<string, unknown> {
  return { type: "checkpoint", id };
}

function durableDoc(root: Record<string, unknown>): Record<string, unknown> {
  return {
    schema: "dzupagent.flow/v1",
    durability: { mode: "durable", checkpoint: { storeRef: "pg://runs" } },
    root,
  };
}

function warnsNoResumePoint(doc: Record<string, unknown>): boolean {
  return computeDurabilityDiagnostics(doc).some(
    (w) => w.code === "DURABLE_MUTATION_NO_RESUME_POINT",
  );
}

describe("D3 resume-point search reaches every container the mutation search does", () => {
  it("still warns when a durable mutating flow genuinely has no resume point", () => {
    const doc = durableDoc({
      type: "sequence",
      id: "root",
      nodes: [mutatingNode("writer")],
    });
    expect(warnsNoResumePoint(doc)).toBe(true);
  });

  it("is silent when the checkpoint sits beside the mutation", () => {
    const doc = durableDoc({
      type: "sequence",
      id: "root",
      nodes: [checkpointNode("cp"), mutatingNode("writer")],
    });
    expect(warnsNoResumePoint(doc)).toBe(false);
  });

  it("sees a checkpoint in an OBJECT-form branch entry, as the mutation search always did", () => {
    const doc = durableDoc({
      type: "parallel",
      id: "fan",
      branches: [
        { type: "sequence", id: "b0", nodes: [checkpointNode("cp")] },
        { type: "sequence", id: "b1", nodes: [mutatingNode("writer")] },
      ],
    });
    expect(warnsNoResumePoint(doc)).toBe(false);
  });

  it("sees a checkpoint in an array-form parallel branch", () => {
    const doc = durableDoc({
      type: "parallel",
      id: "fan",
      branches: [[checkpointNode("cp")], [mutatingNode("writer")]],
    });
    expect(warnsNoResumePoint(doc)).toBe(false);
  });

  it("sees a checkpoint inside an approval branch", () => {
    const doc = durableDoc({
      type: "approval",
      id: "gate",
      onApprove: [checkpointNode("cp"), mutatingNode("writer")],
    });
    expect(warnsNoResumePoint(doc)).toBe(false);
  });

  it("sees a checkpoint inside a try_catch catch handler", () => {
    const doc = durableDoc({
      type: "try_catch",
      id: "guarded",
      body: [mutatingNode("writer")],
      catch: [checkpointNode("cp")],
    });
    expect(warnsNoResumePoint(doc)).toBe(false);
  });
});

describe("RESUME_POINT_REQUIRED honours the same reachability", () => {
  function requireResumeDoc(
    root: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      schema: "dzupagent.flow/v1",
      durability: { resume: { requireResumePoint: true } },
      root,
    };
  }

  it("still errors when no resume point exists anywhere", () => {
    const doc = requireResumeDoc({
      type: "sequence",
      id: "root",
      nodes: [mutatingNode("writer")],
    });
    expect(computeDurabilityErrors(doc).map((e) => e.code)).toEqual([
      "RESUME_POINT_REQUIRED",
    ]);
  });

  it("does not fail the compile for a checkpoint in an object-form branch", () => {
    // The compile-blocking half of the same bug: an author who put their
    // checkpoint in an object-form branch was told the flow had none.
    const doc = requireResumeDoc({
      type: "parallel",
      id: "fan",
      branches: [
        { type: "sequence", id: "b0", nodes: [checkpointNode("cp")] },
        { type: "sequence", id: "b1", nodes: [mutatingNode("writer")] },
      ],
    });
    expect(computeDurabilityErrors(doc)).toEqual([]);
  });
});

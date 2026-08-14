import { describe, expect, it } from "vitest";

import { createFlowCompiler } from "../index.js";
import type { CompilerOptions } from "../types.js";

// An approval gate with no on_reject: the rejected outcome dead-ends at the
// gate awaiting a decision that never lowers into a continuation — a
// suspended exit in the F-R2 port model.
const SUSPENDED_DSL = [
  "dsl: dzupflow/v1",
  "id: unattended-suspend",
  "version: 1",
  "steps:",
  "  - approval:",
  "      id: gate",
  '      question: "Ship it?"',
  "      on_approve:",
  "        - complete:",
  "            id: done",
  "            result: complete",
].join("\n");

// One-dimension control: identical document except the rejected outcome has
// a lowered continuation, so no suspended exit exists.
const RESOLVED_DSL = [
  SUSPENDED_DSL,
  "      on_reject:",
  "        - complete:",
  "            id: declined",
  "            result: complete",
].join("\n");

const toolResolver = {
  resolve: () => null,
  listAvailable: () => [],
};

function unattended(extra: Partial<CompilerOptions> = {}) {
  return createFlowCompiler({
    toolResolver,
    referencePolicy: "strict",
    admissionProfile: "unattended",
    ...extra,
  });
}

describe("checkpoint-bound interaction admission", () => {
  it("requires an explicit rejected continuation", async () => {
    const result = await unattended().compileDsl(SUSPENDED_DSL);

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) return;
    const diagnostic = result.errors.find(
      (item) => item.code === "MISSING_REQUIRED_FIELD",
    );
    expect(diagnostic).toMatchObject({
      stage: 2,
      category: "shape",
    });
    expect(diagnostic?.message).toMatch(/approval\.on_reject/);
  });

  it("admits the same document when the rejected path lowers a continuation (one-dimension control)", async () => {
    const result = await unattended().compileDsl(RESOLVED_DSL);

    expect("errors" in result).toBe(false);
    if ("errors" in result) return;
    expect(result.ports?.suspendedExits).toEqual([]);
    expect(
      result.warnings.some((w) => w.code === "SUSPENDED_EXIT_ACKNOWLEDGED"),
    ).toBe(false);
  });

  it("does not let a suspended-exit acknowledgment bypass the required branch", async () => {
    const result = await unattended({
      acknowledgeSuspendedExits: true,
    }).compileDsl(SUSPENDED_DSL);

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 2,
          code: "MISSING_REQUIRED_FIELD",
        }),
      ]),
    );
  });

  it("does not consult the acknowledgment when no suspended exit exists (ack is not a blanket bypass)", async () => {
    const result = await unattended({
      acknowledgeSuspendedExits: true,
    }).compileDsl(RESOLVED_DSL);

    expect("errors" in result).toBe(false);
    if ("errors" in result) return;
    expect(
      result.warnings.some((w) => w.code === "SUSPENDED_EXIT_ACKNOWLEDGED"),
    ).toBe(false);
  });

  it("requires the rejected continuation in interactive compilation too", async () => {
    const result = await createFlowCompiler({ toolResolver }).compileDsl(
      SUSPENDED_DSL,
    );

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "MISSING_REQUIRED_FIELD" }),
      ]),
    );
  });

  it("surfaces the root fragment ports on interactive successes too", async () => {
    const result = await createFlowCompiler({ toolResolver }).compileDsl(
      RESOLVED_DSL,
    );

    expect("errors" in result).toBe(false);
    if ("errors" in result) return;
    const artifact = result.artifact as {
      nodes: Array<{ id: string; name?: string }>;
    };
    const gate = artifact.nodes.find((n) => n.name?.startsWith("approval:"));
    expect(gate).toBeDefined();
    expect(result.ports?.suspendedExits).toEqual([]);
    expect(result.ports?.suspensionSites).toEqual([gate?.id]);
    expect(result.ports?.entryNodeIds).toEqual([gate?.id]);
  });
});

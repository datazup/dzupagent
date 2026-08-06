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

describe("suspended-exit admission (F-R2 port consumer)", () => {
  it("denies unattended compilation while a suspended exit exists", async () => {
    const result = await unattended().compileDsl(SUSPENDED_DSL);

    expect("errors" in result).toBe(true);
    if (!("errors" in result)) return;
    const diagnostic = result.errors.find(
      (item) => item.code === "SUSPENDED_EXIT_UNATTENDED",
    );
    expect(diagnostic).toMatchObject({
      stage: 4,
      category: "policy",
    });
    // The denial must name the suspended node so an operator can find it.
    expect(diagnostic?.message).toMatch(/approval:/);
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

  it("admits under an explicit operator acknowledgment, leaving a warning trace", async () => {
    const result = await unattended({
      acknowledgeSuspendedExits: true,
    }).compileDsl(SUSPENDED_DSL);

    expect("errors" in result).toBe(false);
    if ("errors" in result) return;
    const warning = result.warnings.find(
      (w) => w.code === "SUSPENDED_EXIT_ACKNOWLEDGED",
    );
    expect(warning).toMatchObject({ stage: 4, category: "policy" });
    expect(result.ports?.suspendedExits).toHaveLength(1);
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

  it("preserves interactive compilation byte-for-byte (no new diagnostics)", async () => {
    const result = await createFlowCompiler({ toolResolver }).compileDsl(
      SUSPENDED_DSL,
    );

    expect("errors" in result).toBe(false);
    if ("errors" in result) return;
    expect(
      result.warnings.some((w) =>
        String(w.code).startsWith("SUSPENDED_EXIT"),
      ),
    ).toBe(false);
  });

  it("surfaces the root fragment ports on interactive successes too", async () => {
    const result = await createFlowCompiler({ toolResolver }).compileDsl(
      SUSPENDED_DSL,
    );

    expect("errors" in result).toBe(false);
    if ("errors" in result) return;
    const artifact = result.artifact as {
      nodes: Array<{ id: string; name?: string }>;
    };
    const gate = artifact.nodes.find((n) => n.name?.startsWith("approval:"));
    expect(gate).toBeDefined();
    expect(result.ports?.suspendedExits).toEqual([gate?.id]);
    expect(result.ports?.entryNodeIds).toEqual([gate?.id]);
  });
});

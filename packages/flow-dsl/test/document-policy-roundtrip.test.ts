import { describe, expect, it } from "vitest";

import { formatDocumentToDsl } from "../src/format-dsl.js";
import { normalizeDslDocument } from "../src/normalize.js";
import { parseDslToDocument } from "../src/parse-dsl.js";

/**
 * G-C2 — the top-level `policy` block is a real spend/time ceiling, so losing it
 * silently is a governance defect, not a cosmetic one: a flow authored with a
 * `budgetCents` ceiling would compile cleanly with no ceiling attached.
 *
 * `policy` must be admitted by **normalize and format together**. Admitting it in
 * only one stage is the DSL-01 defect class (the field survives one direction and
 * vanishes on the other), so every case below pins both directions.
 *
 * The DSL-06 reachability matrix cannot cover this: it enumerates *node kinds*,
 * and `policy` is a *document-level* key. Hence this explicit spec.
 */

const VALID_STEP = {
  agent: {
    id: "a0",
    agentId: "ag-1",
    instructions: "do the thing",
    output: { key: "o", schema: { type: "object" } },
  },
};

function normalize(policy: unknown) {
  return normalizeDslDocument({
    dsl: "dzupflow/v1",
    id: "policy-fixture",
    version: 1,
    ...(policy === undefined ? {} : { policy }),
    steps: [VALID_STEP],
  });
}

describe("document-level policy round-trips through the DSL grammar", () => {
  it("admits a full policy block with zero diagnostics and preserves every field", () => {
    const { ok, diagnostics, document } = normalize({
      budgetCents: 2500,
      timeoutMs: 60_000,
      workingDirectory: "/srv/flow",
    });

    expect(diagnostics).toEqual([]);
    expect(ok).toBe(true);
    // Pin the VALUES, not mere presence: a ceiling that arrives as `{}` or with a
    // coerced budget is the same governance failure as one that is dropped.
    expect(document?.policy).toEqual({
      budgetCents: 2500,
      timeoutMs: 60_000,
      workingDirectory: "/srv/flow",
    });
  });

  it("emits policy back to DSL text and reparses to the same ceiling", () => {
    const { document } = normalize({ budgetCents: 2500, timeoutMs: 60_000 });
    expect(document).not.toBeNull();

    const dsl = formatDocumentToDsl(document!);
    // The formatter must actually emit the block — this is the half of the
    // round-trip that a normalize-only fix would leave broken.
    expect(dsl).toContain("policy:");
    expect(dsl).toContain("budgetCents: 2500");

    const reparsed = parseDslToDocument(dsl);
    expect(reparsed.diagnostics).toEqual([]);
    expect(reparsed.document?.policy).toEqual({
      budgetCents: 2500,
      timeoutMs: 60_000,
    });
  });

  it("round-trips a partial policy without inventing the absent fields", () => {
    const { document } = normalize({ budgetCents: 100 });
    expect(document?.policy).toEqual({ budgetCents: 100 });

    const reparsed = parseDslToDocument(formatDocumentToDsl(document!));
    expect(reparsed.document?.policy).toEqual({ budgetCents: 100 });
  });

  it("omits the policy key entirely when no policy is authored", () => {
    const { document } = normalize(undefined);
    expect(document).not.toBeNull();
    expect(document?.policy).toBeUndefined();
    expect(formatDocumentToDsl(document!)).not.toContain("policy:");
  });

  it("no longer reports policy as an unsupported top-level field", () => {
    const { diagnostics } = normalize({ budgetCents: 100 });
    expect(diagnostics.filter((d) => d.path === "root.policy")).toEqual([]);
  });

  it("still rejects genuinely unknown top-level fields (admission is not blanket)", () => {
    // Negative control for the case above: proves the fix admitted `policy`
    // specifically rather than disabling top-level field checking altogether.
    const { diagnostics } = normalizeDslDocument({
      dsl: "dzupflow/v1",
      id: "policy-fixture",
      version: 1,
      nonsenseField: { budgetCents: 1 },
      steps: [VALID_STEP],
    });

    expect(diagnostics.some((d) => d.path === "root.nonsenseField")).toBe(true);
  });

  it("fails closed on a non-object policy rather than admitting a bogus ceiling", () => {
    const { diagnostics, document } = normalize("25 dollars");

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.some((d) => d.path === "root.policy")).toBe(true);
    // The bad value must be dropped, not coerced onto the document.
    expect(document?.policy).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  parseDslToDocument,
  type PrimitiveDefinitionV2,
} from "../index.js";
import {
  evaluatePrimitivePolicyNarrowing,
} from "../v2-policy-narrowing.js";

const ADAPTER_RUN = BUILT_IN_PRIMITIVE_REGISTRY_V2.resolve(
  "adapter.run",
  "1",
)!;

describe("dzupflow/v2 primitive policy narrowing", () => {
  it("intersects numeric ceilings and adds approval monotonically", () => {
    const result = evaluatePrimitivePolicyNarrowing(
      ADAPTER_RUN,
      {
        timeoutMs: 30_000,
        budgetCents: 25,
        requireApproval: true,
      },
      {
        timeoutMs: 60_000,
        budgetCents: 100,
        requireApproval: false,
      },
    );

    expect(result).toEqual({
      ok: true,
      narrowing: {
        timeoutMs: 30_000,
        budgetCents: 25,
        requireApproval: true,
      },
      effectivePolicy: {
        timeoutMs: 30_000,
        budgetCents: 25,
        requireApproval: true,
      },
    });
    if (!result.ok) throw new Error("expected valid narrowing");
    expect(Object.isFrozen(result.narrowing)).toBe(true);
    expect(Object.isFrozen(result.effectivePolicy)).toBe(true);
  });

  it("rejects widening, undeclared fields, and unreviewed semantics", () => {
    expect(
      evaluatePrimitivePolicyNarrowing(
        ADAPTER_RUN,
        { timeoutMs: 120_000, requireApproval: false },
        { timeoutMs: 60_000, requireApproval: true },
      ),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.objectContaining({
          code: "V2_POLICY_OVERRIDE_WIDENS_AUTHORITY",
          field: "timeoutMs",
        }),
        expect.objectContaining({
          code: "V2_POLICY_OVERRIDE_WIDENS_AUTHORITY",
          field: "requireApproval",
        }),
      ]),
    });

    const shell = BUILT_IN_PRIMITIVE_REGISTRY_V2.resolve("shell.run", "1")!;
    expect(
      evaluatePrimitivePolicyNarrowing(shell, { budgetCents: 1 }),
    ).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({
          code: "V2_POLICY_OVERRIDE_NOT_ALLOWED",
          field: "budgetCents",
        }),
      ],
    });

    const futureDefinition = {
      ...ADAPTER_RUN,
      policy: {
        ...ADAPTER_RUN.policy,
        allowedOverrides: ["futureConstraint"],
      },
    } as PrimitiveDefinitionV2;
    expect(
      evaluatePrimitivePolicyNarrowing(futureDefinition, {
        futureConstraint: "strict",
      }),
    ).toMatchObject({
      ok: false,
      errors: [
        expect.objectContaining({
          code: "V2_POLICY_OVERRIDE_SEMANTICS_UNSUPPORTED",
          field: "futureConstraint",
        }),
      ],
    });
  });

  it("binds exact primitive identity and preserves canonical v1 compatibility", () => {
    const parsed = parseDslToDocument(`
dsl: dzupflow/v2
id: narrowed
version: 2.0.0
steps:
  - id: draft
    use: adapter.run@1
    with:
      provider: codex
      instructions: Draft.
    policy:
      timeoutMs: 30000
      budgetCents: 25
      requireApproval: true
    save:
      result: state.draft
`);

    if (!parsed.ok) {
      throw new Error(JSON.stringify(parsed.diagnostics, null, 2));
    }
    expect(parsed.document.policy).toBeUndefined();
    expect(parsed.frontend?.policyNarrowings).toEqual([
      {
        authoredPath: "root.steps[0]",
        primitiveRef: ADAPTER_RUN.ref,
        primitiveSemanticHash: ADAPTER_RUN.compatibility.semanticHash,
        narrowing: {
          budgetCents: 25,
          requireApproval: true,
          timeoutMs: 30_000,
        },
      },
    ]);
    expect(parsed.document.root.nodes[0]).not.toHaveProperty("policy");
  });

  it("reports exact authored fields for disallowed and kernel policy", () => {
    const disallowed = parseDslToDocument(`
dsl: dzupflow/v2
id: denied
version: 2.0.0
steps:
  - id: command
    use: shell.run@1
    with:
      command: yarn test
    policy:
      budgetCents: 5
    save:
      result: state.command
`);
    expect(disallowed.ok).toBe(false);
    if (disallowed.ok) throw new Error("expected denied override");
    expect(disallowed.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "V2_POLICY_OVERRIDE_NOT_ALLOWED",
        path: "root.steps[0].policy.budgetCents",
        span: expect.objectContaining({ lineStart: 11, lineEnd: 11 }),
      }),
    );

    const kernel = parseDslToDocument(`
dsl: dzupflow/v2
id: kernel-policy
version: 2.0.0
steps:
  - id: done
    use: core.complete@1
    with:
      result: done
    policy:
      requireApproval: true
`);
    expect(kernel.ok).toBe(false);
    if (kernel.ok) throw new Error("expected kernel policy rejection");
    expect(kernel.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "V2_POLICY_REQUIRES_PRIMITIVE",
        path: "root.steps[0].policy",
      }),
    );
  });

  it("rejects an authored ceiling above a host-supplied inherited limit", () => {
    const parsed = parseDslToDocument(
      `
dsl: dzupflow/v2
id: inherited
version: 2.0.0
steps:
  - id: draft
    use: adapter.run@1
    with:
      provider: codex
      instructions: Draft.
    policy:
      timeoutMs: 30000
    save:
      result: state.draft
`,
      { v2InheritedPolicy: { timeoutMs: 20_000 } },
    );

    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("expected inherited ceiling rejection");
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "V2_POLICY_OVERRIDE_WIDENS_AUTHORITY",
        path: "root.steps[0].policy.timeoutMs",
        message: expect.stringContaining("inherited ceiling 20000"),
      }),
    );
  });
});

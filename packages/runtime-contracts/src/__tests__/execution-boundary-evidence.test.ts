import { describe, expect, it } from "vitest";

import {
  admitExecutionBoundaryEvidenceV1,
  materializeAdapterPolicyRefV1,
  materializeExecutionBoundaryEvidenceV1,
  materializeExecutionStateAccessInventoryV1,
  materializeWorkspaceHandleRefV1,
  validateExecutionBoundaryEvidenceV1,
  type AdapterPolicyRefV1,
  type ExecutionBoundaryAdmissionExpectationV1,
  type ExecutionBoundaryEvidenceV1,
  type ExecutionDefinitionOwnerV1,
  type WorkspaceHandleRefV1,
} from "../execution-boundary-evidence.js";

const digest = (character: string) =>
  `sha256:${character.repeat(64)}` as const;

const owner: ExecutionDefinitionOwnerV1 = {
  rootDefinitionId: "flow/review",
  rootDefinitionDigest: digest("a"),
  scopedDefinitionId: "flow/review/root",
  scopedDefinitionDigest: digest("b"),
  executionKind: "adapter.run",
  nodeId: "adapter-1",
  nodePath: "root.nodes[0]",
};

function policy(
  overrides: Partial<Parameters<typeof materializeAdapterPolicyRefV1>[0]> = {},
): AdapterPolicyRefV1 {
  return materializeAdapterPolicyRefV1({
    policyId: "adapter-policy/review",
    authorityId: "policy-authority/framework-test",
    revision: "7",
    policyDigest: digest("c"),
    target: { executionKind: "adapter.run", nodeId: owner.nodeId },
    effectiveAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  });
}

function workspace(
  overrides: Partial<Parameters<typeof materializeWorkspaceHandleRefV1>[0]> = {},
): WorkspaceHandleRefV1 {
  return materializeWorkspaceHandleRefV1({
    handleId: "workspace-handle-17",
    authorityId: "workspace-authority/framework-test",
    revision: "4",
    scopeDigest: digest("d"),
    ...overrides,
  });
}

function evidence(
  overrides: Partial<Parameters<typeof materializeExecutionBoundaryEvidenceV1>[0]> = {},
): ExecutionBoundaryEvidenceV1 {
  const state = materializeExecutionStateAccessInventoryV1({
    owner,
    declared: {
      status: "exact",
      basisDigest: digest("e"),
      reads: ["diff", "request"],
      writes: ["review"],
    },
    observed: {
      status: "unknown",
      reason: "runtime-observation-unavailable",
    },
  });
  return materializeExecutionBoundaryEvidenceV1({
    owner,
    state,
    adapterPolicy: policy(),
    workspace: workspace(),
    ...overrides,
  });
}

function expectation(
  overrides: Partial<ExecutionBoundaryAdmissionExpectationV1> = {},
): ExecutionBoundaryAdmissionExpectationV1 {
  const value = evidence();
  return {
    owner,
    stateInventoryDigest: value.state.inventoryDigest,
    adapterPolicy: value.adapterPolicy,
    workspace: value.workspace,
    admittedAt: "2026-08-19T12:00:00.000Z",
    requireDeclaredExact: true,
    ...overrides,
  };
}

describe("execution boundary evidence v1", () => {
  it("round-trips exact declared and explicit unknown observed state without values", () => {
    const value = evidence();
    const restored = JSON.parse(JSON.stringify(value)) as unknown;

    expect(validateExecutionBoundaryEvidenceV1(restored)).toEqual({
      valid: true,
      value,
      issues: [],
    });
    expect(JSON.stringify(value)).not.toContain("/repo/");
    expect(value.state.declared).toEqual({
      status: "exact",
      basisDigest: digest("e"),
      reads: ["diff", "request"],
      writes: ["review"],
    });
    expect(value.state.observed).toEqual({
      status: "unknown",
      reason: "runtime-observation-unavailable",
    });
  });

  it("canonicalizes materializer input but rejects duplicate or unsorted retained keys", () => {
    const state = materializeExecutionStateAccessInventoryV1({
      owner,
      declared: {
        status: "exact",
        basisDigest: digest("e"),
        reads: ["request", "diff", "diff"],
        writes: ["review"],
      },
      observed: { status: "unknown", reason: "runtime-observation-unavailable" },
    });
    expect(state.declared.status === "exact" && state.declared.reads).toEqual([
      "diff",
      "request",
    ]);

    for (const reads of [["request", "diff"], ["diff", "diff"]]) {
      const malformed = structuredClone(state) as unknown as Record<string, unknown>;
      (malformed.declared as Record<string, unknown>).reads = reads;
      expect(
        validateExecutionBoundaryEvidenceV1(
          materializeExecutionBoundaryEvidenceV1({
            owner,
            state,
            adapterPolicy: policy(),
            workspace: workspace(),
          }),
        ).valid,
      ).toBe(true);
      expect(
        validateExecutionBoundaryEvidenceV1({
          ...evidence(),
          state: malformed,
        }).issues.map((issue) => issue.code),
      ).toContain("INVALID_VALUE");
    }
  });

  it("rejects unknown state disguised as an empty exact inventory", () => {
    const value = evidence();
    const malformed = structuredClone(value) as unknown as Record<string, unknown>;
    const state = malformed.state as Record<string, unknown>;
    state.declared = { status: "exact", reads: [], writes: [] };

    expect(
      validateExecutionBoundaryEvidenceV1(malformed).issues.map(
        (issue) => issue.code,
      ),
    ).toContain("INVALID_VALUE");
  });

  it("rejects schema drift, owner drift, digest drift, and cycles without throwing", () => {
    const cases: unknown[] = [
      { ...evidence(), schema: "dzupagent.executionBoundaryEvidence/v2" },
      {
        ...evidence(),
        owner: { ...owner, nodeId: "foreign-node" },
      },
      { ...evidence(), boundaryDigest: digest("f") },
    ];
    const cyclic = structuredClone(evidence()) as unknown as Record<string, unknown>;
    cyclic.extra = cyclic;
    cases.push(cyclic);

    for (const value of cases) {
      expect(() => validateExecutionBoundaryEvidenceV1(value)).not.toThrow();
      expect(validateExecutionBoundaryEvidenceV1(value).valid).toBe(false);
    }
  });

  it("rejects a fully re-digested foreign definition and node at admission", () => {
    const foreignOwner: ExecutionDefinitionOwnerV1 = {
      ...owner,
      rootDefinitionId: "flow/foreign",
      rootDefinitionDigest: digest("f"),
      nodeId: "adapter-foreign",
      nodePath: "root.nodes[9]",
    };
    const foreignState = materializeExecutionStateAccessInventoryV1({
      owner: foreignOwner,
      declared: {
        status: "exact",
        basisDigest: digest("e"),
        reads: ["diff"],
        writes: ["review"],
      },
      observed: {
        status: "unknown",
        reason: "runtime-observation-unavailable",
      },
    });
    const foreign = materializeExecutionBoundaryEvidenceV1({
      owner: foreignOwner,
      state: foreignState,
      adapterPolicy: policy({
        target: { executionKind: "adapter.run", nodeId: foreignOwner.nodeId },
      }),
      workspace: workspace(),
    });

    expect(
      admitExecutionBoundaryEvidenceV1(
        foreign,
        expectation({
          stateInventoryDigest: foreign.state.inventoryDigest,
          adapterPolicy: foreign.adapterPolicy,
          workspace: foreign.workspace,
        }),
      ).issues.map((item) => item.code),
    ).toContain("BINDING_MISMATCH");
  });

  it("admits matching policy/workspace authority and rejects independent drift", () => {
    const value = evidence();
    expect(admitExecutionBoundaryEvidenceV1(value, expectation()).valid).toBe(true);

    const foreignPolicies = [
      policy({ authorityId: "policy-authority/foreign" }),
      policy({ revision: "8" }),
      policy({ policyDigest: digest("f") }),
      policy({ target: { executionKind: "adapter.run", nodeId: "foreign-node" } }),
    ];
    for (const adapterPolicy of foreignPolicies) {
      expect(
        admitExecutionBoundaryEvidenceV1(value, expectation({ adapterPolicy }))
          .valid,
      ).toBe(false);
    }

    const foreignWorkspaces = [
      workspace({ authorityId: "workspace-authority/foreign" }),
      workspace({ revision: "5" }),
      workspace({ scopeDigest: digest("f") }),
    ];
    for (const currentWorkspace of foreignWorkspaces) {
      expect(
        admitExecutionBoundaryEvidenceV1(
          value,
          expectation({ workspace: currentWorkspace }),
        ).valid,
      ).toBe(false);
    }

    expect(
      admitExecutionBoundaryEvidenceV1(
        value,
        expectation({ adapterPolicy: undefined }),
      ).issues.map((issue) => issue.code),
    ).toContain("AUTHORITY_MISMATCH");
    expect(
      admitExecutionBoundaryEvidenceV1(
        value,
        expectation({ workspace: undefined }),
      ).issues.map((issue) => issue.code),
    ).toContain("AUTHORITY_MISMATCH");
  });

  it("rejects expired/not-yet-effective policy and a bare policy string", () => {
    expect(
      admitExecutionBoundaryEvidenceV1(
        evidence(),
        expectation({ admittedAt: "2026-09-02T00:00:00.000Z" }),
      ).issues.map((issue) => issue.code),
    ).toContain("POLICY_EXPIRED");
    expect(
      admitExecutionBoundaryEvidenceV1(
        evidence(),
        expectation({ admittedAt: "2026-07-31T00:00:00.000Z" }),
      ).issues.map((issue) => issue.code),
    ).toContain("POLICY_NOT_EFFECTIVE");

    const malformed = structuredClone(evidence()) as unknown as Record<string, unknown>;
    malformed.adapterPolicy = "adapter-policy/review";
    expect(
      validateExecutionBoundaryEvidenceV1(malformed).issues.map(
        (issue) => issue.code,
      ),
    ).toContain("INVALID_TYPE");
  });

  it("denies foreign checkpoint/current admission evidence before any resolution or dispatch", () => {
    const checkpointBytes = JSON.stringify(evidence());
    let resolverCalls = 0;
    let dispatchCalls = 0;
    let resolvedPath: string | undefined;

    const restart = (
      bytes: string,
      expected: ExecutionBoundaryAdmissionExpectationV1,
    ): boolean => {
      const admitted = admitExecutionBoundaryEvidenceV1(
        JSON.parse(bytes) as unknown,
        expected,
      );
      if (!admitted.valid) return false;
      resolverCalls += 1;
      resolvedPath = "/host/private/resolved-only-after-admission";
      dispatchCalls += 1;
      return true;
    };

    expect(restart(checkpointBytes, expectation())).toBe(true);
    expect(resolverCalls).toBe(1);
    expect(dispatchCalls).toBe(1);
    expect(resolvedPath).toBe("/host/private/resolved-only-after-admission");
    expect(checkpointBytes).not.toContain(resolvedPath);

    resolverCalls = 0;
    dispatchCalls = 0;
    resolvedPath = undefined;
    expect(
      restart(
        checkpointBytes,
        expectation({ stateInventoryDigest: digest("f") }),
      ),
    ).toBe(false);
    expect(resolverCalls).toBe(0);
    expect(dispatchCalls).toBe(0);
    expect(resolvedPath).toBeUndefined();
  });

  it("keeps legacy bytes parseable but denies strict admission with zero dispatch", () => {
    const legacy = JSON.parse(
      JSON.stringify({
        schema: "dzupagent.executionRequest/v1",
        kind: "adapter.run",
        policy: { workingDirectory: "legacy/raw/path" },
      }),
    ) as Record<string, unknown>;
    let dispatchCalls = 0;
    const admitted = admitExecutionBoundaryEvidenceV1(
      legacy.boundaryEvidence,
      expectation(),
    );
    if (admitted.valid) dispatchCalls += 1;

    expect(legacy.policy).toEqual({ workingDirectory: "legacy/raw/path" });
    expect(admitted.valid).toBe(false);
    expect(dispatchCalls).toBe(0);
  });
});

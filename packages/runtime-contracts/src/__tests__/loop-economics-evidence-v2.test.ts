import fixture from "../../fixtures/ai-execution-conformance-v2.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import {
  AI_BUDGET_RESERVATION_SCHEMA,
  type AiBudgetReservation,
} from "../ai-budget-reservation.js";
import type {
  AiExecutionBinding,
  AiUsageTruthV2,
} from "../ai-execution.js";
import { CANONICAL_JSON_VERSION } from "../idempotency.js";
import {
  LOOP_ECONOMICS_EVIDENCE_V2_COMPATIBILITY,
  LOOP_ECONOMICS_EVIDENCE_V2_SCHEMA,
  admitLoopEconomicsEvidenceV2,
  materializeLoopEconomicsEvidenceV2,
  validateLoopEconomicsEvidenceV2,
  type LoopEconomicsControlSelectionV2,
  type LoopEconomicsEvidenceInputV2,
  type LoopEconomicsLeafAdmissionV2,
  type LoopEconomicsLeafOutcomeV2,
  type LoopEconomicsResolutionV2,
} from "../loop-economics-evidence-v2.js";
import {
  LOOP_ECONOMICS_EVIDENCE_SCHEMA,
  materializeLoopEconomicsEvidence,
  type LoopEconomicsEvidenceOwner,
  type LoopEconomicsExecutionAdmission,
} from "../loop-economics-evidence.js";

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const fixtureBinding = (
  fixture as {
    cases: Array<{ receipt?: { schema?: string; binding?: AiExecutionBinding } }>;
  }
).cases.find(({ receipt }) =>
  receipt?.schema === "dzupagent.aiExecutionReceipt/v2"
)?.receipt?.binding;

if (fixtureBinding === undefined) {
  throw new Error("V2 fixture must provide an execution binding");
}

const binding: AiExecutionBinding = fixtureBinding;
const owner: LoopEconomicsEvidenceOwner = {
  runId: "run-v2",
  loopNodeId: "loop",
  reservationId: "resv:v1:run-v2:item:loop:0",
  unit: { kind: "item", itemIndex: 0, iteration: 1, attempt: 0 },
};

const reservation: AiBudgetReservation = {
  schema: AI_BUDGET_RESERVATION_SCHEMA,
  status: "admitted",
  tariffRef: binding.offer.tariffRef!,
  offerRef: binding.offer.offerId,
  modelRef: binding.model.modelRef,
  modelRevision: binding.model.revision,
  provenance: {
    sourceKind: "provider-published",
    authorityId: "provider/prices",
    revision: "2026-08-19",
    effectiveAt: "2026-08-19T00:00:00.000Z",
    digest: digest("a"),
  },
  currency: "USD",
  reservedAmountMicros: 80_000,
  usageCeiling: {
    uncachedInputTokens: 1_000,
    outputTokens: 500,
  },
  reservedAt: "2026-08-19T00:00:01.000Z",
};

const execution: LoopEconomicsExecutionAdmission = {
  nodeId: "model",
  binding,
  money: {
    status: "priced",
    reservation,
    tariffDigest: digest("b"),
  },
  quota: { status: "not-applicable" },
};

const usage: AiUsageTruthV2 = {
  measurement: "known",
  tokens: { input: 20, output: 10 },
  cost: {
    status: "reconciled",
    currency: "USD",
    amountMicros: 30_000,
    charges: [{
      attempt: 1,
      offerRef: reservation.offerRef,
      tariffRef: reservation.tariffRef,
      amountMicros: 30_000,
      provenance: reservation.provenance,
    }],
  },
};

const leaves: readonly LoopEconomicsLeafAdmissionV2[] = [
  {
    leafId: "execution:model",
    order: 0,
    nodePath: ["loop", "try", "branch", "model"],
    controlRequirements: [
      { selectionIndex: 0, kind: "branch", requiredBranch: "primary" },
      { selectionIndex: 1, kind: "catch", requiredArm: "body" },
    ],
    idempotencyKey: "loop-leaf:run-v2:model",
    fence: 1,
    kind: "execution",
    execution,
  },
  {
    leafId: "charge:model",
    order: 1,
    nodePath: ["loop", "try", "branch", "model", "charge"],
    controlRequirements: [
      { selectionIndex: 0, kind: "branch", requiredBranch: "primary" },
      { selectionIndex: 1, kind: "catch", requiredArm: "body" },
    ],
    idempotencyKey: "loop-leaf:run-v2:model:charge",
    fence: 1,
    kind: "charge",
    chargeId: "charge:run-v2:model",
    executionLeafId: "execution:model",
    bindingDigest: binding.bindingDigest,
    money: execution.money,
    quota: execution.quota,
  },
  {
    leafId: "effect:notify",
    order: 2,
    nodePath: ["loop", "try", "branch", "notify"],
    controlRequirements: [
      { selectionIndex: 0, kind: "branch", requiredBranch: "primary" },
      { selectionIndex: 1, kind: "catch", requiredArm: "body" },
    ],
    idempotencyKey: "loop-leaf:run-v2:notify",
    fence: 1,
    kind: "effect",
    effect: { nodeId: "notify", intentDigest: digest("c") },
  },
];

function input(
  resolution: LoopEconomicsResolutionV2 = { status: "pending" },
  overrides: Partial<LoopEconomicsEvidenceInputV2> = {}
): LoopEconomicsEvidenceInputV2 {
  return {
    schema: LOOP_ECONOMICS_EVIDENCE_V2_SCHEMA,
    canonicalization: CANONICAL_JSON_VERSION,
    owner,
    definitionDigest: digest("d"),
    bodyPlanDigest: digest("e"),
    unitAttempt: 0,
    controlSelections: [
      {
        kind: "branch",
        nodePath: ["loop", "try", "branch"],
        selectedBranch: "primary",
      },
      {
        kind: "catch",
        nodePath: ["loop", "try"],
        selectedArm: "body",
      },
    ],
    leaves,
    resolution,
    ...overrides,
  };
}

const recordedExecution = (): LoopEconomicsLeafOutcomeV2 => ({
  leafId: "execution:model",
  kind: "execution",
  status: "recorded",
  bindingDigest: binding.bindingDigest,
  receiptDigest: digest("f"),
  usage,
});

const recordedCharge = (): LoopEconomicsLeafOutcomeV2 => ({
  leafId: "charge:model",
  kind: "charge",
  status: "recorded",
  bindingDigest: binding.bindingDigest,
  receiptDigest: digest("0"),
  usage,
});

const releasedEffect = (
  reason: "not-selected" | "prior-leaf-failed" = "prior-leaf-failed"
): LoopEconomicsLeafOutcomeV2 => ({
  leafId: "effect:notify",
  kind: "effect",
  status: "released",
  reason,
  releaseDigest: digest("1"),
});

function settled(
  outcomes: readonly LoopEconomicsLeafOutcomeV2[] = [
    recordedExecution(),
    recordedCharge(),
    releasedEffect(),
  ]
): LoopEconomicsResolutionV2 {
  return { status: "settled", outcomes };
}

describe("loop economics V2 per-leaf outcomes", () => {
  it("binds exact plan, selection, attempt, authority, identity, and fence while pending", () => {
    const evidence = materializeLoopEconomicsEvidenceV2(input());

    expect(validateLoopEconomicsEvidenceV2(evidence, {
      owner,
      definitionDigest: digest("d"),
      bodyPlanDigest: digest("e"),
      unitAttempt: 0,
      reservedCostCents: 8,
      resolutionStatus: "pending",
    })).toEqual({
      valid: true,
      terminalSuccess: false,
      requiresReconciliation: false,
      resolutionStatus: "pending",
      diagnostics: [],
    });
    expect(admitLoopEconomicsEvidenceV2(evidence)).toMatchObject({
      status: "pending",
    });
  });

  it("keeps admission stable while control decisions become durably known", () => {
    const unresolvedControls = [
      {
        kind: "branch",
        nodePath: ["loop", "try", "branch"],
        selectedBranch: null,
      },
      {
        kind: "catch",
        nodePath: ["loop", "try"],
        selectedArm: null,
      },
    ] satisfies readonly LoopEconomicsControlSelectionV2[];
    const pending = materializeLoopEconomicsEvidenceV2(input(undefined, {
      controlSelections: unresolvedControls,
    }));
    const settledEvidence = materializeLoopEconomicsEvidenceV2(input(settled()));
    const unresolvedTerminal = materializeLoopEconomicsEvidenceV2(input(settled(), {
      controlSelections: unresolvedControls,
    }));

    expect(validateLoopEconomicsEvidenceV2(pending).valid).toBe(true);
    expect(settledEvidence.admissionDigest).toBe(pending.admissionDigest);
    expect(settledEvidence.evidenceDigest).not.toBe(pending.evidenceDigest);
    expect(validateLoopEconomicsEvidenceV2(unresolvedTerminal).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({
        code: "LOOP_ECONOMICS_V2_BINDING_MISMATCH",
        path: "resolution.outcomes[0]",
      })])
    );
  });

  it("settles a partial sequence with recorded execution/charge and a proven undispatched effect", () => {
    const evidence = materializeLoopEconomicsEvidenceV2(input(settled()));

    expect(validateLoopEconomicsEvidenceV2(evidence, {
      reservedCostCents: 8,
      settledCostCents: 3,
      resolutionStatus: "settled",
    })).toEqual({
      valid: true,
      terminalSuccess: true,
      requiresReconciliation: false,
      resolutionStatus: "settled",
      diagnostics: [],
    });
    expect(admitLoopEconomicsEvidenceV2(evidence)).toMatchObject({
      status: "admitted",
    });
    expect(JSON.stringify(evidence)).not.toContain('"result"');
  });

  it("binds an untaken branch as released rather than silently omitting its leaf", () => {
    const untakenLeaves: readonly LoopEconomicsLeafAdmissionV2[] = [
      leaves[0]!,
      leaves[1]!,
      {
        ...leaves[2]!,
        controlRequirements: [
          { selectionIndex: 0, kind: "branch", requiredBranch: "secondary" },
          { selectionIndex: 1, kind: "catch", requiredArm: "body" },
        ],
      },
    ];
    const evidence = materializeLoopEconomicsEvidenceV2(input(settled([
      recordedExecution(),
      recordedCharge(),
      releasedEffect("not-selected"),
    ]), {
      leaves: untakenLeaves,
    }));

    expect(validateLoopEconomicsEvidenceV2(evidence).terminalSuccess).toBe(true);
  });

  it("binds catch execution selection and keeps all non-catch leaves explicit", () => {
    const catchLeaves: readonly LoopEconomicsLeafAdmissionV2[] = [
      {
        ...leaves[0]!,
        nodePath: ["loop", "try", "catch", "model"],
        controlRequirements: [
          { selectionIndex: 0, kind: "branch", requiredBranch: "primary" },
          { selectionIndex: 1, kind: "catch", requiredArm: "catch" },
        ],
      },
      {
        ...leaves[1]!,
        nodePath: ["loop", "try", "catch", "model", "charge"],
        controlRequirements: [
          { selectionIndex: 0, kind: "branch", requiredBranch: "primary" },
          { selectionIndex: 1, kind: "catch", requiredArm: "catch" },
        ],
      },
      {
        ...leaves[2]!,
        nodePath: ["loop", "try", "body", "notify"],
      },
    ];
    const evidence = materializeLoopEconomicsEvidenceV2(input(settled([
      recordedExecution(),
      recordedCharge(),
      releasedEffect("not-selected"),
    ]), {
      leaves: catchLeaves,
      controlSelections: [
        {
          kind: "branch",
          nodePath: ["loop", "try", "branch"],
          selectedBranch: "primary",
        },
        {
          kind: "catch",
          nodePath: ["loop", "try"],
          selectedArm: "catch",
        },
      ],
    }));

    expect(validateLoopEconomicsEvidenceV2(evidence).terminalSuccess).toBe(true);
  });

  it("blocks terminal success when an external commit loses acknowledgement", () => {
    const evidence = materializeLoopEconomicsEvidenceV2(input({
      status: "reconciliation-required",
      outcomes: [
        {
          leafId: "execution:model",
          kind: "execution",
          status: "unknown",
          reason: "dispatch-acknowledgement-lost",
          observationDigest: digest("2"),
        },
        {
          leafId: "charge:model",
          kind: "charge",
          status: "unknown",
          reason: "receipt-unavailable",
          observationDigest: digest("3"),
        },
        releasedEffect(),
      ],
    }));

    expect(validateLoopEconomicsEvidenceV2(evidence)).toEqual({
      valid: true,
      terminalSuccess: false,
      requiresReconciliation: true,
      resolutionStatus: "reconciliation-required",
      diagnostics: [],
    });
    expect(admitLoopEconomicsEvidenceV2(evidence)).toMatchObject({
      status: "reconciliation-required",
    });
  });

  it("settles released-before-dispatch leaves as zero without treating unknown as zero", () => {
    const released = (leaf: LoopEconomicsLeafAdmissionV2): LoopEconomicsLeafOutcomeV2 => ({
      leafId: leaf.leafId,
      kind: leaf.kind,
      status: "released",
      reason: "dispatch-denied",
      releaseDigest: digest("4"),
    });
    const evidence = materializeLoopEconomicsEvidenceV2(input(settled(
      leaves.map(released)
    )));

    expect(validateLoopEconomicsEvidenceV2(evidence, {
      settledCostCents: 0,
    }).terminalSuccess).toBe(true);

    const unknown = materializeLoopEconomicsEvidenceV2(input({
      status: "reconciliation-required",
      outcomes: [
        {
          leafId: "execution:model",
          kind: "execution",
          status: "unknown",
          reason: "reconciliation-unavailable",
          observationDigest: digest("5"),
        },
        released(leaves[1]!),
        released(leaves[2]!),
      ],
    }));
    expect(validateLoopEconomicsEvidenceV2(unknown, {
      settledCostCents: 0,
    }).valid).toBe(false);
  });

  it("rejects missing, duplicate, reordered, or foreign leaf outcomes", () => {
    const missing = materializeLoopEconomicsEvidenceV2(input(settled([
      recordedExecution(),
      recordedCharge(),
    ])));
    const duplicate = materializeLoopEconomicsEvidenceV2(input(settled([
      recordedExecution(),
      recordedExecution(),
      releasedEffect(),
    ])));
    const reordered = materializeLoopEconomicsEvidenceV2(input(settled([
      recordedCharge(),
      recordedExecution(),
      releasedEffect(),
    ])));
    const foreign = materializeLoopEconomicsEvidenceV2(input(settled([
      { ...recordedExecution(), leafId: "execution:foreign" },
      recordedCharge(),
      releasedEffect(),
    ])));

    expect(validateLoopEconomicsEvidenceV2(missing).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "LOOP_ECONOMICS_V2_MISSING_LEAF" })])
    );
    expect(validateLoopEconomicsEvidenceV2(duplicate).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "LOOP_ECONOMICS_V2_DUPLICATE_LEAF" })])
    );
    expect(validateLoopEconomicsEvidenceV2(reordered).valid).toBe(false);
    expect(validateLoopEconomicsEvidenceV2(foreign).valid).toBe(false);
  });

  it("rejects unknown fields, digest drift, authority drift, and invalid settlement status", () => {
    const current = materializeLoopEconomicsEvidenceV2(input(settled()));
    const extra = materializeLoopEconomicsEvidenceV2({
      ...input(),
      leaves: [{
        ...leaves[0]!,
        unsafe: "value",
      } as unknown as LoopEconomicsLeafAdmissionV2],
    });
    const wrongStatus = materializeLoopEconomicsEvidenceV2(input({
      status: "settled",
      outcomes: [
        {
          leafId: "execution:model",
          kind: "execution",
          status: "unknown",
          reason: "authority-drift",
          observationDigest: digest("6"),
        },
        recordedCharge(),
        releasedEffect(),
      ],
    }));

    expect(validateLoopEconomicsEvidenceV2(extra).valid).toBe(false);
    expect(validateLoopEconomicsEvidenceV2({
      ...current,
      evidenceDigest: digest("7"),
    }).valid).toBe(false);
    expect(validateLoopEconomicsEvidenceV2(current, {
      bodyPlanDigest: digest("8"),
    }).valid).toBe(false);
    expect(validateLoopEconomicsEvidenceV2(wrongStatus).valid).toBe(false);
  });

  it("keeps external idempotency stable while binding every takeover fence", () => {
    const first = materializeLoopEconomicsEvidenceV2(input());
    const takeover = materializeLoopEconomicsEvidenceV2(input(undefined, {
      leaves: leaves.map((leaf) => ({ ...leaf, fence: 2 })),
    }));

    expect(takeover.leaves.map(({ idempotencyKey }) => idempotencyKey)).toEqual(
      first.leaves.map(({ idempotencyKey }) => idempotencyKey)
    );
    expect(takeover.admissionDigest).not.toBe(first.admissionDigest);
    expect(validateLoopEconomicsEvidenceV2(takeover, {
      admissionDigest: first.admissionDigest,
    }).valid).toBe(false);
  });

  it("rejects duplicate external identity, mixed fences, and unit-attempt drift", () => {
    const duplicateIdentity = materializeLoopEconomicsEvidenceV2(input(undefined, {
      leaves: leaves.map((leaf, index) => index === 1
        ? { ...leaf, idempotencyKey: leaves[0]!.idempotencyKey }
        : leaf),
    }));
    const mixedFence = materializeLoopEconomicsEvidenceV2(input(undefined, {
      leaves: leaves.map((leaf, index) => index === 2
        ? { ...leaf, fence: 2 }
        : leaf),
    }));
    const attemptDrift = materializeLoopEconomicsEvidenceV2(input(undefined, {
      owner: {
        ...owner,
        reservationId: "resv:v1:run-v2:item:loop:0:attempt:1",
        unit: { kind: "item", itemIndex: 0, iteration: 1, attempt: 1 },
      },
    }));
    const iterationAttemptDrift = materializeLoopEconomicsEvidenceV2(input(undefined, {
      owner: {
        ...owner,
        reservationId: "resv:v1:run-v2:iteration:loop:1",
        unit: { kind: "iteration", iteration: 1 },
      },
      unitAttempt: 1,
    }));

    expect(validateLoopEconomicsEvidenceV2(duplicateIdentity).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({
        code: "LOOP_ECONOMICS_V2_DUPLICATE_IDENTITY",
        path: "leaves[1].idempotencyKey",
      })])
    );
    expect(validateLoopEconomicsEvidenceV2(mixedFence).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({
        code: "LOOP_ECONOMICS_V2_BINDING_MISMATCH",
        path: "leaves[2].fence",
      })])
    );
    expect(validateLoopEconomicsEvidenceV2(attemptDrift).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({
        code: "LOOP_ECONOMICS_V2_BINDING_MISMATCH",
        path: "unitAttempt",
      })])
    );
    expect(validateLoopEconomicsEvidenceV2(iterationAttemptDrift).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({
        code: "LOOP_ECONOMICS_V2_BINDING_MISMATCH",
        path: "unitAttempt",
      })])
    );
  });

  it("requires one charge per execution and refuses zero release after a recorded execution", () => {
    const missingCharge = materializeLoopEconomicsEvidenceV2(input(undefined, {
      leaves: [leaves[0]!, { ...leaves[2]!, order: 1 }],
    }));
    const releasedCharge: LoopEconomicsLeafOutcomeV2 = {
      leafId: "charge:model",
      kind: "charge",
      status: "released",
      reason: "dispatch-denied",
      releaseDigest: digest("9"),
    };
    const zeroedCharge = materializeLoopEconomicsEvidenceV2(input(settled([
      recordedExecution(),
      releasedCharge,
      releasedEffect(),
    ])));

    expect(validateLoopEconomicsEvidenceV2(missingCharge).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({
        code: "LOOP_ECONOMICS_V2_MISSING_LEAF",
        path: "leaves",
      })])
    );
    expect(validateLoopEconomicsEvidenceV2(zeroedCharge).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({
        code: "LOOP_ECONOMICS_V2_BINDING_MISMATCH",
        path: "resolution.outcomes",
      })])
    );
  });

  it("rejects charge control drift and divergent recorded usage", () => {
    const controlDrift = materializeLoopEconomicsEvidenceV2(input(undefined, {
      leaves: leaves.map((leaf, index) => index === 1
        ? { ...leaf, controlRequirements: [] }
        : leaf),
    }));
    const divergentCharge: LoopEconomicsLeafOutcomeV2 = {
      leafId: "charge:model",
      kind: "charge",
      status: "recorded",
      bindingDigest: binding.bindingDigest,
      receiptDigest: digest("0"),
      usage: {
        ...usage,
        tokens: { input: usage.tokens.input + 1, output: usage.tokens.output },
      },
    };
    const divergentUsage = materializeLoopEconomicsEvidenceV2(input(settled([
      recordedExecution(),
      divergentCharge,
      releasedEffect(),
    ])));

    expect(validateLoopEconomicsEvidenceV2(controlDrift).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({
        code: "LOOP_ECONOMICS_V2_BINDING_MISMATCH",
        path: "leaves[1].controlRequirements",
      })])
    );
    expect(validateLoopEconomicsEvidenceV2(divergentUsage).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({
        code: "LOOP_ECONOMICS_V2_BINDING_MISMATCH",
        path: "resolution.outcomes[1].usage",
      })])
    );
  });

  it("is deterministic for canonical content and rejects cyclic evidence safely", () => {
    const first = materializeLoopEconomicsEvidenceV2(input(settled()));
    const second = materializeLoopEconomicsEvidenceV2(structuredClone(input(settled())));
    const cyclic = structuredClone(first) as typeof first & { self?: unknown };
    cyclic.self = cyclic;

    expect(second).toEqual(first);
    expect(() => validateLoopEconomicsEvidenceV2(cyclic)).not.toThrow();
    expect(validateLoopEconomicsEvidenceV2(cyclic).valid).toBe(false);
  });

  it("keeps V1 readable only through V1 and explicitly denies downgrade admission", () => {
    const v1 = materializeLoopEconomicsEvidence({
      schema: LOOP_ECONOMICS_EVIDENCE_SCHEMA,
      canonicalization: CANONICAL_JSON_VERSION,
      owner,
      executions: [execution],
      effectIntents: [],
      terminal: { status: "pending" },
    });

    expect(LOOP_ECONOMICS_EVIDENCE_V2_COMPATIBILITY).toEqual({
      v1Read: "validate-with-v1",
      v1Upgrade: "reconcile-from-current-authority",
      downgrade: "deny",
    });
    expect(validateLoopEconomicsEvidenceV2(v1).diagnostics).toEqual([
      expect.objectContaining({
        code: "LOOP_ECONOMICS_V2_DOWNGRADE_DENIED",
      }),
    ]);
    expect(admitLoopEconomicsEvidenceV2(v1).status).toBe("denied");
  });
});

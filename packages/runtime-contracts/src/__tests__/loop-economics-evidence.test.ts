import fixture from "../../fixtures/ai-execution-conformance-v2.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import {
  AI_BUDGET_RESERVATION_SCHEMA,
  reserveAiBudget,
  type AiBudgetReservation,
} from "../ai-budget-reservation.js";
import {
  AI_QUOTA_SCHEMA,
  AI_TARIFF_SCHEMA,
  type AiTariff,
} from "../ai-economics.js";
import type { AiExecutionBinding } from "../ai-execution.js";
import {
  materializeAiExecutionBinding,
  materializeAiExecutionOfferSnapshot,
  materializeAiResolvedTargetSnapshot,
} from "../ai-execution-node.js";
import {
  CANONICAL_JSON_VERSION,
  canonicalInputDigest,
} from "../idempotency.js";
import {
  LOOP_ECONOMICS_EVIDENCE_SCHEMA,
  materializeLoopEconomicsEvidence,
  validateLoopEconomicsEvidence,
  type LoopEconomicsEvidenceInput,
  type LoopEconomicsEvidenceOwner,
  type LoopEconomicsEvidenceV1,
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
  runId: "run-1",
  loopNodeId: "loop",
  reservationId: "resv:v1:run-1:iteration:loop:1",
  unit: { kind: "iteration", iteration: 1 },
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
    revision: "2026-08-01",
    effectiveAt: "2026-08-01T00:00:00.000Z",
    digest: digest("f"),
  },
  currency: "USD",
  reservedAmountMicros: 80_000,
  usageCeiling: {
    uncachedInputTokens: 1_000,
    outputTokens: 500,
  },
  reservedAt: "2026-08-14T00:00:00.000Z",
};

function pricedInput(
  overrides: Partial<LoopEconomicsEvidenceInput> = {}
): LoopEconomicsEvidenceInput {
  return {
    schema: LOOP_ECONOMICS_EVIDENCE_SCHEMA,
    canonicalization: CANONICAL_JSON_VERSION,
    owner,
    executions: [{
      nodeId: "body",
      binding,
      money: {
        status: "priced",
        reservation,
        tariffDigest: digest("a"),
      },
      quota: { status: "not-applicable" },
    }],
    effectIntents: [{ nodeId: "effect", intentDigest: digest("b") }],
    terminal: { status: "pending" },
    ...overrides,
  };
}

function settledEvidence(): LoopEconomicsEvidenceV1 {
  return materializeLoopEconomicsEvidence(pricedInput({
    terminal: {
      status: "recorded",
      executions: [{
        nodeId: "body",
        bindingDigest: binding.bindingDigest,
        receiptDigest: digest("c"),
        usage: {
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
        },
      }],
      effects: [{
        nodeId: "effect",
        intentDigest: digest("b"),
        receiptDigest: digest("d"),
      }],
    },
  }));
}

describe("loop economics evidence", () => {
  it("binds a priced reservation to exact owner, execution, tariff, and cents", () => {
    const evidence = materializeLoopEconomicsEvidence(pricedInput());

    expect(validateLoopEconomicsEvidence(evidence, {
      owner,
      reservedCostCents: 8,
      terminalStatus: "pending",
    })).toEqual({ valid: true, diagnostics: [] });
  });

  it("binds terminal V2 usage and effect receipts without retaining result bytes", () => {
    const evidence = settledEvidence();

    expect(validateLoopEconomicsEvidence(evidence, {
      owner,
      reservedCostCents: 8,
      settledCostCents: 3,
      terminalStatus: "recorded",
    })).toEqual({ valid: true, diagnostics: [] });
    expect(JSON.stringify(evidence)).not.toContain('"result"');
  });

  it("keeps subscription money unknown while retaining measured quota", () => {
    const {
      snapshotDigest: _offerDigest,
      tariffRef: _tariffRef,
      ...baseOffer
    } = binding.offer;
    const offerInput = {
      ...baseOffer,
      authMode: "subscription_cli" as const,
      quotaPolicyRef: "quota/team-plan/v3",
    };
    const { bindingDigest: _bindingDigest, ...baseBinding } = binding;
    const subscriptionBinding = materializeAiExecutionBinding({
      ...baseBinding,
      offer: materializeAiExecutionOfferSnapshot(offerInput),
    });
    const evidence = materializeLoopEconomicsEvidence(pricedInput({
      executions: [{
        nodeId: "body",
        binding: subscriptionBinding,
        money: { status: "unknown", reason: "subscription" },
        quota: {
          status: "bound",
          policyRef: "quota/team-plan/v3",
          policyDigest: digest("1"),
          decisionDigest: digest("2"),
        },
      }],
      effectIntents: [],
      terminal: {
        status: "recorded",
        executions: [{
          nodeId: "body",
          bindingDigest: subscriptionBinding.bindingDigest,
          receiptDigest: digest("3"),
          usage: {
            measurement: "known",
            tokens: { input: 12, output: 4 },
            cost: { status: "unknown", reason: "subscription" },
            quota: {
              schema: AI_QUOTA_SCHEMA,
              unit: "requests",
              consumed: 1,
              poolRef: "team-plan",
              observedAt: "2026-08-14T00:00:01.000Z",
            },
          },
        }],
        effects: [],
      },
    }));

    expect(validateLoopEconomicsEvidence(evidence, {
      owner,
      terminalStatus: "recorded",
    })).toEqual({ valid: true, diagnostics: [] });
    expect(validateLoopEconomicsEvidence(evidence, {
      reservedCostCents: 0,
    }).valid).toBe(false);
  });

  it.each([
    ["route", (input: LoopEconomicsEvidenceInput) => {
      const execution = input.executions[0]!;
      const { bindingDigest: _bindingDigest, ...baseBinding } = execution.binding;
      return {
        ...input,
        executions: [{
          ...execution,
          binding: materializeAiExecutionBinding({
        ...baseBinding,
        routeDecision: {
          ...execution.binding.routeDecision,
          decisionId: "foreign-decision",
          decisionDigest: digest("4"),
        },
          }),
        }],
      };
    }],
    ["offer", (input: LoopEconomicsEvidenceInput) => {
      const execution = input.executions[0]!;
      const { snapshotDigest: _offerDigest, ...baseOffer } = execution.binding.offer;
      const { bindingDigest: _bindingDigest, ...baseBinding } = execution.binding;
      return {
        ...input,
        executions: [{
          ...execution,
          binding: materializeAiExecutionBinding({
            ...baseBinding,
            offer: materializeAiExecutionOfferSnapshot({
        ...baseOffer,
        offerRevision: "foreign-revision",
            }),
          }),
        }],
      };
    }],
    ["target", (input: LoopEconomicsEvidenceInput) => {
      const execution = input.executions[0]!;
      const { snapshotDigest: _targetDigest, ...baseTarget } =
        execution.binding.target;
      const { bindingDigest: _bindingDigest, ...baseBinding } = execution.binding;
      return {
        ...input,
        executions: [{
          ...execution,
          binding: materializeAiExecutionBinding({
            ...baseBinding,
            target: materializeAiResolvedTargetSnapshot({
              ...baseTarget,
              targetRevision: "foreign-target-revision",
            }),
          }),
        }],
      };
    }],
    ["model revision", (input: LoopEconomicsEvidenceInput) => {
      const execution = input.executions[0]!;
      const money = execution.money;
      if (money.status !== "priced") return input;
      const revision = "foreign-model-revision";
      const { snapshotDigest: _offerDigest, ...baseOffer } =
        execution.binding.offer;
      const { bindingDigest: _bindingDigest, ...baseBinding } = execution.binding;
      return {
        ...input,
        executions: [{
          ...execution,
          binding: materializeAiExecutionBinding({
            ...baseBinding,
            model: { ...baseBinding.model, revision },
            offer: materializeAiExecutionOfferSnapshot({
              ...baseOffer,
              model: { ...baseOffer.model, revision },
            }),
          }),
          money: {
            ...money,
            reservation: { ...money.reservation, modelRevision: revision },
          },
        }],
      };
    }],
    ["tariff", (input: LoopEconomicsEvidenceInput) => {
      const execution = input.executions[0]!;
      const money = execution.money;
      return money.status !== "priced" ? input : {
        ...input,
        executions: [{
          ...execution,
          money: { ...money, tariffDigest: digest("5") },
        }],
      };
    }],
    ["price authority", (input: LoopEconomicsEvidenceInput) => {
      const execution = input.executions[0]!;
      const money = execution.money;
      return money.status !== "priced" ? input : {
        ...input,
        executions: [{
          ...execution,
          money: { ...money, reservation: {
          ...money.reservation,
          provenance: { ...money.reservation.provenance, digest: digest("6") },
          } },
        }],
      };
    }],
    ["currency", (input: LoopEconomicsEvidenceInput) => {
      const execution = input.executions[0]!;
      const money = execution.money;
      return money.status !== "priced" ? input : {
        ...input,
        executions: [{
          ...execution,
          money: {
            ...money,
            reservation: { ...money.reservation, currency: "EUR" },
          },
        }],
      };
    }],
    ["quota decision", (input: LoopEconomicsEvidenceInput) => {
      const execution = input.executions[0]!;
      return {
        ...input,
        executions: [{ ...execution, quota: {
        status: "bound" as const,
        policyRef: "foreign-policy",
        policyDigest: digest("7"),
        decisionDigest: digest("8"),
        } }],
      };
    }],
    ["effect intent", (input: LoopEconomicsEvidenceInput) => {
      return {
        ...input,
        effectIntents: [{ nodeId: "effect", intentDigest: digest("9") }],
      };
    }],
  ] as const)("rejects internally re-digested foreign %s bytes against current admission", (_label, mutate) => {
    const current = materializeLoopEconomicsEvidence(pricedInput());
    const foreign = materializeLoopEconomicsEvidence(mutate(pricedInput()));

    expect(validateLoopEconomicsEvidence(foreign, {
      reservationBindingDigest: current.reservationBindingDigest,
    }).valid).toBe(false);
  });

  it.each([
    ["usage", (value: LoopEconomicsEvidenceV1) => {
      const { reservationBindingDigest: _reservation, evidenceDigest: _evidence, ...input } = value;
      if (input.terminal.status !== "recorded") return value;
      const execution = input.terminal.executions[0]!;
      const usage = execution.usage;
      if (usage.measurement === "unknown" || usage.cost.status === "unknown") return value;
      return materializeLoopEconomicsEvidence({
        ...input,
        terminal: {
          ...input.terminal,
          executions: [{
            ...execution,
            usage: { ...usage, cost: {
              ...usage.cost,
            amountMicros: 40_000,
            charges: [{ ...usage.cost.charges[0]!, amountMicros: 40_000 }],
            } },
          }],
        },
      });
    }],
    ["effect receipt", (value: LoopEconomicsEvidenceV1) => {
      const { reservationBindingDigest: _reservation, evidenceDigest: _evidence, ...input } = value;
      return input.terminal.status !== "recorded" ? value : materializeLoopEconomicsEvidence({
        ...input,
        terminal: {
          ...input.terminal,
          effects: [{
            ...input.terminal.effects[0]!,
            receiptDigest: digest("0"),
          }],
        },
      });
    }],
  ] as const)("rejects re-digested terminal %s drift against the current record", (_label, mutate) => {
    const current = settledEvidence();
    const foreign = mutate(current);

    expect(validateLoopEconomicsEvidence(foreign, {
      evidenceDigest: current.evidenceDigest,
    }).valid).toBe(false);
  });

  it("rejects owner, schema, digest, unknown-money-as-zero, and cyclic corruption", () => {
    const valid = settledEvidence();
    const ownerDrift = {
      ...valid,
      owner: { ...valid.owner, reservationId: "foreign" },
    };
    const zeroUnknown = materializeLoopEconomicsEvidence(pricedInput({
      executions: [{
        nodeId: "body",
        binding,
        money: { status: "unknown", reason: "provider-silent" },
        quota: { status: "not-applicable" },
      }],
      effectIntents: [],
      terminal: {
        status: "recorded",
        executions: [{
          nodeId: "body",
          bindingDigest: binding.bindingDigest,
          receiptDigest: digest("e"),
          usage: {
            measurement: "known",
            tokens: { input: 1, output: 1 },
            cost: {
              status: "estimated",
              currency: "USD",
              amountMicros: 0,
              charges: [{
                attempt: 1,
                offerRef: reservation.offerRef,
                tariffRef: reservation.tariffRef,
                amountMicros: 0,
                provenance: reservation.provenance,
              }],
            },
          },
        }],
        effects: [],
      },
    }));
    const cyclic = structuredClone(valid) as LoopEconomicsEvidenceV1 & {
      self?: unknown;
    };
    cyclic.self = cyclic;

    expect(validateLoopEconomicsEvidence(ownerDrift).valid).toBe(false);
    expect(validateLoopEconomicsEvidence({ ...valid, schema: "legacy" }).valid).toBe(false);
    expect(validateLoopEconomicsEvidence({ ...valid, evidenceDigest: digest("0") }).valid).toBe(false);
    expect(validateLoopEconomicsEvidence(zeroUnknown).valid).toBe(false);
    expect(() => validateLoopEconomicsEvidence(cyclic)).not.toThrow();
    expect(validateLoopEconomicsEvidence(cyclic).valid).toBe(false);
  });

  it("cannot materialize evidence from a missing-rate or expired tariff admission", () => {
    const tariff: AiTariff = {
      schema: AI_TARIFF_SCHEMA,
      tariffId: reservation.tariffRef,
      offerRef: reservation.offerRef,
      modelRef: reservation.modelRef,
      modelRevision: reservation.modelRevision,
      currency: "USD",
      baseRates: { inputMicrosPerToken: 1, outputMicrosPerToken: 1 },
      provenance: reservation.provenance,
    };
    const request = {
      usageCeiling: {
        uncachedInputTokens: 1,
        outputTokens: 1,
        reasoningTokens: 1,
      },
      hardCeiling: { currency: "USD", maxAmountMicros: 100 },
      reservedAt: reservation.reservedAt,
    };

    expect(reserveAiBudget({ tariff, ...request })).toMatchObject({
      status: "rejected",
      reason: "rate-unavailable",
    });
    expect(reserveAiBudget({
      tariff: {
        ...tariff,
        baseRates: {
          ...tariff.baseRates,
          reasoningMicrosPerToken: 1,
        },
        provenance: {
          ...tariff.provenance,
          expiresAt: "2026-08-13T00:00:00.000Z",
        },
      },
      ...request,
    })).toMatchObject({ status: "rejected", reason: "tariff-expired" });
  });

  it("uses canonical digests rather than object identity", () => {
    const evidence = settledEvidence();
    expect(evidence.reservationBindingDigest).toBe(
      `sha256:${canonicalInputDigest({
        schema: evidence.schema,
        canonicalization: evidence.canonicalization,
        owner: evidence.owner,
        executions: evidence.executions,
        effectIntents: evidence.effectIntents,
      })}`
    );
  });
});

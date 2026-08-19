import type { LoopNode, PipelineNode } from "@dzupagent/core";
import {
  AI_BUDGET_RESERVATION_SCHEMA,
  reserveAiBudget,
  type AiBudgetReservation,
} from "@dzupagent/runtime-contracts/ai-budget-reservation";
import fixture from "@dzupagent/runtime-contracts/fixtures/ai-execution-conformance-v2.json" with { type: "json" };
import type { AiExecutionBinding } from "@dzupagent/runtime-contracts/ai-execution";
import {
  AI_QUOTA_SCHEMA,
  AI_TARIFF_SCHEMA,
  CANONICAL_JSON_VERSION,
  type AiTariff,
} from "@dzupagent/runtime-contracts";
import {
  materializeAiExecutionBinding,
  materializeAiExecutionOfferSnapshot,
  materializeAiResolvedTargetSnapshot,
} from "@dzupagent/runtime-contracts/ai-execution/node";
import {
  LOOP_ECONOMICS_EVIDENCE_SCHEMA,
  materializeLoopEconomicsEvidence,
  type LoopEconomicsEvidenceInput,
  type LoopEconomicsEvidenceOwner,
  type LoopEconomicsEvidenceV1,
  type LoopEconomicsExecutionAdmission,
} from "@dzupagent/runtime-contracts/loop-economics-evidence";
import { describe, expect, it } from "vitest";

import { executeLoop } from "../pipeline/loop-executor.js";
import type { LoopResumeOptions } from "../pipeline/loop-executor.js";
import type { NodeExecutor } from "../pipeline/pipeline-runtime-types.js";

const digest = (character: string) =>
  `sha256:${character.repeat(64)}` as const;

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

function exactEvidence(input: {
  owner: LoopEconomicsEvidenceOwner;
  nodeIds: readonly string[];
  reservedCostCents: number;
  settledCostCents?: number;
  effect?: {
    nodeId: string;
    intentDigest: `sha256:${string}`;
    receiptDigest?: `sha256:${string}`;
  };
}): LoopEconomicsEvidenceV1 {
  const nodeIds = [...input.nodeIds].sort();
  if (
    input.reservedCostCents % nodeIds.length !== 0 ||
    (input.settledCostCents !== undefined &&
      input.settledCostCents % nodeIds.length !== 0)
  ) {
    throw new Error("Test evidence costs must divide evenly across body nodes");
  }
  const reservedAmountMicros =
    (input.reservedCostCents * 10_000) / nodeIds.length;
  const settledAmountMicros =
    input.settledCostCents === undefined
      ? undefined
      : (input.settledCostCents * 10_000) / nodeIds.length;
  const reservation = (nodeId: string): AiBudgetReservation => ({
    schema: AI_BUDGET_RESERVATION_SCHEMA,
    status: "admitted",
    tariffRef: binding.offer.tariffRef!,
    offerRef: binding.offer.offerId,
    modelRef: binding.model.modelRef,
    modelRevision: binding.model.revision,
    provenance: {
      sourceKind: "provider-published",
      authorityId: "provider/prices",
      revision: `2026-08-19/${nodeId}`,
      effectiveAt: "2026-08-19T00:00:00.000Z",
      digest: digest("f"),
    },
    currency: "USD",
    reservedAmountMicros,
    usageCeiling: { uncachedInputTokens: 100, outputTokens: 50 },
    reservedAt: "2026-08-19T00:00:00.000Z",
  });
  const reservations = new Map(
    nodeIds.map((nodeId) => [nodeId, reservation(nodeId)] as const)
  );
  return materializeLoopEconomicsEvidence({
    schema: LOOP_ECONOMICS_EVIDENCE_SCHEMA,
    canonicalization: CANONICAL_JSON_VERSION,
    owner: input.owner,
    executions: nodeIds.map((nodeId) => ({
      nodeId,
      binding,
      money: {
        status: "priced" as const,
        reservation: reservations.get(nodeId)!,
        tariffDigest: digest("a"),
      },
      quota: { status: "not-applicable" as const },
    })),
    effectIntents: input.effect === undefined
      ? []
      : [{
          nodeId: input.effect.nodeId,
          intentDigest: input.effect.intentDigest,
        }],
    terminal:
      settledAmountMicros === undefined
        ? { status: "pending" }
        : {
            status: "recorded",
            executions: nodeIds.map((nodeId, index) => {
              const reservation = reservations.get(nodeId)!;
              return {
                nodeId,
                bindingDigest: binding.bindingDigest,
                receiptDigest: digest(String((index + 1) % 10)),
                usage: {
                  measurement: "known" as const,
                  tokens: { input: 2, output: 1 },
                  cost: {
                    status: "reconciled" as const,
                    currency: "USD",
                    amountMicros: settledAmountMicros,
                    charges: [{
                      attempt: 1,
                      offerRef: reservation.offerRef,
                      tariffRef: reservation.tariffRef,
                      amountMicros: settledAmountMicros,
                      provenance: reservation.provenance,
                    }],
                  },
                },
              };
            }),
            effects: input.effect === undefined
              ? []
              : [{
                  nodeId: input.effect.nodeId,
                  intentDigest: input.effect.intentDigest,
                  receiptDigest: input.effect.receiptDigest ?? digest("e"),
                }],
          },
  });
}

function rematerializeEvidence(
  evidence: LoopEconomicsEvidenceV1,
  mutate: (input: LoopEconomicsEvidenceInput) => LoopEconomicsEvidenceInput
): LoopEconomicsEvidenceV1 {
  const {
    reservationBindingDigest: _reservationBindingDigest,
    evidenceDigest: _evidenceDigest,
    ...input
  } = structuredClone(evidence);
  return materializeLoopEconomicsEvidence(mutate(input));
}

function replaceFirstExecution(
  evidence: LoopEconomicsEvidenceV1,
  mutate: (
    execution: LoopEconomicsExecutionAdmission
  ) => LoopEconomicsExecutionAdmission
): LoopEconomicsEvidenceV1 {
  return rematerializeEvidence(evidence, (input) => ({
    ...input,
    executions: [mutate(input.executions[0]!)],
  }));
}

function withBinding(
  execution: LoopEconomicsExecutionAdmission,
  nextBinding: AiExecutionBinding,
  mutateReservation?: (reservation: AiBudgetReservation) => AiBudgetReservation
): LoopEconomicsExecutionAdmission {
  return {
    ...execution,
    binding: nextBinding,
    money: execution.money.status === "priced" && mutateReservation !== undefined
      ? {
          ...execution.money,
          reservation: mutateReservation(execution.money.reservation),
        }
      : execution.money,
  };
}

function subscriptionEvidence(input: {
  owner: LoopEconomicsEvidenceOwner;
  moneyAsZero?: boolean;
  omitQuota?: boolean;
}): LoopEconomicsEvidenceV1 {
  const {
    snapshotDigest: _offerDigest,
    tariffRef: _tariffRef,
    ...baseOffer
  } = binding.offer;
  const { bindingDigest: _bindingDigest, ...baseBinding } = binding;
  const subscriptionBinding = materializeAiExecutionBinding({
    ...baseBinding,
    offer: materializeAiExecutionOfferSnapshot({
      ...baseOffer,
      authMode: "subscription_cli",
      quotaPolicyRef: "quota/team-plan/v3",
    }),
  });
  return materializeLoopEconomicsEvidence({
    schema: LOOP_ECONOMICS_EVIDENCE_SCHEMA,
    canonicalization: CANONICAL_JSON_VERSION,
    owner: input.owner,
    executions: [{
      nodeId: "body",
      binding: subscriptionBinding,
      money: { status: "unknown", reason: "subscription" },
      quota: {
        status: "bound",
        policyRef: "quota/team-plan/v3",
        policyDigest: digest("7"),
        decisionDigest: digest("8"),
      },
    }],
    effectIntents: [],
    terminal: {
      status: "recorded",
      executions: [{
        nodeId: "body",
        bindingDigest: subscriptionBinding.bindingDigest,
        receiptDigest: digest("9"),
        usage: {
          measurement: "known",
          tokens: { input: 2, output: 1 },
          cost: input.moneyAsZero
            ? {
                status: "estimated",
                currency: "USD",
                amountMicros: 0,
                charges: [{
                  attempt: 1,
                  offerRef: subscriptionBinding.offer.offerId,
                  tariffRef: "tariff/fictional",
                  amountMicros: 0,
                  provenance: {
                    sourceKind: "provider-published",
                    authorityId: "provider/prices",
                    revision: "fictional",
                    effectiveAt: "2026-08-19T00:00:00.000Z",
                    digest: digest("6"),
                  },
                }],
              }
            : { status: "unknown", reason: "subscription" },
          ...(input.omitQuota
            ? {}
            : {
                quota: {
                  schema: AI_QUOTA_SCHEMA,
                  unit: "requests",
                  consumed: 1,
                  poolRef: "team-plan",
                  observedAt: "2026-08-19T00:00:01.000Z",
                },
              }),
        },
      }],
      effects: [],
    },
  });
}

function owner(input: {
  runId: string;
  loopNodeId: string;
  reservationId: string;
  itemIndex?: number;
  attempt?: number;
}): LoopEconomicsEvidenceOwner {
  return {
    runId: input.runId,
    loopNodeId: input.loopNodeId,
    reservationId: input.reservationId,
    unit:
      input.itemIndex === undefined
        ? { kind: "iteration", iteration: 1 }
        : {
            kind: "item",
            itemIndex: input.itemIndex,
            iteration: input.itemIndex + 1,
            attempt: input.attempt ?? 0,
          },
  };
}

const executor = (runs: string[]): NodeExecutor => async (nodeId) => {
  runs.push(nodeId);
  return { nodeId, output: "ok", durationMs: 1 };
};

describe("exact loop economics evidence", () => {
  it("rejects cents-only predicate reservations before body dispatch", async () => {
    const runs: string[] = [];
    const releases: unknown[] = [];
    const loopNode: LoopNode = {
      id: "predicate",
      type: "loop",
      bodyNodeIds: ["body"],
      maxIterations: 1,
      continuePredicateName: "continue",
      typedWhile: {
        conditionSchema: "dzupagent.flowTypedCondition/v1",
        condition: { op: "literal", value: true },
        onExhausted: "continue",
        iterationBudgetCents: 8,
      },
    };
    const result = await executeLoop(
      loopNode,
      [{ id: "body", type: "agent", agentId: "body" }],
      executor(runs),
      { state: {}, previousResults: new Map() },
      { continue: () => false },
      undefined,
      {
        budgetMode: "strict",
        budgetEvidenceMode: "required",
        budgetRunId: "missing-evidence",
        reserveIterationBudget: async () => ({
          status: "reserved",
          reservedCostCents: 8,
        }),
        settleIterationBudget: async () => undefined,
        releaseIterationBudget: async (input) => {
          releases.push(input);
        },
        reconcileIterationBudget: async () => ({ status: "unknown" }),
        measureItemCost: async () => ({ status: "known", costCents: 3 }),
      }
    );

    expect(result.result.error).toContain("legacy cents-only reservation");
    expect(runs).toEqual([]);
    expect(releases).toHaveLength(1);
  });

  it.each([
    ["route", (evidence: LoopEconomicsEvidenceV1) =>
      replaceFirstExecution(evidence, (execution) => {
        const { bindingDigest: _bindingDigest, ...baseBinding } =
          execution.binding;
        return withBinding(
          execution,
          materializeAiExecutionBinding({
            ...baseBinding,
            routeDecision: {
              ...baseBinding.routeDecision,
              decisionId: "foreign-route-decision",
              decisionDigest: digest("1"),
            },
          })
        );
      })],
    ["offer", (evidence: LoopEconomicsEvidenceV1) =>
      replaceFirstExecution(evidence, (execution) => {
        const { bindingDigest: _bindingDigest, ...baseBinding } =
          execution.binding;
        const { snapshotDigest: _offerDigest, ...baseOffer } =
          execution.binding.offer;
        return withBinding(
          execution,
          materializeAiExecutionBinding({
            ...baseBinding,
            offer: materializeAiExecutionOfferSnapshot({
              ...baseOffer,
              offerRevision: "foreign-offer-revision",
            }),
          })
        );
      })],
    ["target", (evidence: LoopEconomicsEvidenceV1) =>
      replaceFirstExecution(evidence, (execution) => {
        const { bindingDigest: _bindingDigest, ...baseBinding } =
          execution.binding;
        const { snapshotDigest: _targetDigest, ...baseTarget } =
          execution.binding.target;
        return withBinding(
          execution,
          materializeAiExecutionBinding({
            ...baseBinding,
            target: materializeAiResolvedTargetSnapshot({
              ...baseTarget,
              targetRevision: "foreign-target-revision",
            }),
          })
        );
      })],
    ["model revision", (evidence: LoopEconomicsEvidenceV1) =>
      replaceFirstExecution(evidence, (execution) => {
        const revision = "foreign-model-revision";
        const { bindingDigest: _bindingDigest, ...baseBinding } =
          execution.binding;
        const { snapshotDigest: _offerDigest, ...baseOffer } =
          execution.binding.offer;
        const nextBinding = materializeAiExecutionBinding({
          ...baseBinding,
          model: { ...baseBinding.model, revision },
          offer: materializeAiExecutionOfferSnapshot({
            ...baseOffer,
            model: { ...baseOffer.model, revision },
          }),
        });
        return withBinding(execution, nextBinding, (value) => ({
          ...value,
          modelRevision: revision,
        }));
      })],
    ["tariff", (evidence: LoopEconomicsEvidenceV1) =>
      replaceFirstExecution(evidence, (execution) => {
        const tariffRef = "tariff/foreign/2026-08";
        const { bindingDigest: _bindingDigest, ...baseBinding } =
          execution.binding;
        const { snapshotDigest: _offerDigest, ...baseOffer } =
          execution.binding.offer;
        const nextBinding = materializeAiExecutionBinding({
          ...baseBinding,
          offer: materializeAiExecutionOfferSnapshot({
            ...baseOffer,
            tariffRef,
          }),
        });
        return withBinding(execution, nextBinding, (value) => ({
          ...value,
          tariffRef,
        }));
      })],
    ["price authority", (evidence: LoopEconomicsEvidenceV1) =>
      replaceFirstExecution(evidence, (execution) => ({
        ...execution,
        money: execution.money.status === "priced"
          ? {
              ...execution.money,
              reservation: {
                ...execution.money.reservation,
                provenance: {
                  ...execution.money.reservation.provenance,
                  authorityId: "foreign/price-authority",
                  revision: "foreign-revision",
                  digest: digest("2"),
                },
              },
            }
          : execution.money,
      }))],
    ["currency", (evidence: LoopEconomicsEvidenceV1) =>
      replaceFirstExecution(evidence, (execution) => ({
        ...execution,
        money: execution.money.status === "priced"
          ? {
              ...execution.money,
              reservation: {
                ...execution.money.reservation,
                currency: "EUR",
              },
            }
          : execution.money,
      }))],
    ["quota policy", (evidence: LoopEconomicsEvidenceV1) =>
      replaceFirstExecution(evidence, (execution) => {
        const policyRef = "quota/foreign/v1";
        const { bindingDigest: _bindingDigest, ...baseBinding } =
          execution.binding;
        const { snapshotDigest: _offerDigest, ...baseOffer } =
          execution.binding.offer;
        return {
          ...withBinding(
            execution,
            materializeAiExecutionBinding({
              ...baseBinding,
              offer: materializeAiExecutionOfferSnapshot({
                ...baseOffer,
                quotaPolicyRef: policyRef,
              }),
            })
          ),
          quota: {
            status: "bound" as const,
            policyRef,
            policyDigest: digest("3"),
            decisionDigest: digest("4"),
          },
        };
      })],
    ["effect intent", (evidence: LoopEconomicsEvidenceV1) =>
      rematerializeEvidence(evidence, (input) => ({
        ...input,
        effectIntents: [{ nodeId: "body", intentDigest: digest("5") }],
      }))],
  ] as const)(
    "rejects a re-digested foreign %s admission before resumed body dispatch",
    async (_label, mutate) => {
      const runId = "foreign-admission";
      const reservationId =
        "resv:v1:foreign-admission:iteration:predicate:1";
      const evidenceOwner = owner({
        runId,
        loopNodeId: "predicate",
        reservationId,
      });
      const current = exactEvidence({
        owner: evidenceOwner,
        nodeIds: ["body"],
        reservedCostCents: 8,
        effect: { nodeId: "body", intentDigest: digest("a") },
      });
      const foreign = mutate(current);
      const runs: string[] = [];
      let reconciles = 0;
      const result = await executeLoop(
        {
          id: "predicate",
          type: "loop",
          bodyNodeIds: ["body"],
          maxIterations: 1,
          continuePredicateName: "continue",
          typedWhile: {
            conditionSchema: "dzupagent.flowTypedCondition/v1",
            condition: { op: "literal", value: true },
            onExhausted: "continue",
            iterationBudgetCents: 8,
          },
        },
        [{ id: "body", type: "agent", agentId: "body" }],
        executor(runs),
        { state: {}, previousResults: new Map() },
        { continue: () => false },
        undefined,
        {
          iterationOutcome: "running",
          iterationEconomics: {
            reservationId,
            reservedCostCents: 8,
            evidence: current,
          },
          budgetMode: "strict",
          budgetEvidenceMode: "required",
          budgetRunId: runId,
          reserveIterationBudget: async () => ({ status: "unknown" }),
          settleIterationBudget: async () => undefined,
          releaseIterationBudget: async () => undefined,
          reconcileIterationBudget: async () => {
            reconciles++;
            return {
              status: "reserved",
              reservedCostCents: 8,
              evidence: foreign,
            };
          },
          measureItemCost: async () => ({
            status: "unknown",
            reason: "must not measure",
          }),
        }
      );

      expect(result.result.error).toContain(
        "reconciliation returned invalid exact economics evidence"
      );
      expect(runs).toEqual([]);
      expect(reconciles).toBe(1);
    }
  );

  it("propagates exact terminal evidence through predicate settlement and checkpoint", async () => {
    const runId = "predicate-exact";
    const reservationId =
      "resv:v1:predicate-exact:iteration:predicate:1";
    const evidenceOwner = owner({ runId, loopNodeId: "predicate", reservationId });
    const pending = exactEvidence({
      owner: evidenceOwner,
      nodeIds: ["body"],
      reservedCostCents: 8,
    });
    const terminal = exactEvidence({
      owner: evidenceOwner,
      nodeIds: ["body"],
      reservedCostCents: 8,
      settledCostCents: 4,
    });
    const checkpoints: unknown[] = [];
    const settlements: unknown[] = [];
    const result = await executeLoop(
      {
        id: "predicate",
        type: "loop",
        bodyNodeIds: ["body"],
        maxIterations: 1,
        continuePredicateName: "continue",
        typedWhile: {
          conditionSchema: "dzupagent.flowTypedCondition/v1",
          condition: { op: "literal", value: true },
          onExhausted: "continue",
          iterationBudgetCents: 8,
        },
      },
      [{ id: "body", type: "agent", agentId: "body" }],
      executor([]),
      { state: {}, previousResults: new Map() },
      { continue: () => false },
      undefined,
      {
        budgetMode: "strict",
        budgetEvidenceMode: "required",
        budgetRunId: runId,
        reserveIterationBudget: async () => ({
          status: "reserved",
          reservedCostCents: 8,
          evidence: pending,
        }),
        measureItemCost: async () => ({
          status: "known",
          costCents: 4,
          evidence: terminal,
        }),
        settleIterationBudget: async (input) => {
          settlements.push(input);
        },
        releaseIterationBudget: async () => undefined,
        reconcileIterationBudget: async () => ({ status: "unknown" }),
        onIterationBudgetCheckpoint: async (input) => {
          checkpoints.push(input);
        },
      }
    );

    expect(result.result.error).toBeUndefined();
    expect(settlements).toContainEqual(
      expect.objectContaining({ evidence: terminal, actualCostCents: 4 })
    );
    expect(checkpoints).toContainEqual(
      expect.objectContaining({
        outcome: "completed",
        economics: expect.objectContaining({ evidence: terminal }),
      })
    );
  });

  it("uses an exact committed effect receipt on resume and dispatches an empty-journal control once", async () => {
    const runCase = async (input: {
      runId: string;
      precommitted: boolean;
    }): Promise<string[]> => {
      const reservationId =
        `resv:v1:${input.runId}:iteration:effect-loop:1`;
      const evidenceOwner = owner({
        runId: input.runId,
        loopNodeId: "effect-loop",
        reservationId,
      });
      const intentDigest = digest("a");
      const receiptDigest = digest("b");
      const pending = exactEvidence({
        owner: evidenceOwner,
        nodeIds: ["effect"],
        reservedCostCents: 8,
        effect: { nodeId: "effect", intentDigest },
      });
      const terminal = exactEvidence({
        owner: evidenceOwner,
        nodeIds: ["effect"],
        reservedCostCents: 8,
        settledCostCents: 4,
        effect: { nodeId: "effect", intentDigest, receiptDigest },
      });
      const committed = new Set<string>(
        input.precommitted ? [receiptDigest] : []
      );
      const externalDispatches: string[] = [];
      const result = await executeLoop(
        {
          id: "effect-loop",
          type: "loop",
          bodyNodeIds: ["effect"],
          maxIterations: 1,
          continuePredicateName: "continue",
          typedWhile: {
            conditionSchema: "dzupagent.flowTypedCondition/v1",
            condition: { op: "literal", value: true },
            onExhausted: "continue",
            iterationBudgetCents: 8,
          },
        },
        [{ id: "effect", type: "agent", agentId: "effect" }],
        async (nodeId) => {
          if (!committed.has(receiptDigest)) {
            externalDispatches.push(input.runId);
            committed.add(receiptDigest);
          }
          return {
            nodeId,
            output: { intentDigest, receiptDigest },
            durationMs: 1,
          };
        },
        { state: {}, previousResults: new Map() },
        { continue: () => false },
        undefined,
        {
          iterationOutcome: "running",
          iterationEconomics: {
            reservationId,
            reservedCostCents: 8,
            evidence: pending,
          },
          budgetMode: "strict",
          budgetEvidenceMode: "required",
          budgetRunId: input.runId,
          reserveIterationBudget: async () => ({ status: "unknown" }),
          reconcileIterationBudget: async () => ({
            status: "reserved",
            reservedCostCents: 8,
            evidence: pending,
          }),
          measureItemCost: async () => ({
            status: "known",
            costCents: 4,
            evidence: terminal,
          }),
          settleIterationBudget: async () => undefined,
          releaseIterationBudget: async () => undefined,
        }
      );
      expect(result.result.error).toBeUndefined();
      expect(committed).toContain(receiptDigest);
      return externalDispatches;
    };

    expect(await runCase({
      runId: "effect-committed",
      precommitted: true,
    })).toEqual([]);
    expect(await runCase({
      runId: "effect-empty-control",
      precommitted: false,
    })).toEqual(["effect-empty-control"]);
  });

  it.each([
    ["usage attribution", (evidence: LoopEconomicsEvidenceV1) =>
      rematerializeEvidence(evidence, (input) => {
        if (input.terminal.status !== "recorded") {
          throw new Error("test setup requires terminal evidence");
        }
        const execution = input.terminal.executions[0]!;
        const usage = execution.usage;
        if (usage.measurement === "unknown" || usage.cost.status === "unknown") {
          throw new Error("test setup requires priced terminal usage");
        }
        return {
          ...input,
          terminal: {
            ...input.terminal,
            executions: [{
              ...execution,
              usage: {
                ...usage,
                cost: {
                  ...usage.cost,
                  charges: usage.cost.charges.map((charge) => ({
                    ...charge,
                    offerRef: "foreign-offer",
                  })),
                },
              },
            }],
          },
        };
      })],
    ["effect intent", (evidence: LoopEconomicsEvidenceV1) =>
      rematerializeEvidence(evidence, (input) => {
        if (input.terminal.status !== "recorded") {
          throw new Error("test setup requires terminal evidence");
        }
        return {
          ...input,
          terminal: {
            ...input.terminal,
            effects: [{
              ...input.terminal.effects[0]!,
              intentDigest: digest("c"),
            }],
          },
        };
      })],
    ["effect receipt", (evidence: LoopEconomicsEvidenceV1) => {
      const foreign = structuredClone(evidence);
      if (foreign.terminal.status !== "recorded") {
        throw new Error("test setup requires terminal evidence");
      }
      const effect = foreign.terminal.effects[0]! as {
        receiptDigest: `sha256:${string}`;
      };
      effect.receiptDigest = digest("d");
      return foreign;
    }],
    ["terminal cost", (evidence: LoopEconomicsEvidenceV1) =>
      rematerializeEvidence(evidence, (input) => {
        if (input.terminal.status !== "recorded") {
          throw new Error("test setup requires terminal evidence");
        }
        const execution = input.terminal.executions[0]!;
        const usage = execution.usage;
        if (usage.measurement === "unknown" || usage.cost.status === "unknown") {
          throw new Error("test setup requires priced terminal usage");
        }
        return {
          ...input,
          terminal: {
            ...input.terminal,
            executions: [{
              ...execution,
              usage: {
                ...usage,
                cost: {
                  ...usage.cost,
                  amountMicros: 50_000,
                  charges: usage.cost.charges.map((charge) => ({
                    ...charge,
                    amountMicros: 50_000,
                  })),
                },
              },
            }],
          },
        };
      })],
    ["quota measurement", (evidence: LoopEconomicsEvidenceV1) =>
      rematerializeEvidence(evidence, (input) => {
        if (input.terminal.status !== "recorded") {
          throw new Error("test setup requires terminal evidence");
        }
        const admission = input.executions[0]!;
        const { bindingDigest: _bindingDigest, ...baseBinding } =
          admission.binding;
        const { snapshotDigest: _offerDigest, ...baseOffer } =
          admission.binding.offer;
        const policyRef = "quota/measured/v1";
        const nextBinding = materializeAiExecutionBinding({
          ...baseBinding,
          offer: materializeAiExecutionOfferSnapshot({
            ...baseOffer,
            quotaPolicyRef: policyRef,
          }),
        });
        return {
          ...input,
          executions: [{
            ...admission,
            binding: nextBinding,
            quota: {
              status: "bound",
              policyRef,
              policyDigest: digest("e"),
              decisionDigest: digest("f"),
            },
          }],
          terminal: {
            ...input.terminal,
            executions: [{
              ...input.terminal.executions[0]!,
              bindingDigest: nextBinding.bindingDigest,
            }],
          },
        };
      })],
  ] as const)(
    "rejects terminal %s drift before a completed checkpoint can redispatch",
    async (_label, mutate) => {
      const runId = "terminal-drift";
      const reservationId =
        "resv:v1:terminal-drift:iteration:predicate:1";
      const evidenceOwner = owner({
        runId,
        loopNodeId: "predicate",
        reservationId,
      });
      const valid = exactEvidence({
        owner: evidenceOwner,
        nodeIds: ["body"],
        reservedCostCents: 8,
        settledCostCents: 4,
        effect: {
          nodeId: "body",
          intentDigest: digest("a"),
          receiptDigest: digest("b"),
        },
      });
      const runs: string[] = [];
      let lifecycleCalls = 0;
      const result = await executeLoop(
        {
          id: "predicate",
          type: "loop",
          bodyNodeIds: ["body"],
          maxIterations: 1,
          continuePredicateName: "continue",
          typedWhile: {
            conditionSchema: "dzupagent.flowTypedCondition/v1",
            condition: { op: "literal", value: true },
            onExhausted: "continue",
            iterationBudgetCents: 8,
          },
        },
        [{ id: "body", type: "agent", agentId: "body" }],
        executor(runs),
        { state: {}, previousResults: new Map() },
        { continue: () => false },
        undefined,
        {
          startBodyNodeIndex: 1,
          bodyResults: {
            body: { nodeId: "body", output: "retained", durationMs: 1 },
          },
          iterationOutcome: "completed",
          iterationEconomics: {
            reservationId,
            reservedCostCents: 8,
            settledCostCents: 4,
            evidence: mutate(valid),
          },
          budgetMode: "strict",
          budgetEvidenceMode: "required",
          budgetRunId: runId,
          reserveIterationBudget: async () => {
            lifecycleCalls++;
            return { status: "unknown" };
          },
          settleIterationBudget: async () => {
            lifecycleCalls++;
          },
          releaseIterationBudget: async () => {
            lifecycleCalls++;
          },
          reconcileIterationBudget: async () => {
            lifecycleCalls++;
            return { status: "unknown" };
          },
          measureItemCost: async () => {
            lifecycleCalls++;
            return { status: "unknown", reason: "must not measure" };
          },
        }
      );

      expect(result.result.error).toContain(
        "checkpoint exact economics evidence is invalid"
      );
      expect(runs).toEqual([]);
      expect(lifecycleCalls).toBe(0);
    }
  );

  it.each([
    ["unknown money represented as zero", (ownerValue: LoopEconomicsEvidenceOwner) =>
      subscriptionEvidence({ owner: ownerValue, moneyAsZero: true })],
    ["bound quota omitted as though zero", (ownerValue: LoopEconomicsEvidenceOwner) =>
      subscriptionEvidence({ owner: ownerValue, omitQuota: true })],
  ] as const)("rejects %s with zero dispatch", async (_label, evidenceFor) => {
    const runId = "unknown-is-not-zero";
    const reservationId =
      "resv:v1:unknown-is-not-zero:iteration:predicate:1";
    const runs: string[] = [];
    const result = await executeLoop(
      {
        id: "predicate",
        type: "loop",
        bodyNodeIds: ["body"],
        maxIterations: 1,
        continuePredicateName: "continue",
        typedWhile: {
          conditionSchema: "dzupagent.flowTypedCondition/v1",
          condition: { op: "literal", value: true },
          onExhausted: "continue",
          iterationBudgetCents: 8,
        },
      },
      [{ id: "body", type: "agent", agentId: "body" }],
      executor(runs),
      { state: {}, previousResults: new Map() },
      { continue: () => false },
      undefined,
      {
        startBodyNodeIndex: 1,
        bodyResults: {
          body: { nodeId: "body", output: "retained", durationMs: 1 },
        },
        iterationOutcome: "completed",
        iterationEconomics: {
          reservationId,
          reservedCostCents: 0,
          settledCostCents: 0,
          evidence: evidenceFor(owner({
            runId,
            loopNodeId: "predicate",
            reservationId,
          })),
        },
        budgetMode: "strict",
        budgetEvidenceMode: "required",
        budgetRunId: runId,
        reserveIterationBudget: async () => ({ status: "unknown" }),
        settleIterationBudget: async () => undefined,
        releaseIterationBudget: async () => undefined,
        reconcileIterationBudget: async () => ({ status: "unknown" }),
        measureItemCost: async () => ({ status: "unknown" }),
      }
    );

    expect(result.result.error).toContain(
      "checkpoint exact economics evidence is invalid"
    );
    expect(runs).toEqual([]);
  });

  it.each(["schema", "digest", "binding", "cycle"] as const)(
    "rejects corrupt %s evidence with zero dispatch",
    async (kind) => {
      const runId = "corrupt-evidence";
      const reservationId =
        "resv:v1:corrupt-evidence:iteration:predicate:1";
      const valid = exactEvidence({
        owner: owner({ runId, loopNodeId: "predicate", reservationId }),
        nodeIds: ["body"],
        reservedCostCents: 8,
      });
      const invalid = structuredClone(valid) as LoopEconomicsEvidenceV1 & {
        self?: unknown;
      };
      if (kind === "schema") {
        Object.assign(invalid, { canonicalization: "non-canonical" });
      } else if (kind === "digest") {
        Object.assign(invalid, { evidenceDigest: digest("0") });
      } else if (kind === "binding") {
        Object.assign(invalid.executions[0]!.binding, {
          bindingDigest: digest("0"),
        });
      } else {
        invalid.self = invalid;
      }
      const runs: string[] = [];
      const result = await executeLoop(
        {
          id: "predicate",
          type: "loop",
          bodyNodeIds: ["body"],
          maxIterations: 1,
          continuePredicateName: "continue",
          typedWhile: {
            conditionSchema: "dzupagent.flowTypedCondition/v1",
            condition: { op: "literal", value: true },
            onExhausted: "continue",
            iterationBudgetCents: 8,
          },
        },
        [{ id: "body", type: "agent", agentId: "body" }],
        executor(runs),
        { state: {}, previousResults: new Map() },
        { continue: () => false },
        undefined,
        {
          iterationOutcome: "running",
          iterationEconomics: {
            reservationId,
            reservedCostCents: 8,
            evidence: invalid,
          },
          budgetMode: "strict",
          budgetEvidenceMode: "required",
          budgetRunId: runId,
          reserveIterationBudget: async () => ({ status: "unknown" }),
          settleIterationBudget: async () => undefined,
          releaseIterationBudget: async () => undefined,
          reconcileIterationBudget: async () => ({ status: "unknown" }),
          measureItemCost: async () => ({ status: "unknown" }),
        }
      );

      expect(result.result.error).toContain(
        "checkpoint exact economics evidence is invalid"
      );
      expect(runs).toEqual([]);
    }
  );

  it.each(["missing tariff", "expired tariff", "missing usage rate"] as const)(
    "blocks %s admission before dispatch",
    async (kind) => {
      const tariff: AiTariff = {
        schema: AI_TARIFF_SCHEMA,
        tariffId: binding.offer.tariffRef!,
        offerRef: binding.offer.offerId,
        modelRef: binding.model.modelRef,
        modelRevision: binding.model.revision,
        currency: "USD",
        baseRates: {
          inputMicrosPerToken: 1,
          outputMicrosPerToken: 1,
          ...(kind === "missing usage rate"
            ? {}
            : { reasoningMicrosPerToken: 1 }),
        },
        provenance: {
          sourceKind: "provider-published",
          authorityId: "provider/prices",
          revision: "2026-08-19",
          effectiveAt: "2026-08-19T00:00:00.000Z",
          digest: digest("f"),
          ...(kind === "expired tariff"
            ? { expiresAt: "2026-08-19T00:00:01.000Z" }
            : {}),
        },
      };
      const reservation = kind === "missing tariff"
        ? undefined
        : reserveAiBudget({
            tariff,
            usageCeiling: {
              uncachedInputTokens: 1,
              outputTokens: 1,
              reasoningTokens: 1,
            },
            hardCeiling: { currency: "USD", maxAmountMicros: 100 },
            reservedAt: "2026-08-19T00:00:02.000Z",
          });
      if (kind === "expired tariff") {
        expect(reservation).toMatchObject({
          status: "rejected",
          reason: "tariff-expired",
        });
      } else if (kind === "missing usage rate") {
        expect(reservation).toMatchObject({
          status: "rejected",
          reason: "rate-unavailable",
        });
      }
      const runs: string[] = [];
      const result = await executeLoop(
        {
          id: "predicate",
          type: "loop",
          bodyNodeIds: ["body"],
          maxIterations: 1,
          continuePredicateName: "continue",
          typedWhile: {
            conditionSchema: "dzupagent.flowTypedCondition/v1",
            condition: { op: "literal", value: true },
            onExhausted: "continue",
            iterationBudgetCents: 8,
          },
        },
        [{ id: "body", type: "agent", agentId: "body" }],
        executor(runs),
        { state: {}, previousResults: new Map() },
        { continue: () => false },
        undefined,
        {
          budgetMode: "strict",
          budgetEvidenceMode: "required",
          budgetRunId: `tariff-${kind.replaceAll(" ", "-")}`,
          reserveIterationBudget: async () => ({ status: "unknown" }),
          settleIterationBudget: async () => undefined,
          releaseIterationBudget: async () => undefined,
          reconcileIterationBudget: async () => ({ status: "absent" }),
          measureItemCost: async () => ({ status: "unknown" }),
        }
      );

      expect(result.result.error).toContain("body dispatch is denied");
      expect(runs).toEqual([]);
    }
  );

  it("propagates for_each evidence and rejects foreign retained evidence with zero dispatch", async () => {
    const loopNode: LoopNode = {
      id: "items-loop",
      type: "loop",
      bodyNodeIds: ["step-a", "step-b"],
      maxIterations: 2,
      continuePredicateName: "unused",
      forEach: {
        source: "$.items",
        as: "item",
        order: "input",
        concurrency: 1,
        empty: { body: "skip", aggregate: "empty-array" },
      },
    };
    const bodyNodes: PipelineNode[] = [
      { id: "step-a", type: "agent", agentId: "a" },
      { id: "step-b", type: "agent", agentId: "b" },
    ];
    const runId = "foreach-exact";
    const reservationId = "resv:v1:foreach-exact:item:items-loop:0";
    const evidenceOwner = owner({
      runId,
      loopNodeId: "items-loop",
      reservationId,
      itemIndex: 0,
    });
    const pending = exactEvidence({
      owner: evidenceOwner,
      nodeIds: ["step-a", "step-b"],
      reservedCostCents: 50,
    });
    const terminal = exactEvidence({
      owner: evidenceOwner,
      nodeIds: ["step-a", "step-b"],
      reservedCostCents: 50,
      settledCostCents: 20,
    });
    const checkpoints: unknown[] = [];
    const outcomes: unknown[] = [];
    const resume: LoopResumeOptions = {
      budgetMode: "strict",
      budgetEvidenceMode: "required",
      budgetRunId: runId,
      itemBudgetCents: 50,
      reserveIterationBudget: async () => ({
        status: "reserved",
        reservedCostCents: 50,
        evidence: pending,
      }),
      measureItemCost: async () => ({
        status: "known",
        costCents: 20,
        evidence: terminal,
      }),
      settleIterationBudget: async () => undefined,
      releaseIterationBudget: async () => undefined,
      reconcileIterationBudget: async () => ({ status: "unknown" }),
      onItemBodyNodeComplete: async (input) => {
        checkpoints.push(input);
      },
      onItemTerminalOutcome: async (input) => {
        outcomes.push(input);
      },
    };
    const completed = await executeLoop(
      loopNode,
      bodyNodes,
      executor([]),
      { state: { items: [{ id: "a" }] }, previousResults: new Map() },
      {},
      undefined,
      resume
    );

    expect(completed.result.error).toBeUndefined();
    expect(checkpoints).toContainEqual(
      expect.objectContaining({
        outcome: "completed",
        economics: expect.objectContaining({ evidence: terminal }),
      })
    );
    expect(outcomes).toContainEqual(
      expect.objectContaining({
        outcome: "completed",
        economics: expect.objectContaining({ evidence: terminal }),
      })
    );

    const resumedPositiveRuns: string[] = [];
    let resumedPositiveReserves = 0;
    let resumedPositiveReconciles = 0;
    const resumedReservationId =
      "resv:v1:foreach-exact:item:items-loop:0:attempt:1";
    const resumedOwner = owner({
      runId,
      loopNodeId: "items-loop",
      reservationId: resumedReservationId,
      itemIndex: 0,
      attempt: 1,
    });
    const resumedPending = exactEvidence({
      owner: resumedOwner,
      nodeIds: ["step-a", "step-b"],
      reservedCostCents: 50,
    });
    const resumedTerminal = exactEvidence({
      owner: resumedOwner,
      nodeIds: ["step-a", "step-b"],
      reservedCostCents: 50,
      settledCostCents: 20,
    });
    const resumedPositive = await executeLoop(
      loopNode,
      bodyNodes,
      executor(resumedPositiveRuns),
      { state: { items: [{ id: "a" }] }, previousResults: new Map() },
      {},
      undefined,
      {
        ...resume,
        reserveIterationBudget: async () => {
          resumedPositiveReserves++;
          return {
            status: "reserved",
            reservedCostCents: 50,
            evidence: resumedPending,
          };
        },
        measureItemCost: async () => ({
          status: "known",
          costCents: 20,
          evidence: resumedTerminal,
        }),
        reconcileIterationBudget: async () => {
          resumedPositiveReconciles++;
          return {
            status: "reserved",
            reservedCostCents: 50,
            evidence: resumedPending,
          };
        },
        itemFrames: {
          "0": {
            itemIndex: 0,
            nextBodyNodeIndex: 1,
            bodyResults: {
              "step-a": {
                nodeId: "step-a",
                output: "retained",
                durationMs: 1,
              },
            },
            outcome: "running",
            economics: {
              reservationId,
              reservedCostCents: 50,
              evidence: pending,
            },
          },
        },
      }
    );

    expect(resumedPositive.result.error).toBeUndefined();
    expect(resumedPositiveRuns).toEqual(["step-b"]);
    expect(resumedPositiveReserves).toBe(1);
    expect(resumedPositiveReconciles).toBe(0);

    const foreign = exactEvidence({
      owner: owner({
        runId: "foreign-run",
        loopNodeId: "items-loop",
        reservationId: "resv:v1:foreign-run:item:items-loop:0",
        itemIndex: 0,
      }),
      nodeIds: ["step-a", "step-b"],
      reservedCostCents: 50,
    });
    const resumedRuns: string[] = [];
    let reconciles = 0;
    const rejected = await executeLoop(
      loopNode,
      bodyNodes,
      executor(resumedRuns),
      { state: { items: [{ id: "a" }] }, previousResults: new Map() },
      {},
      undefined,
      {
        ...resume,
        itemFrames: {
          "0": {
            itemIndex: 0,
            nextBodyNodeIndex: 1,
            bodyResults: {
              "step-a": { nodeId: "step-a", output: "ok", durationMs: 1 },
            },
            outcome: "running",
            economics: {
              reservationId,
              reservedCostCents: 50,
              evidence: foreign,
            },
          },
        },
        reconcileIterationBudget: async () => {
          reconciles++;
          return { status: "unknown" };
        },
      }
    );

    expect(rejected.result.error).toContain("checkpoint exact economics evidence is invalid");
    expect(resumedRuns).toEqual([]);
    expect(reconciles).toBe(0);
  });
});

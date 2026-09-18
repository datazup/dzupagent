/**
 * DSL-V2-HOST-BRIDGE-20260918 test fixture: an anchored conditional
 * `for_each` definition, a strict V2 host with an in-memory ledger and
 * receipt store, and the node executor the suites share.
 *
 * The host is deliberately the only thing that can run an execution or
 * effect leaf: its `dispatchLeaf` either invokes the framework's `execute`
 * thunk once and retains the receipt with the actual result, or replays the
 * retained result without invoking it. The executor records whether a leaf
 * node ever ran outside a host dispatch.
 */
import {
  AI_BUDGET_RESERVATION_SCHEMA,
  type AiBudgetReservation,
} from "@dzupagent/runtime-contracts/ai-budget-reservation";
import fixture from "@dzupagent/runtime-contracts/fixtures/ai-execution-conformance-v2.json" with { type: "json" };
import type { AiExecutionBinding, AiUsageTruthV2 } from "@dzupagent/runtime-contracts/ai-execution";
import { CANONICAL_JSON_VERSION, canonicalInputDigest } from "@dzupagent/runtime-contracts";
import {
  LOOP_ECONOMICS_EVIDENCE_V2_SCHEMA,
  materializeLoopEconomicsEvidenceV2,
  type LoopEconomicsEvidenceV2,
  type LoopEconomicsLeafAdmissionV2,
  type LoopEconomicsRecordedLeafOutcomeV2,
  type LoopEconomicsSha256DigestV2,
} from "@dzupagent/runtime-contracts/loop-economics-evidence-v2";
import type { PipelineDefinition } from "@dzupagent/runtime-contracts/pipeline-artifact";
import type { PipelineCheckpoint } from "@dzupagent/core/pipeline";

import type {
  LoopBudgetV2Host,
  LoopBudgetV2LeafDispatchInput,
  LoopBudgetV2LeafDispatchResult,
  LoopIterationBudgetReservationInput,
} from "../../pipeline/loop-executor/budget-types.js";
import type { NodeExecutor, NodeResult } from "../../pipeline/pipeline-runtime-types.js";
import type { InMemoryPipelineCheckpointStore } from "../../pipeline/in-memory-checkpoint-store.js";

const fixtureBinding = (
  fixture as { cases: Array<{ receipt?: { schema?: string; binding?: AiExecutionBinding } }> }
).cases.find(({ receipt }) => receipt?.schema === "dzupagent.aiExecutionReceipt/v2")?.receipt?.binding;
if (fixtureBinding === undefined) throw new Error("V2 fixture must provide an execution binding");
export const binding: AiExecutionBinding = fixtureBinding;

/** Micros reserved and charged per execution leaf: two cents. */
export const EXECUTION_MICROS = 20_000;
export const digest = (value: unknown): LoopEconomicsSha256DigestV2 => `sha256:${canonicalInputDigest(value)}`;

const source = (path: string, nodeType: string, nodeId: string) => ({
  source: { kind: "flow-node" as const, path, nodeType, nodeId },
});

/**
 * `items` — for_each over `items` with one branch:
 *   before (agent action)  → execution + charge
 *   choose (branch gate)   → control
 *   yes (agent action)     → execution + charge, then arm
 *   no (tool action)       → effect, else arm (absent when `emptyElse`)
 *   after (local set)      → no leaf
 */
export function v2BranchDefinition(concurrency = 1, emptyElse = false): PipelineDefinition {
  return {
    id: "item-branch-v2", name: "ItemBranchV2", version: "1", schemaVersion: "1.0.0",
    entryNodeId: "items", checkpointStrategy: "after_each_node", resume: { onProcessRestart: "resume_from_checkpoint" },
    nodes: [
      { id: "items", type: "loop", maxIterations: 100, continuePredicateName: "items",
        bodyNodeIds: ["before", "choose", "yes", ...(emptyElse ? [] : ["no"]), "after"],
        bodyGraph: { entryNodeId: "before", normalExitNodeIds: ["after"], suspendedExitNodeIds: [], terminalExitNodeIds: [], errorExitNodeIds: [] },
        forEach: { source: "items", as: "item", concurrency, order: "input", empty: { body: "skip", aggregate: "empty-array" }, collect: { from: "after", into: "answers", order: "input" } },
        ...source("root.nodes[0]", "for_each", "items") },
      { id: "before", type: "agent", agentId: "before", ...source("root.nodes[0].body[0]", "action", "before") },
      { id: "choose", type: "gate", gateType: "quality", condition: "choose", ...source("root.nodes[0].body[1]", "branch", "choose") },
      { id: "yes", type: "agent", agentId: "yes", ...source("root.nodes[0].body[1].then[0]", "action", "yes") },
      ...(emptyElse ? [] : [{ id: "no", type: "tool" as const, toolName: "notify", effectClass: "notify", ...source("root.nodes[0].body[1].else[0]", "action", "no") }]),
      { id: "after", type: "tool", toolName: "set-local", ...source("root.nodes[0].body[2]", "set", "after") },
      { id: "done", type: "agent", agentId: "done" },
    ],
    edges: [
      { type: "sequential", sourceNodeId: "before", targetNodeId: "choose" },
      { type: "conditional", sourceNodeId: "choose", predicateName: "choose", branches: emptyElse ? { true: "yes" } : { true: "yes", false: "no" } },
      ...(emptyElse ? [{ type: "sequential" as const, sourceNodeId: "choose", targetNodeId: "after" }] : [{ type: "sequential" as const, sourceNodeId: "no", targetNodeId: "after" }]),
      { type: "sequential", sourceNodeId: "yes", targetNodeId: "after" },
      { type: "sequential", sourceNodeId: "items", targetNodeId: "done" },
    ],
  };
}

export const predicates = { choose: (state: Record<string, unknown>) => Number(state.item) % 2 === 0 };
export const LEAF_NODE_IDS = new Set(["before", "yes", "no"]);

export interface V2LedgerRow { state: "reserved" | "settled" | "released"; cost: number; itemIndex: number; attempt: number }
export interface V2Receipt {
  readonly itemIndex: number;
  readonly result: NodeResult;
  readonly outcome: LoopEconomicsRecordedLeafOutcomeV2;
  readonly charge?: LoopEconomicsRecordedLeafOutcomeV2;
}
export interface V2Ledger {
  rows: Record<string, V2LedgerRow>;
  /** Retained receipts by idempotency key: the durable result carrier. */
  receipts: Record<string, V2Receipt>;
  /** Keys presented to `dispatchLeaf`, in order. */
  dispatches: string[];
  /** Keys whose `execute` thunk the host actually invoked, in order. */
  executions: string[];
  /** Keys answered from a retained receipt without executing. */
  replays: string[];
  /** Settlement count per item index. */
  charges: Record<string, number>;
  /** The key whose thunk is executing right now, when any. */
  executing?: string;
}

export function emptyLedger(): V2Ledger {
  return { rows: {}, receipts: {}, dispatches: [], executions: [], replays: [], charges: {} };
}

export interface V2HostFaults {
  /** Throw before invoking `execute` (dispatch never happened). */
  throwBeforeExecute?: (key: string) => boolean;
  /** Retain the receipt, then throw (acknowledgement lost after dispatch). */
  throwAfterExecute?: (key: string) => boolean;
  /** Retain the receipt, then answer `unknown` (acknowledgement lost). */
  unknownAfterExecute?: (key: string) => boolean;
  /** On replay, the receipt exists but its result custody is missing. */
  resultMissing?: (key: string) => boolean;
  /** Override the measured cents. */
  measureCents?: number;
  /** Rewrite the pending record before returning it from reserve. */
  mutateAdmission?: (evidence: LoopEconomicsEvidenceV2) => unknown;
  /** Return V1 evidence instead of a V2 record. */
  answerV1?: boolean;
  /** Return no record at all. */
  answerNone?: boolean;
}

export function reservationFor(nodeId: string): AiBudgetReservation {
  return {
    schema: AI_BUDGET_RESERVATION_SCHEMA,
    status: "admitted",
    tariffRef: binding.offer.tariffRef!,
    offerRef: binding.offer.offerId,
    modelRef: binding.model.modelRef,
    modelRevision: binding.model.revision,
    provenance: {
      sourceKind: "provider-published",
      authorityId: "provider/prices",
      revision: `2026-09-18/${nodeId}`,
      effectiveAt: "2026-09-18T00:00:00.000Z",
      digest: `sha256:${"f".repeat(64)}`,
    },
    currency: "USD",
    reservedAmountMicros: EXECUTION_MICROS,
    usageCeiling: { uncachedInputTokens: 100, outputTokens: 50 },
    reservedAt: "2026-09-18T00:00:00.000Z",
  };
}

export function usageFor(nodeId: string): AiUsageTruthV2 {
  const admitted = reservationFor(nodeId);
  return {
    measurement: "known",
    tokens: { input: 2, output: 1 },
    cost: {
      status: "reconciled",
      currency: "USD",
      amountMicros: EXECUTION_MICROS,
      charges: [{
        attempt: 1,
        offerRef: admitted.offerRef,
        tariffRef: admitted.tariffRef,
        amountMicros: EXECUTION_MICROS,
        provenance: admitted.provenance,
      }],
    },
  };
}

/** The pending record a well-behaved V2 host admits for one item attempt. */
export function admitPendingRecord(input: LoopIterationBudgetReservationInput): { evidence: LoopEconomicsEvidenceV2; reservedCostCents: number } {
  const request = input.economicsV2;
  if (request === undefined) throw new Error("the V2 host was reserved without a V2 request");
  let reservedMicros = 0;
  const leaves: LoopEconomicsLeafAdmissionV2[] = request.inventory.leaves.map((leaf) => {
    const base = {
      leafId: leaf.leafId,
      order: leaf.order,
      nodePath: leaf.nodePath,
      controlRequirements: leaf.controlRequirements,
      idempotencyKey: request.leafIdempotencyKeys[leaf.leafId]!,
      fence: 1,
    };
    if (leaf.kind === "execution") {
      reservedMicros += EXECUTION_MICROS;
      return { ...base, kind: "execution", execution: { nodeId: leaf.runtimeNodeId, binding, money: { status: "priced", reservation: reservationFor(leaf.runtimeNodeId), tariffDigest: `sha256:${"a".repeat(64)}` }, quota: { status: "not-applicable" } } };
    }
    if (leaf.kind === "charge") {
      const execution = request.inventory.leaves.find((candidate) => candidate.leafId === leaf.executionLeafId)!;
      return { ...base, kind: "charge", chargeId: leaf.leafId, executionLeafId: leaf.executionLeafId, bindingDigest: binding.bindingDigest, money: { status: "priced", reservation: reservationFor(execution.runtimeNodeId), tariffDigest: `sha256:${"a".repeat(64)}` }, quota: { status: "not-applicable" } };
    }
    return { ...base, kind: "effect", effect: { nodeId: leaf.runtimeNodeId, intentDigest: digest({ intent: leaf.leafId }) } };
  });
  const evidence = materializeLoopEconomicsEvidenceV2({
    schema: LOOP_ECONOMICS_EVIDENCE_V2_SCHEMA,
    canonicalization: CANONICAL_JSON_VERSION,
    owner: request.owner,
    definitionDigest: request.inventory.definitionDigest,
    bodyPlanDigest: request.inventory.bodyPlanDigest,
    unitAttempt: request.unitAttempt,
    controlSelections: request.inventory.controlSelections,
    leaves,
    resolution: { status: "pending" },
  });
  return { evidence, reservedCostCents: Math.ceil(reservedMicros / 10_000) };
}

export function settledCents(evidence: LoopEconomicsEvidenceV2 | undefined): number {
  if (evidence === undefined || evidence.resolution.status === "pending") throw new Error("record is not resolved");
  let micros = 0;
  for (const outcome of evidence.resolution.outcomes) {
    if (outcome.kind === "charge" && outcome.status === "recorded" && outcome.usage.cost.status !== "unknown") micros += outcome.usage.cost.amountMicros;
  }
  return Math.ceil(micros / 10_000);
}

/** A strict V2 host over an in-memory ledger; `faults` is mutable per test. */
export function createV2Host(options: { ledger?: V2Ledger; itemBudgetCents?: number; faults?: V2HostFaults } = {}) {
  const ledger = options.ledger ?? emptyLedger();
  const faults: V2HostFaults = options.faults ?? {};
  const host: LoopBudgetV2Host = {
    mode: "strict",
    evidenceMode: "required-v2",
    itemBudgetCents: options.itemBudgetCents ?? 10,
    reserve(input) {
      const { evidence, reservedCostCents } = admitPendingRecord(input);
      ledger.rows[input.reservationId!] = { state: "reserved", cost: 0, itemIndex: input.itemIndex!, attempt: input.attempt ?? 0 };
      if (faults.answerNone) return { status: "reserved", reservedCostCents };
      if (faults.answerV1) return { status: "reserved", reservedCostCents, evidence: { schema: "dzupagent.loopEconomicsEvidence/v1" } as never };
      const answered = faults.mutateAdmission === undefined ? evidence : (faults.mutateAdmission(evidence) as LoopEconomicsEvidenceV2);
      return { status: "reserved", reservedCostCents, evidenceV2: answered };
    },
    async dispatchLeaf(input: LoopBudgetV2LeafDispatchInput): Promise<LoopBudgetV2LeafDispatchResult> {
      const key = input.idempotencyKey;
      ledger.dispatches.push(key);
      const retained = ledger.receipts[key];
      if (retained !== undefined) {
        if (faults.resultMissing?.(key)) {
          return { status: "unknown", reason: "receipt-unavailable", observationDigest: digest({ key, missing: "result" }) };
        }
        ledger.replays.push(key);
        return { status: "recorded", result: retained.result, outcome: retained.outcome, ...(retained.charge === undefined ? {} : { charge: retained.charge }) };
      }
      if (faults.throwBeforeExecute?.(key)) throw new Error(`dispatch refused before execution: ${key}`);
      ledger.executing = key;
      ledger.executions.push(key);
      let result: NodeResult;
      try {
        result = await input.execute();
      } finally {
        delete ledger.executing;
      }
      const nodeId = input.leaf.kind === "execution" ? input.leaf.execution.nodeId : input.leaf.kind === "effect" ? input.leaf.effect.nodeId : result.nodeId;
      const receiptDigest = digest({ key, result });
      const outcome: LoopEconomicsRecordedLeafOutcomeV2 = input.leaf.kind === "execution"
        ? { leafId: input.leaf.leafId, kind: "execution", status: "recorded", bindingDigest: binding.bindingDigest, receiptDigest, usage: usageFor(nodeId) }
        : { leafId: input.leaf.leafId, kind: "effect", status: "recorded", intentDigest: (input.leaf as Extract<LoopEconomicsLeafAdmissionV2, { kind: "effect" }>).effect.intentDigest, receiptDigest };
      const charge: LoopEconomicsRecordedLeafOutcomeV2 | undefined = input.chargeLeaf === undefined || outcome.kind !== "execution"
        ? undefined
        : { leafId: input.chargeLeaf.leafId, kind: "charge", status: "recorded", bindingDigest: binding.bindingDigest, receiptDigest: digest({ key, charge: true }), usage: outcome.usage };
      const unit = input.evidence.owner.unit;
      ledger.receipts[key] = { itemIndex: unit.kind === "item" ? unit.itemIndex : -1, result, outcome, ...(charge === undefined ? {} : { charge }) };
      if (faults.throwAfterExecute?.(key)) throw new Error(`dispatch acknowledgement lost: ${key}`);
      if (faults.unknownAfterExecute?.(key)) {
        return { status: "unknown", reason: "dispatch-acknowledgement-lost", observationDigest: digest({ key, lost: true }) };
      }
      return { status: "recorded", result, outcome, ...(charge === undefined ? {} : { charge }) };
    },
    measureItemCost(input) {
      if (input.evidenceV2 === undefined) return { status: "unknown", reason: "no V2 record" };
      return { status: "known", costCents: faults.measureCents ?? settledCents(input.evidenceV2) };
    },
    settle(input) {
      const row = ledger.rows[input.reservationId!]!;
      if (row.state !== "settled") ledger.charges[String(row.itemIndex)] = (ledger.charges[String(row.itemIndex)] ?? 0) + 1;
      row.state = "settled";
      row.cost = input.actualCostCents;
    },
    release(input) {
      const row = ledger.rows[input.reservationId!]!;
      row.state = "released";
    },
    reconcile(input) {
      const row = ledger.rows[input.reservationId];
      if (row === undefined) return { status: "absent" };
      if (row.state === "settled") return { status: "settled", cost: { status: "known", costCents: row.cost } };
      if (row.state === "released") return { status: "released" };
      return { status: "reserved", reservedCostCents: 4 };
    },
  };
  return { host, ledger, faults };
}

/**
 * The shared node executor; records leaf nodes that ran outside a host
 * dispatch. Outputs derive from the item and from `before`'s retained result,
 * never from executor-side state mutation, so a replayed leaf is exactly as
 * good as an executed one downstream.
 */
export function executor(calls: string[], ledger: V2Ledger, outside: string[] = [], failing: ReadonlySet<string> = new Set()): NodeExecutor {
  return async (id, _node, ctx) => {
    calls.push(`${id}:${ctx.state.item ?? "outer"}`);
    if (LEAF_NODE_IDS.has(id) && ledger.executing === undefined) outside.push(`${id}:${ctx.state.item}`);
    if (failing.has(id)) return { nodeId: id, output: null, durationMs: 1, error: `${id} failed` };
    return { nodeId: id, output: outputFor(id, ctx), durationMs: 1 };
  };
}

export function outputFor(id: string, ctx: { state: Record<string, unknown>; previousResults: Map<string, NodeResult> }): unknown {
  if (id === "done") return ctx.state.answers;
  if (id === "before") return `item-${ctx.state.item}`;
  return `${id}:${String(ctx.previousResults.get("before")?.output)}`;
}

export async function checkpoints(store: InMemoryPipelineCheckpointStore, runId: string): Promise<PipelineCheckpoint[]> {
  const values: PipelineCheckpoint[] = [];
  for (let version = 1; ; version++) {
    const value = await store.loadVersion(runId, version);
    if (!value) return values;
    values.push(value);
  }
}

/**
 * Framework V2 host bridge for conditional `for_each` items
 * (packet DSL-V2-HOST-BRIDGE-20260918, plan §5).
 *
 * Owns the strict V2 profile of the item host:
 *
 * - **Preparation** binds the compiled loop to its P1 leaf inventory and to
 *   the framework's own item/attempt-scoped idempotency keys, so the host's
 *   admitted record can be checked against exact identities before dispatch
 *   (requirement §3.1). Recompilation with fresh runtime ids yields another
 *   definition digest and is refused as a different definition.
 * - **Admission validation** rejects a host record whose owner, digests,
 *   attempt, leaf identities, node paths, control requirements, links or keys
 *   differ from what the framework derived.
 * - **Custody** is the per-item accumulator of control selections and leaf
 *   outcomes. Selections are derived from the durable graph frame — never by
 *   re-evaluating a predicate — and the unselected arm is released
 *   `not-selected` in the same checkpoint (§3.4). A retained record that
 *   disagrees with its frame blocks.
 * - **The leaf executor** routes every execution/effect leaf through the
 *   host's single `dispatchLeaf` authority with one `execute` thunk (§3.2);
 *   the charge leaf is recorded from the execution outcome, never dispatched.
 *
 * Nothing here reserves, settles or releases money: the item-level lifecycle
 * in `for-each-item-budget*.ts` keeps that, now carrying the V2 record.
 *
 * @module pipeline/loop-executor/for-each-item-economics-v2
 */

import type {
  LoopNode,
  PipelineDefinition,
  PipelineNode,
} from "@dzupagent/runtime-contracts/pipeline-artifact";
import { canonicalInputDigest } from "@dzupagent/runtime-contracts";
import type { LoopEconomicsEvidenceOwner } from "@dzupagent/runtime-contracts/loop-economics-evidence";
import {
  buildLoopEconomicsLeafInventoryV2,
  materializeLoopEconomicsEvidenceV2,
  validateLoopEconomicsEvidenceV2,
  type LoopEconomicsEvidenceInputV2,
  type LoopEconomicsEvidenceV2,
  type LoopEconomicsLeafAdmissionV2,
  type LoopEconomicsLeafInventoryV2,
  type LoopEconomicsLeafOutcomeV2,
  type LoopEconomicsReleaseReasonV2,
  type LoopEconomicsResolutionV2,
  type LoopEconomicsSha256DigestV2,
  type LoopEconomicsUnknownReasonV2,
} from "@dzupagent/runtime-contracts/loop-economics-evidence-v2";
import type { NodeExecutor, NodeResult } from "../pipeline-runtime-types.js";
import {
  nodeIdempotencyContext,
  nodeIdempotencyKey,
} from "../pipeline-shared/idempotency.js";
import type {
  ForEachEconomicsV2Preparation,
  ForEachEconomicsV2Readiness,
  LoopBudgetV2Host,
  LoopBudgetV2LeafDispatchResult,
} from "./budget-types.js";
import type { LoopBodyGraphCheckpointState } from "./types.js";

const MICROS_PER_CENT = 10_000;

export const FOR_EACH_V2_RELEASE_PROOF_SCHEMA =
  "dzupagent/for-each-v2-release-proof/v1" as const;
export const FOR_EACH_V2_OBSERVATION_SCHEMA =
  "dzupagent/for-each-v2-observation/v1" as const;

function sha(value: unknown): LoopEconomicsSha256DigestV2 {
  return `sha256:${canonicalInputDigest(value)}`;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalInputDigest(left) === canonicalInputDigest(right);
  } catch {
    return false;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

/**
 * Bind one compiled `for_each` loop to its resolved V2 leaf inventory and to
 * the framework's leaf idempotency keys. Pure; the definition is not mutated.
 */
export function prepareForEachEconomicsV2(
  definition: PipelineDefinition,
  loopNode: LoopNode,
  runId: string | undefined
): ForEachEconomicsV2Readiness {
  if (runId === undefined || runId.length === 0) {
    return { status: "denied", error: "exact V2 loop economics requires a non-empty runtime run identity" };
  }
  if (loopNode.forEach === undefined || loopNode.bodyGraph === undefined) {
    return { status: "denied", error: "V2 selected/skipped-leaf economics admits only a compiler-lowered for_each graph body" };
  }
  const built = buildLoopEconomicsLeafInventoryV2(definition, loopNode.id);
  if (built.status === "denied") {
    return {
      status: "denied",
      error: `V2 leaf inventory denied: ${built.diagnostics
        .map(({ code, path, message }) => `${code} at ${path}: ${message}`)
        .join("; ")}`,
    };
  }
  const inventory = built.inventory;
  const nodesById = new Map(definition.nodes.map((node) => [node.id, node] as const));
  // Per-node retry would re-enter the leaf executor after the host already
  // answered, which is a second dispatch under the same attempt key. The V2
  // profile has exactly one route to run a leaf, so retries are denied here
  // rather than tolerated at dispatch time.
  for (const leaf of inventory.leaves) {
    if (leaf.kind === "charge") continue;
    const node = nodesById.get(leaf.runtimeNodeId);
    if (node !== undefined && (node.retries ?? 0) > 0) {
      return {
        status: "denied",
        error: `V2 leaf node ${JSON.stringify(node.id)} declares retries; per-node retry would re-dispatch leaf ${JSON.stringify(leaf.leafId)} under one attempt`,
      };
    }
  }
  const leafIdempotencyKeys = (itemIndex: number, attempt: number): Readonly<Record<string, string>> => {
    const keys: Record<string, string> = {};
    const executionKeys = new Map<string, string>();
    for (const leaf of inventory.leaves) {
      if (leaf.kind === "charge") continue;
      const node = nodesById.get(leaf.runtimeNodeId) as PipelineNode;
      const key = nodeIdempotencyKey(runId, node.id, {
        flowDefinition: definition,
        ...nodeIdempotencyContext(node),
        scope: {
          loopNodeId: loopNode.id,
          itemIndex,
          bodyNodeId: node.id,
          ...(attempt > 0 ? { attempt } : {}),
        },
      });
      keys[leaf.leafId] = key;
      if (leaf.kind === "execution") executionKeys.set(leaf.leafId, key);
    }
    for (const leaf of inventory.leaves) {
      if (leaf.kind !== "charge") continue;
      // The charge shares its execution's external identity; a lost
      // acknowledgement can therefore never allocate a fresh key for either.
      keys[leaf.leafId] = `${executionKeys.get(leaf.executionLeafId)!}:charge`;
    }
    return keys;
  };
  return { status: "ready", preparation: { inventory, leafIdempotencyKeys } };
}

// ---------------------------------------------------------------------------
// Admission validation
// ---------------------------------------------------------------------------

export interface ForEachEvidenceV2Expectation {
  readonly preparation: ForEachEconomicsV2Preparation;
  readonly owner: LoopEconomicsEvidenceOwner;
  readonly unitAttempt: number;
  readonly reservedCostCents: number;
  readonly settledCostCents?: number;
  readonly resolutionStatus?: LoopEconomicsResolutionV2["status"];
  readonly leafIdempotencyKeys: Readonly<Record<string, string>>;
  /** When given, the record must be the same admission (retained state). */
  readonly admissionDigest?: LoopEconomicsSha256DigestV2;
  /** A record the host has just admitted: every selection must still be open. */
  readonly freshAdmission?: boolean;
}

/**
 * Validate a host-supplied V2 record against the framework's derived
 * identities. Returns the first blocking reason, or `undefined`.
 */
export function validateForEachEvidenceV2(
  value: unknown,
  expected: ForEachEvidenceV2Expectation
): string | undefined {
  const { inventory } = expected.preparation;
  const validation = validateLoopEconomicsEvidenceV2(value, {
    owner: expected.owner,
    definitionDigest: inventory.definitionDigest,
    bodyPlanDigest: inventory.bodyPlanDigest,
    unitAttempt: expected.unitAttempt,
    reservedCostCents: expected.reservedCostCents,
    ...(expected.settledCostCents === undefined ? {} : { settledCostCents: expected.settledCostCents }),
    ...(expected.resolutionStatus === undefined ? {} : { resolutionStatus: expected.resolutionStatus }),
    ...(expected.admissionDigest === undefined ? {} : { admissionDigest: expected.admissionDigest }),
  });
  if (!validation.valid) {
    return validation.diagnostics.map(({ path, message }) => `${path}: ${message}`).join("; ");
  }
  const evidence = value as LoopEconomicsEvidenceV2;
  if (evidence.leaves.length !== inventory.leaves.length) {
    return `record admits ${evidence.leaves.length} leaves; the inventory has ${inventory.leaves.length}`;
  }
  for (const [index, expectedLeaf] of inventory.leaves.entries()) {
    const leaf = evidence.leaves[index]!;
    const at = `leaves[${index}]`;
    if (leaf.leafId !== expectedLeaf.leafId) return `${at}.leafId: ${JSON.stringify(leaf.leafId)} is not the inventory leaf ${JSON.stringify(expectedLeaf.leafId)}`;
    if (leaf.order !== expectedLeaf.order) return `${at}.order: differs from the inventory`;
    if (leaf.kind !== expectedLeaf.kind) return `${at}.kind: ${leaf.kind} contradicts the inventory ${expectedLeaf.kind}`;
    if (!canonicalEqual(leaf.nodePath, expectedLeaf.nodePath)) return `${at}.nodePath: differs from the inventory`;
    if (!canonicalEqual(leaf.controlRequirements, expectedLeaf.controlRequirements)) return `${at}.controlRequirements: differ from the inventory`;
    const expectedKey = expected.leafIdempotencyKeys[leaf.leafId];
    if (expectedKey === undefined || leaf.idempotencyKey !== expectedKey) return `${at}.idempotencyKey: is not the framework-derived key for this item attempt`;
    if (leaf.kind === "execution" && expectedLeaf.kind === "execution" && leaf.execution.nodeId !== expectedLeaf.runtimeNodeId) return `${at}.execution.nodeId: is not the bound runtime node`;
    if (leaf.kind === "effect" && expectedLeaf.kind === "effect" && leaf.effect.nodeId !== expectedLeaf.runtimeNodeId) return `${at}.effect.nodeId: is not the bound runtime node`;
    if (leaf.kind === "charge" && expectedLeaf.kind === "charge" && leaf.executionLeafId !== expectedLeaf.executionLeafId) return `${at}.executionLeafId: is not the linked inventory execution leaf`;
  }
  if (evidence.controlSelections.length !== inventory.controlSelections.length) {
    return `record declares ${evidence.controlSelections.length} control selections; the inventory has ${inventory.controlSelections.length}`;
  }
  for (const [index, expectedSelection] of inventory.controlSelections.entries()) {
    const selection = evidence.controlSelections[index]!;
    if (selection.kind !== expectedSelection.kind || !canonicalEqual(selection.nodePath, expectedSelection.nodePath)) {
      return `controlSelections[${index}]: differs from the inventory`;
    }
    const resolved = selection.kind === "branch" ? selection.selectedBranch : selection.selectedArm;
    if (expected.freshAdmission === true && resolved !== null) {
      return `controlSelections[${index}]: a fresh admission pre-resolves the selection to ${JSON.stringify(resolved)}; only the durable frame selects`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Custody
// ---------------------------------------------------------------------------

interface GateBinding {
  readonly selectionIndex: number;
  readonly runtimeNodeId: string;
  readonly thenFirst: string | undefined;
  readonly elseFirst: string | undefined;
  readonly thenNodes: ReadonlySet<string>;
  readonly elseNodes: ReadonlySet<string>;
  readonly thenLeafIds: readonly string[];
  readonly elseLeafIds: readonly string[];
}

interface NodeLeaves {
  readonly leaf: LoopEconomicsLeafAdmissionV2;
  readonly charge?: LoopEconomicsLeafAdmissionV2;
}

export interface ForEachEconomicsV2Snapshot {
  readonly evidence: LoopEconomicsEvidenceV2;
  readonly leafOutcomes?: readonly LoopEconomicsLeafOutcomeV2[];
}

export type ForEachEconomicsV2Resolution =
  | { readonly status: "settled"; readonly evidence: LoopEconomicsEvidenceV2 }
  | { readonly status: "reconciliation-required"; readonly evidence: LoopEconomicsEvidenceV2 }
  | { readonly status: "pending"; readonly error: string };

/**
 * Per-item V2 custody: the admitted record, its control selections and its
 * leaf outcomes. Every mutation is a pure function of durable inputs (the
 * graph frame, a host dispatch answer, a terminal reason), so a resumed item
 * rebuilds exactly the custody the crashed one held.
 */
export class ForEachItemEconomicsV2Custody {
  private evidence: LoopEconomicsEvidenceV2;
  private readonly outcomes = new Map<string, LoopEconomicsLeafOutcomeV2>();
  private readonly leafById: ReadonlyMap<string, LoopEconomicsLeafAdmissionV2>;
  private readonly leavesByNode: ReadonlyMap<string, NodeLeaves>;
  private readonly gates: readonly GateBinding[];

  constructor(
    inventory: LoopEconomicsLeafInventoryV2,
    evidence: LoopEconomicsEvidenceV2,
    retained: readonly LoopEconomicsLeafOutcomeV2[] = []
  ) {
    this.evidence = evidence;
    this.leafById = new Map(evidence.leaves.map((leaf) => [leaf.leafId, leaf] as const));
    const leavesByNode = new Map<string, NodeLeaves>();
    for (const leaf of inventory.leaves) {
      if (leaf.kind === "charge") continue;
      const admitted = this.leafById.get(leaf.leafId)!;
      const chargeInventory = inventory.leaves.find(
        (candidate) => candidate.kind === "charge" && candidate.executionLeafId === leaf.leafId
      );
      const charge = chargeInventory === undefined ? undefined : this.leafById.get(chargeInventory.leafId);
      leavesByNode.set(leaf.runtimeNodeId, { leaf: admitted, ...(charge === undefined ? {} : { charge }) });
    }
    this.leavesByNode = leavesByNode;
    this.gates = buildGateBindings(inventory);
    for (const outcome of retained) this.outcomes.set(outcome.leafId, outcome);
    // Resolved records embed their outcomes; re-open them into the map so a
    // resumed settled/blocked record answers the same questions.
    if (evidence.resolution.status !== "pending") {
      for (const outcome of evidence.resolution.outcomes) this.outcomes.set(outcome.leafId, outcome);
    }
  }

  /** The current record (pending resolution, selections as known so far). */
  get record(): LoopEconomicsEvidenceV2 {
    return this.evidence;
  }

  leavesForNode(runtimeNodeId: string): NodeLeaves | undefined {
    return this.leavesByNode.get(runtimeNodeId);
  }

  outcomeOf(leafId: string): LoopEconomicsLeafOutcomeV2 | undefined {
    return this.outcomes.get(leafId);
  }

  /** Every retained outcome in admitted leaf order. */
  orderedOutcomes(): LoopEconomicsLeafOutcomeV2[] {
    return this.evidence.leaves
      .map((leaf) => this.outcomes.get(leaf.leafId))
      .filter((outcome): outcome is LoopEconomicsLeafOutcomeV2 => outcome !== undefined);
  }

  hasUnknown(): boolean {
    return [...this.outcomes.values()].some((outcome) => outcome.status === "unknown");
  }

  /** Runtime nodes whose leaves are retained as unknown — the only resumable block. */
  unknownNodeIds(): string[] {
    const ids = new Set<string>();
    for (const [nodeId, { leaf, charge }] of this.leavesByNode) {
      if (this.outcomes.get(leaf.leafId)?.status === "unknown" ||
          (charge !== undefined && this.outcomes.get(charge.leafId)?.status === "unknown")) ids.add(nodeId);
    }
    return [...ids];
  }

  /** What the checkpoint writer persists beside the graph frame. */
  snapshot(): ForEachEconomicsV2Snapshot {
    if (this.evidence.resolution.status !== "pending") return { evidence: this.evidence };
    const leafOutcomes = this.orderedOutcomes();
    return leafOutcomes.length === 0 ? { evidence: this.evidence } : { evidence: this.evidence, leafOutcomes };
  }

  /**
   * Derive control selections from the durable frame and release the
   * unselected arms; verify every retained selection and outcome against
   * the frame. Returns the first inconsistency, which blocks the item.
   */
  applyFrame(frame: LoopBodyGraphCheckpointState): string | undefined {
    const completed = new Set(frame.completedNodeIds);
    const selections = [...this.evidence.controlSelections];
    let changed = false;
    for (const gate of this.gates) {
      const selection = selections[gate.selectionIndex]!;
      const recorded = selection.kind === "branch" ? selection.selectedBranch : null;
      if (!completed.has(gate.runtimeNodeId)) {
        if (recorded !== null) return `gate ${JSON.stringify(gate.runtimeNodeId)} has a recorded selection but the durable frame has not completed it`;
        continue;
      }
      const derived = deriveSelection(gate, frame);
      if (derived === undefined) return `gate ${JSON.stringify(gate.runtimeNodeId)}: the durable frame's transition contradicts the authored branch structure`;
      if (recorded === null) {
        selections[gate.selectionIndex] = { kind: "branch", nodePath: selection.nodePath, selectedBranch: derived };
        changed = true;
        const unselected = derived === "then" ? gate.elseLeafIds : gate.thenLeafIds;
        for (const leafId of unselected) {
          if (this.outcomes.has(leafId)) return `leaf ${JSON.stringify(leafId)} carries an outcome although its arm was not selected`;
          this.outcomes.set(leafId, {
            leafId,
            kind: this.leafById.get(leafId)!.kind,
            status: "released",
            reason: "not-selected",
            releaseDigest: sha({
              schema: FOR_EACH_V2_RELEASE_PROOF_SCHEMA,
              owner: this.evidence.owner,
              admissionDigest: this.evidence.admissionDigest,
              leafId,
              reason: "not-selected",
              gate: gate.runtimeNodeId,
              selectedBranch: derived,
            }),
          });
        }
      } else if (recorded !== derived) {
        return `gate ${JSON.stringify(gate.runtimeNodeId)}: recorded selection ${JSON.stringify(recorded)} disagrees with the durable frame`;
      }
    }
    if (changed) this.evidence = rematerialize(this.evidence, { controlSelections: selections });

    for (const [nodeId, { leaf, charge }] of this.leavesByNode) {
      const outcome = this.outcomes.get(leaf.leafId);
      const chargeOutcome = charge === undefined ? undefined : this.outcomes.get(charge.leafId);
      if (outcome?.status === "recorded" && !completed.has(nodeId)) {
        return `leaf ${JSON.stringify(leaf.leafId)} is recorded but node ${JSON.stringify(nodeId)} is not completed in the durable frame`;
      }
      if (outcome?.status === "unknown" && completed.has(nodeId)) {
        return `leaf ${JSON.stringify(leaf.leafId)} is unknown although node ${JSON.stringify(nodeId)} completed in the durable frame`;
      }
      if (completed.has(nodeId) && outcome === undefined) {
        return `node ${JSON.stringify(nodeId)} completed without a recorded V2 outcome for leaf ${JSON.stringify(leaf.leafId)}`;
      }
      if (charge !== undefined && (outcome?.status ?? "pending") !== (chargeOutcome?.status ?? "pending")) {
        return `charge leaf ${JSON.stringify(charge.leafId)} does not follow its execution leaf`;
      }
    }
    return undefined;
  }

  /** Record a host dispatch answer for the leaves of one node. */
  recordDispatch(runtimeNodeId: string, dispatch: LoopBudgetV2LeafDispatchResult): string | undefined {
    const leaves = this.leavesByNode.get(runtimeNodeId);
    if (leaves === undefined) return `node ${JSON.stringify(runtimeNodeId)} has no V2 leaf`;
    const { leaf, charge } = leaves;
    if (dispatch.status === "unknown") {
      const unknown = (leafId: string, kind: LoopEconomicsLeafAdmissionV2["kind"]) => {
        this.outcomes.set(leafId, { leafId, kind, status: "unknown", reason: dispatch.reason, observationDigest: dispatch.observationDigest });
      };
      unknown(leaf.leafId, leaf.kind);
      if (charge !== undefined) unknown(charge.leafId, charge.kind);
      return undefined;
    }
    const { outcome } = dispatch;
    if (outcome.leafId !== leaf.leafId || outcome.kind !== leaf.kind) return `host recorded ${JSON.stringify(outcome.leafId)} for leaf ${JSON.stringify(leaf.leafId)}`;
    if (leaf.kind === "execution" && outcome.kind === "execution" && outcome.bindingDigest !== leaf.execution.binding.bindingDigest) return `recorded execution binding differs from the admitted leaf ${JSON.stringify(leaf.leafId)}`;
    if (leaf.kind === "effect" && outcome.kind === "effect" && outcome.intentDigest !== leaf.effect.intentDigest) return `recorded effect intent differs from the admitted leaf ${JSON.stringify(leaf.leafId)}`;
    if (charge !== undefined) {
      const recordedCharge = dispatch.charge;
      if (recordedCharge === undefined) return `host recorded execution leaf ${JSON.stringify(leaf.leafId)} without its linked charge`;
      if (recordedCharge.leafId !== charge.leafId || recordedCharge.kind !== "charge") return `host recorded ${JSON.stringify(recordedCharge.leafId)} for charge leaf ${JSON.stringify(charge.leafId)}`;
      if (charge.kind === "charge" && recordedCharge.bindingDigest !== charge.bindingDigest) return `recorded charge binding differs from the admitted leaf ${JSON.stringify(charge.leafId)}`;
      if (outcome.kind === "execution" && !canonicalEqual(recordedCharge.usage, outcome.usage)) return `recorded charge usage differs from its execution usage for ${JSON.stringify(leaf.leafId)}`;
      this.outcomes.set(charge.leafId, recordedCharge);
    } else if (dispatch.charge !== undefined) {
      return `host recorded a charge for effect leaf ${JSON.stringify(leaf.leafId)}`;
    }
    this.outcomes.set(leaf.leafId, outcome);
    return undefined;
  }

  /** Retain an unknown observation for every leaf of one node. */
  recordUnknown(runtimeNodeId: string, reason: LoopEconomicsUnknownReasonV2, observation: unknown): void {
    this.recordDispatch(runtimeNodeId, {
      status: "unknown",
      reason,
      observationDigest: sha({
        schema: FOR_EACH_V2_OBSERVATION_SCHEMA,
        owner: this.evidence.owner,
        admissionDigest: this.evidence.admissionDigest,
        node: runtimeNodeId,
        reason,
        observation,
      }),
    });
  }

  /** Release every leaf that has no outcome yet; a terminal-only step. */
  releaseRemaining(reason: Exclude<LoopEconomicsReleaseReasonV2, "not-selected">): void {
    for (const leaf of this.evidence.leaves) {
      if (this.outcomes.has(leaf.leafId)) continue;
      this.outcomes.set(leaf.leafId, {
        leafId: leaf.leafId,
        kind: leaf.kind,
        status: "released",
        reason,
        releaseDigest: sha({
          schema: FOR_EACH_V2_RELEASE_PROOF_SCHEMA,
          owner: this.evidence.owner,
          admissionDigest: this.evidence.admissionDigest,
          leafId: leaf.leafId,
          reason,
        }),
      });
    }
  }

  /** Materialize the resolved record once every leaf has an outcome. */
  resolve(): ForEachEconomicsV2Resolution {
    const missing = this.evidence.leaves.filter((leaf) => !this.outcomes.has(leaf.leafId));
    if (missing.length > 0) {
      return { status: "pending", error: `leaves without an outcome: ${missing.map((leaf) => leaf.leafId).join(", ")}` };
    }
    const outcomes = this.orderedOutcomes();
    const status = this.hasUnknown() ? "reconciliation-required" : "settled";
    const evidence = rematerialize(this.evidence, { resolution: { status, outcomes } });
    return { status, evidence };
  }
}

function rematerialize(
  evidence: LoopEconomicsEvidenceV2,
  patch: Partial<Pick<LoopEconomicsEvidenceInputV2, "controlSelections" | "resolution">>
): LoopEconomicsEvidenceV2 {
  const { admissionDigest: _admission, evidenceDigest: _digest, ...input } = evidence;
  return materializeLoopEconomicsEvidenceV2({ ...input, ...patch });
}

function buildGateBindings(inventory: LoopEconomicsLeafInventoryV2): GateBinding[] {
  const gates: GateBinding[] = [];
  let selectionIndex = 0;
  for (const binding of inventory.bindings) {
    if (binding.executionClass.kind !== "control") continue;
    const index = selectionIndex;
    selectionIndex += 1;
    const under = (arm: "then" | "else") => inventory.bindings.filter((candidate) =>
      candidate.controlRequirements.some((requirement) =>
        requirement.selectionIndex === index && requirement.kind === "branch" && requirement.requiredBranch === arm));
    const first = (arm: "then" | "else") => under(arm)
      .filter((candidate) => {
        const last = candidate.controlRequirements.at(-1);
        return last?.selectionIndex === index && last.kind === "branch" && last.requiredBranch === arm;
      })
      .sort((left, right) => left.order - right.order)[0]?.runtimeNodeId;
    const leafIds = (arm: "then" | "else") => inventory.leaves
      .filter((leaf) => leaf.controlRequirements.some((requirement) =>
        requirement.selectionIndex === index && requirement.kind === "branch" && requirement.requiredBranch === arm))
      .map((leaf) => leaf.leafId);
    gates.push({
      selectionIndex: index,
      runtimeNodeId: binding.runtimeNodeId,
      thenFirst: first("then"),
      elseFirst: first("else"),
      thenNodes: new Set(under("then").map((candidate) => candidate.runtimeNodeId)),
      elseNodes: new Set(under("else").map((candidate) => candidate.runtimeNodeId)),
      thenLeafIds: leafIds("then"),
      elseLeafIds: leafIds("else"),
    });
  }
  return gates;
}

/**
 * The arm a completed gate took, read from the authored structure: the
 * successor is the first `then` node, the first `else` node, or — only when
 * no `else` arm is authored — any continuation outside the `then` arm. No
 * other successor value is read as a transition, and no predicate is
 * evaluated here.
 */
function deriveSelection(gate: GateBinding, frame: LoopBodyGraphCheckpointState): "then" | "else" | undefined {
  const position = frame.completedNodeIds.indexOf(gate.runtimeNodeId);
  const successor = frame.completedNodeIds[position + 1] ?? frame.nextNodeId;
  if (successor !== undefined && successor === gate.thenFirst) return "then";
  if (successor !== undefined && successor === gate.elseFirst) return "else";
  if (gate.elseFirst !== undefined) return undefined;
  if (successor === undefined) return frame.completed ? "else" : undefined;
  if (successor === gate.runtimeNodeId || gate.thenNodes.has(successor) || gate.elseNodes.has(successor)) return undefined;
  return "else";
}

// ---------------------------------------------------------------------------
// Settlement arithmetic
// ---------------------------------------------------------------------------

/** Cents implied by the recorded charges of a resolved record. */
export function settledCentsFromEvidenceV2(
  evidence: LoopEconomicsEvidenceV2
): { readonly status: "known"; readonly cents: number } | { readonly status: "unknown"; readonly reason: string } {
  if (evidence.resolution.status === "pending") return { status: "unknown", reason: "the V2 record is not resolved" };
  const outcomes = new Map(evidence.resolution.outcomes.map((outcome) => [outcome.leafId, outcome] as const));
  let micros = 0;
  for (const leaf of evidence.leaves) {
    if (leaf.kind !== "charge") continue;
    const outcome = outcomes.get(leaf.leafId);
    if (outcome === undefined || outcome.status === "unknown") return { status: "unknown", reason: `charge ${leaf.leafId} has no recorded outcome` };
    if (outcome.status === "released") continue;
    if (outcome.kind !== "charge") return { status: "unknown", reason: `charge ${leaf.leafId} recorded a ${outcome.kind} outcome` };
    const cost = outcome.usage.cost;
    if (cost.status === "unknown") return { status: "unknown", reason: `charge ${leaf.leafId} recorded unknown cost` };
    if (!Number.isSafeInteger(cost.amountMicros) || cost.amountMicros < 0) return { status: "unknown", reason: `charge ${leaf.leafId} recorded an invalid amount` };
    micros += cost.amountMicros;
    if (!Number.isSafeInteger(micros)) return { status: "unknown", reason: "recorded charges overflow" };
  }
  return { status: "known", cents: Math.ceil(micros / MICROS_PER_CENT) };
}

// ---------------------------------------------------------------------------
// Leaf executor
// ---------------------------------------------------------------------------

export interface ForEachV2LeafExecutorInput {
  readonly custody: ForEachItemEconomicsV2Custody;
  readonly dispatchLeaf: LoopBudgetV2Host["dispatchLeaf"];
  /** The framework's body executor — the one route that runs a node. */
  readonly execute: NodeExecutor;
}

/**
 * Wrap the framework executor so that every execution/effect leaf reaches
 * the host's `dispatchLeaf` exactly once per attempt, with `execute` as the
 * single thunk that can run the node. Local nodes and gates bypass the host.
 */
export function createForEachV2LeafExecutor(input: ForEachV2LeafExecutorInput): NodeExecutor {
  const { custody, dispatchLeaf, execute } = input;
  return async (nodeId, node, context) => {
    const leaves = custody.leavesForNode(nodeId);
    if (leaves === undefined) return execute(nodeId, node, context);
    const { leaf, charge } = leaves;
    const started = Date.now();
    const blocked = (reason: LoopEconomicsUnknownReasonV2, detail: string, observation: unknown): NodeResult => {
      custody.recordUnknown(nodeId, reason, observation);
      return { nodeId, output: null, durationMs: Date.now() - started, error: `V2 leaf ${leaf.leafId} outcome is unknown (${reason}): ${detail}` };
    };
    if (context.idempotencyKey !== leaf.idempotencyKey) {
      return blocked("authority-drift", "the dispatch key is not the admitted leaf key", { expected: leaf.idempotencyKey, actual: context.idempotencyKey ?? null });
    }
    const prior = custody.outcomeOf(leaf.leafId);
    if (prior !== undefined && prior.status !== "unknown") {
      // A recorded or released leaf is settled accounting; re-entry (a retry,
      // a duplicate schedule) must not overwrite it with an unknown row. The
      // custody keeps the host's answer and the node reports the refusal.
      return { nodeId, output: null, durationMs: Date.now() - started, error: `V2 leaf ${leaf.leafId} is already ${prior.status}; a second dispatch under the same attempt is refused` };
    }
    let dispatch: LoopBudgetV2LeafDispatchResult;
    try {
      dispatch = await dispatchLeaf({
        evidence: custody.record,
        leaf,
        ...(charge === undefined ? {} : { chargeLeaf: charge }),
        idempotencyKey: leaf.idempotencyKey,
        fence: leaf.fence,
        priorOutcomes: custody.orderedOutcomes(),
        ...(prior === undefined ? {} : { priorOutcome: prior }),
        execute: () => execute(nodeId, node, context),
      });
    } catch (error) {
      return blocked("dispatch-acknowledgement-lost", describe(error), { error: describe(error) });
    }
    if (dispatch.status === "unknown") {
      custody.recordDispatch(nodeId, dispatch);
      return { nodeId, output: null, durationMs: Date.now() - started, error: `V2 leaf ${leaf.leafId} outcome is unknown (${dispatch.reason})` };
    }
    if (dispatch.result.nodeId !== nodeId) {
      return blocked("authority-drift", "the host returned a result for another node", { resultNodeId: dispatch.result.nodeId });
    }
    const contradiction = custody.recordDispatch(nodeId, dispatch);
    if (contradiction !== undefined) {
      return blocked("authority-drift", contradiction, { contradiction });
    }
    return dispatch.result;
  };
}

/** Rebuild custody from a retained checkpoint record. */
export function restoreForEachEconomicsV2Custody(
  inventory: LoopEconomicsLeafInventoryV2,
  retained: { readonly evidenceV2: LoopEconomicsEvidenceV2; readonly leafOutcomesV2?: readonly LoopEconomicsLeafOutcomeV2[] }
): ForEachItemEconomicsV2Custody {
  return new ForEachItemEconomicsV2Custody(inventory, retained.evidenceV2, retained.leafOutcomesV2 ?? []);
}

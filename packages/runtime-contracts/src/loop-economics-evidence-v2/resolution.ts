import { validateAiUsageTruthV2 } from "../ai-execution.js";
import { isLeafSelected } from "./control.js";
import { validateRecordedUsageViaV1 } from "./leaves.js";
import {
  add,
  canonicalEqual,
  exactKeys,
  nonEmpty,
  nonEmptyString,
  nonNegativeSafeInteger,
  record,
  sha,
} from "./shared.js";
import {
  LOOP_ECONOMICS_RELEASE_REASONS_V2,
  LOOP_ECONOMICS_UNKNOWN_REASONS_V2,
  type LoopEconomicsEvidenceDiagnosticV2,
  type LoopEconomicsReleaseReasonV2,
  type LoopEconomicsResolutionV2,
  type LoopEconomicsUnknownReasonV2,
} from "./types.js";

export function validateResolution(
  value: unknown,
  leaves: readonly unknown[],
  selections: readonly unknown[],
  owner: unknown,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): LoopEconomicsResolutionV2["status"] | "invalid" {
  if (!record(value)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", "resolution", "Resolution is required.");
    return "invalid";
  }
  if (value.status === "pending") {
    exactKeys(value, ["status"], "resolution", diagnostics);
    return "pending";
  }
  if (value.status !== "settled" && value.status !== "reconciliation-required") {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", "resolution.status", "Resolution must be pending, settled, or reconciliation-required.");
    return "invalid";
  }
  exactKeys(value, ["status", "outcomes"], "resolution", diagnostics);
  const outcomes = Array.isArray(value.outcomes) ? value.outcomes : [];
  if (!Array.isArray(value.outcomes)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", "resolution.outcomes", "Resolved evidence must contain an outcome array.");
  }
  validateOutcomeCoverage(outcomes, leaves, selections, owner, diagnostics);
  const containsUnknown = outcomes.some(
    (outcome) => record(outcome) && outcome.status === "unknown"
  );
  if (value.status === "settled" && containsUnknown) {
    add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", "resolution.status", "Settled evidence cannot contain an unknown leaf outcome.");
  }
  if (value.status === "reconciliation-required" && !containsUnknown) {
    add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", "resolution.status", "Reconciliation-required evidence must contain at least one unknown leaf outcome.");
  }
  return value.status;
}

function validateOutcomeCoverage(
  outcomes: readonly unknown[],
  leaves: readonly unknown[],
  selections: readonly unknown[],
  owner: unknown,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  const leafById = new Map<string, Record<string, unknown>>();
  const outcomeCounts = new Map<string, number>();
  leaves.forEach((leaf) => {
    if (record(leaf) && nonEmptyString(leaf.leafId)) leafById.set(leaf.leafId, leaf);
  });
  outcomes.forEach((outcome, index) => {
    if (record(outcome) && nonEmptyString(outcome.leafId)) {
      outcomeCounts.set(outcome.leafId, (outcomeCounts.get(outcome.leafId) ?? 0) + 1);
      if ((outcomeCounts.get(outcome.leafId) ?? 0) > 1) {
        add(diagnostics, "LOOP_ECONOMICS_V2_DUPLICATE_LEAF", `resolution.outcomes[${index}].leafId`, "Each admitted leaf must have exactly one outcome.");
      }
    }
  });
  for (const leafId of leafById.keys()) {
    if (!outcomeCounts.has(leafId)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_MISSING_LEAF", "resolution.outcomes", `Missing outcome for admitted leaf ${leafId}.`);
    }
  }
  if (outcomes.length !== leaves.length) {
    add(diagnostics, "LOOP_ECONOMICS_V2_MISSING_LEAF", "resolution.outcomes", "Resolved evidence must cover every admitted leaf exactly once.");
  }

  outcomes.forEach((outcome, index) => {
    const path = `resolution.outcomes[${index}]`;
    if (!record(outcome)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Leaf outcome must be an object.");
      return;
    }
    nonEmpty(outcome.leafId, `${path}.leafId`, diagnostics);
    const leaf = nonEmptyString(outcome.leafId)
      ? leafById.get(outcome.leafId)
      : undefined;
    if (leaf === undefined) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.leafId`, "Outcome does not name an admitted leaf.");
    }
    const orderedLeaf = record(leaves[index]) ? leaves[index] : undefined;
    if (orderedLeaf?.leafId !== outcome.leafId) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.leafId`, "Outcome order must match admitted leaf order.");
    }
    if (leaf !== undefined && outcome.kind !== leaf.kind) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.kind`, "Outcome kind must match its admitted leaf.");
    }

    if (outcome.status === "recorded") {
      validateRecordedOutcome(outcome, leaf, leaves, owner, path, diagnostics);
    } else if (outcome.status === "released") {
      exactKeys(outcome, ["leafId", "kind", "status", "reason", "releaseDigest"], path, diagnostics);
      if (!LOOP_ECONOMICS_RELEASE_REASONS_V2.includes(outcome.reason as LoopEconomicsReleaseReasonV2)) {
        add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.reason`, "Release reason is not canonical.");
      }
      sha(outcome.releaseDigest, `${path}.releaseDigest`, diagnostics);
    } else if (outcome.status === "unknown") {
      exactKeys(outcome, ["leafId", "kind", "status", "reason", "observationDigest"], path, diagnostics);
      if (!LOOP_ECONOMICS_UNKNOWN_REASONS_V2.includes(outcome.reason as LoopEconomicsUnknownReasonV2)) {
        add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.reason`, "Unknown outcome reason is not canonical.");
      }
      sha(outcome.observationDigest, `${path}.observationDigest`, diagnostics);
    } else {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.status`, "Leaf outcome must be recorded, released, or unknown.");
    }
    const selected = leaf === undefined
      ? undefined
      : isLeafSelected(leaf, selections);
    if (
      selected === false &&
      (outcome.status !== "released" || outcome.reason !== "not-selected")
    ) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", path, "A leaf outside the selected branch/catch path must be released as not-selected.");
    }
    if (
      selected === true &&
      outcome.status === "released" &&
      outcome.reason === "not-selected"
    ) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", path, "A selected leaf cannot be released as not-selected.");
    }
    if (
      selected === undefined &&
      (
        outcome.status === "recorded" ||
        outcome.status === "unknown" ||
        (outcome.status === "released" && outcome.reason === "not-selected")
      )
    ) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", path, "A dispatched or not-selected outcome requires a durable control selection.");
    }
  });

  for (const leaf of leafById.values()) {
    if (leaf.kind !== "charge" || !nonEmptyString(leaf.executionLeafId)) continue;
    const executionOutcome = outcomes.find(
      (candidate) => record(candidate) && candidate.leafId === leaf.executionLeafId
    );
    const chargeOutcomeIndex = outcomes.findIndex(
      (candidate) => record(candidate) && candidate.leafId === leaf.leafId
    );
    const chargeOutcome = outcomes[chargeOutcomeIndex];
    if (
      record(executionOutcome) && executionOutcome.status === "released" &&
      record(chargeOutcome) && chargeOutcome.status !== "released"
    ) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", "resolution.outcomes", "A released execution cannot have a recorded or unknown charge dispatch.");
    }
    if (
      record(executionOutcome) && executionOutcome.status !== "released" &&
      record(chargeOutcome) && chargeOutcome.status === "released"
    ) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", "resolution.outcomes", "A recorded or unknown execution cannot release its admitted charge as zero.");
    }
    if (
      record(executionOutcome) && executionOutcome.status === "recorded" &&
      record(chargeOutcome) && chargeOutcome.status === "recorded" &&
      !canonicalEqual(executionOutcome.usage, chargeOutcome.usage)
    ) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `resolution.outcomes[${chargeOutcomeIndex}].usage`, "Recorded charge usage must equal its execution outcome usage.");
    }
  }
}

function validateRecordedOutcome(
  outcome: Record<string, unknown>,
  leaf: Record<string, unknown> | undefined,
  leaves: readonly unknown[],
  owner: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (outcome.kind === "execution") {
    exactKeys(outcome, ["leafId", "kind", "status", "bindingDigest", "receiptDigest", "usage"], path, diagnostics);
    sha(outcome.bindingDigest, `${path}.bindingDigest`, diagnostics);
    sha(outcome.receiptDigest, `${path}.receiptDigest`, diagnostics);
    if (leaf?.kind !== "execution" || !record(leaf.execution)) return;
    const binding = record(leaf.execution.binding) ? leaf.execution.binding : undefined;
    if (outcome.bindingDigest !== binding?.bindingDigest) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.bindingDigest`, "Recorded execution binding must match its admission.");
    }
    validateRecordedUsageViaV1(outcome.usage, leaf.execution, owner, path, diagnostics);
  } else if (outcome.kind === "effect") {
    exactKeys(outcome, ["leafId", "kind", "status", "intentDigest", "receiptDigest"], path, diagnostics);
    sha(outcome.intentDigest, `${path}.intentDigest`, diagnostics);
    sha(outcome.receiptDigest, `${path}.receiptDigest`, diagnostics);
    if (leaf?.kind === "effect" && record(leaf.effect) && outcome.intentDigest !== leaf.effect.intentDigest) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.intentDigest`, "Recorded effect intent must match its admission.");
    }
  } else if (outcome.kind === "charge") {
    exactKeys(outcome, ["leafId", "kind", "status", "bindingDigest", "receiptDigest", "usage"], path, diagnostics);
    sha(outcome.bindingDigest, `${path}.bindingDigest`, diagnostics);
    sha(outcome.receiptDigest, `${path}.receiptDigest`, diagnostics);
    if (leaf?.kind !== "charge") return;
    if (outcome.bindingDigest !== leaf.bindingDigest) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.bindingDigest`, "Recorded charge binding must match its admission.");
    }
    const executionLeaf = leaves.find(
      (candidate) =>
        record(candidate) &&
        candidate.kind === "execution" &&
        candidate.leafId === leaf.executionLeafId
    );
    const execution = record(executionLeaf) && record(executionLeaf.execution)
      ? executionLeaf.execution
      : undefined;
    if (execution !== undefined) {
      validateRecordedUsageViaV1(outcome.usage, execution, owner, path, diagnostics);
    } else {
      for (const diagnostic of validateAiUsageTruthV2(outcome.usage).diagnostics) {
        add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.${diagnostic.path}`, diagnostic.message);
      }
    }
  } else {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.kind`, "Recorded outcome kind must be execution, effect, or charge.");
  }
}

export function sumSettledCosts(
  resolution: unknown,
  leaves: readonly unknown[]
): number | undefined {
  if (!record(resolution) || resolution.status !== "settled" || !Array.isArray(resolution.outcomes)) return undefined;
  const outcomes = new Map<string, Record<string, unknown>>();
  for (const outcome of resolution.outcomes) {
    if (record(outcome) && nonEmptyString(outcome.leafId)) outcomes.set(outcome.leafId, outcome);
  }
  let total = 0;
  for (const leaf of leaves) {
    if (!record(leaf) || leaf.kind !== "execution" || !nonEmptyString(leaf.leafId)) continue;
    const chargeLeaf = leaves.find(
      (candidate) => record(candidate) && candidate.kind === "charge" && candidate.executionLeafId === leaf.leafId
    );
    const selectedLeafId = record(chargeLeaf) && nonEmptyString(chargeLeaf.leafId)
      ? chargeLeaf.leafId
      : leaf.leafId;
    const outcome = outcomes.get(selectedLeafId);
    if (!record(outcome)) return undefined;
    if (outcome.status === "released") continue;
    if (outcome.status !== "recorded" || !record(outcome.usage) || !record(outcome.usage.cost) || outcome.usage.cost.status === "unknown") return undefined;
    const amount = outcome.usage.cost.amountMicros;
    if (!nonNegativeSafeInteger(amount)) return undefined;
    total += amount;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

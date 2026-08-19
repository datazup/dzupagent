import {
  add,
  exactKeys,
  nonEmpty,
  nonEmptyString,
  nonNegativeSafeInteger,
  nonNegativeSafeIntegerField,
  record,
  safeDigest,
} from "./shared.js";
import type { LoopEconomicsEvidenceDiagnosticV2 } from "./types.js";

export function validateControlSelections(
  values: readonly unknown[],
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const path = `controlSelections[${index}]`;
    if (!record(value)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Control selection must be an object.");
      return;
    }
    if (value.kind === "branch") {
      exactKeys(value, ["kind", "nodePath", "selectedBranch"], path, diagnostics);
      validateNodePath(value.nodePath, `${path}.nodePath`, diagnostics);
      if (value.selectedBranch !== null) {
        nonEmpty(value.selectedBranch, `${path}.selectedBranch`, diagnostics);
      }
    } else if (value.kind === "catch") {
      exactKeys(value, ["kind", "nodePath", "selectedArm"], path, diagnostics);
      validateNodePath(value.nodePath, `${path}.nodePath`, diagnostics);
      if (
        value.selectedArm !== null &&
        value.selectedArm !== "body" &&
        value.selectedArm !== "catch"
      ) {
        add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.selectedArm`, "Catch selection must choose body or catch.");
      }
    } else {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.kind`, "Control selection must be branch or catch.");
    }
    const key = safeDigest({ kind: value.kind, nodePath: value.nodePath });
    if (key !== undefined && seen.has(key)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "A control node can be selected only once.");
    } else if (key !== undefined) {
      seen.add(key);
    }
  });
}

export function validateControlRequirements(
  value: unknown,
  selections: readonly unknown[],
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (!Array.isArray(value)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Leaf control requirements must be an array.");
    return;
  }
  let previous = -1;
  value.forEach((requirement, index) => {
    const requirementPath = `${path}[${index}]`;
    if (!record(requirement)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", requirementPath, "Control requirement must be an object.");
      return;
    }
    if (requirement.kind === "branch") {
      exactKeys(requirement, ["selectionIndex", "kind", "requiredBranch"], requirementPath, diagnostics);
      nonEmpty(requirement.requiredBranch, `${requirementPath}.requiredBranch`, diagnostics);
    } else if (requirement.kind === "catch") {
      exactKeys(requirement, ["selectionIndex", "kind", "requiredArm"], requirementPath, diagnostics);
      if (requirement.requiredArm !== "body" && requirement.requiredArm !== "catch") {
        add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${requirementPath}.requiredArm`, "Required catch arm must be body or catch.");
      }
    } else {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${requirementPath}.kind`, "Control requirement must be branch or catch.");
    }
    nonNegativeSafeIntegerField(requirement.selectionIndex, `${requirementPath}.selectionIndex`, diagnostics);
    if (typeof requirement.selectionIndex === "number" && requirement.selectionIndex <= previous) {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${requirementPath}.selectionIndex`, "Control requirement indexes must be unique and strictly increasing.");
    }
    if (typeof requirement.selectionIndex === "number") previous = requirement.selectionIndex;
    const selection = nonNegativeSafeInteger(requirement.selectionIndex)
      ? selections[requirement.selectionIndex]
      : undefined;
    if (!record(selection) || selection.kind !== requirement.kind) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${requirementPath}.selectionIndex`, "Control requirement must reference a selection of the same kind.");
    }
  });
}

export function isLeafSelected(
  leaf: Record<string, unknown>,
  selections: readonly unknown[]
): boolean | undefined {
  if (!Array.isArray(leaf.controlRequirements)) return undefined;
  for (const requirement of leaf.controlRequirements) {
    if (!record(requirement) || !nonNegativeSafeInteger(requirement.selectionIndex)) return undefined;
    const selection = selections[requirement.selectionIndex];
    if (!record(selection) || selection.kind !== requirement.kind) return undefined;
    if (
      requirement.kind === "branch" &&
      selection.selectedBranch === null
    ) return undefined;
    if (
      requirement.kind === "branch" &&
      selection.selectedBranch !== requirement.requiredBranch
    ) return false;
    if (
      requirement.kind === "catch" &&
      selection.selectedArm === null
    ) return undefined;
    if (
      requirement.kind === "catch" &&
      selection.selectedArm !== requirement.requiredArm
    ) return false;
  }
  return true;
}

export function validateNodePath(
  value: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (!Array.isArray(value) || value.length === 0) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Node path must be a non-empty ordered array.");
    return;
  }
  value.forEach((segment, index) => nonEmpty(segment, `${path}[${index}]`, diagnostics));
}

export function validatePathTail(
  nodePath: unknown,
  nodeId: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (Array.isArray(nodePath) && nodePath.length > 0 && nonEmptyString(nodeId) && nodePath.at(-1) !== nodeId) {
    add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", path, "Node path must terminate at the admitted node id.");
  }
}

import type { AiUsageTruthV2 } from "../ai-execution.js";
import { CANONICAL_JSON_VERSION } from "../idempotency.js";
import {
  LOOP_ECONOMICS_EVIDENCE_SCHEMA,
  materializeLoopEconomicsEvidence,
  validateLoopEconomicsEvidence,
  type LoopEconomicsEvidenceOwner,
  type LoopEconomicsExecutionAdmission,
} from "../loop-economics-evidence.js";
import {
  validateControlRequirements,
  validateNodePath,
  validatePathTail,
} from "./control.js";
import {
  add,
  canonicalEqual,
  digest,
  exactKeys,
  mapV1Code,
  nonEmpty,
  nonEmptyString,
  positiveSafeInteger,
  positiveSafeIntegerField,
  record,
  safeDigest,
  sha,
} from "./shared.js";
import type {
  LoopEconomicsEvidenceDiagnosticV2,
  LoopEconomicsSha256DigestV2,
} from "./types.js";

export function validateLeaves(
  leaves: readonly unknown[],
  selections: readonly unknown[],
  owner: unknown,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  const ids = new Set<string>();
  const externalIdentities = new Set<string>();
  const pathKinds = new Set<string>();
  const executionLeaves = new Map<string, Record<string, unknown>>();
  let unitFence: number | undefined;

  leaves.forEach((leaf, index) => {
    const path = `leaves[${index}]`;
    if (!record(leaf)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Leaf admission must be an object.");
      return;
    }
    if (leaf.kind === "execution") {
      exactKeys(leaf, ["leafId", "order", "nodePath", "controlRequirements", "idempotencyKey", "fence", "kind", "execution"], path, diagnostics);
    } else if (leaf.kind === "effect") {
      exactKeys(leaf, ["leafId", "order", "nodePath", "controlRequirements", "idempotencyKey", "fence", "kind", "effect"], path, diagnostics);
    } else if (leaf.kind === "charge") {
      exactKeys(leaf, ["leafId", "order", "nodePath", "controlRequirements", "idempotencyKey", "fence", "kind", "chargeId", "executionLeafId", "bindingDigest", "money", "quota"], path, diagnostics);
    } else {
      add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.kind`, "Leaf kind must be execution, effect, or charge.");
    }

    nonEmpty(leaf.leafId, `${path}.leafId`, diagnostics);
    if (nonEmptyString(leaf.leafId)) {
      if (ids.has(leaf.leafId)) {
        add(diagnostics, "LOOP_ECONOMICS_V2_DUPLICATE_LEAF", `${path}.leafId`, "Leaf ids must be unique.");
      }
      ids.add(leaf.leafId);
    }
    if (leaf.order !== index) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.order`, "Leaf order must be contiguous and equal its array position.");
    }
    validateNodePath(leaf.nodePath, `${path}.nodePath`, diagnostics);
    validateControlRequirements(
      leaf.controlRequirements,
      selections,
      `${path}.controlRequirements`,
      diagnostics
    );
    nonEmpty(leaf.idempotencyKey, `${path}.idempotencyKey`, diagnostics);
    if (nonEmptyString(leaf.idempotencyKey)) {
      if (externalIdentities.has(leaf.idempotencyKey)) {
        add(diagnostics, "LOOP_ECONOMICS_V2_DUPLICATE_IDENTITY", `${path}.idempotencyKey`, "External idempotency keys must be unique within one loop unit.");
      }
      externalIdentities.add(leaf.idempotencyKey);
    }
    positiveSafeIntegerField(leaf.fence, `${path}.fence`, diagnostics);
    if (positiveSafeInteger(leaf.fence)) {
      if (unitFence === undefined) {
        unitFence = leaf.fence;
      } else if (leaf.fence !== unitFence) {
        add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.fence`, "Every leaf in one loop unit must bind the same current fence.");
      }
    }
    const pathKind = safeDigest({ kind: leaf.kind, nodePath: leaf.nodePath });
    if (pathKind !== undefined && pathKinds.has(pathKind)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_DUPLICATE_LEAF", `${path}.nodePath`, "A leaf kind and node path pair must be unique.");
    } else if (pathKind !== undefined) {
      pathKinds.add(pathKind);
    }

    if (leaf.kind === "execution") {
      validateExecutionAdmissionViaV1(leaf.execution, owner, `${path}.execution`, diagnostics);
      if (nonEmptyString(leaf.leafId)) executionLeaves.set(leaf.leafId, leaf);
      const nodeId = record(leaf.execution) ? leaf.execution.nodeId : undefined;
      validatePathTail(leaf.nodePath, nodeId, `${path}.nodePath`, diagnostics);
    } else if (leaf.kind === "effect") {
      if (!record(leaf.effect)) {
        add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.effect`, "Effect admission must be an object.");
      } else {
        exactKeys(leaf.effect, ["nodeId", "intentDigest"], `${path}.effect`, diagnostics);
        nonEmpty(leaf.effect.nodeId, `${path}.effect.nodeId`, diagnostics);
        sha(leaf.effect.intentDigest, `${path}.effect.intentDigest`, diagnostics);
        validatePathTail(leaf.nodePath, leaf.effect.nodeId, `${path}.nodePath`, diagnostics);
      }
    }
  });

  const chargedExecutions = new Set<string>();
  const chargeIds = new Set<string>();
  leaves.forEach((leaf, index) => {
    if (!record(leaf) || leaf.kind !== "charge") return;
    const path = `leaves[${index}]`;
    nonEmpty(leaf.chargeId, `${path}.chargeId`, diagnostics);
    if (nonEmptyString(leaf.chargeId)) {
      if (chargeIds.has(leaf.chargeId)) {
        add(diagnostics, "LOOP_ECONOMICS_V2_DUPLICATE_IDENTITY", `${path}.chargeId`, "Charge ids must be unique within one loop unit.");
      }
      chargeIds.add(leaf.chargeId);
    }
    nonEmpty(leaf.executionLeafId, `${path}.executionLeafId`, diagnostics);
    sha(leaf.bindingDigest, `${path}.bindingDigest`, diagnostics);
    if (!nonEmptyString(leaf.executionLeafId)) return;
    const executionLeaf = executionLeaves.get(leaf.executionLeafId);
    if (executionLeaf === undefined || !record(executionLeaf.execution)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.executionLeafId`, "Charge must reference an admitted execution leaf.");
      return;
    }
    if (chargedExecutions.has(leaf.executionLeafId)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_DUPLICATE_LEAF", `${path}.executionLeafId`, "An execution may have at most one charge leaf; V2 usage carries per-attempt charge lines.");
    }
    chargedExecutions.add(leaf.executionLeafId);
    if (
      typeof executionLeaf.order === "number" &&
      typeof leaf.order === "number" &&
      leaf.order <= executionLeaf.order
    ) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.order`, "Charge leaf must follow its execution leaf.");
    }
    const execution = executionLeaf.execution;
    if (!canonicalEqual(leaf.controlRequirements, executionLeaf.controlRequirements)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.controlRequirements`, "Charge control requirements must equal its execution admission.");
    }
    if (!record(execution.binding) || leaf.bindingDigest !== execution.binding.bindingDigest) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.bindingDigest`, "Charge binding must match its execution admission.");
    }
    if (!canonicalEqual(leaf.money, execution.money)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.money`, "Charge money authority must equal its execution admission.");
    }
    if (!canonicalEqual(leaf.quota, execution.quota)) {
      add(diagnostics, "LOOP_ECONOMICS_V2_BINDING_MISMATCH", `${path}.quota`, "Charge quota authority must equal its execution admission.");
    }
  });

  for (const leafId of executionLeaves.keys()) {
    if (!chargedExecutions.has(leafId)) {
      add(
        diagnostics,
        "LOOP_ECONOMICS_V2_MISSING_LEAF",
        "leaves",
        `Execution leaf ${leafId} must have exactly one charge leaf.`
      );
    }
  }
}

function validateExecutionAdmissionViaV1(
  execution: unknown,
  owner: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (!record(execution) || !record(owner)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Execution admission must be an object.");
    return;
  }
  try {
    const evidence = materializeLoopEconomicsEvidence({
      schema: LOOP_ECONOMICS_EVIDENCE_SCHEMA,
      canonicalization: CANONICAL_JSON_VERSION,
      owner: owner as unknown as LoopEconomicsEvidenceOwner,
      executions: [execution as unknown as LoopEconomicsExecutionAdmission],
      effectIntents: [],
      terminal: { status: "pending" },
    });
    const result = validateLoopEconomicsEvidence(evidence);
    for (const diagnostic of result.diagnostics) {
      if (!diagnostic.path.startsWith("executions[0]")) continue;
      add(
        diagnostics,
        mapV1Code(diagnostic.code),
        `${path}${diagnostic.path.slice("executions[0]".length)}`,
        diagnostic.message
      );
    }
  } catch {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", path, "Execution admission cannot be canonically materialized.");
  }
}

export function validateRecordedUsageViaV1(
  usage: unknown,
  execution: Record<string, unknown>,
  owner: unknown,
  path: string,
  diagnostics: LoopEconomicsEvidenceDiagnosticV2[]
): void {
  if (!record(owner) || !record(execution.binding)) {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.usage`, "Usage cannot be verified without an exact execution admission.");
    return;
  }
  try {
    const evidence = materializeLoopEconomicsEvidence({
      schema: LOOP_ECONOMICS_EVIDENCE_SCHEMA,
      canonicalization: CANONICAL_JSON_VERSION,
      owner: owner as unknown as LoopEconomicsEvidenceOwner,
      executions: [execution as unknown as LoopEconomicsExecutionAdmission],
      effectIntents: [],
      terminal: {
        status: "recorded",
        executions: [{
          nodeId: execution.nodeId as string,
          bindingDigest: execution.binding.bindingDigest as LoopEconomicsSha256DigestV2,
          receiptDigest: digest({ path, usage }),
          usage: usage as AiUsageTruthV2,
        }],
        effects: [],
      },
    });
    const result = validateLoopEconomicsEvidence(evidence);
    for (const diagnostic of result.diagnostics) {
      if (!diagnostic.path.startsWith("terminal.executions[0]")) continue;
      add(
        diagnostics,
        mapV1Code(diagnostic.code),
        `${path}${diagnostic.path.slice("terminal.executions[0]".length)}`,
        diagnostic.message
      );
    }
  } catch {
    add(diagnostics, "LOOP_ECONOMICS_V2_INVALID", `${path}.usage`, "Recorded usage cannot be canonically verified.");
  }
}

import {
  validateAiExecutionReceipt,
  type AiExecutionBinding,
  type AiExecutionDiagnostic,
  type AiExecutionOfferSnapshot,
  type AiExecutionReceipt,
  type AiExecutionReceiptV2,
  type AiExecutionValidation,
  type AiRouteDecisionBinding,
  type AiResolvedTargetSnapshot,
} from "./ai-execution.js";
import type { ExecutionRouteDecision } from "./canonical-execution.js";
import { canonicalInputDigest } from "./idempotency.js";

export type AiResolvedTargetSnapshotInput = Omit<
  AiResolvedTargetSnapshot,
  "snapshotDigest"
>;
export type AiExecutionOfferSnapshotInput = Omit<
  AiExecutionOfferSnapshot,
  "snapshotDigest"
>;
export type AiExecutionBindingInput = Omit<AiExecutionBinding, "bindingDigest">;

/** Node-host custody helper. The browser-neutral contract subpath imports no Node APIs. */
export function digestAiResolvedTargetSnapshot(
  value: AiResolvedTargetSnapshotInput,
): `sha256:${string}` {
  return `sha256:${canonicalInputDigest(value)}`;
}

export function materializeAiResolvedTargetSnapshot(
  value: AiResolvedTargetSnapshotInput,
): AiResolvedTargetSnapshot {
  return { ...value, snapshotDigest: digestAiResolvedTargetSnapshot(value) };
}

export function digestAiExecutionOfferSnapshot(
  value: AiExecutionOfferSnapshotInput,
): `sha256:${string}` {
  return `sha256:${canonicalInputDigest(value)}`;
}

export function materializeAiExecutionOfferSnapshot(
  value: AiExecutionOfferSnapshotInput,
): AiExecutionOfferSnapshot {
  return { ...value, snapshotDigest: digestAiExecutionOfferSnapshot(value) };
}

export function materializeAiRouteDecisionBinding(
  value: ExecutionRouteDecision & { readonly selectedCandidateId: string },
): AiRouteDecisionBinding {
  return {
    decisionId: value.id,
    policyId: value.policyId,
    selectedCandidateId: value.selectedCandidateId,
    decisionDigest: `sha256:${canonicalInputDigest(value)}`,
  };
}

export function digestAiExecutionBinding(
  value: AiExecutionBindingInput,
): `sha256:${string}` {
  return `sha256:${canonicalInputDigest(value)}`;
}

export function materializeAiExecutionBinding(
  value: AiExecutionBindingInput,
): AiExecutionBinding {
  return { ...value, bindingDigest: digestAiExecutionBinding(value) };
}

export function validateAiResolvedTargetSnapshotDigest(
  value: unknown,
  path = "target",
): AiExecutionValidation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      valid: false,
      diagnostics: [{
        code: "AI_TARGET_SNAPSHOT_INVALID",
        path,
        message: "Target snapshot must be an object.",
      }],
    };
  }
  const snapshot = value as AiResolvedTargetSnapshot;
  const { snapshotDigest, ...input } = snapshot;
  const diagnostics: AiExecutionDiagnostic[] = [];
  if (snapshotDigest !== safeDigestAiResolvedTargetSnapshot(input)) {
    diagnostics.push({
      code: "AI_TARGET_SNAPSHOT_INVALID",
      path: `${path}.snapshotDigest`,
      message: "Target snapshot digest does not match its canonical content.",
    });
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

export function validateAiExecutionOfferSnapshotDigest(
  value: unknown,
  path = "offer",
): AiExecutionValidation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidDigest(path, "AI_EXECUTION_OFFER_INVALID", "Execution offer must be an object.");
  }
  const snapshot = value as AiExecutionOfferSnapshot;
  const { snapshotDigest, ...input } = snapshot;
  if (snapshotDigest !== safeDigestAiExecutionOfferSnapshot(input)) {
    return invalidDigest(
      `${path}.snapshotDigest`,
      "AI_EXECUTION_OFFER_INVALID",
      "Execution offer digest does not match its canonical content.",
    );
  }
  return { valid: true, diagnostics: [] };
}

export function validateAiExecutionBindingDigest(
  value: unknown,
  path = "binding",
): AiExecutionValidation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalidDigest(path, "AI_EXECUTION_BINDING_INVALID", "Execution binding must be an object.");
  }
  const binding = value as AiExecutionBinding;
  const { bindingDigest, ...input } = binding;
  const diagnostics: AiExecutionDiagnostic[] = [];
  if (bindingDigest !== safeDigestAiExecutionBinding(input)) {
    diagnostics.push({
      code: "AI_EXECUTION_BINDING_INVALID",
      path: `${path}.bindingDigest`,
      message: "Execution binding digest does not match its canonical content.",
    });
  }
  diagnostics.push(
    ...validateAiExecutionOfferSnapshotDigest(binding.offer, `${path}.offer`).diagnostics,
    ...validateAiResolvedTargetSnapshotDigest(binding.target, `${path}.target`).diagnostics,
  );
  return { valid: diagnostics.length === 0, diagnostics };
}

/**
 * Host acceptance validator: structural receipt checks plus canonical SHA-256
 * custody for the final target and every attempt target.
 */
export function validateAiExecutionReceiptCustody(
  value: unknown,
): AiExecutionValidation {
  const structural = validateAiExecutionReceipt(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return structural;
  }
  const receipt = value as Partial<AiExecutionReceipt | AiExecutionReceiptV2>;
  const diagnostics: AiExecutionDiagnostic[] = [
    ...structural.diagnostics,
    ...validateAiResolvedTargetSnapshotDigest(receipt.target, "target").diagnostics,
    ...(Array.isArray(receipt.attempts) ? receipt.attempts : []).flatMap((attempt, index) =>
      validateAiResolvedTargetSnapshotDigest(
        attempt?.target,
        `attempts[${index}].target`,
      ).diagnostics,
    ),
  ];
  if (receipt.schema === "dzupagent.aiExecutionReceipt/v2") {
    const bound = receipt as Partial<AiExecutionReceiptV2>;
    diagnostics.push(
      ...validateAiExecutionBindingDigest(bound.binding, "binding").diagnostics,
      ...(Array.isArray(bound.attempts) ? bound.attempts : []).flatMap((attempt, index) =>
        validateAiExecutionBindingDigest(
          attempt?.binding,
          `attempts[${index}].binding`,
        ).diagnostics,
      ),
    );
    const decision = bound.result?.routeDecision;
    const routeBinding = bound.binding?.routeDecision;
    if (
      decision !== undefined &&
      routeBinding !== undefined &&
      routeBinding.decisionDigest !== safeCanonicalDigest(decision)
    ) {
      diagnostics.push({
        code: "AI_EXECUTION_BINDING_INVALID",
        path: "binding.routeDecision.decisionDigest",
        message: "Route decision digest does not match the canonical result decision.",
      });
    }
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

function safeDigestAiResolvedTargetSnapshot(
  value: AiResolvedTargetSnapshotInput,
): `sha256:${string}` | undefined {
  try {
    return digestAiResolvedTargetSnapshot(value);
  } catch {
    return undefined;
  }
}

function safeDigestAiExecutionOfferSnapshot(
  value: AiExecutionOfferSnapshotInput,
): `sha256:${string}` | undefined {
  try {
    return digestAiExecutionOfferSnapshot(value);
  } catch {
    return undefined;
  }
}

function safeDigestAiExecutionBinding(
  value: AiExecutionBindingInput,
): `sha256:${string}` | undefined {
  try {
    return digestAiExecutionBinding(value);
  } catch {
    return undefined;
  }
}

function safeCanonicalDigest(value: unknown): `sha256:${string}` | undefined {
  try {
    return `sha256:${canonicalInputDigest(value)}`;
  } catch {
    return undefined;
  }
}

function invalidDigest(
  path: string,
  code: AiExecutionDiagnostic["code"],
  message: string,
): AiExecutionValidation {
  return { valid: false, diagnostics: [{ code, path, message }] };
}

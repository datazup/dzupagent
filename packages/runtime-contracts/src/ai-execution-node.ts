import {
  validateAiExecutionReceipt,
  type AiExecutionDiagnostic,
  type AiExecutionReceipt,
  type AiExecutionValidation,
  type AiResolvedTargetSnapshot,
} from "./ai-execution.js";
import { canonicalInputDigest } from "./idempotency.js";

export type AiResolvedTargetSnapshotInput = Omit<
  AiResolvedTargetSnapshot,
  "snapshotDigest"
>;

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
  if (snapshotDigest !== digestAiResolvedTargetSnapshot(input)) {
    diagnostics.push({
      code: "AI_TARGET_SNAPSHOT_INVALID",
      path: `${path}.snapshotDigest`,
      message: "Target snapshot digest does not match its canonical content.",
    });
  }
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
  const receipt = value as Partial<AiExecutionReceipt>;
  const diagnostics = [
    ...structural.diagnostics,
    ...validateAiResolvedTargetSnapshotDigest(receipt.target, "target").diagnostics,
    ...(Array.isArray(receipt.attempts) ? receipt.attempts : []).flatMap((attempt, index) =>
      validateAiResolvedTargetSnapshotDigest(
        attempt?.target,
        `attempts[${index}].target`,
      ).diagnostics,
    ),
  ];
  return { valid: diagnostics.length === 0, diagnostics };
}

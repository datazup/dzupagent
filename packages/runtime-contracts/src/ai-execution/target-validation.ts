import {
  validateExecutionBoundaryEvidenceV1,
} from "../execution-boundary-evidence.js";
import {
  add,
  enumValue,
  isIsoDate,
  isRecord,
  nonEmpty,
  nonEmptyStrings,
  numberValue,
  positiveInteger,
  stringValue,
  validateArtifact,
  validateMessages,
} from "../ai-execution-validation-primitives.js";
import {
  AI_EXECUTION_OPERATION_KINDS,
  AI_EXECUTION_STYLES,
  AI_RESOLVED_TARGET_SCHEMA,
  AI_TARGET_PLACEMENTS,
} from "../ai-execution-types.js";
import type {
  AiExecutionDiagnostic,
} from "../ai-execution-receipt-types.js";

const AI_PUBLIC_TARGET_FORBIDDEN_KEYS = new Set([
  "apikey",
  "auth",
  "authref",
  "authsourceref",
  "backend",
  "command",
  "credential",
  "driver",
  "driverid",
  "endpoint",
  "filepath",
  "filesystempath",
  "model",
  "path",
  "profile",
  "profileref",
  "provider",
  "providerpath",
  "secret",
  "secretref",
  "token",
  "workerid",
  "workername",
  "workerref",
]);


export function validateExecutionBoundary(
  execution: Record<string, unknown> | undefined,
  diagnostics: AiExecutionDiagnostic[],
): void {
  if (execution?.boundaryEvidence === undefined) return;
  const boundary = validateExecutionBoundaryEvidenceV1(
    execution.boundaryEvidence,
  );
  if (!boundary.valid) {
    for (const item of boundary.issues) {
      add(
        diagnostics,
        "AI_EXECUTION_BOUNDARY_INVALID",
        `execution.boundaryEvidence${item.path === "$" ? "" : item.path.slice(1)}`,
        item.message,
      );
    }
    return;
  }
  const source = isRecord(execution.source) ? execution.source : undefined;
  if (
    boundary.value.owner.executionKind !== execution.kind ||
    boundary.value.owner.nodeId !== source?.nodeId ||
    boundary.value.owner.nodePath !== source?.nodePath
  ) {
    add(
      diagnostics,
      "AI_EXECUTION_BOUNDARY_INVALID",
      "execution.boundaryEvidence.owner",
      "Execution-boundary owner must match the canonical request leaf.",
    );
  }
}

export function validateOperation(
  value: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!isRecord(value)) {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      path,
      "AI execution operation must be an object."
    );
    return;
  }
  const kind = value.kind;
  if (!(AI_EXECUTION_OPERATION_KINDS as readonly unknown[]).includes(kind)) {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      `${path}.kind`,
      "Unsupported AI execution operation."
    );
    return;
  }
  const input = isRecord(value.input) ? value.input : {};
  const output = isRecord(value.output) ? value.output : {};
  switch (kind) {
    case "text.generate":
      nonEmpty(stringValue(input.text), `${path}.input.text`, diagnostics);
      enumValue(
        stringValue(output.modality),
        ["text"] as const,
        `${path}.output.modality`,
        diagnostics
      );
      break;
    case "chat.generate":
      validateMessages(input.messages, `${path}.input.messages`, diagnostics);
      enumValue(
        stringValue(output.modality),
        ["text"] as const,
        `${path}.output.modality`,
        diagnostics
      );
      break;
    case "structured.generate":
      nonEmpty(stringValue(input.prompt), `${path}.input.prompt`, diagnostics);
      enumValue(
        stringValue(output.modality),
        ["json"] as const,
        `${path}.output.modality`,
        diagnostics
      );
      if (!output.schemaRef && !output.schema) {
        add(
          diagnostics,
          "AI_INVALID_VALUE",
          `${path}.output`,
          "Structured output requires a schemaRef or inline schema."
        );
      }
      break;
    case "embedding.create":
      nonEmptyStrings(input.texts, `${path}.input.texts`, diagnostics);
      enumValue(
        stringValue(output.modality),
        ["embedding"] as const,
        `${path}.output.modality`,
        diagnostics
      );
      if (output.dimensions !== undefined) {
        positiveInteger(
          numberValue(output.dimensions),
          `${path}.output.dimensions`,
          diagnostics
        );
      }
      break;
    case "audio.transcribe":
      validateArtifact(input.audio, `${path}.input.audio`, diagnostics);
      enumValue(
        stringValue(output.modality),
        ["text"] as const,
        `${path}.output.modality`,
        diagnostics
      );
      break;
    case "speech.synthesize":
      nonEmpty(stringValue(input.text), `${path}.input.text`, diagnostics);
      enumValue(
        stringValue(output.modality),
        ["audio"] as const,
        `${path}.output.modality`,
        diagnostics
      );
      if (input.voiceRef !== undefined)
        nonEmpty(
          stringValue(input.voiceRef),
          `${path}.input.voiceRef`,
          diagnostics
        );
      if (output.mediaTypes !== undefined) {
        nonEmptyStrings(
          output.mediaTypes,
          `${path}.output.mediaTypes`,
          diagnostics
        );
      }
      break;
    case "image.analyze":
      if (!Array.isArray(input.images) || input.images.length === 0) {
        add(
          diagnostics,
          "AI_INVALID_VALUE",
          `${path}.input.images`,
          "Image analysis requires at least one image artifact."
        );
      }
      (Array.isArray(input.images) ? input.images : []).forEach(
        (artifact, index) =>
          validateArtifact(
            artifact,
            `${path}.input.images[${index}]`,
            diagnostics
          )
      );
      enumValue(
        stringValue(output.modality),
        ["text", "json"] as const,
        `${path}.output.modality`,
        diagnostics
      );
      if (output.modality === "json" && !output.schemaRef && !output.schema) {
        add(
          diagnostics,
          "AI_INVALID_VALUE",
          `${path}.output`,
          "JSON image analysis requires a schemaRef or inline schema."
        );
      }
      break;
    case "token.count":
      if (Object.hasOwn(input, "text"))
        nonEmpty(stringValue(input.text), `${path}.input.text`, diagnostics);
      else
        validateMessages(input.messages, `${path}.input.messages`, diagnostics);
      enumValue(
        stringValue(output.modality),
        ["token-count"] as const,
        `${path}.output.modality`,
        diagnostics
      );
      break;
    case "agent.run":
      nonEmpty(
        stringValue(input.agentRef),
        `${path}.input.agentRef`,
        diagnostics
      );
      enumValue(
        stringValue(output.modality),
        ["text", "json", "unknown"] as const,
        `${path}.output.modality`,
        diagnostics
      );
      break;
  }
}

export function validateExecutionKind(
  execution: unknown,
  operation: string | undefined,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!isRecord(execution) || !operation) return;
  const executionKind = stringValue(execution.kind);
  const compatible =
    operation === "agent.run"
      ? executionKind === "agent" ||
        executionKind === "adapter.run" ||
        executionKind === "worker.dispatch"
      : executionKind === "prompt" ||
        executionKind === "adapter.run" ||
        executionKind === "worker.dispatch";
  if (!compatible) {
    add(
      diagnostics,
      "AI_EXECUTION_KIND_INCOMPATIBLE",
      "execution.kind",
      `Canonical execution kind ${String(
        executionKind
      )} cannot host operation ${operation}.`
    );
  }
}

export function validateTargetSnapshot(
  value: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!isRecord(value) || value.schema !== AI_RESOLVED_TARGET_SCHEMA) {
    add(
      diagnostics,
      "AI_INVALID_SCHEMA",
      `${path}.schema`,
      "Unsupported resolved AI target schema."
    );
    return;
  }
  nonEmpty(stringValue(value.targetId), `${path}.targetId`, diagnostics);
  nonEmpty(
    stringValue(value.targetRevision),
    `${path}.targetRevision`,
    diagnostics
  );
  nonEmpty(
    stringValue(value.policyRevision),
    `${path}.policyRevision`,
    diagnostics
  );
  nonEmpty(
    stringValue(value.routeCandidateId),
    `${path}.routeCandidateId`,
    diagnostics
  );
  enumValue(
    stringValue(value.operation),
    AI_EXECUTION_OPERATION_KINDS,
    `${path}.operation`,
    diagnostics
  );
  enumValue(
    stringValue(value.placement),
    AI_TARGET_PLACEMENTS,
    `${path}.placement`,
    diagnostics
  );
  enumValue(
    stringValue(value.executionStyle),
    AI_EXECUTION_STYLES,
    `${path}.executionStyle`,
    diagnostics
  );
  if (value.authMode !== undefined) {
    enumValue(
      stringValue(value.authMode),
      [
        "subscription_cli",
        "api_key",
        "workload_identity",
        "local_model",
      ] as const,
      `${path}.authMode`,
      diagnostics
    );
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(stringValue(value.snapshotDigest) ?? "")) {
    add(
      diagnostics,
      "AI_TARGET_SNAPSHOT_INVALID",
      `${path}.snapshotDigest`,
      "Target snapshot identity must be a lowercase SHA-256 digest."
    );
  }
  if (!isIsoDate(value.resolvedAt)) {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      `${path}.resolvedAt`,
      "Target resolution time must be ISO-8601."
    );
  }
}

/** Validates the browser-neutral structure and cross-fields of one binding. */

export function validateTargetSelector(
  value: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!isRecord(value)) {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      `${path}.kind`,
      "Target selector must use target-id or task-profile."
    );
  } else if (value.kind === "target-id") {
    nonEmpty(stringValue(value.targetId), `${path}.targetId`, diagnostics);
  } else if (value.kind === "task-profile") {
    nonEmpty(
      stringValue(value.taskProfileId),
      `${path}.taskProfileId`,
      diagnostics
    );
  } else {
    add(
      diagnostics,
      "AI_INVALID_VALUE",
      `${path}.kind`,
      "Target selector must use target-id or task-profile."
    );
  }
}

export function collectPublicTargetLeakPaths(
  value: unknown,
  path = "$",
  seen = new WeakSet<object>()
): string[] {
  if (value === null || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectPublicTargetLeakPaths(item, `${path}[${index}]`, seen)
    );
  }
  return Object.entries(value).flatMap(([key, nested]) => {
    const nestedPath = path === "$" ? key : `${path}.${key}`;
    const normalized = key.replaceAll(/[-_]/g, "").toLowerCase();
    return [
      ...(AI_PUBLIC_TARGET_FORBIDDEN_KEYS.has(normalized) ? [nestedPath] : []),
      ...collectPublicTargetLeakPaths(nested, nestedPath, seen),
    ];
  });
}

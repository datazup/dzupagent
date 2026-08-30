import {
  add,
  enumValue,
  isIsoDate,
  isRecord,
  jsonEqual,
  nonEmpty,
  stringValue,
  uniqueStrings,
  validation,
} from "../ai-execution-validation-primitives.js";
import {
  AI_EXECUTION_BINDING_SCHEMA,
  AI_EXECUTION_OFFER_SCHEMA,
} from "../ai-execution-types.js";
import type {
  AiExecutionDiagnostic,
  AiExecutionValidation,
} from "../ai-execution-receipt-types.js";
import {
  validateTargetSnapshot,
} from "./target-validation.js";

export function validateAiExecutionBinding(
  value: unknown
): AiExecutionValidation {
  const diagnostics: AiExecutionDiagnostic[] = [];
  validateExecutionBinding(value, "binding", diagnostics);
  return validation(diagnostics);
}

export function validateExecutionBinding(
  value: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!isRecord(value) || value.schema !== AI_EXECUTION_BINDING_SCHEMA) {
    add(
      diagnostics,
      "AI_EXECUTION_BINDING_INVALID",
      `${path}.schema`,
      "Unsupported AI execution binding schema."
    );
    return;
  }
  validateRouteDecisionBinding(value.routeDecision, `${path}.routeDecision`, diagnostics);
  validateExecutionOffer(value.offer, `${path}.offer`, diagnostics);
  validateTargetSnapshot(value.target, `${path}.target`, diagnostics);
  validatePromptBinding(value.prompt, `${path}.prompt`, diagnostics);
  validatePersonaBinding(value.persona, `${path}.persona`, diagnostics);
  validateModelIdentity(value.model, `${path}.model`, diagnostics);
  digestValue(value.bindingDigest, `${path}.bindingDigest`, diagnostics, "binding");

  const route = isRecord(value.routeDecision) ? value.routeDecision : undefined;
  const offer = isRecord(value.offer) ? value.offer : undefined;
  const target = isRecord(value.target) ? value.target : undefined;
  if (
    route?.selectedCandidateId !== offer?.offerId ||
    route?.selectedCandidateId !== target?.routeCandidateId
  ) {
    add(
      diagnostics,
      "AI_EXECUTION_BINDING_MISMATCH",
      path,
      "Route decision, execution offer, and resolved target must name one candidate."
    );
  }
  if (!jsonEqual(value.model, offer?.model)) {
    add(
      diagnostics,
      "AI_EXECUTION_BINDING_MISMATCH",
      `${path}.model`,
      "Binding model identity must equal the offer model identity."
    );
  }
  if (
    offer !== undefined &&
    target !== undefined &&
    (offer.backend !== target.backend ||
      (target.provider !== undefined && offer.provider !== target.provider) ||
      (target.authMode !== undefined && offer.authMode !== target.authMode) ||
      (target.profileRef !== undefined && offer.profileRef !== target.profileRef) ||
      (target.model !== undefined &&
        isRecord(offer.model) &&
        offer.model.providerModelId !== target.model))
  ) {
    add(
      diagnostics,
      "AI_EXECUTION_BINDING_MISMATCH",
      `${path}.offer`,
      "Execution offer identity must agree with the resolved target."
    );
  }
}

function validateExecutionOffer(
  value: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!isRecord(value) || value.schema !== AI_EXECUTION_OFFER_SCHEMA) {
    add(
      diagnostics,
      "AI_EXECUTION_OFFER_INVALID",
      `${path}.schema`,
      "Unsupported AI execution offer schema."
    );
    return;
  }
  for (const key of ["offerId", "offerRevision", "provider"] as const) {
    nonEmpty(stringValue(value[key]), `${path}.${key}`, diagnostics);
  }
  validateModelIdentity(value.model, `${path}.model`, diagnostics);
  enumValue(
    stringValue(value.backend),
    ["cli", "local-model", "sdk", "api", "remote"] as const,
    `${path}.backend`,
    diagnostics
  );
  if (value.authMode !== undefined) {
    enumValue(
      stringValue(value.authMode),
      ["subscription_cli", "api_key", "workload_identity", "local_model"] as const,
      `${path}.authMode`,
      diagnostics
    );
  }
  enumValue(
    stringValue(value.locality),
    ["local", "remote"] as const,
    `${path}.locality`,
    diagnostics
  );
  enumValue(
    stringValue(value.privacyClass),
    ["device", "private-network", "provider", "public"] as const,
    `${path}.privacyClass`,
    diagnostics
  );
  uniqueStrings(value.capabilities, `${path}.capabilities`, diagnostics);
  enumValue(
    stringValue(value.cacheBehavior),
    ["none", "provider", "host", "unknown"] as const,
    `${path}.cacheBehavior`,
    diagnostics
  );
  enumValue(
    stringValue(value.sessionBehavior),
    ["stateless", "stateful", "unknown"] as const,
    `${path}.sessionBehavior`,
    diagnostics
  );
  const health = isRecord(value.health) ? value.health : undefined;
  enumValue(
    stringValue(health?.status),
    ["healthy", "degraded", "unhealthy", "unknown"] as const,
    `${path}.health.status`,
    diagnostics
  );
  if (health?.checkedAt !== undefined && !isIsoDate(health.checkedAt)) {
    add(diagnostics, "AI_EXECUTION_OFFER_INVALID", `${path}.health.checkedAt`, "Offer health time must be ISO-8601.");
  }
  if (!isIsoDate(value.effectiveAt)) {
    add(diagnostics, "AI_EXECUTION_OFFER_INVALID", `${path}.effectiveAt`, "Offer effective time must be ISO-8601.");
  }
  if (value.expiresAt !== undefined && !isIsoDate(value.expiresAt)) {
    add(diagnostics, "AI_EXECUTION_OFFER_INVALID", `${path}.expiresAt`, "Offer expiry must be ISO-8601 when present.");
  }
  const effectiveAt = stringValue(value.effectiveAt);
  const expiresAt = stringValue(value.expiresAt);
  if (
    effectiveAt !== undefined &&
    expiresAt !== undefined &&
    isIsoDate(effectiveAt) &&
    isIsoDate(expiresAt) &&
    Date.parse(expiresAt) <= Date.parse(effectiveAt)
  ) {
    add(diagnostics, "AI_EXECUTION_OFFER_INVALID", `${path}.expiresAt`, "Offer expiry must be after its effective time.");
  }
  digestValue(value.catalogDigest, `${path}.catalogDigest`, diagnostics, "catalog");
  digestValue(value.snapshotDigest, `${path}.snapshotDigest`, diagnostics, "offer snapshot");
}

function validateRouteDecisionBinding(
  value: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!isRecord(value)) {
    add(diagnostics, "AI_EXECUTION_BINDING_INVALID", path, "Route decision binding is required.");
    return;
  }
  for (const key of ["decisionId", "policyId", "selectedCandidateId"] as const) {
    nonEmpty(stringValue(value[key]), `${path}.${key}`, diagnostics);
  }
  digestValue(value.decisionDigest, `${path}.decisionDigest`, diagnostics, "route decision");
}

function validatePromptBinding(
  value: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!isRecord(value)) {
    add(diagnostics, "AI_EXECUTION_BINDING_INVALID", path, "Prompt binding is required.");
    return;
  }
  nonEmpty(stringValue(value.blueprintRef), `${path}.blueprintRef`, diagnostics);
  nonEmpty(stringValue(value.blueprintRevision), `${path}.blueprintRevision`, diagnostics);
  digestValue(value.blueprintDigest, `${path}.blueprintDigest`, diagnostics, "prompt blueprint");
  digestValue(value.renderedPayloadDigest, `${path}.renderedPayloadDigest`, diagnostics, "rendered payload");
}

function validatePersonaBinding(
  value: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!isRecord(value) || (value.status !== "none" && value.status !== "bound")) {
    add(diagnostics, "AI_EXECUTION_BINDING_INVALID", `${path}.status`, "Persona binding must be none or bound.");
    return;
  }
  if (value.status === "bound") {
    nonEmpty(stringValue(value.personaId), `${path}.personaId`, diagnostics);
    nonEmpty(stringValue(value.revision), `${path}.revision`, diagnostics);
    digestValue(value.digest, `${path}.digest`, diagnostics, "persona");
  }
}

function validateModelIdentity(
  value: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[]
): void {
  if (!isRecord(value)) {
    add(diagnostics, "AI_EXECUTION_BINDING_INVALID", path, "Model identity is required.");
    return;
  }
  nonEmpty(stringValue(value.modelRef), `${path}.modelRef`, diagnostics);
  nonEmpty(stringValue(value.revision), `${path}.revision`, diagnostics);
  digestValue(value.catalogDigest, `${path}.catalogDigest`, diagnostics, "model catalog");
}

function digestValue(
  value: unknown,
  path: string,
  diagnostics: AiExecutionDiagnostic[],
  label: string
): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(stringValue(value) ?? "")) {
    add(
      diagnostics,
      "AI_EXECUTION_BINDING_INVALID",
      path,
      `${label} identity must be a lowercase SHA-256 digest.`
    );
  }
}

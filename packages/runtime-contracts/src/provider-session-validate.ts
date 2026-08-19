/**
 * Fail-closed provider-session admission (runtime validator).
 *
 * Extracted from `provider-session.ts` (RF-03 pin exit), which re-exports the
 * public entry point and the diagnostic types so the
 * `@dzupagent/runtime-contracts/provider-session` surface is unchanged.
 */

import {
  PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA,
  PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA_V1,
  PROVIDER_SESSION_CAPABILITIES,
  PROVIDER_SESSION_CAPABILITIES_V1,
  PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
  PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA_V1,
  PROVIDER_SESSION_EFFECTS,
  PROVIDER_SESSION_EFFECTS_V1,
  type ProviderSessionCapability,
  type ProviderSessionEffect,
} from "./provider-session-schema.js";

export type ProviderSessionAdmissionDiagnosticCode =
  | "BINDING_SCHEMA_INVALID"
  | "BINDING_IDENTITY_INVALID"
  | "DESCRIPTOR_SCHEMA_INVALID"
  | "BACKEND_IDENTITY_INVALID"
  | "CAPABILITY_DECLARATION_INVALID"
  | "CAPABILITY_REQUIRED_UNSUPPORTED"
  | "EFFECT_AUTHORITY_INVALID"
  | "SERIALIZABLE_STATE_FORBIDDEN";

export interface ProviderSessionAdmissionDiagnostic {
  readonly code: ProviderSessionAdmissionDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface ProviderSessionAdmissionResult {
  readonly valid: boolean;
  readonly diagnostics: readonly ProviderSessionAdmissionDiagnostic[];
}

const FORBIDDEN_SERIALIZABLE_KEYS = new Set([
  "apikey",
  "credential",
  "credentials",
  "password",
  "protocolobject",
  "rawevent",
  "sdkclient",
  "secret",
  "token",
]);

/** Fail-closed admission performed before any provider dispatch. */
export function validateProviderSessionAttemptBinding(
  candidate: unknown,
  requiredCapabilities: readonly ProviderSessionCapability[] = [],
): ProviderSessionAdmissionResult {
  const diagnostics: ProviderSessionAdmissionDiagnostic[] = [];
  if (!isRecord(candidate)) {
    add(diagnostics, "BINDING_SCHEMA_INVALID", "", "Attempt binding must be an object.");
    return { valid: false, diagnostics };
  }

  inspectForbiddenState(candidate, "", diagnostics, new Set());
  const legacyBinding = candidate.schema === PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA_V1;
  const currentBinding = candidate.schema === PROVIDER_SESSION_ATTEMPT_BINDING_SCHEMA;
  if (!legacyBinding && !currentBinding) {
    add(diagnostics, "BINDING_SCHEMA_INVALID", "schema", "Attempt binding schema is unsupported.");
  }
  for (const key of ["bindingId", "executionAttemptId", "authSourceRef", "boundAt"] as const) {
    if (!nonEmpty(candidate[key])) {
      add(diagnostics, "BINDING_IDENTITY_INVALID", key, `${key} must be a non-empty string.`);
    }
  }
  if (nonEmpty(candidate.boundAt) && !validTimestamp(candidate.boundAt)) {
    add(diagnostics, "BINDING_IDENTITY_INVALID", "boundAt", "boundAt must be an ISO timestamp.");
  }

  const descriptor = candidate.descriptor;
  if (!isRecord(descriptor)) {
    add(diagnostics, "DESCRIPTOR_SCHEMA_INVALID", "descriptor", "Capability descriptor must be an object.");
  } else {
    const admittedCapabilities = legacyBinding
      ? PROVIDER_SESSION_CAPABILITIES_V1
      : PROVIDER_SESSION_CAPABILITIES;
    const admittedCapabilitySet: ReadonlySet<ProviderSessionCapability> =
      new Set(admittedCapabilities);
    inspectDescriptor(
      descriptor,
      diagnostics,
      legacyBinding
        ? PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA_V1
        : PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
      admittedCapabilities,
    );
    for (const capability of [...new Set(requiredCapabilities)]) {
      const support = isRecord(descriptor.capabilities)
        ? descriptor.capabilities[capability]
        : undefined;
      if (
        !admittedCapabilitySet.has(capability)
        || !isRecord(support)
        || support.status !== "native"
      ) {
        add(
          diagnostics,
          "CAPABILITY_REQUIRED_UNSUPPORTED",
          `descriptor.capabilities.${capability}`,
          `Required provider-session capability is not native: ${capability}.`,
        );
      }
    }
  }

  inspectEffectAuthorities(
    candidate.effectAuthorities,
    diagnostics,
    legacyBinding ? PROVIDER_SESSION_EFFECTS_V1 : PROVIDER_SESSION_EFFECTS,
  );
  return { valid: diagnostics.length === 0, diagnostics };
}

function inspectDescriptor(
  descriptor: Record<string, unknown>,
  diagnostics: ProviderSessionAdmissionDiagnostic[],
  expectedSchema:
    | typeof PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA_V1
    | typeof PROVIDER_SESSION_CAPABILITY_DESCRIPTOR_SCHEMA,
  admittedCapabilities: readonly ProviderSessionCapability[],
): void {
  if (descriptor.schema !== expectedSchema) {
    add(diagnostics, "DESCRIPTOR_SCHEMA_INVALID", "descriptor.schema", "Capability descriptor schema is unsupported.");
  }
  for (const key of ["descriptorId", "providerId", "observedAt"] as const) {
    if (!nonEmpty(descriptor[key])) {
      add(diagnostics, "DESCRIPTOR_SCHEMA_INVALID", `descriptor.${key}`, `${key} must be a non-empty string.`);
    }
  }
  if (nonEmpty(descriptor.observedAt) && !validTimestamp(descriptor.observedAt)) {
    add(diagnostics, "DESCRIPTOR_SCHEMA_INVALID", "descriptor.observedAt", "observedAt must be an ISO timestamp.");
  }

  const backend = descriptor.backend;
  if (
    !isRecord(backend)
    || !nonEmpty(backend.id)
    || !["cli", "local-model", "sdk", "api", "remote", "app-server"].includes(String(backend.kind))
  ) {
    add(diagnostics, "BACKEND_IDENTITY_INVALID", "descriptor.backend", "Backend id and kind are required.");
  } else if (
    backend.artifactDigest !== undefined
    && !/^sha256:[a-f0-9]{64}$/u.test(String(backend.artifactDigest))
  ) {
    add(
      diagnostics,
      "BACKEND_IDENTITY_INVALID",
      "descriptor.backend.artifactDigest",
      "Artifact digest must be a lowercase SHA-256 reference.",
    );
  }

  const capabilities = descriptor.capabilities;
  if (!isRecord(capabilities)) {
    add(diagnostics, "CAPABILITY_DECLARATION_INVALID", "descriptor.capabilities", "Capability map must be an object.");
    return;
  }
  for (const capability of admittedCapabilities) {
    const support = capabilities[capability];
    if (
      !isRecord(support)
      || !["native", "unsupported"].includes(String(support.status))
      || support.emulation !== "forbidden"
      || (support.status === "unsupported" && !nonEmpty(support.reason))
    ) {
      add(
        diagnostics,
        "CAPABILITY_DECLARATION_INVALID",
        `descriptor.capabilities.${capability}`,
        "Capability must be native or explicitly unsupported, with emulation forbidden.",
      );
    }
  }
}

function inspectEffectAuthorities(
  value: unknown,
  diagnostics: ProviderSessionAdmissionDiagnostic[],
  admittedEffects: readonly ProviderSessionEffect[],
): void {
  if (!isRecord(value)) {
    add(diagnostics, "EFFECT_AUTHORITY_INVALID", "effectAuthorities", "Effect authority map must be an object.");
    return;
  }
  for (const effect of admittedEffects) {
    const authority = value[effect];
    if (
      !isRecord(authority)
      || authority.effect !== effect
      || !nonEmpty(authority.retryAuthorityId)
      || !nonEmpty(authority.fallbackAuthorityId)
      || ![0, 1].includes(Number(authority.maxRetries))
      || !["none", "ordered-compatible"].includes(String(authority.fallback))
    ) {
      add(
        diagnostics,
        "EFFECT_AUTHORITY_INVALID",
        `effectAuthorities.${effect}`,
        "Every effect needs one named retry authority, fallback authority, and bounded retry policy.",
      );
    }
  }
}

function inspectForbiddenState(
  value: unknown,
  path: string,
  diagnostics: ProviderSessionAdmissionDiagnostic[],
  seen: Set<object>,
): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) {
    add(diagnostics, "SERIALIZABLE_STATE_FORBIDDEN", path, "Attempt binding must be JSON-serializable.");
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectForbiddenState(entry, `${path}[${index}]`, diagnostics, seen));
    seen.delete(value);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
    const entryPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_SERIALIZABLE_KEYS.has(normalized)) {
      add(diagnostics, "SERIALIZABLE_STATE_FORBIDDEN", entryPath, "Credentials and provider protocol objects are forbidden.");
    }
    if (typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
      add(diagnostics, "SERIALIZABLE_STATE_FORBIDDEN", entryPath, "Attempt binding must contain JSON values only.");
    } else {
      inspectForbiddenState(entry, entryPath, diagnostics, seen);
    }
  }
  seen.delete(value);
}

function add(
  diagnostics: ProviderSessionAdmissionDiagnostic[],
  code: ProviderSessionAdmissionDiagnosticCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

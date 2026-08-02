import { createHash } from "node:crypto";

import type {
  AdapterCapabilityProfile,
  ProviderRequestIdempotencyEnforcement,
  ProviderRequestLookupKey,
} from "./types.js";

const LOOKUP_KEYS = new Set<ProviderRequestLookupKey>([
  "idempotencyKey",
  "requestId",
  "sessionId",
  "responseId",
]);
const STABLE_IDENTITY_KEYS = new Set<ProviderRequestLookupKey>([
  "requestId",
  "sessionId",
  "responseId",
]);
const ENFORCEMENTS = new Set<ProviderRequestIdempotencyEnforcement>([
  "provider",
  "gateway",
  "adapter",
  "controller-local",
  "none",
]);

export type ProviderRequestCapabilityBlocker =
  | "idempotency_not_accepted"
  | "idempotency_not_provider_enforced"
  | "restart_lookup_unavailable"
  | "required_lookup_key_unavailable"
  | "stable_identity_lookup_unavailable";

export interface ProviderRequestCapabilityRequirements {
  providerEnforcedIdempotency: boolean;
  restartLookupBy: readonly ProviderRequestLookupKey[];
  stableIdentityLookup: boolean;
}

export interface ProviderRequestCapabilityInspectionInput {
  providerId: string;
  capabilities: AdapterCapabilityProfile;
  lookupMethodAvailable: boolean;
  requirements: ProviderRequestCapabilityRequirements;
}

export interface ProviderRequestCapabilityInspection {
  schemaVersion: 1;
  artifactType: "dzupagent/provider-request-capability-inspection/v1";
  providerId: string;
  requirements: {
    providerEnforcedIdempotency: boolean;
    restartLookupBy: ProviderRequestLookupKey[];
    stableIdentityLookup: boolean;
  };
  declaredCapabilities: {
    idempotencyKey: {
      accepted: boolean;
      enforcement: ProviderRequestIdempotencyEnforcement;
      providerEnforced: boolean;
    };
    restartLookup: {
      declaredSupported: boolean;
      lookupMethodAvailable: boolean;
      supported: boolean;
      lookupBy: ProviderRequestLookupKey[];
      stableIdentityLookupBy: ProviderRequestLookupKey[];
    };
  };
  qualification: {
    accepted: boolean;
    blockers: ProviderRequestCapabilityBlocker[];
  };
  effects: {
    credentialReads: 0;
    networkAttempts: 0;
    providerDispatches: 0;
    providerSpendUsd: 0;
  };
  capabilitySha256: string;
  inspectionId: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedLookupKeys(value: unknown): ProviderRequestLookupKey[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value)]
    .filter((entry): entry is ProviderRequestLookupKey =>
      typeof entry === "string" && LOOKUP_KEYS.has(entry as ProviderRequestLookupKey),
    )
    .sort();
}

export function inspectProviderRequestCapabilities(
  input: ProviderRequestCapabilityInspectionInput,
): ProviderRequestCapabilityInspection {
  const providerId = String(input.providerId || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,127}$/u.test(providerId)) {
    throw new Error("provider request capability inspection requires a stable provider id");
  }

  const requestedLookupBy = normalizedLookupKeys(input.requirements.restartLookupBy);
  if (requestedLookupBy.length !== input.requirements.restartLookupBy.length) {
    throw new Error("provider request capability inspection requirements contain invalid lookup keys");
  }

  const declared = input.capabilities.providerRequestCorrelation;
  const accepted = declared?.idempotencyKey.accepted === true;
  const rawEnforcement = declared?.idempotencyKey.enforcement;
  const enforcement = ENFORCEMENTS.has(rawEnforcement as ProviderRequestIdempotencyEnforcement)
    ? (rawEnforcement as ProviderRequestIdempotencyEnforcement)
    : "none";
  const providerEnforced = accepted && enforcement === "provider";
  const lookupBy = normalizedLookupKeys(declared?.restartLookup.lookupBy);
  const declaredSupported = declared?.restartLookup.supported === true;
  const lookupMethodAvailable = input.lookupMethodAvailable === true;
  const supported = declaredSupported && lookupMethodAvailable && lookupBy.length > 0;
  const stableIdentityLookupBy = lookupBy.filter((key) => STABLE_IDENTITY_KEYS.has(key));

  const blockers: ProviderRequestCapabilityBlocker[] = [];
  if (!accepted) blockers.push("idempotency_not_accepted");
  if (input.requirements.providerEnforcedIdempotency && !providerEnforced) {
    blockers.push("idempotency_not_provider_enforced");
  }
  if (!supported) blockers.push("restart_lookup_unavailable");
  if (requestedLookupBy.some((key) => !lookupBy.includes(key))) {
    blockers.push("required_lookup_key_unavailable");
  }
  if (input.requirements.stableIdentityLookup && stableIdentityLookupBy.length === 0) {
    blockers.push("stable_identity_lookup_unavailable");
  }

  const requirements = {
    providerEnforcedIdempotency: input.requirements.providerEnforcedIdempotency === true,
    restartLookupBy: requestedLookupBy,
    stableIdentityLookup: input.requirements.stableIdentityLookup === true,
  };
  const declaredCapabilities = {
    idempotencyKey: { accepted, enforcement, providerEnforced },
    restartLookup: {
      declaredSupported,
      lookupMethodAvailable,
      supported,
      lookupBy,
      stableIdentityLookupBy,
    },
  };
  const qualification = { accepted: blockers.length === 0, blockers };
  const capabilitySha256 = sha256(JSON.stringify(declaredCapabilities));
  const body = {
    schemaVersion: 1 as const,
    artifactType: "dzupagent/provider-request-capability-inspection/v1" as const,
    providerId,
    requirements,
    declaredCapabilities,
    qualification,
    effects: {
      credentialReads: 0 as const,
      networkAttempts: 0 as const,
      providerDispatches: 0 as const,
      providerSpendUsd: 0 as const,
    },
    capabilitySha256,
  };
  return Object.freeze({ ...body, inspectionId: sha256(JSON.stringify(body)) });
}

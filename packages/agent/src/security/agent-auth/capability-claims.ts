/**
 * Capability-claim extraction and validation for signed agent messages.
 *
 * Pure parsing: returns either the normalized capabilities or a structured
 * failure descriptor (code + reason) that the caller maps into an
 * {@link AgentAuthResult} via its own `failureResult` helper. This keeps
 * result-shape construction in the composition root while isolating the
 * JSON-claim validation rules here.
 *
 * @module security/agent-auth/capability-claims
 */
import type { AgentAuthFailureCode } from "./types.js";

/** Structured failure descriptor emitted by capability-claim parsing. */
export interface CapabilityClaimFailure {
  code: AgentAuthFailureCode;
  reason: string;
}

/** Result of parsing a capability-claim payload. */
export type CapabilityClaimParseResult =
  | { kind: "ok"; capabilities: string[] }
  | { kind: "failure"; failure: CapabilityClaimFailure };

/**
 * Parse and validate the capability claims embedded in a signed message
 * payload (a JSON string).
 */
export function extractCapabilityClaims(
  payload: string
): CapabilityClaimParseResult {
  const fail = (
    code: AgentAuthFailureCode,
    reason: string
  ): { kind: "failure"; failure: CapabilityClaimFailure } => ({
    kind: "failure",
    failure: { code, reason },
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return fail(
      "malformed_capability_claim",
      "Capability claim payload must be valid UTF-8 JSON"
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail(
      "malformed_capability_claim",
      "Capability claim payload must be a JSON object"
    );
  }

  const record = parsed as Record<string, unknown>;
  const capabilitiesValue = record["capabilities"];
  if (capabilitiesValue === undefined) {
    return fail("missing_capability_claim", "Missing capabilities claim");
  }

  if (
    !Array.isArray(capabilitiesValue) ||
    capabilitiesValue.some((entry) => typeof entry !== "string")
  ) {
    return fail(
      "malformed_capability_claim",
      "Capabilities claim must be a string array"
    );
  }

  const normalizedCapabilities = capabilitiesValue.map((entry) => entry.trim());
  if (normalizedCapabilities.some((entry) => entry.length === 0)) {
    return fail(
      "malformed_capability_claim",
      "Capabilities claim contains empty entries"
    );
  }

  const expirationValue = record["capabilitiesExp"] ?? record["exp"];
  if (expirationValue !== undefined) {
    if (
      typeof expirationValue !== "number" ||
      !Number.isFinite(expirationValue)
    ) {
      return fail(
        "malformed_capability_claim",
        "Capability claim expiry must be a finite number"
      );
    }
    if (expirationValue <= Math.floor(Date.now() / 1000)) {
      return fail("expired_capability_claim", "Capability claim expired");
    }
  }

  return { kind: "ok", capabilities: normalizedCapabilities };
}

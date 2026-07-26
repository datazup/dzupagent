/**
 * Typed reader for the G01 authority envelope (ADR-0001 C3 / L2 adoption).
 *
 * `authority-classes.ts` gave the framework a *vocabulary* for authority. This
 * is where that vocabulary starts preventing a bug class: it takes an
 * untrusted envelope off the wire and either narrows it to a type whose
 * `authorityClass` is the exact union, or refuses it. Downstream code that
 * accepts an {@link AuthorityEnvelope} can no longer be handed an envelope
 * carrying an unrecognized or ineligible class, because there is no way to
 * construct one without going through here.
 *
 * The envelope itself is produced and signed by
 * `scripts/flow-prompt-lab/lib/g01-authority-envelope.js`, which remains the
 * source of truth. This reader deliberately does **not** re-implement that
 * verifier: signature checking, quorum, receipt/provenance binding, principal
 * digests and expiry all stay operator-side. Consistent with C3's scope, the
 * framework *reads* authority claims; it does not adjudicate them.
 *
 * What it does guarantee is the part a consumer cannot re-derive from types
 * alone: the claimed class is real vocabulary, and it is eligible to carry the
 * envelope's effect. Everything else is shape validation so that narrowing is
 * honest rather than a cast.
 */

import {
  checkEffectAuthorized,
  type AuthorityClass,
} from "./authority-classes.js";

/** Schema string stamped by the lab's envelope builder. */
export const G01_AUTHORITY_ENVELOPE_SCHEMA =
  "datazup/g01-authority-envelope/v1";

/**
 * The effect an authority envelope carries.
 *
 * Fixed rather than a parameter: this envelope exists for exactly one effect,
 * and both the lab's builder and its verifier hard-code the same value.
 */
const ENVELOPE_EFFECT = "authority_promotion_gate_envelope_only";

/** The campaign target an envelope binds its grant to. */
export interface AuthorityEnvelopeTarget {
  readonly repository: string;
  readonly baseCommit: string;
  readonly baseTree: string;
}

/** The certified principal that signed the envelope. */
export interface AuthorityEnvelopeSigner {
  readonly signerId: string;
  readonly publicKeySha256: string;
}

/**
 * A G01 authority envelope, narrowed.
 *
 * Only obtainable from {@link readAuthorityEnvelope}, so holding one is itself
 * evidence that the authority class is known and effect-eligible.
 */
export interface AuthorityEnvelope {
  readonly schema: typeof G01_AUTHORITY_ENVELOPE_SCHEMA;
  readonly campaignId: string;
  readonly gateId: string;
  readonly decision: string;
  readonly authorityGranted: boolean;
  /** The exact union — never a widened `string`. */
  readonly authorityClass: AuthorityClass;
  readonly target: AuthorityEnvelopeTarget;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly signer: AuthorityEnvelopeSigner;
}

export type AuthorityEnvelopeReadResult =
  | { readonly ok: true; readonly envelope: AuthorityEnvelope }
  | {
      readonly ok: false;
      readonly reason:
        | "not-an-envelope"
        | "unsupported-schema"
        | "malformed-field"
        | "unauthorized-class";
      readonly message: string;
    };

/**
 * Read an untrusted value as a G01 authority envelope.
 *
 * Returns a result rather than throwing, matching `checkEffectAuthorized` —
 * the framework's read of authority is a question, not an assertion. Fails
 * closed at every branch: anything not positively recognized is refused.
 */
export function readAuthorityEnvelope(
  value: unknown,
): AuthorityEnvelopeReadResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refuse("not-an-envelope", "Authority envelope must be an object");
  }

  const raw = value as Record<string, unknown>;

  // Schema first: a foreign envelope that happens to share field names must
  // not be read as this one.
  if (raw.schema !== G01_AUTHORITY_ENVELOPE_SCHEMA) {
    return refuse(
      "unsupported-schema",
      `Expected schema '${G01_AUTHORITY_ENVELOPE_SCHEMA}', got '${String(
        raw.schema,
      )}'`,
    );
  }

  for (const field of [
    "campaignId",
    "gateId",
    "decision",
    "issuedAt",
    "expiresAt",
    "nonce",
  ] as const) {
    if (!isNonEmptyString(raw[field])) {
      return refuse(
        "malformed-field",
        `Authority envelope field '${field}' must be a non-empty string`,
      );
    }
  }

  // Checked explicitly rather than coerced: the string 'false' is truthy, and
  // coercing it here would silently grant authority.
  if (typeof raw.authorityGranted !== "boolean") {
    return refuse(
      "malformed-field",
      "Authority envelope field 'authorityGranted' must be a boolean",
    );
  }

  const target = readTarget(raw.target);
  if (target === null) {
    return refuse(
      "malformed-field",
      "Authority envelope field 'target' must carry repository, baseCommit and baseTree",
    );
  }

  const signer = readSigner(raw.signer);
  if (signer === null) {
    return refuse(
      "malformed-field",
      "Authority envelope field 'signer' must carry signerId and publicKeySha256",
    );
  }

  // The C3 check, and the reason this reader exists. `checkEffectAuthorized`
  // fails closed on both an unknown class and a known-but-ineligible one
  // (notably `development-unverified`, which may observe but never bear
  // authority), so a single call covers both refusals.
  const authorized = checkEffectAuthorized({
    authorityClass: String(raw.authorityClass ?? ""),
    effect: ENVELOPE_EFFECT,
  });
  if (!authorized.ok) {
    return refuse("unauthorized-class", authorized.message);
  }

  return {
    ok: true,
    envelope: Object.freeze({
      schema: G01_AUTHORITY_ENVELOPE_SCHEMA,
      campaignId: raw.campaignId as string,
      gateId: raw.gateId as string,
      decision: raw.decision as string,
      authorityGranted: raw.authorityGranted,
      authorityClass: authorized.authorityClass,
      target,
      issuedAt: raw.issuedAt as string,
      expiresAt: raw.expiresAt as string,
      nonce: raw.nonce as string,
      signer,
    }),
  };
}

/** Copied, not aliased, so a later mutation of the input cannot reach inside. */
function readTarget(value: unknown): AuthorityEnvelopeTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (
    !isNonEmptyString(raw.repository) ||
    !isNonEmptyString(raw.baseCommit) ||
    !isNonEmptyString(raw.baseTree)
  ) {
    return null;
  }
  return Object.freeze({
    repository: raw.repository,
    baseCommit: raw.baseCommit,
    baseTree: raw.baseTree,
  });
}

function readSigner(value: unknown): AuthorityEnvelopeSigner | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (
    !isNonEmptyString(raw.signerId) ||
    !isNonEmptyString(raw.publicKeySha256)
  ) {
    return null;
  }
  return Object.freeze({
    signerId: raw.signerId,
    publicKeySha256: raw.publicKeySha256,
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

type AuthorityEnvelopeRefusal = Extract<
  AuthorityEnvelopeReadResult,
  { ok: false }
>;

function refuse(
  reason: AuthorityEnvelopeRefusal["reason"],
  message: string,
): AuthorityEnvelopeRefusal {
  return { ok: false, reason, message };
}

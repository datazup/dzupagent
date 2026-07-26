/**
 * G01 authority-class vocabulary (ADR-0001 C3 / L2).
 *
 * Every artifact the G01 pipeline stamps carries an `effect`; this contract
 * says which authority classes may honestly carry each effect. It is a *lift*
 * of `scripts/flow-prompt-lab/lib/g01-authority-classes.js`, which remains the
 * source of truth — the two are kept in parity by a cross-stack test.
 *
 * Scope is deliberately narrow: **vocabulary and effect-eligibility only**.
 * The Ed25519 broker, the signing CLI, and the enforcement daemon stay
 * repo-local operator tooling in `scripts`. The framework needs to *speak*
 * about authority (to type an envelope, to route a gate); it does not need to
 * *enforce* it. Accordingly `checkEffectAuthorized` is a pure predicate that
 * never throws, unlike the lab's `assertEffectAuthorized`.
 *
 * Sits in `identity/` beside `capability-checker` and `delegation-*`, which
 * model the same "who may do what" concern.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Properties that distinguish one authority class from another. */
export interface AuthorityClassProperties {
  /** Whether an artifact in this class requires a human in the loop. */
  readonly humanRequired: boolean;
  /** Whether this class may run without attended supervision. */
  readonly canRunUnattended: boolean;
}

export const AUTHORITY_CLASSES = Object.freeze({
  "autonomous-ai": Object.freeze({
    humanRequired: false,
    canRunUnattended: true,
  }),
  "externally-delegated-ai": Object.freeze({
    humanRequired: false,
    canRunUnattended: true,
  }),
  "human-approved": Object.freeze({
    humanRequired: true,
    canRunUnattended: false,
  }),
  "development-unverified": Object.freeze({
    humanRequired: false,
    canRunUnattended: true,
  }),
}) satisfies Readonly<Record<string, AuthorityClassProperties>>;

/** The exact authority-class union — not a widened `string`. */
export type AuthorityClass = keyof typeof AUTHORITY_CLASSES;

export const AUTHORITY_CLASS_NAMES = Object.freeze([
  "autonomous-ai",
  "externally-delegated-ai",
  "human-approved",
  "development-unverified",
]) as readonly AuthorityClass[];

/**
 * Classes that may carry a production authority claim.
 *
 * `development-unverified` is excluded by design: it never makes an honest
 * production claim, so it may observe (report-only effects) but never bear
 * authority.
 */
export const AUTHORITY_BEARING_CLASSES = Object.freeze([
  "autonomous-ai",
  "externally-delegated-ai",
  "human-approved",
]) as readonly AuthorityClass[];

// ---------------------------------------------------------------------------
// Effect eligibility
// ---------------------------------------------------------------------------

const EVERY_CLASS = AUTHORITY_CLASS_NAMES;

export const EFFECT_ELIGIBILITY = Object.freeze({
  agent_reviewed_gate_admission_policy_only: AUTHORITY_BEARING_CLASSES,
  deterministic_floor_report_only: EVERY_CLASS,
  "authenticated-review-evidence-only-no-authority": EVERY_CLASS,
  g01_certified_principals_registry_only: AUTHORITY_BEARING_CLASSES,
  authority_promotion_gate_envelope_only: AUTHORITY_BEARING_CLASSES,
}) satisfies Readonly<Record<string, readonly AuthorityClass[]>>;

/** The exact governed-effect union. */
export type GovernedEffect = keyof typeof EFFECT_ELIGIBILITY;

// ---------------------------------------------------------------------------
// Guards and the eligibility predicate
// ---------------------------------------------------------------------------

/**
 * `hasOwn` rather than `in`, so inherited Object properties (`toString`,
 * `constructor`) are not mistaken for vocabulary members.
 */
export function isAuthorityClass(value: string): value is AuthorityClass {
  return Object.hasOwn(AUTHORITY_CLASSES, value);
}

export function isGovernedEffect(value: string): value is GovernedEffect {
  return Object.hasOwn(EFFECT_ELIGIBILITY, value);
}

export function isAuthorityBearing(value: string): boolean {
  return isAuthorityClass(value) && AUTHORITY_BEARING_CLASSES.includes(value);
}

export type EffectAuthorizationResult =
  | {
      readonly ok: true;
      readonly authorityClass: AuthorityClass;
      readonly effect: GovernedEffect;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "unknown-authority-class"
        | "unmapped-effect"
        | "class-not-eligible";
      readonly message: string;
    };

/**
 * Answer whether a class may honestly carry an effect. Fails closed: unknown
 * classes and unmapped effects are refused rather than defaulted to permitted.
 *
 * Returns a result instead of throwing — this is the framework's *read* of the
 * vocabulary, not an enforcement point.
 */
export function checkEffectAuthorized(input: {
  readonly authorityClass: string;
  readonly effect: string;
}): EffectAuthorizationResult {
  const authorityClass = String(input.authorityClass ?? "");
  const effect = String(input.effect ?? "");

  if (!isAuthorityClass(authorityClass)) {
    return {
      ok: false,
      reason: "unknown-authority-class",
      message: `Unknown authority class '${authorityClass || "(empty)"}'`,
    };
  }
  if (!isGovernedEffect(effect)) {
    return {
      ok: false,
      reason: "unmapped-effect",
      message: `Effect '${
        effect || "(empty)"
      }' is outside the mapped G01 effect vocabulary`,
    };
  }
  if (!EFFECT_ELIGIBILITY[effect].includes(authorityClass)) {
    return {
      ok: false,
      reason: "class-not-eligible",
      message: `Authority class '${authorityClass}' is not eligible for effect '${effect}'`,
    };
  }
  return { ok: true, authorityClass, effect };
}

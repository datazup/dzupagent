/**
 * Provider subscription-quota observations (ADAPTER-QUOTA-OBSERVATION-MVP01).
 *
 * An observation is evidence, never a reservation or an authorization. It keeps
 * what the provider reported and nothing more: a window's duration, used
 * percentage and reset time are each nullable, and nothing here converts a
 * percentage into tokens or capacity. Freshness is fixed when the evidence is
 * first observed; reading it again (from a cache or store) never extends it.
 *
 * Subscription quota is deliberately separate from API billing, token usage
 * and context occupancy, which have their own contracts.
 *
 * Shape validation and assessment are pure: the caller supplies `now`.
 */

export const PROVIDER_QUOTA_SCHEMA = "dzupagent.providerQuota/v1" as const;

/** Window durations in minutes that providers currently document. */
export const PROVIDER_QUOTA_WINDOW_MINUTES = {
  fiveHours: 300,
  sevenDays: 10_080,
} as const;

/** Allowance for a host clock that runs slightly behind the observer's. */
export const PROVIDER_QUOTA_DEFAULT_MAX_CLOCK_SKEW_MS = 120_000;

export const PROVIDER_QUOTA_LIMITS = {
  maxObservationsPerReading: 32,
  maxWindowsPerObservation: 8,
  maxRefLength: 128,
} as const;

export const PROVIDER_QUOTA_COLLECTION_METHODS = [
  "request-response",
  "host-ingestion",
] as const;
export type ProviderQuotaCollectionMethod =
  (typeof PROVIDER_QUOTA_COLLECTION_METHODS)[number];

/**
 * The provider's own statement on whether usage is currently permitted,
 * separate from window percentages. `unknown` means the provider was asked or
 * normally reports it but gave no answer; `not-reported` means this provider
 * has no such statement. Only `allowed` and `not-reported` let windows decide.
 */
export const PROVIDER_QUOTA_USAGE_PERMISSIONS = [
  "allowed",
  "denied",
  "unknown",
  "not-reported",
] as const;
export type ProviderQuotaUsagePermission =
  (typeof PROVIDER_QUOTA_USAGE_PERMISSIONS)[number];

/**
 * Fixed, provider-independent reason codes. Provider-authored error text is
 * never carried; it is mapped to one of these.
 */
export const PROVIDER_QUOTA_REASON_CODES = [
  "no-observation",
  "stale",
  "future-observation",
  "malformed",
  "window-missing",
  "used-percent-missing",
  "reset-passed",
  "usage-not-allowed",
  "usage-permission-unknown",
  "pool-unknown",
  "unsupported",
  "timeout",
  "cancelled",
  "cleanup-failed",
  "rpc-error",
  "schema-invalid",
  "transport-failed",
] as const;
export type ProviderQuotaReasonCode =
  (typeof PROVIDER_QUOTA_REASON_CODES)[number];

/** One provider-reported window, identified by its duration, not its position. */
export interface ProviderQuotaWindow {
  /** Provider-native key or position, for example `primary` or `five_hour`. */
  readonly windowRef: string;
  /** Null when the provider did not state a duration; never inferred. */
  readonly durationMinutes: number | null;
  /** Null when the provider omitted it or sent a malformed value. */
  readonly usedPercent: number | null;
  /** ISO-8601 instant; null when the provider did not report one. */
  readonly resetsAt: string | null;
}

/** One metered bucket of one account or pool at one observation time. */
export interface ProviderQuotaObservation {
  readonly schema: typeof PROVIDER_QUOTA_SCHEMA;
  readonly provider: string;
  /**
   * Opaque account or subscription-pool reference supplied by the host. Null
   * means the identity is unknown, so the observation cannot establish
   * independent capacity for any pool.
   */
  readonly poolRef: string | null;
  /** Provider-metered bucket, when the provider distinguishes several. */
  readonly bucketRef: string | null;
  /** Model the bucket is scoped to, when the provider states one. */
  readonly modelScope: string | null;
  /** Fixed identifier of the collection route, for example an RPC method. */
  readonly source: string;
  readonly method: ProviderQuotaCollectionMethod;
  /** When the evidence was originally observed; unchanged by later reads. */
  readonly observedAt: string;
  /** After this instant the evidence needs re-observation. */
  readonly expiresAt: string;
  /** Provider-stated permission; percentages never override a denial. */
  readonly usagePermission: ProviderQuotaUsagePermission;
  readonly windows: readonly ProviderQuotaWindow[];
}

interface ProviderQuotaReadingBase {
  readonly schema: typeof PROVIDER_QUOTA_SCHEMA;
  readonly provider: string;
  readonly poolRef: string | null;
  /** When this read finished; distinct from each observation's `observedAt`. */
  readonly completedAt: string;
}

/** The result of one request for observations through the common interface. */
export type ProviderQuotaReading = ProviderQuotaReadingBase &
  (
    | {
        /** At least one observation was unexpired at `completedAt`. */
        readonly status: "current";
        readonly observations: readonly ProviderQuotaObservation[];
      }
    | {
        /** Every observation had expired at `completedAt`; kept for diagnosis. */
        readonly status: "stale";
        readonly reason: "stale";
        readonly observations: readonly ProviderQuotaObservation[];
      }
    | {
        readonly status: "unavailable" | "unsupported" | "failed";
        readonly reason: ProviderQuotaReasonCode;
        readonly observations: readonly [];
      }
  );

export type ProviderQuotaReadingStatus = ProviderQuotaReading["status"];

export type ProviderQuotaWindowState = "available" | "exhausted" | "unknown";

export interface ProviderQuotaWindowAssessment {
  readonly durationMinutes: number;
  readonly poolRef: string | null;
  readonly bucketRef: string | null;
  readonly state: ProviderQuotaWindowState;
  /** Reported value; zero stays zero. Null when unknown. */
  readonly usedPercent: number | null;
  readonly resetsAt: string | null;
  readonly observedAt: string | null;
  /** Null only for `available` and `exhausted`. */
  readonly reason: ProviderQuotaReasonCode | null;
}

export interface ProviderQuotaAssessmentOptions {
  /** ISO-8601 instant at which the evidence is judged. */
  readonly now: string;
  /** Every window the caller needs; each is assessed independently. */
  readonly requiredWindowMinutes: readonly number[];
  readonly maxClockSkewMs?: number;
}

const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;

/** Accepts only a canonical `Date#toISOString()` instant. */
export function isProviderQuotaInstant(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** A bounded, opaque, single-token reference; free text is not a reference. */
export function isProviderQuotaRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= PROVIDER_QUOTA_LIMITS.maxRefLength &&
    REF_PATTERN.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableRef(value: unknown): boolean {
  return value === null || isProviderQuotaRef(value);
}

function validateWindow(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path}: must be an object`];
  const issues: string[] = [];
  if (!isProviderQuotaRef(value.windowRef)) issues.push(`${path}.windowRef: invalid`);
  const duration = value.durationMinutes;
  if (
    duration !== null &&
    (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration <= 0)
  ) {
    issues.push(`${path}.durationMinutes: must be a positive integer or null`);
  }
  const used = value.usedPercent;
  if (
    used !== null &&
    (typeof used !== "number" || !Number.isFinite(used) || used < 0)
  ) {
    issues.push(`${path}.usedPercent: must be a finite non-negative number or null`);
  }
  if (value.resetsAt !== null && !isProviderQuotaInstant(value.resetsAt)) {
    issues.push(`${path}.resetsAt: must be an ISO instant or null`);
  }
  return issues;
}

/** Returns an empty list for a valid observation, otherwise issue strings. */
export function validateProviderQuotaObservation(value: unknown): readonly string[] {
  if (!isRecord(value)) return ["observation: must be an object"];
  const issues: string[] = [];
  if (value.schema !== PROVIDER_QUOTA_SCHEMA) issues.push("schema: unsupported");
  if (!isProviderQuotaRef(value.provider)) issues.push("provider: invalid");
  if (!nullableRef(value.poolRef)) issues.push("poolRef: invalid");
  if (!nullableRef(value.bucketRef)) issues.push("bucketRef: invalid");
  if (!nullableRef(value.modelScope)) issues.push("modelScope: invalid");
  if (!isProviderQuotaRef(value.source)) issues.push("source: invalid");
  if (
    !PROVIDER_QUOTA_COLLECTION_METHODS.includes(
      value.method as ProviderQuotaCollectionMethod,
    )
  ) {
    issues.push("method: unsupported");
  }
  const observed = isProviderQuotaInstant(value.observedAt);
  const expires = isProviderQuotaInstant(value.expiresAt);
  if (!observed) issues.push("observedAt: must be an ISO instant");
  if (!expires) issues.push("expiresAt: must be an ISO instant");
  if (
    observed &&
    expires &&
    Date.parse(value.expiresAt as string) <= Date.parse(value.observedAt as string)
  ) {
    issues.push("expiresAt: must be after observedAt");
  }
  if (
    !PROVIDER_QUOTA_USAGE_PERMISSIONS.includes(
      value.usagePermission as ProviderQuotaUsagePermission,
    )
  ) {
    issues.push("usagePermission: unsupported");
  }
  if (!Array.isArray(value.windows)) {
    issues.push("windows: must be an array");
  } else {
    if (value.windows.length > PROVIDER_QUOTA_LIMITS.maxWindowsPerObservation) {
      issues.push("windows: too many");
    }
    const durations = new Set<number>();
    value.windows.forEach((window, index) => {
      issues.push(...validateWindow(window, `windows[${index}]`));
      const duration = isRecord(window) ? window.durationMinutes : null;
      if (typeof duration === "number") {
        if (durations.has(duration)) {
          issues.push(`windows[${index}].durationMinutes: duplicate duration`);
        }
        durations.add(duration);
      }
    });
  }
  return issues;
}

/** Returns an empty list for a valid reading, otherwise issue strings. */
export function validateProviderQuotaReading(value: unknown): readonly string[] {
  if (!isRecord(value)) return ["reading: must be an object"];
  const issues: string[] = [];
  if (value.schema !== PROVIDER_QUOTA_SCHEMA) issues.push("schema: unsupported");
  if (!isProviderQuotaRef(value.provider)) issues.push("provider: invalid");
  if (!nullableRef(value.poolRef)) issues.push("poolRef: invalid");
  if (!isProviderQuotaInstant(value.completedAt)) {
    issues.push("completedAt: must be an ISO instant");
  }
  const observations = value.observations;
  if (!Array.isArray(observations)) return [...issues, "observations: must be an array"];
  if (observations.length > PROVIDER_QUOTA_LIMITS.maxObservationsPerReading) {
    issues.push("observations: too many");
  }
  observations.forEach((observation, index) => {
    for (const issue of validateProviderQuotaObservation(observation)) {
      issues.push(`observations[${index}].${issue}`);
    }
    if (isRecord(observation)) {
      if (observation.provider !== value.provider) {
        issues.push(`observations[${index}].provider: differs from reading`);
      }
      if (observation.poolRef !== value.poolRef) {
        issues.push(`observations[${index}].poolRef: differs from reading`);
      }
    }
  });
  switch (value.status) {
    case "current":
      if (observations.length === 0) issues.push("observations: required when current");
      if (Object.hasOwn(value, "reason")) issues.push("reason: not allowed when current");
      break;
    case "stale":
      if (observations.length === 0) issues.push("observations: required when stale");
      if (value.reason !== "stale") issues.push("reason: must be stale");
      break;
    case "unavailable":
    case "unsupported":
    case "failed":
      if (observations.length !== 0) issues.push("observations: must be empty");
      if (
        !PROVIDER_QUOTA_REASON_CODES.includes(value.reason as ProviderQuotaReasonCode)
      ) {
        issues.push("reason: unsupported");
      }
      break;
    default:
      issues.push("status: unsupported");
  }
  return issues;
}

function unknownWindow(
  durationMinutes: number,
  observation: ProviderQuotaObservation | null,
  reason: ProviderQuotaReasonCode,
  window?: ProviderQuotaWindow,
): ProviderQuotaWindowAssessment {
  return {
    durationMinutes,
    poolRef: observation?.poolRef ?? null,
    bucketRef: observation?.bucketRef ?? null,
    state: "unknown",
    usedPercent: window?.usedPercent ?? null,
    resetsAt: window?.resetsAt ?? null,
    observedAt: observation?.observedAt ?? null,
    reason,
  };
}

/**
 * Judges each required window of one observation at `now`. Only a valid,
 * unexpired, not-future observation of a known pool, whose provider has not
 * denied or left usage permission unknown, and whose window has the exact
 * duration, a reported used percentage and a reset time that has not passed,
 * can be `available` or `exhausted`; everything else is `unknown` with a
 * reason.
 */
export function assessProviderQuotaObservation(
  observation: ProviderQuotaObservation,
  options: ProviderQuotaAssessmentOptions,
): readonly ProviderQuotaWindowAssessment[] {
  const now = Date.parse(options.now);
  const skew = options.maxClockSkewMs ?? PROVIDER_QUOTA_DEFAULT_MAX_CLOCK_SKEW_MS;
  let observationReason: ProviderQuotaReasonCode | null = null;
  if (
    !isProviderQuotaInstant(options.now) ||
    validateProviderQuotaObservation(observation).length > 0
  ) {
    observationReason = "malformed";
  } else if (Date.parse(observation.observedAt) > now + Math.max(0, skew)) {
    observationReason = "future-observation";
  } else if (now >= Date.parse(observation.expiresAt)) {
    observationReason = "stale";
  } else if (observation.poolRef === null) {
    observationReason = "pool-unknown";
  } else if (observation.usagePermission === "denied") {
    observationReason = "usage-not-allowed";
  } else if (observation.usagePermission === "unknown") {
    observationReason = "usage-permission-unknown";
  }
  return options.requiredWindowMinutes.map((durationMinutes) => {
    if (observationReason !== null) {
      return unknownWindow(durationMinutes, observation, observationReason);
    }
    const window = observation.windows.find(
      (candidate) => candidate.durationMinutes === durationMinutes,
    );
    if (window === undefined) {
      return unknownWindow(durationMinutes, observation, "window-missing");
    }
    if (window.usedPercent === null) {
      return unknownWindow(durationMinutes, observation, "used-percent-missing", window);
    }
    if (window.resetsAt !== null && Date.parse(window.resetsAt) <= now) {
      return unknownWindow(durationMinutes, observation, "reset-passed", window);
    }
    return {
      durationMinutes,
      poolRef: observation.poolRef,
      bucketRef: observation.bucketRef,
      state: window.usedPercent >= 100 ? "exhausted" : "available",
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt,
      observedAt: observation.observedAt,
      reason: null,
    };
  });
}

/**
 * Judges a whole reading: one assessment per required window for each
 * observation, or, without usable observations, one `unknown` per required
 * window carrying the reading's reason.
 */
export function assessProviderQuotaReading(
  reading: ProviderQuotaReading,
  options: ProviderQuotaAssessmentOptions,
): readonly ProviderQuotaWindowAssessment[] {
  if (validateProviderQuotaReading(reading).length > 0) {
    return options.requiredWindowMinutes.map((minutes) =>
      unknownWindow(minutes, null, "malformed"),
    );
  }
  if (reading.status !== "current") {
    // A reading already judged stale stays stale, whatever its expiry says.
    if (reading.status === "stale") {
      return reading.observations.flatMap((observation) =>
        options.requiredWindowMinutes.map((minutes) =>
          unknownWindow(minutes, observation, "stale"),
        ),
      );
    }
    return options.requiredWindowMinutes.map((minutes) => ({
      ...unknownWindow(minutes, null, reading.reason),
      poolRef: reading.poolRef,
    }));
  }
  return reading.observations.flatMap((observation) =>
    assessProviderQuotaObservation(observation, options),
  );
}

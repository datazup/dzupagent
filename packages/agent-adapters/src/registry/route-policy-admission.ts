import type {
  ExecutionRouteCandidate,
  ExecutionRouteCandidateHealth,
  ExecutionRouteConstraint,
  ExecutionRouteCostClass,
  ExecutionRoutePolicy,
  ExecutionRoutePrivacyClass,
  ExecutionRouteRequirements,
  ExecutionRouteTransitionKind,
  ProviderAuthenticationMode,
  ProviderExecutionBackend,
} from "@dzupagent/runtime-contracts";

/**
 * Public admission boundary for external route-policy input.
 *
 * `ExecutionRoutePolicy` values produced inside the workspace are typed at the
 * source; input arriving from outside — HTTP bodies, persisted rows, files,
 * another process — is not. This boundary parses such input into the typed
 * policy domain instead of casting it: every field is validated, the admitted
 * value is rebuilt from the validated parts (never the input reference), and
 * the first rejection throws — there is no partial admission and no coercion.
 *
 * Each rejection carries a distinct fail-closed code plus the JSON-ish `path`
 * of the offending value. Codes are distinct per rejection *class*; entries of
 * a collection share their class code and are told apart by `path`
 * (`candidates[2].costClass`). Unknown keys are rejected everywhere, matching
 * the package's strict-allowlist convention for external input (SEC-C-01 in
 * `http/request-schemas.ts`); the boundary is hand-rolled rather than zod so
 * the dependency-free `./routing` entrypoint stays dependency-free and every
 * rejection keeps a stable machine-readable code.
 *
 * The boundary admits *shape*, deliberately not selection semantics: duplicate
 * candidate ids, unsupported strategies, missing seeds or malformed weight
 * tags remain the deterministic selector's own fail-closed admission pass, so
 * one vocabulary owns each concern.
 */

export type RoutePolicyAdmissionCode =
  | "ROUTE_POLICY_NOT_AN_OBJECT"
  | "ROUTE_POLICY_UNKNOWN_KEY"
  | "ROUTE_POLICY_INVALID_ID"
  | "ROUTE_POLICY_INVALID_REQUEST_ID"
  | "ROUTE_POLICY_INVALID_STRATEGY"
  | "ROUTE_POLICY_INVALID_CANDIDATES"
  | "ROUTE_POLICY_INVALID_CANDIDATE_ID"
  | "ROUTE_POLICY_INVALID_CANDIDATE_FIELD"
  | "ROUTE_POLICY_INVALID_HARD_CONSTRAINTS"
  | "ROUTE_POLICY_INVALID_HARD_CONSTRAINT"
  | "ROUTE_POLICY_INVALID_PREFERENCE_ORDER"
  | "ROUTE_POLICY_INVALID_FALLBACK"
  | "ROUTE_POLICY_INVALID_MAX_SELECTION_LATENCY"
  | "ROUTE_POLICY_INVALID_ORIGIN_CANDIDATE_ID"
  | "ROUTE_POLICY_INVALID_APPROVED_TRANSITIONS"
  | "ROUTE_POLICY_INVALID_REQUIREMENTS"
  | "ROUTE_POLICY_INVALID_REQUIREMENTS_FIELD";

/** Fail-closed admission error: nothing is admitted once one is raised. */
export class RoutePolicyAdmissionError extends Error {
  readonly code: RoutePolicyAdmissionCode;
  /** JSON-ish location of the rejected value, e.g. `candidates[2].costClass`. */
  readonly path: string;

  constructor(code: RoutePolicyAdmissionCode, path: string, message: string) {
    super(message);
    this.name = "RoutePolicyAdmissionError";
    this.code = code;
    this.path = path;
  }
}

/** Generous upper bounds; external input never gets unbounded strings/lists. */
const MAX_TEXT_LENGTH = 1000;
const MAX_LIST_LENGTH = 500;

const ROUTE_STRATEGIES = [
  "fixed",
  "rule",
  "weighted",
  "hash",
  "round-robin",
  "llm-rank",
] as const satisfies readonly ExecutionRoutePolicy["strategy"][];

const ROUTE_FALLBACKS = [
  "none",
  "ordered-compatible",
] as const satisfies readonly ExecutionRoutePolicy["fallback"][];

const TRANSITION_KINDS = [
  "subscription-to-api",
  "local-to-remote",
  "identity-change",
  "privacy-downgrade",
  "higher-cost",
] as const satisfies readonly ExecutionRouteTransitionKind[];

const CONSTRAINT_KINDS = [
  "provider",
  "tags",
  "capability",
  "policy",
] as const satisfies readonly ExecutionRouteConstraint["kind"][];

const COST_CLASSES = [
  "free",
  "low",
  "medium",
  "high",
] as const satisfies readonly ExecutionRouteCostClass[];

const PRIVACY_CLASSES = [
  "device",
  "private-network",
  "provider",
  "public",
] as const satisfies readonly ExecutionRoutePrivacyClass[];

const EXECUTION_BACKENDS = [
  "cli",
  "local-model",
  "sdk",
  "api",
  "remote",
] as const satisfies readonly ProviderExecutionBackend[];

const AUTH_MODES = [
  "subscription_cli",
  "api_key",
  "workload_identity",
  "local_model",
] as const satisfies readonly ProviderAuthenticationMode[];

const LOCALITIES = ["local", "remote"] as const;
const ACCESS_CLASSES = ["local", "subscription", "api"] as const;

const HEALTH_STATUSES = [
  "healthy",
  "degraded",
  "unhealthy",
  "unknown",
] as const satisfies readonly ExecutionRouteCandidateHealth["status"][];

const POLICY_KEYS = [
  "id",
  "requestId",
  "strategy",
  "candidates",
  "hardConstraints",
  "preferenceOrder",
  "fallback",
  "maxSelectionLatencyMs",
  "originCandidateId",
  "approvedTransitions",
  "requirements",
] as const;

const CANDIDATE_KEYS = [
  "id",
  "provider",
  "backend",
  "authMode",
  "agentHost",
  "model",
  "profileRef",
  "authSourceRef",
  "authAvailable",
  "backendAvailable",
  "modelAvailable",
  "health",
  "costClass",
  "privacyClass",
  "locality",
  "accessClass",
  "policyCompatible",
  "tags",
  "capabilities",
] as const;

const HEALTH_KEYS = ["status", "checkedAt", "reason"] as const;

const CONSTRAINT_KEYS = ["kind", "values"] as const;

const REQUIREMENT_KEYS = [
  "providers",
  "backends",
  "agentHosts",
  "models",
  "capabilities",
  "profileRefs",
  "authSourceRefs",
  "maximumCostClass",
  "minimumPrivacyClass",
  "requireHealthy",
] as const;

/**
 * Parses unvalidated input into a typed `ExecutionRoutePolicy`, or throws a
 * `RoutePolicyAdmissionError` naming the first rejected value. The returned
 * policy is built from the validated parts — freshly allocated objects and
 * arrays — so no unvalidated reference from the input survives admission.
 */
export function admitExecutionRoutePolicy(
  input: unknown,
): ExecutionRoutePolicy {
  const record = requireRecord(input, "ROUTE_POLICY_NOT_AN_OBJECT", "policy");
  rejectUnknownKeys(record, POLICY_KEYS, "policy");

  const candidatesInput = record.candidates;
  if (
    !Array.isArray(candidatesInput) ||
    candidatesInput.length > MAX_LIST_LENGTH
  ) {
    reject(
      "ROUTE_POLICY_INVALID_CANDIDATES",
      "candidates",
      `candidates must be an array of at most ${MAX_LIST_LENGTH} candidates`,
    );
  }

  const policy: {
    -readonly [K in keyof ExecutionRoutePolicy]: ExecutionRoutePolicy[K];
  } = {
    id: requireText(record.id, "ROUTE_POLICY_INVALID_ID", "id"),
    requestId: requireText(
      record.requestId,
      "ROUTE_POLICY_INVALID_REQUEST_ID",
      "requestId",
    ),
    strategy: requireEnum(
      record.strategy,
      ROUTE_STRATEGIES,
      "ROUTE_POLICY_INVALID_STRATEGY",
      "strategy",
    ),
    candidates: candidatesInput.map((candidate, index) =>
      admitCandidate(candidate, `candidates[${index}]`),
    ),
    hardConstraints: admitHardConstraints(record.hardConstraints),
    preferenceOrder: requireTextArray(
      record.preferenceOrder,
      "ROUTE_POLICY_INVALID_PREFERENCE_ORDER",
      "preferenceOrder",
    ),
    fallback: requireEnum(
      record.fallback,
      ROUTE_FALLBACKS,
      "ROUTE_POLICY_INVALID_FALLBACK",
      "fallback",
    ),
    maxSelectionLatencyMs: requirePositiveInteger(
      record.maxSelectionLatencyMs,
      "ROUTE_POLICY_INVALID_MAX_SELECTION_LATENCY",
      "maxSelectionLatencyMs",
    ),
  };

  if (record.originCandidateId !== undefined) {
    policy.originCandidateId = requireText(
      record.originCandidateId,
      "ROUTE_POLICY_INVALID_ORIGIN_CANDIDATE_ID",
      "originCandidateId",
    );
  }
  if (record.approvedTransitions !== undefined) {
    policy.approvedTransitions = requireEnumArray(
      record.approvedTransitions,
      TRANSITION_KINDS,
      "ROUTE_POLICY_INVALID_APPROVED_TRANSITIONS",
      "approvedTransitions",
    );
  }
  if (record.requirements !== undefined) {
    policy.requirements = admitRequirements(record.requirements);
  }

  return policy;
}

function admitCandidate(input: unknown, path: string): ExecutionRouteCandidate {
  const record = requireRecord(
    input,
    "ROUTE_POLICY_INVALID_CANDIDATE_FIELD",
    path,
  );
  rejectUnknownKeys(record, CANDIDATE_KEYS, path);

  const candidate: {
    -readonly [K in keyof ExecutionRouteCandidate]: ExecutionRouteCandidate[K];
  } = {
    id: requireText(
      record.id,
      "ROUTE_POLICY_INVALID_CANDIDATE_ID",
      `${path}.id`,
    ),
  };

  copyText(candidate, record, "provider", path);
  copyEnum(candidate, record, "backend", EXECUTION_BACKENDS, path);
  copyEnum(candidate, record, "authMode", AUTH_MODES, path);
  copyText(candidate, record, "agentHost", path);
  copyText(candidate, record, "model", path);
  copyText(candidate, record, "profileRef", path);
  copyText(candidate, record, "authSourceRef", path);
  copyBoolean(candidate, record, "authAvailable", path);
  copyBoolean(candidate, record, "backendAvailable", path);
  copyBoolean(candidate, record, "modelAvailable", path);
  copyEnum(candidate, record, "costClass", COST_CLASSES, path);
  copyEnum(candidate, record, "privacyClass", PRIVACY_CLASSES, path);
  copyEnum(candidate, record, "locality", LOCALITIES, path);
  copyEnum(candidate, record, "accessClass", ACCESS_CLASSES, path);
  copyBoolean(candidate, record, "policyCompatible", path);

  if (record.health !== undefined) {
    candidate.health = admitHealth(record.health, `${path}.health`);
  }
  if (record.tags !== undefined) {
    candidate.tags = requireTextArray(
      record.tags,
      "ROUTE_POLICY_INVALID_CANDIDATE_FIELD",
      `${path}.tags`,
    );
  }
  if (record.capabilities !== undefined) {
    candidate.capabilities = requireTextArray(
      record.capabilities,
      "ROUTE_POLICY_INVALID_CANDIDATE_FIELD",
      `${path}.capabilities`,
    );
  }

  return candidate;
}

function admitHealth(
  input: unknown,
  path: string,
): ExecutionRouteCandidateHealth {
  const record = requireRecord(
    input,
    "ROUTE_POLICY_INVALID_CANDIDATE_FIELD",
    path,
  );
  rejectUnknownKeys(record, HEALTH_KEYS, path);

  const health: {
    -readonly [K in keyof ExecutionRouteCandidateHealth]: ExecutionRouteCandidateHealth[K];
  } = {
    status: requireEnum(
      record.status,
      HEALTH_STATUSES,
      "ROUTE_POLICY_INVALID_CANDIDATE_FIELD",
      `${path}.status`,
    ),
  };
  if (record.checkedAt !== undefined) {
    health.checkedAt = requireText(
      record.checkedAt,
      "ROUTE_POLICY_INVALID_CANDIDATE_FIELD",
      `${path}.checkedAt`,
    );
  }
  if (record.reason !== undefined) {
    health.reason = requireText(
      record.reason,
      "ROUTE_POLICY_INVALID_CANDIDATE_FIELD",
      `${path}.reason`,
    );
  }
  return health;
}

function admitHardConstraints(
  input: unknown,
): readonly ExecutionRouteConstraint[] {
  if (!Array.isArray(input) || input.length > MAX_LIST_LENGTH) {
    reject(
      "ROUTE_POLICY_INVALID_HARD_CONSTRAINTS",
      "hardConstraints",
      `hardConstraints must be an array of at most ${MAX_LIST_LENGTH} constraints`,
    );
  }
  return input.map((constraint, index) => {
    const path = `hardConstraints[${index}]`;
    const record = requireRecord(
      constraint,
      "ROUTE_POLICY_INVALID_HARD_CONSTRAINT",
      path,
    );
    rejectUnknownKeys(record, CONSTRAINT_KEYS, path);
    return {
      kind: requireEnum(
        record.kind,
        CONSTRAINT_KINDS,
        "ROUTE_POLICY_INVALID_HARD_CONSTRAINT",
        `${path}.kind`,
      ),
      values: requireTextArray(
        record.values,
        "ROUTE_POLICY_INVALID_HARD_CONSTRAINT",
        `${path}.values`,
      ),
    };
  });
}

function admitRequirements(input: unknown): ExecutionRouteRequirements {
  const record = requireRecord(
    input,
    "ROUTE_POLICY_INVALID_REQUIREMENTS",
    "requirements",
  );
  rejectUnknownKeys(record, REQUIREMENT_KEYS, "requirements");

  const requirements: {
    -readonly [K in keyof ExecutionRouteRequirements]: ExecutionRouteRequirements[K];
  } = {};

  for (const key of [
    "providers",
    "agentHosts",
    "models",
    "capabilities",
    "profileRefs",
    "authSourceRefs",
  ] as const) {
    if (record[key] !== undefined) {
      requirements[key] = requireTextArray(
        record[key],
        "ROUTE_POLICY_INVALID_REQUIREMENTS_FIELD",
        `requirements.${key}`,
      );
    }
  }
  if (record.backends !== undefined) {
    requirements.backends = requireEnumArray(
      record.backends,
      EXECUTION_BACKENDS,
      "ROUTE_POLICY_INVALID_REQUIREMENTS_FIELD",
      "requirements.backends",
    );
  }
  if (record.maximumCostClass !== undefined) {
    requirements.maximumCostClass = requireEnum(
      record.maximumCostClass,
      COST_CLASSES,
      "ROUTE_POLICY_INVALID_REQUIREMENTS_FIELD",
      "requirements.maximumCostClass",
    );
  }
  if (record.minimumPrivacyClass !== undefined) {
    requirements.minimumPrivacyClass = requireEnum(
      record.minimumPrivacyClass,
      PRIVACY_CLASSES,
      "ROUTE_POLICY_INVALID_REQUIREMENTS_FIELD",
      "requirements.minimumPrivacyClass",
    );
  }
  if (record.requireHealthy !== undefined) {
    if (typeof record.requireHealthy !== "boolean") {
      reject(
        "ROUTE_POLICY_INVALID_REQUIREMENTS_FIELD",
        "requirements.requireHealthy",
        "requireHealthy must be a boolean",
      );
    }
    requirements.requireHealthy = record.requireHealthy;
  }

  return requirements;
}

function requireRecord(
  value: unknown,
  code: RoutePolicyAdmissionCode,
  path: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject(code, path, `${path} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      reject(
        "ROUTE_POLICY_UNKNOWN_KEY",
        `${path}.${key}`,
        `Unknown key "${key}" at ${path}; external route-policy input is a strict allowlist`,
      );
    }
  }
}

function requireText(
  value: unknown,
  code: RoutePolicyAdmissionCode,
  path: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TEXT_LENGTH
  ) {
    reject(
      code,
      path,
      `${path} must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`,
    );
  }
  return value;
}

function requireTextArray(
  value: unknown,
  code: RoutePolicyAdmissionCode,
  path: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_LENGTH) {
    reject(
      code,
      path,
      `${path} must be an array of at most ${MAX_LIST_LENGTH} strings`,
    );
  }
  return value.map((entry, index) =>
    requireText(entry, code, `${path}[${index}]`),
  );
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  code: RoutePolicyAdmissionCode,
  path: string,
): T {
  if (
    typeof value !== "string" ||
    !(allowed as readonly string[]).includes(value)
  ) {
    reject(code, path, `${path} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function requireEnumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  code: RoutePolicyAdmissionCode,
  path: string,
): readonly T[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_LENGTH) {
    reject(
      code,
      path,
      `${path} must be an array of at most ${MAX_LIST_LENGTH} entries`,
    );
  }
  return value.map((entry, index) =>
    requireEnum(entry, allowed, code, `${path}[${index}]`),
  );
}

function requirePositiveInteger(
  value: unknown,
  code: RoutePolicyAdmissionCode,
  path: string,
): number {
  // Parse, never coerce: a numeric string, NaN, Infinity, a float or a
  // non-positive value all fail closed instead of being normalized.
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    reject(code, path, `${path} must be a positive safe integer`);
  }
  return value;
}

type TextKeys =
  | "provider"
  | "agentHost"
  | "model"
  | "profileRef"
  | "authSourceRef";

function copyText(
  candidate: { -readonly [K in TextKeys]?: string },
  record: Record<string, unknown>,
  key: TextKeys,
  path: string,
): void {
  if (record[key] !== undefined) {
    candidate[key] = requireText(
      record[key],
      "ROUTE_POLICY_INVALID_CANDIDATE_FIELD",
      `${path}.${key}`,
    );
  }
}

type BooleanKeys =
  | "authAvailable"
  | "backendAvailable"
  | "modelAvailable"
  | "policyCompatible";

function copyBoolean(
  candidate: { -readonly [K in BooleanKeys]?: boolean },
  record: Record<string, unknown>,
  key: BooleanKeys,
  path: string,
): void {
  if (record[key] !== undefined) {
    if (typeof record[key] !== "boolean") {
      reject(
        "ROUTE_POLICY_INVALID_CANDIDATE_FIELD",
        `${path}.${key}`,
        `${path}.${key} must be a boolean`,
      );
    }
    candidate[key] = record[key];
  }
}

function copyEnum<
  K extends
    | "backend"
    | "authMode"
    | "costClass"
    | "privacyClass"
    | "locality"
    | "accessClass",
>(
  candidate: { -readonly [P in K]?: ExecutionRouteCandidate[P] },
  record: Record<string, unknown>,
  key: K,
  allowed: readonly NonNullable<ExecutionRouteCandidate[K]>[],
  path: string,
): void {
  if (record[key] !== undefined) {
    candidate[key] = requireEnum(
      record[key],
      allowed as readonly (NonNullable<ExecutionRouteCandidate[K]> & string)[],
      "ROUTE_POLICY_INVALID_CANDIDATE_FIELD",
      `${path}.${key}`,
    );
  }
}

function reject(
  code: RoutePolicyAdmissionCode,
  path: string,
  message: string,
): never {
  throw new RoutePolicyAdmissionError(code, path, message);
}

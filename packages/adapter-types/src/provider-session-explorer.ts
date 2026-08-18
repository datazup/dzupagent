/**
 * Provider Session Explorer contracts shared by framework adapters and product
 * consumers. These records are browser-safe metadata only: provider-native
 * identifiers may be used for server-side correlation but must not be stored
 * in browser tab persistence or mixed across installation boundaries.
 */

export const PROVIDER_CATALOG_SCHEMA_VERSION = "codev/provider-catalog/v2" as const;

export type ProviderSessionExplorerKnownProviderId =
  | "codex"
  | "claude"
  | "gemini"
  | "qwen"
  | "goose"
  | "crush";

export interface ProviderInstallationIdentityV2 {
  readonly providerId: string;
  readonly installationId: string;
  readonly backendId: string;
}

export interface CanonicalAgentSessionIdentityV2
  extends ProviderInstallationIdentityV2 {
  readonly sessionId: string;
  readonly nativeSessionId?: string;
  readonly managedSessionId?: string;
  readonly sourceObservationIds: readonly string[];
}

export type SessionContinuationMode =
  | "native_resume"
  | "managed_context"
  | "fork_context"
  | "read_only"
  | "unsupported"
  | "unknown";

export interface SessionContinuationDecision {
  readonly mode: SessionContinuationMode;
  readonly reasonCode: string;
  readonly explanation: string;
  readonly providerCapabilitySource?: string;
  readonly qualifiedVersion?: string;
  readonly bindingGeneration?: number;
  readonly requiresClaim?: boolean;
  readonly requiresFreshAuthorization: boolean;
}

export type ProviderCapabilitySupport = "supported" | "unsupported" | "unknown";
export type ProviderCatalogConfidence = "authoritative" | "observed" | "unverified";
export type ProviderCatalogCompleteness = "account" | "runtime" | "aliases" | "partial";
export type ProviderEvidenceFreshness = "fresh" | "stale" | "unknown";

export interface CapabilityEvidence {
  readonly support: ProviderCapabilitySupport;
  readonly source: string;
  readonly observedAt: string;
  readonly expiresAt?: string;
  readonly qualifiedVersion?: string;
  readonly constraints?: Readonly<Record<string, unknown>>;
}

export interface ProviderEffortCapability {
  readonly effortId: string;
  readonly displayName: string;
  readonly nativeValue: string;
  readonly source: string;
  readonly confidence: ProviderCatalogConfidence;
}

export type ProviderEffortCapabilityV2 = ProviderEffortCapability;

export interface ProviderModelCapabilityV2 {
  readonly modelId: string;
  readonly displayName: string;
  readonly isDefault: boolean;
  readonly hidden?: boolean;
  readonly deprecated?: boolean;
  readonly efforts: readonly ProviderEffortCapability[];
  readonly defaultEffortId?: string;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly capabilityConstraints?: Readonly<Record<string, unknown>>;
}

export interface ProviderCatalogSnapshotV2 extends ProviderInstallationIdentityV2 {
  readonly schemaVersion: typeof PROVIDER_CATALOG_SCHEMA_VERSION;
  readonly source: string;
  readonly sourceRevision?: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly fingerprint: string;
  readonly authenticated: boolean | null;
  readonly completeness: ProviderCatalogCompleteness;
  readonly confidence: ProviderCatalogConfidence;
  readonly models: readonly ProviderModelCapabilityV2[];
  readonly capabilities: Readonly<Record<string, CapabilityEvidence>>;
  readonly warnings: readonly string[];
}

/** Minimal common projection; products may extend it with governed lineage. */
export interface ProviderSessionObservationV2 {
  readonly canonicalIdentity: CanonicalAgentSessionIdentityV2;
  readonly observedAt: string;
  readonly continuation: SessionContinuationDecision;
}

export interface ProviderSessionExplorerDiagnostic {
  readonly path: string;
  readonly code:
    | "INVALID_IDENTITY"
    | "INVALID_PUBLIC_DATA"
    | "INVALID_TIMESTAMP"
    | "INVALID_CATALOG"
    | "INVALID_CONTINUATION";
  readonly message: string;
}

export interface ProviderSessionExplorerConformanceResult {
  readonly valid: boolean;
  readonly diagnostics: readonly ProviderSessionExplorerDiagnostic[];
}

const ID_MAX = 512;
const TEXT_MAX = 2_000;
const MAX_DEPTH = 8;
const MAX_ITEMS = 1_000;
const FUTURE_SKEW_MS = 5 * 60 * 1_000;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const HOST_PATH = /(?:^|[\s"'`([{=,:;])(?:\/(?!\/)|~[\\/]|[a-zA-Z]:[\\/]|\\\\)/u;
const FILE_URI = /(?:^|[\s"'`([{=,:;])file:\/{2,}/iu;
const SECRET_VALUE =
  /(?:authorization\s*[:=]|bearer\s+[a-z0-9._~+/=-]+|(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|private[_ -]?key|cookie)\s*[:=])/iu;
const SECRET_KEY =
  /(?:authorization|api.?key|access.?key|token|secret|password|private.?key|credential|cookie|raw.?env|raw.?output|workspace.?path)/iu;

function record(input: unknown): Record<string, unknown> | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null
    ? (input as Record<string, unknown>)
    : null;
}

function safeString(input: unknown, max = ID_MAX): input is string {
  return (
    typeof input === "string" &&
    input.length > 0 &&
    input.length <= max &&
    input === input.trim() &&
    !CONTROL.test(input) &&
    !HOST_PATH.test(input) &&
    !FILE_URI.test(input)
  );
}

function safeText(input: unknown): input is string {
  return safeString(input, TEXT_MAX) && !SECRET_VALUE.test(input);
}

function safePublicValue(input: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return false;
  if (input === null || typeof input === "boolean") return true;
  if (typeof input === "number") return Number.isFinite(input);
  if (typeof input === "string") return safeText(input);
  if (Array.isArray(input)) {
    return input.length <= MAX_ITEMS && input.every((item) => safePublicValue(item, depth + 1));
  }
  const value = record(input);
  if (!value || Object.keys(value).length > MAX_ITEMS) return false;
  return Object.entries(value).every(
    ([key, nested]) => safeString(key, 128) && !SECRET_KEY.test(key) && safePublicValue(nested, depth + 1),
  );
}

function isoMillis(input: unknown): number | null {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(input)) return null;
  const value = Date.parse(input);
  return Number.isFinite(value) ? value : null;
}

function unexpectedKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const set = new Set(allowed);
  return Object.keys(value).filter((key) => !set.has(key));
}

function diagnostic(
  code: ProviderSessionExplorerDiagnostic["code"],
  path: string,
  message: string,
): ProviderSessionExplorerDiagnostic {
  return { code, path, message };
}

export function validateProviderInstallationIdentityV2(
  input: unknown,
): ProviderSessionExplorerConformanceResult {
  const value = record(input);
  const diagnostics: ProviderSessionExplorerDiagnostic[] = [];
  if (!value) {
    diagnostics.push(diagnostic("INVALID_IDENTITY", "", "Identity must be a plain object."));
  } else {
    for (const field of ["providerId", "installationId", "backendId"] as const) {
      if (!safeString(value[field])) {
        diagnostics.push(diagnostic("INVALID_IDENTITY", field, `${field} must be a browser-safe opaque id.`));
      }
    }
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

export function validateSessionContinuationDecision(
  input: unknown,
): ProviderSessionExplorerConformanceResult {
  const value = record(input);
  const diagnostics: ProviderSessionExplorerDiagnostic[] = [];
  if (!value) {
    return {
      valid: false,
      diagnostics: [diagnostic("INVALID_CONTINUATION", "", "Continuation must be a plain object.")],
    };
  }
  const allowedKeys = [
    "mode",
    "reasonCode",
    "explanation",
    "providerCapabilitySource",
    "qualifiedVersion",
    "bindingGeneration",
    "requiresClaim",
    "requiresFreshAuthorization",
  ] as const;
  if (unexpectedKeys(value, allowedKeys).length > 0) {
    diagnostics.push(
      diagnostic("INVALID_CONTINUATION", "", "Continuation contains an unknown field."),
    );
  }
  const modes: readonly SessionContinuationMode[] = [
    "native_resume",
    "managed_context",
    "fork_context",
    "read_only",
    "unsupported",
    "unknown",
  ];
  if (!modes.includes(value["mode"] as SessionContinuationMode)) {
    diagnostics.push(diagnostic("INVALID_CONTINUATION", "mode", "Continuation mode is not recognized."));
  }
  if (!safeString(value["reasonCode"])) {
    diagnostics.push(diagnostic("INVALID_CONTINUATION", "reasonCode", "A safe reason code is required."));
  }
  if (!safeText(value["explanation"])) {
    diagnostics.push(diagnostic("INVALID_PUBLIC_DATA", "explanation", "Explanation is not browser-safe."));
  }
  if (
    value["providerCapabilitySource"] !== undefined &&
    !safeString(value["providerCapabilitySource"])
  ) {
    diagnostics.push(
      diagnostic(
        "INVALID_PUBLIC_DATA",
        "providerCapabilitySource",
        "Capability source is not browser-safe.",
      ),
    );
  }
  if (value["qualifiedVersion"] !== undefined && !safeString(value["qualifiedVersion"])) {
    diagnostics.push(
      diagnostic("INVALID_PUBLIC_DATA", "qualifiedVersion", "Qualified version is not browser-safe."),
    );
  }
  if (
    value["bindingGeneration"] !== undefined &&
    (!Number.isInteger(value["bindingGeneration"]) || Number(value["bindingGeneration"]) < 0)
  ) {
    diagnostics.push(
      diagnostic(
        "INVALID_CONTINUATION",
        "bindingGeneration",
        "Binding generation must be a non-negative integer.",
      ),
    );
  }
  if (value["requiresClaim"] !== undefined && typeof value["requiresClaim"] !== "boolean") {
    diagnostics.push(
      diagnostic("INVALID_CONTINUATION", "requiresClaim", "Claim requirement must be boolean."),
    );
  }
  if (typeof value["requiresFreshAuthorization"] !== "boolean") {
    diagnostics.push(
      diagnostic(
        "INVALID_CONTINUATION",
        "requiresFreshAuthorization",
        "Fresh-authorization requirement must be boolean.",
      ),
    );
  }
  const mode = value["mode"];
  if (["native_resume", "managed_context", "fork_context", "unknown"].includes(String(mode)) && value["requiresFreshAuthorization"] !== true) {
    diagnostics.push(diagnostic("INVALID_CONTINUATION", "requiresFreshAuthorization", "Control requires fresh authorization."));
  }
  if (mode === "native_resume") {
    if (!safeString(value["providerCapabilitySource"])) {
      diagnostics.push(diagnostic("INVALID_CONTINUATION", "providerCapabilitySource", "Native resume requires capability evidence."));
    }
    if (!safeString(value["qualifiedVersion"])) {
      diagnostics.push(diagnostic("INVALID_CONTINUATION", "qualifiedVersion", "Native resume requires a qualified version."));
    }
    if (!Number.isInteger(value["bindingGeneration"]) || Number(value["bindingGeneration"]) < 0) {
      diagnostics.push(diagnostic("INVALID_CONTINUATION", "bindingGeneration", "Native resume requires a non-negative binding generation."));
    }
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

function validateEvidence(input: unknown, path: string): ProviderSessionExplorerDiagnostic[] {
  const value = record(input);
  if (!value) return [diagnostic("INVALID_CATALOG", path, "Capability evidence must be an object.")];
  const diagnostics: ProviderSessionExplorerDiagnostic[] = [];
  if (
    unexpectedKeys(value, [
      "support",
      "source",
      "observedAt",
      "expiresAt",
      "qualifiedVersion",
      "constraints",
    ]).length > 0
  ) {
    diagnostics.push(diagnostic("INVALID_CATALOG", path, "Capability evidence contains an unknown field."));
  }
  const support = value["support"];
  if (!(["supported", "unsupported", "unknown"] as const).includes(support as ProviderCapabilitySupport)) {
    diagnostics.push(diagnostic("INVALID_CATALOG", `${path}.support`, "Capability support is invalid."));
  }
  if (!safeString(value["source"])) diagnostics.push(diagnostic("INVALID_PUBLIC_DATA", `${path}.source`, "Evidence source is unsafe."));
  if (value["qualifiedVersion"] !== undefined && !safeString(value["qualifiedVersion"])) {
    diagnostics.push(
      diagnostic("INVALID_PUBLIC_DATA", `${path}.qualifiedVersion`, "Qualified version is unsafe."),
    );
  }
  const observed = isoMillis(value["observedAt"]);
  const expires = value["expiresAt"] === undefined ? null : isoMillis(value["expiresAt"]);
  if (observed === null) diagnostics.push(diagnostic("INVALID_TIMESTAMP", `${path}.observedAt`, "Observed timestamp is invalid."));
  if (value["expiresAt"] !== undefined && expires === null) diagnostics.push(diagnostic("INVALID_TIMESTAMP", `${path}.expiresAt`, "Expiry timestamp is invalid."));
  if (observed !== null && expires !== null && expires <= observed) diagnostics.push(diagnostic("INVALID_TIMESTAMP", `${path}.expiresAt`, "Expiry must follow observation."));
  if (value["constraints"] !== undefined && !safePublicValue(value["constraints"])) diagnostics.push(diagnostic("INVALID_PUBLIC_DATA", `${path}.constraints`, "Constraints contain unsafe public data."));
  return diagnostics;
}

export function validateProviderCatalogSnapshotV2(
  input: unknown,
): ProviderSessionExplorerConformanceResult {
  const value = record(input);
  const diagnostics: ProviderSessionExplorerDiagnostic[] = [];
  if (!value) return { valid: false, diagnostics: [diagnostic("INVALID_CATALOG", "", "Catalog must be a plain object.")] };
  if (
    unexpectedKeys(value, [
      "schemaVersion",
      "providerId",
      "installationId",
      "backendId",
      "source",
      "sourceRevision",
      "observedAt",
      "expiresAt",
      "fingerprint",
      "authenticated",
      "completeness",
      "confidence",
      "models",
      "capabilities",
      "warnings",
    ]).length > 0
  ) {
    diagnostics.push(diagnostic("INVALID_CATALOG", "", "Catalog contains an unknown field."));
  }
  diagnostics.push(...validateProviderInstallationIdentityV2(value).diagnostics);
  if (value["schemaVersion"] !== PROVIDER_CATALOG_SCHEMA_VERSION) diagnostics.push(diagnostic("INVALID_CATALOG", "schemaVersion", "Catalog schema version is unsupported."));
  if (!safeString(value["source"])) diagnostics.push(diagnostic("INVALID_PUBLIC_DATA", "source", "Catalog source is unsafe."));
  if (value["sourceRevision"] !== undefined && !safeString(value["sourceRevision"])) {
    diagnostics.push(
      diagnostic("INVALID_PUBLIC_DATA", "sourceRevision", "Catalog source revision is unsafe."),
    );
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(String(value["fingerprint"] ?? ""))) diagnostics.push(diagnostic("INVALID_CATALOG", "fingerprint", "Catalog fingerprint must be a SHA-256 content id."));
  const observed = isoMillis(value["observedAt"]);
  const expires = isoMillis(value["expiresAt"]);
  if (observed === null) diagnostics.push(diagnostic("INVALID_TIMESTAMP", "observedAt", "Catalog observation timestamp is invalid."));
  if (expires === null || (observed !== null && expires <= observed)) diagnostics.push(diagnostic("INVALID_TIMESTAMP", "expiresAt", "Catalog expiry must follow observation."));
  if (![true, false, null].includes(value["authenticated"] as boolean | null)) diagnostics.push(diagnostic("INVALID_CATALOG", "authenticated", "Authentication state must be boolean or null."));
  if (!( ["account", "runtime", "aliases", "partial"] as const).includes(value["completeness"] as ProviderCatalogCompleteness)) diagnostics.push(diagnostic("INVALID_CATALOG", "completeness", "Catalog completeness is invalid."));
  if (!( ["authoritative", "observed", "unverified"] as const).includes(value["confidence"] as ProviderCatalogConfidence)) diagnostics.push(diagnostic("INVALID_CATALOG", "confidence", "Catalog confidence is invalid."));
  const models = value["models"];
  if (!Array.isArray(models) || models.length > MAX_ITEMS) {
    diagnostics.push(diagnostic("INVALID_CATALOG", "models", "Catalog models must be a bounded array."));
  } else {
    const modelIds = new Set<string>();
    let defaults = 0;
    models.forEach((inputModel, index) => {
      const model = record(inputModel);
      const path = `models.${index}`;
      if (!model || unexpectedKeys(model, ["modelId", "displayName", "isDefault", "hidden", "deprecated", "efforts", "defaultEffortId", "maxInputTokens", "maxOutputTokens", "capabilityConstraints"]).length > 0) {
        diagnostics.push(diagnostic("INVALID_CATALOG", path, "Model contains an invalid or unknown field."));
        return;
      }
      if (!safeString(model["modelId"]) || modelIds.has(String(model["modelId"]))) diagnostics.push(diagnostic("INVALID_CATALOG", `${path}.modelId`, "Model id is unsafe or duplicated."));
      modelIds.add(String(model["modelId"]));
      if (!safeText(model["displayName"])) diagnostics.push(diagnostic("INVALID_PUBLIC_DATA", `${path}.displayName`, "Model display name is unsafe."));
      if (model["isDefault"] === true) defaults += 1;
      if (typeof model["isDefault"] !== "boolean") diagnostics.push(diagnostic("INVALID_CATALOG", `${path}.isDefault`, "Default state must be boolean."));
      if (model["hidden"] !== undefined && typeof model["hidden"] !== "boolean") diagnostics.push(diagnostic("INVALID_CATALOG", `${path}.hidden`, "Hidden state must be boolean."));
      if (model["deprecated"] !== undefined && typeof model["deprecated"] !== "boolean") diagnostics.push(diagnostic("INVALID_CATALOG", `${path}.deprecated`, "Deprecated state must be boolean."));
      if (model["maxInputTokens"] !== undefined && (!Number.isSafeInteger(model["maxInputTokens"]) || Number(model["maxInputTokens"]) <= 0)) diagnostics.push(diagnostic("INVALID_CATALOG", `${path}.maxInputTokens`, "Input limit must be a positive integer."));
      if (model["maxOutputTokens"] !== undefined && (!Number.isSafeInteger(model["maxOutputTokens"]) || Number(model["maxOutputTokens"]) <= 0)) diagnostics.push(diagnostic("INVALID_CATALOG", `${path}.maxOutputTokens`, "Output limit must be a positive integer."));
      if (model["capabilityConstraints"] !== undefined && !safePublicValue(model["capabilityConstraints"])) diagnostics.push(diagnostic("INVALID_PUBLIC_DATA", `${path}.capabilityConstraints`, "Model constraints contain unsafe public data."));
      const efforts = model["efforts"];
      if (!Array.isArray(efforts) || efforts.length > 100) {
        diagnostics.push(diagnostic("INVALID_CATALOG", `${path}.efforts`, "Efforts must be a bounded array."));
      } else {
        const effortIds = new Set<string>();
        efforts.forEach((inputEffort, effortIndex) => {
          const effort = record(inputEffort);
          const effortPath = `${path}.efforts.${effortIndex}`;
          if (!effort || unexpectedKeys(effort, ["effortId", "displayName", "nativeValue", "source", "confidence"]).length > 0 || !safeString(effort["effortId"]) || !safeText(effort["displayName"]) || !safeString(effort["nativeValue"]) || !safeString(effort["source"]) || !( ["authoritative", "observed", "unverified"] as const).includes(effort["confidence"] as ProviderCatalogConfidence) || effortIds.has(String(effort["effortId"]))) {
            diagnostics.push(diagnostic("INVALID_CATALOG", effortPath, "Effort evidence is invalid or duplicated."));
          }
          effortIds.add(String(effort?.["effortId"]));
        });
        if (model["defaultEffortId"] !== undefined && !effortIds.has(String(model["defaultEffortId"]))) diagnostics.push(diagnostic("INVALID_CATALOG", `${path}.defaultEffortId`, "Default effort is not advertised by the model."));
      }
    });
    if (defaults > 1) diagnostics.push(diagnostic("INVALID_CATALOG", "models", "At most one model may be the provider default."));
  }
  const capabilities = record(value["capabilities"]);
  if (!capabilities) diagnostics.push(diagnostic("INVALID_CATALOG", "capabilities", "Capabilities must be an object."));
  else for (const [key, evidence] of Object.entries(capabilities)) {
    if (!safeString(key, 128) || SECRET_KEY.test(key)) diagnostics.push(diagnostic("INVALID_PUBLIC_DATA", `capabilities.${key}`, "Capability key is unsafe."));
    diagnostics.push(...validateEvidence(evidence, `capabilities.${key}`));
  }
  if (!Array.isArray(value["warnings"]) || !value["warnings"].every((warning) => safeText(warning))) diagnostics.push(diagnostic("INVALID_PUBLIC_DATA", "warnings", "Catalog warnings contain unsafe public data."));
  const modelCatalogEvidence = capabilities?.["modelCatalog"];
  if (
    value["authenticated"] !== true &&
    record(modelCatalogEvidence)?.["support"] === "supported"
  ) {
    diagnostics.push(
      diagnostic(
        "INVALID_CATALOG",
        "capabilities.modelCatalog.support",
        "Unauthenticated catalogs cannot claim supported model-catalog evidence.",
      ),
    );
  }
  return { valid: diagnostics.length === 0, diagnostics };
}

export function getProviderCatalogFreshnessV2(
  input: ProviderCatalogSnapshotV2,
  evaluatedAt: Date = new Date(),
): ProviderEvidenceFreshness {
  const observed = isoMillis(input.observedAt);
  const expires = isoMillis(input.expiresAt);
  const now = evaluatedAt.getTime();
  if (observed === null || expires === null || !Number.isFinite(now) || observed > now + FUTURE_SKEW_MS) return "unknown";
  return expires > now ? "fresh" : "stale";
}

export function isProviderCatalogSnapshotSelectableV2(
  input: unknown,
  evaluatedAt: Date = new Date(),
): input is ProviderCatalogSnapshotV2 {
  const validation = validateProviderCatalogSnapshotV2(input);
  if (!validation.valid) return false;
  const catalog = input as ProviderCatalogSnapshotV2;
  const modelCatalog = catalog.capabilities["modelCatalog"];
  const evidenceFresh = modelCatalog?.expiresAt !== undefined && isoMillis(modelCatalog.expiresAt)! > evaluatedAt.getTime() && isoMillis(modelCatalog.observedAt)! <= evaluatedAt.getTime() + FUTURE_SKEW_MS;
  return catalog.authenticated === true && catalog.confidence !== "unverified" && getProviderCatalogFreshnessV2(catalog, evaluatedAt) === "fresh" && modelCatalog?.support === "supported" && evidenceFresh && catalog.models.some((model) => model.hidden !== true && model.deprecated !== true) && catalog.models.every((model) => model.efforts.every((effort) => effort.confidence !== "unverified"));
}

export function validateProviderSessionObservationV2(
  input: unknown,
): ProviderSessionExplorerConformanceResult {
  const value = record(input);
  if (!value) return { valid: false, diagnostics: [diagnostic("INVALID_IDENTITY", "", "Observation must be an object.")] };
  const identity = record(value["canonicalIdentity"]);
  const diagnostics = [...validateProviderInstallationIdentityV2(identity).diagnostics];
  if (!identity || !safeString(identity["sessionId"]) || !Array.isArray(identity["sourceObservationIds"]) || identity["sourceObservationIds"].length === 0 || !identity["sourceObservationIds"].every((id) => safeString(id)) || new Set(identity["sourceObservationIds"] as string[]).size !== identity["sourceObservationIds"].length) diagnostics.push(diagnostic("INVALID_IDENTITY", "canonicalIdentity", "Canonical session identity is incomplete or ambiguous."));
  diagnostics.push(...validateSessionContinuationDecision(value["continuation"]).diagnostics);
  if (isoMillis(value["observedAt"]) === null) diagnostics.push(diagnostic("INVALID_TIMESTAMP", "observedAt", "Observation timestamp is invalid."));
  if (value["continuation"] && record(value["continuation"])?.["mode"] === "native_resume" && !safeString(identity?.["nativeSessionId"])) diagnostics.push(diagnostic("INVALID_IDENTITY", "canonicalIdentity.nativeSessionId", "Native resume requires native identity."));
  return { valid: diagnostics.length === 0, diagnostics };
}

/**
 * Provider names never grant resume. Admission requires a valid observation,
 * exact installation/backend agreement, a selectable catalog, and fresh
 * supported native-resume evidence from that same snapshot.
 */
export function isNativeResumeAdmittedV2(
  observationInput: unknown,
  catalogInput: unknown,
  evaluatedAt: Date = new Date(),
): boolean {
  if (
    !validateProviderSessionObservationV2(observationInput).valid ||
    !isProviderCatalogSnapshotSelectableV2(catalogInput, evaluatedAt)
  ) {
    return false;
  }
  const observation = observationInput as ProviderSessionObservationV2;
  const catalog = catalogInput as ProviderCatalogSnapshotV2;
  if (
    observation.continuation.mode !== "native_resume" ||
    observation.canonicalIdentity.providerId !== catalog.providerId ||
    observation.canonicalIdentity.installationId !== catalog.installationId ||
    observation.canonicalIdentity.backendId !== catalog.backendId
  ) {
    return false;
  }
  const evidence = catalog.capabilities["native_resume"];
  if (!evidence || evidence.support !== "supported" || evidence.expiresAt === undefined) return false;
  const observed = isoMillis(evidence.observedAt);
  const expires = isoMillis(evidence.expiresAt);
  const now = evaluatedAt.getTime();
  return (
    observed !== null &&
    expires !== null &&
    Number.isFinite(now) &&
    observed <= now + FUTURE_SKEW_MS &&
    expires > now
  );
}

import {
  EFFECT_CLASSES,
  FLOW_DATA_CLASSIFICATIONS,
  type EffectClass,
  type FlowDataClassification,
} from "./primitives.js";

export const FLOW_TOOL_SECURITY_POLICY_SCHEMA =
  "dzupagent.flowToolSecurityPolicy/v1" as const;
export const FLOW_CONNECTOR_SECURITY_MANIFEST_SCHEMA =
  "dzupagent.flowConnectorSecurityManifest/v1" as const;

export type FlowHttpCredentialScheme =
  | "bearer"
  | "basic"
  | "api-key-header";

/**
 * Authored HTTP credential slot. `credential` is an exact whole-value
 * reference to a host-created handle; portable code never dereferences it.
 */
export interface FlowHttpCredentialAuth {
  readonly scheme: FlowHttpCredentialScheme;
  readonly credential: string;
  readonly provider: string;
  readonly scopes: readonly string[];
  /** Required only for `api-key-header`; Authorization and Cookie are denied. */
  readonly headerName?: string;
}

export interface FlowToolCredentialPolicy {
  readonly mode: "forbidden" | "handle-only";
  readonly inputPaths: readonly string[];
  readonly resolverCapabilityRef?: string;
  /** Exact provider identities accepted by this tool. Wildcards are forbidden. */
  readonly allowedProviders: readonly string[];
  /** Every listed scope must be present on the host-created handle. */
  readonly requiredScopes: readonly string[];
}

/**
 * Serializable, provider-free security contract for one callable tool.
 * It contains policy metadata only: no executable handle or credential data.
 */
export interface FlowToolSecurityPolicy {
  readonly schema: typeof FLOW_TOOL_SECURITY_POLICY_SCHEMA;
  readonly acceptedInputClassifications: readonly FlowDataClassification[];
  readonly credential: FlowToolCredentialPolicy;
  readonly outputClassification: FlowDataClassification;
  readonly effectClasses: readonly EffectClass[];
  readonly evidence: {
    readonly required: readonly string[];
    readonly classification: FlowDataClassification;
    readonly rawContent: "forbidden" | "ephemeral" | "allowed-by-policy";
  };
}

export interface FlowConnectorSecurityTool {
  readonly toolRef: string;
  readonly policy: FlowToolSecurityPolicy;
}

/**
 * Connector-level catalogue binding a versioned connector/provider identity
 * to the exact security policy of each tool it publishes.
 */
export interface FlowConnectorSecurityManifest {
  readonly schema: typeof FLOW_CONNECTOR_SECURITY_MANIFEST_SCHEMA;
  readonly ref: `connector://${string}@${string}`;
  readonly provider: string;
  readonly tools: readonly FlowConnectorSecurityTool[];
}

export type FlowToolSecurityPolicyInput = Omit<
  FlowToolSecurityPolicy,
  "schema"
>;

export function defineFlowToolSecurityPolicy(
  input: FlowToolSecurityPolicyInput,
): FlowToolSecurityPolicy {
  const policy: FlowToolSecurityPolicy = {
    schema: FLOW_TOOL_SECURITY_POLICY_SCHEMA,
    acceptedInputClassifications: Object.freeze([
      ...input.acceptedInputClassifications,
    ]),
    credential: Object.freeze({
      ...input.credential,
      inputPaths: Object.freeze([...input.credential.inputPaths]),
      allowedProviders: Object.freeze([
        ...input.credential.allowedProviders,
      ]),
      requiredScopes: Object.freeze([...input.credential.requiredScopes]),
    }),
    outputClassification: input.outputClassification,
    effectClasses: Object.freeze([...input.effectClasses]),
    evidence: Object.freeze({
      ...input.evidence,
      required: Object.freeze([...input.evidence.required]),
    }),
  };
  const issues = validateFlowToolSecurityPolicy(policy);
  if (issues.length > 0) {
    throw new TypeError(`invalid tool security policy: ${issues.join("; ")}`);
  }
  return Object.freeze(policy);
}

export function validateFlowToolSecurityPolicy(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ["policy must be an object"];
  allowedKeys(
    value,
    [
      "schema",
      "acceptedInputClassifications",
      "credential",
      "outputClassification",
      "effectClasses",
      "evidence",
    ],
    "policy",
    issues,
  );
  if (value.schema !== FLOW_TOOL_SECURITY_POLICY_SCHEMA) {
    issues.push(`schema must be ${FLOW_TOOL_SECURITY_POLICY_SCHEMA}`);
  }
  enumArray(
    value.acceptedInputClassifications,
    FLOW_DATA_CLASSIFICATIONS,
    "acceptedInputClassifications",
    issues,
    true,
  );
  enumValue(
    value.outputClassification,
    FLOW_DATA_CLASSIFICATIONS,
    "outputClassification",
    issues,
  );
  enumArray(value.effectClasses, EFFECT_CLASSES, "effectClasses", issues, true);
  validateCredentialPolicy(value.credential, issues);
  validateEvidencePolicy(value.evidence, issues);
  return issues;
}

export function defineFlowConnectorSecurityManifest(
  input: Omit<FlowConnectorSecurityManifest, "schema">,
): FlowConnectorSecurityManifest {
  const manifest: FlowConnectorSecurityManifest = {
    schema: FLOW_CONNECTOR_SECURITY_MANIFEST_SCHEMA,
    ref: input.ref,
    provider: input.provider,
    tools: Object.freeze(
      input.tools.map((tool) =>
        Object.freeze({ toolRef: tool.toolRef, policy: tool.policy }),
      ),
    ),
  };
  const issues = validateFlowConnectorSecurityManifest(manifest);
  if (issues.length > 0) {
    throw new TypeError(
      `invalid connector security manifest: ${issues.join("; ")}`,
    );
  }
  return Object.freeze(manifest);
}

export function validateFlowConnectorSecurityManifest(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ["manifest must be an object"];
  allowedKeys(value, ["schema", "ref", "provider", "tools"], "manifest", issues);
  if (value.schema !== FLOW_CONNECTOR_SECURITY_MANIFEST_SCHEMA) {
    issues.push(`schema must be ${FLOW_CONNECTOR_SECURITY_MANIFEST_SCHEMA}`);
  }
  if (
    typeof value.ref !== "string" ||
    !/^connector:\/\/[^@\s]+@[^@\s]+$/.test(value.ref)
  ) {
    issues.push("ref must be a versioned connector URI");
  }
  requireString(value.provider, "provider", issues);
  if (!Array.isArray(value.tools) || value.tools.length === 0) {
    issues.push("tools must be a non-empty array");
    return issues;
  }
  const seen = new Set<string>();
  value.tools.forEach((tool, index) => {
    const path = `tools[${index}]`;
    if (!isRecord(tool)) {
      issues.push(`${path} must be an object`);
      return;
    }
    allowedKeys(tool, ["toolRef", "policy"], path, issues);
    requireString(tool.toolRef, `${path}.toolRef`, issues);
    if (typeof tool.toolRef === "string") {
      if (seen.has(tool.toolRef)) issues.push(`${path}.toolRef is duplicated`);
      seen.add(tool.toolRef);
    }
    for (const issue of validateFlowToolSecurityPolicy(tool.policy)) {
      issues.push(`${path}.policy.${issue}`);
    }
    if (
      isRecord(tool.policy) &&
      isRecord(tool.policy.credential) &&
      tool.policy.credential.mode === "handle-only" &&
      Array.isArray(tool.policy.credential.allowedProviders) &&
      typeof value.provider === "string" &&
      !tool.policy.credential.allowedProviders.includes(value.provider)
    ) {
      issues.push(
        `${path}.policy.credential.allowedProviders must include connector provider`,
      );
    }
  });
  return issues;
}

function validateCredentialPolicy(value: unknown, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push("credential must be an object");
    return;
  }
  allowedKeys(
    value,
    [
      "mode",
      "inputPaths",
      "resolverCapabilityRef",
      "allowedProviders",
      "requiredScopes",
    ],
    "credential",
    issues,
  );
  if (value.mode !== "forbidden" && value.mode !== "handle-only") {
    issues.push("credential.mode must be forbidden or handle-only");
  }
  const inputPaths = stringArray(
    value.inputPaths,
    "credential.inputPaths",
    issues,
  );
  const providers = stringArray(
    value.allowedProviders,
    "credential.allowedProviders",
    issues,
  );
  stringArray(value.requiredScopes, "credential.requiredScopes", issues);
  if (
    inputPaths?.some(
      (path) =>
        !/^[A-Za-z][A-Za-z0-9_-]*(?:\.(?:[A-Za-z][A-Za-z0-9_-]*|\*))+$/u.test(
          path,
        ) ||
        (path.includes("*") && !path.endsWith(".*")),
    )
  ) {
    issues.push("credential.inputPaths contains an invalid path");
  }
  if (providers?.some((provider) => provider.includes("*"))) {
    issues.push("credential.allowedProviders cannot contain wildcards");
  }
  if (value.mode === "forbidden") {
    if ((inputPaths?.length ?? 0) > 0) {
      issues.push("credential.inputPaths must be empty when forbidden");
    }
    if ((providers?.length ?? 0) > 0) {
      issues.push("credential.allowedProviders must be empty when forbidden");
    }
    if (
      Array.isArray(value.requiredScopes) &&
      value.requiredScopes.length > 0
    ) {
      issues.push("credential.requiredScopes must be empty when forbidden");
    }
    if (value.resolverCapabilityRef !== undefined) {
      issues.push(
        "credential.resolverCapabilityRef is forbidden when credentials are forbidden",
      );
    }
    return;
  }
  if ((inputPaths?.length ?? 0) === 0) {
    issues.push("credential.inputPaths is required for handle-only policy");
  }
  if ((providers?.length ?? 0) === 0) {
    issues.push("credential.allowedProviders is required for handle-only policy");
  }
  requireString(
    value.resolverCapabilityRef,
    "credential.resolverCapabilityRef",
    issues,
  );
}

function validateEvidencePolicy(value: unknown, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push("evidence must be an object");
    return;
  }
  allowedKeys(
    value,
    ["required", "classification", "rawContent"],
    "evidence",
    issues,
  );
  stringArray(value.required, "evidence.required", issues);
  enumValue(
    value.classification,
    FLOW_DATA_CLASSIFICATIONS,
    "evidence.classification",
    issues,
  );
  if (
    value.rawContent !== "forbidden" &&
    value.rawContent !== "ephemeral" &&
    value.rawContent !== "allowed-by-policy"
  ) {
    issues.push(
      "evidence.rawContent must be forbidden, ephemeral, or allowed-by-policy",
    );
  }
}

function allowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: string[],
): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) issues.push(`${path}.${key} is not allowed`);
  }
}

function enumArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  issues: string[],
  requireNonEmpty = false,
): T[] | undefined {
  const values = stringArray(value, path, issues);
  if (values === undefined) return undefined;
  if (requireNonEmpty && values.length === 0) {
    issues.push(`${path} must not be empty`);
  }
  const accepted = new Set<string>(allowed);
  values.forEach((entry) => {
    if (!accepted.has(entry)) issues.push(`${path} contains invalid value ${entry}`);
  });
  return values as T[];
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  issues: string[],
): void {
  if (typeof value !== "string" || !new Set<string>(allowed).has(value)) {
    issues.push(`${path} has an invalid value`);
  }
}

function stringArray(
  value: unknown,
  path: string,
  issues: string[],
): string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)
  ) {
    issues.push(`${path} must contain only non-empty strings`);
    return undefined;
  }
  if (new Set(value).size !== value.length) {
    issues.push(`${path} cannot contain duplicates`);
  }
  return value as string[];
}

function requireString(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push(`${path} must be a non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

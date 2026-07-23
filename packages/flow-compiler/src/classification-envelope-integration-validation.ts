const CLASSIFICATIONS = new Set([
  "public",
  "internal",
  "sensitive",
  "secret",
]);
const TOOL_KINDS = new Set(["mcp-tool", "skill", "workflow", "agent"]);
const EFFECT_CLASSES = new Set([
  "read",
  "compute",
  "llm",
  "file_write",
  "code_change",
  "network_write",
  "db_write",
  "human_decision",
  "queue_publish",
]);

export function validateCompiledIntegration(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (!recordWithKeys(
    value,
    [
      "nodePath",
      "nodeId",
      "toolRef",
      "toolKind",
      "policyHash",
      "acceptedInputClassifications",
      "credential",
      "outputClassification",
      "effectClasses",
      "evidence",
    ],
    path,
    issues,
  )) return;
  requireNonEmptyString(value.nodePath, `${path}.nodePath`, issues);
  if (value.nodeId !== undefined) {
    requireNonEmptyString(value.nodeId, `${path}.nodeId`, issues);
  }
  requireNonEmptyString(value.toolRef, `${path}.toolRef`, issues);
  enumValue(value.toolKind, TOOL_KINDS, `${path}.toolKind`, issues);
  if (
    typeof value.policyHash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.policyHash)
  ) {
    issues.push(`${path}.policyHash must be a lowercase SHA-256 digest`);
  }
  enumArray(
    value.acceptedInputClassifications,
    CLASSIFICATIONS,
    `${path}.acceptedInputClassifications`,
    issues,
  );
  if (value.credential !== undefined) {
    validateCredential(value.credential, `${path}.credential`, issues);
  }
  enumValue(
    value.outputClassification,
    CLASSIFICATIONS,
    `${path}.outputClassification`,
    issues,
  );
  enumArray(
    value.effectClasses,
    EFFECT_CLASSES,
    `${path}.effectClasses`,
    issues,
  );
  validateEvidence(value.evidence, `${path}.evidence`, issues);
}

function validateCredential(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (!recordWithKeys(
    value,
    [
      "mode",
      "inputPaths",
      "resolverCapabilityRef",
      "allowedProviders",
      "requiredScopes",
    ],
    path,
    issues,
  )) return;
  if (value.mode !== "handle-only") {
    issues.push(`${path}.mode must be handle-only`);
  }
  stringArray(value.inputPaths, `${path}.inputPaths`, issues);
  requireNonEmptyString(
    value.resolverCapabilityRef,
    `${path}.resolverCapabilityRef`,
    issues,
  );
  stringArray(value.allowedProviders, `${path}.allowedProviders`, issues);
  stringArray(value.requiredScopes, `${path}.requiredScopes`, issues);
}

function validateEvidence(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (!recordWithKeys(
    value,
    ["required", "classification", "rawContent"],
    path,
    issues,
  )) return;
  stringArray(value.required, `${path}.required`, issues);
  enumValue(
    value.classification,
    CLASSIFICATIONS,
    `${path}.classification`,
    issues,
  );
  enumValue(
    value.rawContent,
    new Set(["forbidden", "ephemeral", "allowed-by-policy"]),
    `${path}.rawContent`,
    issues,
  );
}

function recordWithKeys(
  value: unknown,
  accepted: readonly string[],
  path: string,
  issues: string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    issues.push(`${path} must be an object`);
    return false;
  }
  const allowed = new Set(accepted);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${path}.${key} is not allowed`);
  }
  return true;
}

function enumArray(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
  issues: string[],
): void {
  const values = stringArray(value, path, issues);
  values?.forEach((entry) => {
    if (!allowed.has(entry)) issues.push(`${path} contains invalid value ${entry}`);
  });
}

function enumValue(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
  issues: string[],
): void {
  if (typeof value !== "string" || !allowed.has(value)) {
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
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    issues.push(`${path} must contain only non-empty strings`);
    return undefined;
  }
  if (new Set(value).size !== value.length) {
    issues.push(`${path} cannot contain duplicates`);
  }
  return value as string[];
}

function requireNonEmptyString(
  value: unknown,
  path: string,
  issues: string[],
): void {
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`${path} must be a non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const AGENT_BLUEPRINT_SCHEMA = "dzupagent.agentBlueprint/v1" as const;
export const COMPILED_AGENT_DESCRIPTOR_SCHEMA =
  "dzupagent.compiledAgentDescriptor/v1" as const;

export const AGENT_BLUEPRINT_STATUSES = [
  "draft",
  "published",
  "deprecated",
] as const;
export type AgentBlueprintStatus = (typeof AGENT_BLUEPRINT_STATUSES)[number];

/**
 * AI-produced results never grant runtime authority. A host-action-request is
 * only a typed request for a separately authorized host operation.
 */
export const AGENT_AUTHORITY_EFFECTS = [
  "none",
  "advisory",
  "proposal",
  "host-action-request",
] as const;
export type AgentAuthorityEffect = (typeof AGENT_AUTHORITY_EFFECTS)[number];

export const AGENT_HANDLER_KINDS = [
  "renderer",
  "normalizer",
  "validator",
  "evidence-resolver",
  "postprocessor",
] as const;
export type AgentHandlerKind = (typeof AGENT_HANDLER_KINDS)[number];

export const AGENT_HANDLER_EFFECT_CLASSES = [
  "none",
  "read",
  "write",
  "external",
] as const;
export type AgentHandlerEffectClass =
  (typeof AGENT_HANDLER_EFFECT_CLASSES)[number];

export type AgentJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AgentJsonValue[]
  | { readonly [key: string]: AgentJsonValue };

export interface AgentHandlerRefs {
  readonly renderer: string;
  readonly normalizer?: string;
  readonly validators: readonly string[];
  readonly evidenceResolvers?: readonly string[];
  readonly postprocessors?: readonly string[];
}

export interface AgentBlueprint {
  readonly schema: typeof AGENT_BLUEPRINT_SCHEMA;
  readonly id: string;
  readonly version: number;
  readonly status: AgentBlueprintStatus;
  readonly personaRef: string;
  readonly taskRef: string;
  readonly promptOverlayRefs?: readonly string[];
  readonly inputSchemaRef: string;
  readonly outputSchemaRef: string;
  readonly toolsetRef: string;
  readonly policyRef: string;
  readonly handlers: AgentHandlerRefs;
  readonly evidenceKinds: readonly string[];
  readonly authorityEffect: AgentAuthorityEffect;
  readonly metadata?: Readonly<Record<string, AgentJsonValue>>;
}

export interface AgentPersonaDefinition {
  readonly ref: string;
  readonly status: AgentBlueprintStatus;
  readonly summary: string;
  readonly promptRef: string;
  readonly compatibleTaskRefs?: readonly string[];
}

export interface AgentTaskProfile {
  readonly ref: string;
  readonly status: AgentBlueprintStatus;
  readonly summary: string;
  readonly promptRef: string;
}

export interface AgentPromptTemplate {
  readonly ref: string;
  readonly status: AgentBlueprintStatus;
  readonly content: string;
}

export interface AgentPolicyDefinition {
  readonly ref: string;
  readonly status: AgentBlueprintStatus;
  readonly value: Readonly<Record<string, AgentJsonValue>>;
}

export interface AgentToolsetDefinition {
  readonly ref: string;
  readonly status: AgentBlueprintStatus;
  readonly tools: readonly string[];
}

export interface AgentSchemaDefinition {
  readonly ref: string;
  readonly status: AgentBlueprintStatus;
  readonly schema: Readonly<Record<string, AgentJsonValue>>;
}

export interface AgentHandlerDescriptor {
  readonly ref: string;
  readonly status: AgentBlueprintStatus;
  readonly kind: AgentHandlerKind;
  readonly version: number;
  readonly effectClass: AgentHandlerEffectClass;
  readonly deterministic: boolean;
}

export interface CompiledAgentPromptLayer {
  readonly kind: "persona" | "task" | "blueprint-overlay" | "provider-overlay";
  readonly ref: string;
  readonly content: string;
  readonly contentSha256: `sha256:${string}`;
}

export interface CompiledAgentDescriptor {
  readonly schema: typeof COMPILED_AGENT_DESCRIPTOR_SCHEMA;
  readonly id: string;
  readonly blueprintVersion: number;
  readonly personaRef: string;
  readonly taskRef: string;
  readonly promptLayers: readonly CompiledAgentPromptLayer[];
  readonly inputSchema: Readonly<Record<string, AgentJsonValue>>;
  readonly outputSchema: Readonly<Record<string, AgentJsonValue>>;
  readonly tools: readonly string[];
  readonly policy: Readonly<Record<string, AgentJsonValue>>;
  readonly handlers: {
    readonly renderer: AgentHandlerDescriptor;
    readonly normalizer?: AgentHandlerDescriptor;
    readonly validators: readonly AgentHandlerDescriptor[];
    readonly evidenceResolvers: readonly AgentHandlerDescriptor[];
    readonly postprocessors: readonly AgentHandlerDescriptor[];
  };
  readonly evidenceKinds: readonly string[];
  readonly authorityEffect: AgentAuthorityEffect;
  readonly sourceRefs: readonly string[];
  readonly fingerprint: `sha256:${string}`;
}

export type AgentBlueprintDiagnosticCode =
  | "INVALID_SCHEMA"
  | "INVALID_VALUE"
  | "DUPLICATE_REF"
  | "MISSING_HANDLER"
  | "HANDLER_KIND_MISMATCH"
  | "UNKNOWN_REF"
  | "UNPUBLISHED_REF"
  | "INCOMPATIBLE_PERSONA_TASK"
  | "INVALID_FINGERPRINT";

export interface AgentBlueprintDiagnostic {
  readonly code: AgentBlueprintDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface AgentBlueprintValidation {
  readonly valid: boolean;
  readonly diagnostics: readonly AgentBlueprintDiagnostic[];
}

export function validateAgentBlueprint(
  value: AgentBlueprint,
): AgentBlueprintValidation {
  const diagnostics: AgentBlueprintDiagnostic[] = [];
  if (value.schema !== AGENT_BLUEPRINT_SCHEMA) {
    add(diagnostics, "INVALID_SCHEMA", "schema", "Unsupported agent blueprint schema.");
  }
  nonEmpty(value.id, "id", diagnostics);
  if (!Number.isInteger(value.version) || value.version < 1) {
    add(diagnostics, "INVALID_VALUE", "version", "Version must be a positive integer.");
  }
  enumValue(value.status, AGENT_BLUEPRINT_STATUSES, "status", diagnostics);
  nonEmpty(value.personaRef, "personaRef", diagnostics);
  nonEmpty(value.taskRef, "taskRef", diagnostics);
  nonEmpty(value.inputSchemaRef, "inputSchemaRef", diagnostics);
  nonEmpty(value.outputSchemaRef, "outputSchemaRef", diagnostics);
  nonEmpty(value.toolsetRef, "toolsetRef", diagnostics);
  nonEmpty(value.policyRef, "policyRef", diagnostics);
  enumValue(
    value.authorityEffect,
    AGENT_AUTHORITY_EFFECTS,
    "authorityEffect",
    diagnostics,
  );
  nonEmpty(value.handlers?.renderer, "handlers.renderer", diagnostics);
  if (!Array.isArray(value.handlers?.validators) || value.handlers.validators.length === 0) {
    add(
      diagnostics,
      "MISSING_HANDLER",
      "handlers.validators",
      "At least one output validator is required.",
    );
  }
  uniqueStrings(value.promptOverlayRefs ?? [], "promptOverlayRefs", diagnostics);
  uniqueStrings(value.handlers?.validators ?? [], "handlers.validators", diagnostics);
  uniqueStrings(
    value.handlers?.evidenceResolvers ?? [],
    "handlers.evidenceResolvers",
    diagnostics,
  );
  uniqueStrings(
    value.handlers?.postprocessors ?? [],
    "handlers.postprocessors",
    diagnostics,
  );
  uniqueStrings(value.evidenceKinds, "evidenceKinds", diagnostics);
  return { valid: diagnostics.length === 0, diagnostics };
}

export function validateCompiledAgentDescriptor(
  value: CompiledAgentDescriptor,
): AgentBlueprintValidation {
  const diagnostics: AgentBlueprintDiagnostic[] = [];
  if (value.schema !== COMPILED_AGENT_DESCRIPTOR_SCHEMA) {
    add(diagnostics, "INVALID_SCHEMA", "schema", "Unsupported compiled descriptor schema.");
  }
  nonEmpty(value.id, "id", diagnostics);
  if (!Number.isInteger(value.blueprintVersion) || value.blueprintVersion < 1) {
    add(
      diagnostics,
      "INVALID_VALUE",
      "blueprintVersion",
      "Blueprint version must be a positive integer.",
    );
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(value.fingerprint)) {
    add(
      diagnostics,
      "INVALID_FINGERPRINT",
      "fingerprint",
      "Fingerprint must be a lowercase SHA-256 digest.",
    );
  }
  if (!Array.isArray(value.promptLayers) || value.promptLayers.length < 2) {
    add(
      diagnostics,
      "INVALID_VALUE",
      "promptLayers",
      "Compiled descriptors require persona and task prompt layers.",
    );
  }
  value.promptLayers?.forEach((promptLayer, index) => {
    if (!/^sha256:[a-f0-9]{64}$/.test(promptLayer.contentSha256)) {
      add(
        diagnostics,
        "INVALID_FINGERPRINT",
        `promptLayers[${index}].contentSha256`,
        "Prompt-layer identity must be a lowercase SHA-256 digest.",
      );
    }
  });
  validateHandlerKind(value.handlers?.renderer, "renderer", "handlers.renderer", diagnostics);
  value.handlers?.validators?.forEach((handler, index) =>
    validateHandlerKind(handler, "validator", `handlers.validators[${index}]`, diagnostics),
  );
  value.handlers?.evidenceResolvers?.forEach((handler, index) =>
    validateHandlerKind(
      handler,
      "evidence-resolver",
      `handlers.evidenceResolvers[${index}]`,
      diagnostics,
    ),
  );
  value.handlers?.postprocessors?.forEach((handler, index) =>
    validateHandlerKind(
      handler,
      "postprocessor",
      `handlers.postprocessors[${index}]`,
      diagnostics,
    ),
  );
  if (value.handlers?.normalizer) {
    validateHandlerKind(
      value.handlers.normalizer,
      "normalizer",
      "handlers.normalizer",
      diagnostics,
    );
  }
  enumValue(
    value.authorityEffect,
    AGENT_AUTHORITY_EFFECTS,
    "authorityEffect",
    diagnostics,
  );
  uniqueStrings(value.tools, "tools", diagnostics);
  uniqueStrings(value.evidenceKinds, "evidenceKinds", diagnostics);
  uniqueStrings(value.sourceRefs, "sourceRefs", diagnostics);
  return { valid: diagnostics.length === 0, diagnostics };
}

function validateHandlerKind(
  handler: AgentHandlerDescriptor | undefined,
  expected: AgentHandlerKind,
  path: string,
  diagnostics: AgentBlueprintDiagnostic[],
): void {
  if (!handler) {
    add(diagnostics, "MISSING_HANDLER", path, `Missing ${expected} handler.`);
  } else if (handler.kind !== expected) {
    add(
      diagnostics,
      "HANDLER_KIND_MISMATCH",
      path,
      `Expected ${expected} handler, received ${handler.kind}.`,
    );
  }
}

function nonEmpty(
  value: unknown,
  path: string,
  diagnostics: AgentBlueprintDiagnostic[],
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    add(diagnostics, "INVALID_VALUE", path, "Expected a non-empty string.");
  }
}

function enumValue(
  value: unknown,
  choices: readonly string[],
  path: string,
  diagnostics: AgentBlueprintDiagnostic[],
): void {
  if (typeof value !== "string" || !choices.includes(value)) {
    add(
      diagnostics,
      "INVALID_VALUE",
      path,
      `Expected one of: ${choices.join(", ")}.`,
    );
  }
}

function uniqueStrings(
  values: readonly string[] | undefined,
  path: string,
  diagnostics: AgentBlueprintDiagnostic[],
): void {
  if (!Array.isArray(values)) {
    add(diagnostics, "INVALID_VALUE", path, "Expected an array.");
    return;
  }
  const seen = new Set<string>();
  values.forEach((value, index) => {
    nonEmpty(value, `${path}[${index}]`, diagnostics);
    if (seen.has(value)) {
      add(diagnostics, "DUPLICATE_REF", `${path}[${index}]`, `Duplicate ref "${value}".`);
    }
    seen.add(value);
  });
}

function add(
  diagnostics: AgentBlueprintDiagnostic[],
  code: AgentBlueprintDiagnosticCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}

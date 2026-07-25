import { createHash } from "node:crypto";

import {
  COMPILED_AGENT_DESCRIPTOR_SCHEMA,
  validateAgentBlueprint,
  validateCompiledAgentDescriptor,
  type AgentBlueprint,
  type AgentBlueprintDiagnostic,
  type AgentBlueprintStatus,
  type AgentHandlerDescriptor,
  type AgentHandlerKind,
  type AgentPersonaDefinition,
  type AgentPolicyDefinition,
  type AgentPromptTemplate,
  type AgentSchemaDefinition,
  type AgentTaskProfile,
  type AgentToolsetDefinition,
  type CompiledAgentDescriptor,
  type CompiledAgentPromptLayer,
} from "@dzupagent/runtime-contracts/agent-blueprint";

export interface AgentBlueprintCatalog {
  readonly personas: readonly AgentPersonaDefinition[];
  readonly tasks: readonly AgentTaskProfile[];
  readonly prompts: readonly AgentPromptTemplate[];
  readonly policies: readonly AgentPolicyDefinition[];
  readonly toolsets: readonly AgentToolsetDefinition[];
  readonly schemas: readonly AgentSchemaDefinition[];
  readonly handlers: readonly AgentHandlerDescriptor[];
}

export interface CompileAgentBlueprintOptions {
  readonly providerOverlayRefs?: readonly string[];
}

export class AgentBlueprintCompileError extends Error {
  constructor(readonly diagnostics: readonly AgentBlueprintDiagnostic[]) {
    super(
      diagnostics
        .map((diagnostic) => `${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`)
        .join("\n"),
    );
    this.name = "AgentBlueprintCompileError";
  }
}

export function compileAgentBlueprint(
  blueprint: AgentBlueprint,
  catalog: AgentBlueprintCatalog,
  options: CompileAgentBlueprintOptions = {},
): CompiledAgentDescriptor {
  const shape = validateAgentBlueprint(blueprint);
  if (!shape.valid) throw new AgentBlueprintCompileError(shape.diagnostics);

  const diagnostics: AgentBlueprintDiagnostic[] = [];
  const requirePublished = blueprint.status === "published";
  const persona = resolve(
    catalog.personas,
    blueprint.personaRef,
    "personaRef",
    requirePublished,
    diagnostics,
  );
  const task = resolve(
    catalog.tasks,
    blueprint.taskRef,
    "taskRef",
    requirePublished,
    diagnostics,
  );
  if (
    persona?.compatibleTaskRefs &&
    !persona.compatibleTaskRefs.includes(blueprint.taskRef)
  ) {
    diagnostics.push({
      code: "INCOMPATIBLE_PERSONA_TASK",
      path: "taskRef",
      message: `Persona "${blueprint.personaRef}" does not allow task "${blueprint.taskRef}".`,
    });
  }

  const promptLayers: CompiledAgentPromptLayer[] = [];
  if (persona) {
    const prompt = resolve(
      catalog.prompts,
      persona.promptRef,
      "persona.promptRef",
      requirePublished,
      diagnostics,
    );
    if (prompt) promptLayers.push(layer("persona", prompt));
  }
  if (task) {
    const prompt = resolve(
      catalog.prompts,
      task.promptRef,
      "task.promptRef",
      requirePublished,
      diagnostics,
    );
    if (prompt) promptLayers.push(layer("task", prompt));
  }
  for (const [index, ref] of (blueprint.promptOverlayRefs ?? []).entries()) {
    const prompt = resolve(
      catalog.prompts,
      ref,
      `promptOverlayRefs[${index}]`,
      requirePublished,
      diagnostics,
    );
    if (prompt) promptLayers.push(layer("blueprint-overlay", prompt));
  }
  for (const [index, ref] of (options.providerOverlayRefs ?? []).entries()) {
    const prompt = resolve(
      catalog.prompts,
      ref,
      `providerOverlayRefs[${index}]`,
      requirePublished,
      diagnostics,
    );
    if (prompt) promptLayers.push(layer("provider-overlay", prompt));
  }

  const inputSchema = resolve(
    catalog.schemas,
    blueprint.inputSchemaRef,
    "inputSchemaRef",
    requirePublished,
    diagnostics,
  );
  const outputSchema = resolve(
    catalog.schemas,
    blueprint.outputSchemaRef,
    "outputSchemaRef",
    requirePublished,
    diagnostics,
  );
  const toolset = resolve(
    catalog.toolsets,
    blueprint.toolsetRef,
    "toolsetRef",
    requirePublished,
    diagnostics,
  );
  const policy = resolve(
    catalog.policies,
    blueprint.policyRef,
    "policyRef",
    requirePublished,
    diagnostics,
  );
  const renderer = resolveHandler(
    catalog.handlers,
    blueprint.handlers.renderer,
    "renderer",
    "handlers.renderer",
    requirePublished,
    diagnostics,
  );
  const normalizer = blueprint.handlers.normalizer
    ? resolveHandler(
        catalog.handlers,
        blueprint.handlers.normalizer,
        "normalizer",
        "handlers.normalizer",
        requirePublished,
        diagnostics,
      )
    : undefined;
  const validators = resolveHandlers(
    catalog.handlers,
    blueprint.handlers.validators,
    "validator",
    "handlers.validators",
    requirePublished,
    diagnostics,
  );
  const evidenceResolvers = resolveHandlers(
    catalog.handlers,
    blueprint.handlers.evidenceResolvers ?? [],
    "evidence-resolver",
    "handlers.evidenceResolvers",
    requirePublished,
    diagnostics,
  );
  const postprocessors = resolveHandlers(
    catalog.handlers,
    blueprint.handlers.postprocessors ?? [],
    "postprocessor",
    "handlers.postprocessors",
    requirePublished,
    diagnostics,
  );

  if (
    diagnostics.length > 0 ||
    !inputSchema ||
    !outputSchema ||
    !toolset ||
    !policy ||
    !renderer
  ) {
    throw new AgentBlueprintCompileError(diagnostics);
  }

  const sourceRefs = unique([
    blueprint.personaRef,
    blueprint.taskRef,
    ...promptLayers.map(({ ref }) => ref),
    blueprint.inputSchemaRef,
    blueprint.outputSchemaRef,
    blueprint.toolsetRef,
    blueprint.policyRef,
    renderer.ref,
    ...(normalizer ? [normalizer.ref] : []),
    ...validators.map(({ ref }) => ref),
    ...evidenceResolvers.map(({ ref }) => ref),
    ...postprocessors.map(({ ref }) => ref),
  ]);
  const unsigned = {
    schema: COMPILED_AGENT_DESCRIPTOR_SCHEMA,
    id: blueprint.id,
    blueprintVersion: blueprint.version,
    personaRef: blueprint.personaRef,
    taskRef: blueprint.taskRef,
    promptLayers,
    inputSchema: inputSchema.schema,
    outputSchema: outputSchema.schema,
    tools: unique(toolset.tools),
    policy: policy.value,
    handlers: {
      renderer,
      ...(normalizer ? { normalizer } : {}),
      validators,
      evidenceResolvers,
      postprocessors,
    },
    evidenceKinds: unique(blueprint.evidenceKinds),
    authorityEffect: blueprint.authorityEffect,
    sourceRefs,
  } as const;
  const descriptor: CompiledAgentDescriptor = {
    ...unsigned,
    fingerprint: fingerprintCompiledAgentDescriptor(unsigned),
  };
  const validation = validateCompiledAgentDescriptor(descriptor);
  if (!validation.valid) throw new AgentBlueprintCompileError(validation.diagnostics);
  return deepFreeze(descriptor);
}

export function fingerprintCompiledAgentDescriptor(
  descriptor: Omit<CompiledAgentDescriptor, "fingerprint">,
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalize(descriptor))
    .digest("hex")}`;
}

export function verifyCompiledAgentDescriptorFingerprint(
  descriptor: CompiledAgentDescriptor,
): boolean {
  const { fingerprint, ...unsigned } = descriptor;
  return fingerprintCompiledAgentDescriptor(unsigned) === fingerprint;
}

function resolve<T extends { readonly ref: string; readonly status: AgentBlueprintStatus }>(
  entries: readonly T[],
  ref: string,
  path: string,
  requirePublished: boolean,
  diagnostics: AgentBlueprintDiagnostic[],
): T | undefined {
  const matches = entries.filter((entry) => entry.ref === ref);
  if (matches.length !== 1) {
    diagnostics.push({
      code: matches.length === 0 ? "UNKNOWN_REF" : "DUPLICATE_REF",
      path,
      message:
        matches.length === 0
          ? `Unknown catalog ref "${ref}".`
          : `Catalog ref "${ref}" is declared more than once.`,
    });
    return undefined;
  }
  const entry = matches[0];
  if (requirePublished && entry?.status !== "published") {
    diagnostics.push({
      code: "UNPUBLISHED_REF",
      path,
      message: `Published blueprint cannot bind ${entry?.status} ref "${ref}".`,
    });
    return undefined;
  }
  return entry;
}

function resolveHandler(
  entries: readonly AgentHandlerDescriptor[],
  ref: string,
  expectedKind: AgentHandlerKind,
  path: string,
  requirePublished: boolean,
  diagnostics: AgentBlueprintDiagnostic[],
): AgentHandlerDescriptor | undefined {
  const handler = resolve(entries, ref, path, requirePublished, diagnostics);
  if (handler && handler.kind !== expectedKind) {
    diagnostics.push({
      code: "HANDLER_KIND_MISMATCH",
      path,
      message: `Handler "${ref}" is ${handler.kind}; expected ${expectedKind}.`,
    });
    return undefined;
  }
  return handler;
}

function resolveHandlers(
  entries: readonly AgentHandlerDescriptor[],
  refs: readonly string[],
  expectedKind: AgentHandlerKind,
  path: string,
  requirePublished: boolean,
  diagnostics: AgentBlueprintDiagnostic[],
): AgentHandlerDescriptor[] {
  return refs.flatMap((ref, index) => {
    const handler = resolveHandler(
      entries,
      ref,
      expectedKind,
      `${path}[${index}]`,
      requirePublished,
      diagnostics,
    );
    return handler ? [handler] : [];
  });
}

function layer(
  kind: CompiledAgentPromptLayer["kind"],
  prompt: AgentPromptTemplate,
): CompiledAgentPromptLayer {
  return {
    kind,
    ref: prompt.ref,
    content: prompt.content,
    contentSha256: `sha256:${createHash("sha256")
      .update(prompt.content)
      .digest("hex")}`,
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

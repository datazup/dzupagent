import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
} from "../primitives/built-ins.js";
import {
  FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW,
} from "@dzupagent/flow-ast";
import type {
  PrimitiveDefinitionV2,
  PrimitiveRegistryV2,
} from "../primitives/types.js";
import type { DslDiagnostic } from "../types.js";
import type {
  DslV2FrontendMetadata,
  DslV2StepLineage,
  LowerDslV2Result,
} from "./types.js";
import {
  withV2SourceLineage,
  type V2SourceLineageMarker,
} from "./source-lineage.js";
import {
  parseV2TypedCondition,
  type ParsedV2TypedCondition,
} from "./typed-condition.js";

const TOP_LEVEL_KEYS = new Set([
  "dsl",
  "id",
  "title",
  "description",
  "version",
  "inputs",
  "defaults",
  "tags",
  "meta",
  "durability",
  "steps",
]);
const STEP_KEYS = new Set([
  "id",
  "use",
  "with",
  "when",
  "save",
  "policy",
  "retry",
  "catch",
  "evidence",
  "annotations",
]);
const EXACT_USE_PATTERN =
  /^([A-Za-z][A-Za-z0-9_.-]*)@([A-Za-z0-9][A-Za-z0-9_.-]*)$/;
const STATE_TARGET_PATTERN = /^state\.([A-Za-z][A-Za-z0-9_]*)$/;
const LEGACY_OUTPUT_FIELDS: Readonly<Record<string, string | undefined>> =
  Object.freeze({
    "adapter.run": "output",
    http: "outputVar",
    "shell.run": "output",
    "evidence.write": "output",
    "validate.schema": "output",
  });

export interface LowerDslV2Options {
  readonly primitiveRegistryV2?: PrimitiveRegistryV2;
}

interface LoweringContext {
  readonly diagnostics: DslDiagnostic[];
  readonly registry: PrimitiveRegistryV2;
  readonly lineage: DslV2StepLineage[];
  readonly bindings: Map<
    PrimitiveDefinitionV2["ref"],
    `sha256:${string}`
  >;
  readonly namespaceVersions: Map<string, string>;
  readonly authoredStepIds: ReadonlySet<string>;
  readonly generatedGuardIds: Set<string>;
}

/** Lower the bounded v2 authoring subset into the existing v1 wrapper frontend. */
export function lowerDslV2Document(
  raw: unknown,
  options: LowerDslV2Options = {},
): LowerDslV2Result {
  const diagnostics: DslDiagnostic[] = [];
  if (!isRecord(raw)) {
    return failure("Top-level dzupflow/v2 document must be an object", "root");
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      diagnostics.push(unsupported(`Unsupported dzupflow/v2 field "${key}"`, `root.${key}`));
    }
  }
  if (raw.dsl !== "dzupflow/v2") {
    diagnostics.push({
      phase: "normalize",
      code: "INVALID_DSL_VERSION",
      message: 'v2 frontend requires dsl: "dzupflow/v2"',
      path: "root.dsl",
    });
  }
  if (raw.version !== "2.0.0") {
    diagnostics.push({
      phase: "normalize",
      code: "INVALID_ENUM_VALUE",
      message: 'dzupflow/v2 version must equal "2.0.0"',
      path: "root.version",
    });
  }
  if (nonEmptyString(raw.id) === undefined) {
    diagnostics.push(
      required("dzupflow/v2 id is required", "root.id"),
    );
  }
  const context: LoweringContext = {
    diagnostics,
    registry:
      options.primitiveRegistryV2 ?? BUILT_IN_PRIMITIVE_REGISTRY_V2,
    lineage: [],
    bindings: new Map(),
    namespaceVersions: new Map(),
    authoredStepIds: collectAuthoredStepIds(raw.steps),
    generatedGuardIds: new Set(),
  };
  const steps = lowerSteps(raw.steps, "root.steps", "steps", context);
  if (diagnostics.length > 0) {
    return {
      ok: false,
      raw: null,
      metadata: null,
      diagnostics: Object.freeze(diagnostics),
    };
  }

  const uses = Object.fromEntries(
    [...context.namespaceVersions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([namespace, version]) => [
        namespace,
        `dzup.${namespace}@${version}`,
      ]),
  );
  const lowered: Record<string, unknown> = {
    dsl: "dzupflow/v1",
    id: typeof raw.id === "string" ? raw.id : raw.id,
    version: 1,
    steps,
  };
  for (const key of [
    "title",
    "description",
    "inputs",
    "defaults",
    "tags",
    "meta",
    "durability",
  ]) {
    if (raw[key] !== undefined) lowered[key] = raw[key];
  }
  if (Object.keys(uses).length > 0) lowered.uses = uses;

  const metadata: DslV2FrontendMetadata = deepFreeze({
    schema: "dzupagent.dslV2Frontend/v1",
    authoredDsl: "dzupflow/v2",
    authoredVersion: "2.0.0",
    canonicalDsl: "dzupflow/v1",
    canonicalVersion: 1,
    stepLineage: context.lineage,
    primitiveBindings: [...context.bindings.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([ref, semanticHash]) => ({ ref, semanticHash })),
  }) as DslV2FrontendMetadata;
  return {
    ok: true,
    raw: deepFreeze(lowered) as Readonly<Record<string, unknown>>,
    metadata,
    diagnostics: [],
  };
}

function lowerSteps(
  raw: unknown,
  authoredPath: string,
  loweredPath: string,
  context: LoweringContext,
): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(raw)) {
    context.diagnostics.push({
      phase: "normalize",
      code: "MISSING_REQUIRED_FIELD",
      message: "dzupflow/v2 steps must be an array",
      path: authoredPath,
    });
    return [];
  }
  return raw.flatMap((step, index) => {
    const lowered = lowerStep(
      step,
      `${authoredPath}[${index}]`,
      `${loweredPath}[${index}]`,
      context,
    );
    return lowered === null ? [] : [lowered];
  });
}

function lowerStep(
  raw: unknown,
  authoredPath: string,
  loweredPath: string,
  context: LoweringContext,
): Readonly<Record<string, unknown>> | null {
  if (!isRecord(raw)) {
    context.diagnostics.push({
      phase: "normalize",
      code: "INVALID_NODE_SHAPE",
      message: "each dzupflow/v2 step must be an object",
      path: authoredPath,
    });
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!STEP_KEYS.has(key)) {
      context.diagnostics.push(
        unsupported(
          `Unsupported dzupflow/v2 step field "${key}"`,
          `${authoredPath}.${key}`,
        ),
      );
    }
  }
  const id = nonEmptyString(raw.id);
  const use = nonEmptyString(raw.use);
  if (id === undefined) {
    context.diagnostics.push(required("v2 step id is required", `${authoredPath}.id`));
  }
  if (use === undefined) {
    context.diagnostics.push(required("v2 step use is required", `${authoredPath}.use`));
    return null;
  }
  const match = EXACT_USE_PATTERN.exec(use);
  if (match === null) {
    context.diagnostics.push({
      phase: "normalize",
      code: "V2_UNPINNED_USE",
      message: `v2 step use must be exact kind@version; received "${use}"`,
      path: `${authoredPath}.use`,
    });
    return null;
  }
  rejectUnsupportedEnvelope(raw, authoredPath, context);
  const input = objectField(raw.with, `${authoredPath}.with`, context);
  const annotations = objectField(
    raw.annotations,
    `${authoredPath}.annotations`,
    context,
  );
  const evidence = objectField(
    raw.evidence,
    `${authoredPath}.evidence`,
    context,
  );
  const base = {
    ...(id === undefined ? {} : { id }),
    ...(annotations === undefined
      ? {}
      : { meta: { annotations } }),
    ...(evidence === undefined ? {} : { evidence }),
  };
  const kind = match[1]!;
  const version = match[2]!;
  const guard =
    kind === "core.branch" || raw.when === undefined
      ? undefined
      : parseV2TypedCondition(
          raw.when,
          `${authoredPath}.when`,
          context.diagnostics,
        );
  if (guard === null) return null;
  const childLoweredPath =
    guard === undefined ? loweredPath : `${loweredPath}.if.then[0]`;
  let lowered: Readonly<Record<string, unknown>> | null;
  if (kind.startsWith("core.")) {
    lowered = lowerCoreStep(
      kind,
      version,
      raw,
      input ?? {},
      base,
      authoredPath,
      childLoweredPath,
      context,
    );
  } else {
    const definition = context.registry.resolve(kind, version);
    if (definition === undefined) {
      context.diagnostics.push({
        phase: "normalize",
        code: "V2_UNKNOWN_PRIMITIVE",
        message: `v2 use "${use}" does not resolve to an exact V2 primitive`,
        path: `${authoredPath}.use`,
      });
      return null;
    }
    registerPrimitive(definition, authoredPath, context);
    const body: Record<string, unknown> = { ...base, ...(input ?? {}) };
    const saveBindings = lowerSave(
      raw.save,
      definition,
      body,
      authoredPath,
      context,
    );
    context.lineage.push({
      authoredPath,
      loweredPath: childLoweredPath,
      use,
      primitiveRef: definition.ref,
      primitiveSemanticHash: definition.compatibility.semanticHash,
    });
    lowered = {
      [kind]: withV2SourceLineage(body, {
        authoredPath,
        loweredPath: childLoweredPath,
        use,
        generated: false,
        primitiveRef: definition.ref,
        primitiveSemanticHash: definition.compatibility.semanticHash,
        ...(Object.keys(saveBindings).length === 0 ? {} : { saveBindings }),
      }),
    };
  }
  if (lowered === null || guard === undefined) return lowered;
  return wrapGuardedStep(
    lowered,
    guard,
    id!,
    use,
    authoredPath,
    loweredPath,
    context,
  );
}

function lowerCoreStep(
  kind: string,
  version: string,
  raw: Record<string, unknown>,
  input: Record<string, unknown>,
  base: Record<string, unknown>,
  authoredPath: string,
  loweredPath: string,
  context: LoweringContext,
): Readonly<Record<string, unknown>> | null {
  if (version !== "1") {
    context.diagnostics.push({
      phase: "normalize",
      code: "V2_UNKNOWN_KERNEL",
      message: `P3a does not support ${kind}@${version}`,
      path: `${authoredPath}.use`,
    });
    return null;
  }
  if (raw.save !== undefined) {
    context.diagnostics.push(
      unsupported(
        `P3a does not support save on ${kind}@${version}`,
        `${authoredPath}.save`,
      ),
    );
  }
  if (kind === "core.set") {
    context.lineage.push({ authoredPath, loweredPath, use: `${kind}@${version}` });
    return {
      set: withV2SourceLineage(
        { ...base, ...input },
        coreSourceLineage(kind, version, authoredPath, loweredPath),
      ),
    };
  }
  if (kind === "core.complete") {
    context.lineage.push({ authoredPath, loweredPath, use: `${kind}@${version}` });
    return {
      complete: withV2SourceLineage(
        { ...base, ...input },
        coreSourceLineage(kind, version, authoredPath, loweredPath),
      ),
    };
  }
  if (kind === "core.branch") {
    const legacyCondition =
      typeof raw.when === "string" && raw.when.length > 0
        ? raw.when
        : undefined;
    const typedCondition =
      legacyCondition !== undefined || raw.when === undefined
        ? undefined
        : parseV2TypedCondition(
            raw.when,
            `${authoredPath}.when`,
            context.diagnostics,
          );
    if (legacyCondition === undefined && typedCondition == null) {
      context.diagnostics.push(
        required(
          "core.branch@1 requires a string or typed boolean when expression",
          `${authoredPath}.when`,
        ),
      );
    }
    const allowed = new Set(["then", "else"]);
    for (const key of Object.keys(input)) {
      if (!allowed.has(key)) {
        context.diagnostics.push(
          unsupported(
            `core.branch@1 with.${key} is unsupported`,
            `${authoredPath}.with.${key}`,
          ),
        );
      }
    }
    context.lineage.push({ authoredPath, loweredPath, use: `${kind}@${version}` });
    const thenSteps = lowerSteps(
      input.then,
      `${authoredPath}.with.then`,
      `${loweredPath}.if.then`,
      context,
    );
    const elseSteps =
      input.else === undefined
        ? undefined
        : lowerSteps(
            input.else,
            `${authoredPath}.with.else`,
            `${loweredPath}.if.else`,
            context,
          );
    return {
      if: withV2SourceLineage(
        {
          ...base,
          condition:
            legacyCondition ??
            FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW,
          ...(typedCondition == null
            ? {}
            : { typedCondition: typedCondition.condition }),
          then: thenSteps,
          ...(elseSteps === undefined ? {} : { else: elseSteps }),
        },
        {
          ...coreSourceLineage(
            kind,
            version,
            authoredPath,
            loweredPath,
          ),
          ...(typedCondition == null
            ? {}
            : {
                typedConditionBindings:
                  typedCondition.sourceBindings,
              }),
        },
      ),
    };
  }
  context.diagnostics.push({
    phase: "normalize",
    code: "V2_UNKNOWN_KERNEL",
    message: `P3a kernel does not contain ${kind}@${version}`,
    path: `${authoredPath}.use`,
  });
  return null;
}

function wrapGuardedStep(
  lowered: Readonly<Record<string, unknown>>,
  guard: ParsedV2TypedCondition,
  id: string,
  use: string,
  authoredPath: string,
  loweredPath: string,
  context: LoweringContext,
): Readonly<Record<string, unknown>> | null {
  const guardId = `${id}__when_guard`;
  if (
    context.authoredStepIds.has(guardId) ||
    context.generatedGuardIds.has(guardId)
  ) {
    context.diagnostics.push({
      phase: "normalize",
      code: "V2_GUARD_ID_CONFLICT",
      message:
        `generated v2 when guard id "${guardId}" conflicts with another step`,
      path: `${authoredPath}.id`,
    });
    return null;
  }
  context.generatedGuardIds.add(guardId);
  for (let index = context.lineage.length - 1; index >= 0; index -= 1) {
    const entry = context.lineage[index];
    if (entry?.authoredPath !== authoredPath) continue;
    context.lineage[index] = {
      ...entry,
      guardId,
      guardLoweredPath: loweredPath,
    };
    break;
  }
  return {
    if: withV2SourceLineage(
      {
        id: guardId,
        condition: FLOW_TYPED_CONDITION_FAIL_CLOSED_SHADOW,
        typedCondition: guard.condition,
        then: [lowered],
      },
      {
        authoredPath,
        loweredPath,
        use,
        generated: false,
        guardedStep: true,
        typedConditionBindings: guard.sourceBindings,
      },
    ),
  };
}

function lowerSave(
  raw: unknown,
  definition: PrimitiveDefinitionV2,
  body: Record<string, unknown>,
  authoredPath: string,
  context: LoweringContext,
): Readonly<Record<string, string>> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    context.diagnostics.push({
      phase: "normalize",
      code: "INVALID_NODE_SHAPE",
      message: "v2 save must map one output port to state.<key>",
      path: `${authoredPath}.save`,
    });
    return {};
  }
  const entries = Object.entries(raw);
  if (entries.length !== 1) {
    context.diagnostics.push({
      phase: "normalize",
      code: "V2_UNSUPPORTED_SAVE",
      message: "P3a supports exactly one saved primitive output",
      path: `${authoredPath}.save`,
    });
    return {};
  }
  const [port, target] = entries[0]!;
  if (!(port in definition.outputPorts)) {
    context.diagnostics.push({
      phase: "normalize",
      code: "V2_UNKNOWN_OUTPUT_PORT",
      message: `primitive ${definition.ref} does not declare output port "${port}"`,
      path: `${authoredPath}.save.${port}`,
    });
    return {};
  }
  if (typeof target !== "string") {
    context.diagnostics.push({
      phase: "normalize",
      code: "V2_INVALID_SAVE_TARGET",
      message: "P3a save target must be state.<key>",
      path: `${authoredPath}.save.${port}`,
    });
    return {};
  }
  const targetMatch = STATE_TARGET_PATTERN.exec(target);
  if (targetMatch === null) {
    context.diagnostics.push({
      phase: "normalize",
      code: "V2_INVALID_SAVE_TARGET",
      message: `P3a save target must be state.<key>; received "${target}"`,
      path: `${authoredPath}.save.${port}`,
    });
    return {};
  }
  const outputField = LEGACY_OUTPUT_FIELDS[primitiveKind(definition)];
  if (outputField === undefined) {
    context.diagnostics.push({
      phase: "normalize",
      code: "V2_UNSUPPORTED_SAVE",
      message: `P3a has no canonical v1 save adapter for ${definition.ref}`,
      path: `${authoredPath}.save`,
    });
    return {};
  }
  body[outputField] = targetMatch[1]!;
  return { [outputField]: port };
}

function coreSourceLineage(
  kind: string,
  version: string,
  authoredPath: string,
  loweredPath: string,
): V2SourceLineageMarker {
  return {
    authoredPath,
    loweredPath,
    use: `${kind}@${version}`,
    generated: false,
  };
}

function registerPrimitive(
  definition: PrimitiveDefinitionV2,
  authoredPath: string,
  context: LoweringContext,
): void {
  context.bindings.set(
    definition.ref,
    definition.compatibility.semanticHash,
  );
  if (definition.namespace.length === 0) return;
  const prior = context.namespaceVersions.get(definition.namespace);
  if (prior !== undefined && prior !== definition.version) {
    context.diagnostics.push({
      phase: "normalize",
      code: "V2_NAMESPACE_VERSION_CONFLICT",
      message: `P3a cannot lower ${definition.namespace}@${prior} and ${definition.namespace}@${definition.version} through one v1 namespace import`,
      path: `${authoredPath}.use`,
    });
    return;
  }
  context.namespaceVersions.set(definition.namespace, definition.version);
}

function rejectUnsupportedEnvelope(
  raw: Record<string, unknown>,
  path: string,
  context: LoweringContext,
): void {
  for (const key of ["policy", "retry", "catch"]) {
    if (raw[key] !== undefined) {
      context.diagnostics.push(
        unsupported(
          `P3a recognizes but does not yet lower ${key}`,
          `${path}.${key}`,
        ),
      );
    }
  }
}

function objectField(
  value: unknown,
  path: string,
  context: LoweringContext,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    context.diagnostics.push({
      phase: "normalize",
      code: "INVALID_NODE_SHAPE",
      message: `${path.split(".").at(-1)} must be an object`,
      path,
    });
    return undefined;
  }
  return value;
}

function primitiveKind(definition: PrimitiveDefinitionV2): string {
  return definition.namespace.length === 0
    ? definition.name
    : `${definition.namespace}.${definition.name}`;
}

function required(message: string, path: string): DslDiagnostic {
  return { phase: "normalize", code: "MISSING_REQUIRED_FIELD", message, path };
}

function unsupported(message: string, path: string): DslDiagnostic {
  return { phase: "normalize", code: "UNSUPPORTED_FIELD", message, path };
}

function failure(message: string, path: string): LowerDslV2Result {
  return {
    ok: false,
    raw: null,
    metadata: null,
    diagnostics: [required(message, path)],
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function collectAuthoredStepIds(value: unknown): ReadonlySet<string> {
  const ids = new Set<string>();
  const visit = (steps: unknown): void => {
    if (!Array.isArray(steps)) return;
    for (const step of steps) {
      if (!isRecord(step)) continue;
      if (typeof step.id === "string" && step.id.length > 0) {
        ids.add(step.id);
      }
      if (!isRecord(step.with)) continue;
      visit(step.with.then);
      visit(step.with.else);
    }
  };
  visit(value);
  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => deepFreeze(item)));
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        deepFreeze(nested),
      ]),
    ),
  );
}

import { BUILT_IN_PRIMITIVE_REGISTRY_V2 } from "../primitives/built-ins.js";
import type { PrimitiveRegistryV2 } from "../primitives/types.js";
import type { DslDiagnostic } from "../types.js";
import type {
  DslV2ExternalImportCatalogs,
  DslV2FrontendMetadata,
  LowerDslV2Result,
} from "./types.js";
import { withV2SourceLineage } from "./source-lineage.js";
import { parseV2TypedCondition } from "./typed-condition.js";
import type { PrimitivePolicyLimits } from "./policy-narrowing.js";
import type { V2LoweringContext } from "./lower-v2-context.js";
import { lowerV2CoreStep, wrapV2GuardedStep } from "./lower-v2-kernel.js";
import {
  lowerV2PolicyNarrowing,
  lowerV2RetryPolicy,
  lowerV2TerminalCatch,
  lowerV2Save,
  registerV2Primitive,
} from "./lower-v2-primitive.js";
import {
  createV2ResolvedImportLock,
  effectiveV2PrimitiveImports,
  parseV2ExternalImports,
  parseV2PrimitiveImports,
  validateV2PrimitiveImportClosure,
} from "./imports.js";
import {
  createV2ImportLockChainEntry,
  type DslV2ImportLockChainEntry,
} from "./import-lock-chain.js";

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
  "imports",
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

/**
 * Primitive kinds whose canonical v1 node is named differently. `agent.run@1`
 * lowers to a v1 `action` node: the primitive is deliberately not kinded
 * `action`, because the compiler resolves v2 contracts by v1 node kind and an
 * `action`-kinded primitive would shadow host tool-registry security policy.
 */
const V1_NODE_FOR_PRIMITIVE_KIND: Readonly<Record<string, string | undefined>> =
  Object.freeze({
    "agent.run": "action",
  });

export interface LowerDslV2Options {
  readonly primitiveRegistryV2?: PrimitiveRegistryV2;
  readonly inheritedPolicy?: PrimitivePolicyLimits;
  readonly importCatalogs?: DslV2ExternalImportCatalogs;
  /**
   * The chain entry this lowering supersedes, if any. Omit to root a new
   * revision line; supply the previous lowering's entry to extend one.
   */
  readonly priorImportLockChainEntry?: DslV2ImportLockChainEntry;
}

/** Lower the bounded v2 authoring subset into the existing v1 wrapper frontend. */
export function lowerDslV2Document(
  raw: unknown,
  options: LowerDslV2Options = {}
): LowerDslV2Result {
  const diagnostics: DslDiagnostic[] = [];
  if (!isRecord(raw)) {
    return failure("Top-level dzupflow/v2 document must be an object", "root");
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      diagnostics.push(
        unsupported(`Unsupported dzupflow/v2 field "${key}"`, `root.${key}`)
      );
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
    diagnostics.push(required("dzupflow/v2 id is required", "root.id"));
  }
  const context: V2LoweringContext = {
    diagnostics,
    registry: options.primitiveRegistryV2 ?? BUILT_IN_PRIMITIVE_REGISTRY_V2,
    lineage: [],
    bindings: new Map(),
    namespaceVersions: new Map(),
    authoredStepIds: collectAuthoredStepIds(raw.steps),
    generatedGuardIds: new Set(),
    inheritedPolicy: options.inheritedPolicy ?? {},
    policyNarrowings: [],
    retryPolicies: [],
    terminalCatches: [],
    multiPortSaves: [],
  };
  const imports = parseV2PrimitiveImports(
    raw.imports,
    context.registry,
    diagnostics
  );
  const externalImports = parseV2ExternalImports(
    raw.imports,
    options.importCatalogs,
    diagnostics
  );
  const steps = lowerSteps(raw.steps, "root.steps", "steps", context);
  validateV2PrimitiveImportClosure(imports, context.bindings, diagnostics);
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
      ])
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

  const primitiveImports = effectiveV2PrimitiveImports(
    imports,
    context.bindings
  );
  const resolvedImportLock = createV2ResolvedImportLock(
    primitiveImports,
    externalImports
  );
  const metadata: DslV2FrontendMetadata = deepFreeze({
    schema: "dzupagent.dslV2Frontend/v1",
    authoredDsl: "dzupflow/v2",
    authoredVersion: "2.0.0",
    canonicalDsl: "dzupflow/v1",
    canonicalVersion: 1,
    primitiveImportMode: imports.explicit ? "explicit" : "derived",
    primitiveImports,
    resolvedImportLock,
    importLockChainEntry: createV2ImportLockChainEntry(
      resolvedImportLock,
      options.priorImportLockChainEntry
    ),
    stepLineage: context.lineage,
    primitiveBindings: [...context.bindings.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([ref, semanticHash]) => ({ ref, semanticHash })),
    policyNarrowings: context.policyNarrowings,
    retryPolicies: context.retryPolicies,
    terminalCatches: context.terminalCatches,
    multiPortSaves: context.multiPortSaves,
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
  context: V2LoweringContext
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
      context
    );
    return lowered === null ? [] : [lowered];
  });
}

function lowerStep(
  raw: unknown,
  authoredPath: string,
  loweredPath: string,
  context: V2LoweringContext
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
          `${authoredPath}.${key}`
        )
      );
    }
  }
  const id = nonEmptyString(raw.id);
  const use = nonEmptyString(raw.use);
  if (id === undefined) {
    context.diagnostics.push(
      required("v2 step id is required", `${authoredPath}.id`)
    );
  }
  if (use === undefined) {
    context.diagnostics.push(
      required("v2 step use is required", `${authoredPath}.use`)
    );
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
  const input = objectField(raw.with, `${authoredPath}.with`, context);
  const annotations = objectField(
    raw.annotations,
    `${authoredPath}.annotations`,
    context
  );
  const evidence = objectField(
    raw.evidence,
    `${authoredPath}.evidence`,
    context
  );
  const base = {
    ...(id === undefined ? {} : { id }),
    ...(annotations === undefined ? {} : { meta: { annotations } }),
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
          context.diagnostics
        );
  if (guard === null) return null;
  const childLoweredPath =
    guard === undefined ? loweredPath : `${loweredPath}.if.then[0]`;
  let lowered: Readonly<Record<string, unknown>> | null;
  if (kind.startsWith("core.")) {
    lowered = lowerV2CoreStep(
      kind,
      version,
      raw,
      input ?? {},
      base,
      authoredPath,
      childLoweredPath,
      context,
      lowerSteps
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
    registerV2Primitive(definition, authoredPath, context);
    const policyNarrowing = lowerV2PolicyNarrowing(
      raw.policy,
      definition,
      authoredPath,
      context
    );
    const retryPolicy = lowerV2RetryPolicy(
      raw.retry,
      definition,
      authoredPath,
      context
    );
    const terminalCatch = lowerV2TerminalCatch(
      raw.catch,
      definition,
      authoredPath,
      context
    );
    const body: Record<string, unknown> = { ...base, ...(input ?? {}) };
    const saveResult = lowerV2Save(
      raw.save,
      definition,
      body,
      authoredPath,
      context,
      {
        guarded: guard !== undefined,
        terminalCatchContinues:
          terminalCatch?.clauses.some(
            (clause) => clause.outcome.action === "continue"
          ) === true,
      }
    );
    context.lineage.push({
      authoredPath,
      loweredPath: childLoweredPath,
      use,
      primitiveRef: definition.ref,
      primitiveSemanticHash: definition.compatibility.semanticHash,
    });
    lowered = {
      [V1_NODE_FOR_PRIMITIVE_KIND[kind] ?? kind]: withV2SourceLineage(body, {
        authoredPath,
        loweredPath: childLoweredPath,
        use,
        generated: false,
        primitiveRef: definition.ref,
        primitiveSemanticHash: definition.compatibility.semanticHash,
        ...(policyNarrowing === undefined ? {} : { policyNarrowing }),
        ...(retryPolicy === undefined ? {} : { retryPolicy }),
        ...(terminalCatch === undefined ? {} : { terminalCatch }),
        ...(Object.keys(saveResult.legacyBindings).length === 0
          ? {}
          : { saveBindings: saveResult.legacyBindings }),
        ...(saveResult.multiPortSave === undefined
          ? {}
          : { multiPortSave: saveResult.multiPortSave }),
      }),
    };
  }
  if (lowered === null || guard === undefined) return lowered;
  return wrapV2GuardedStep(
    lowered,
    guard,
    id!,
    use,
    authoredPath,
    loweredPath,
    context
  );
}

function objectField(
  value: unknown,
  path: string,
  context: V2LoweringContext
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
      Object.entries(value).map(([key, nested]) => [key, deepFreeze(nested)])
    )
  );
}

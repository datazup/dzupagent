import type { FlowDocumentV1, FlowNode } from "@dzupagent/flow-ast";

import { BUILT_IN_PRIMITIVE_REGISTRY_V2 } from "../primitives/built-ins.js";
import { primitiveKind } from "../primitives/definition-v2.js";
import type { PrimitiveDefinitionV2 } from "../primitives/types.js";
import type { PrimitiveRegistryV2 } from "../primitives/types.js";
import { parseDslToDocument } from "../parse-dsl.js";
import { parseYamlSubset } from "../mini-yaml.js";
import type { DslDiagnostic } from "../types.js";
import {
  DSL_V2_AUTHORING_ID,
  type DslV1ToV2MigrationItem,
  type DslV1ToV2MigrationReport,
  type DslV2AuthoringOptions,
} from "./contracts.js";
import { sha256, stableStringify } from "./canonical.js";
import { reverseV2Condition } from "./condition-conversion.js";
import { formatDslV2Document, v2AuthoringAuthority } from "./source-import.js";

const OUTPUT_FIELDS: Readonly<Record<string, string | undefined>> =
  Object.freeze({
    "adapter.run": "output",
    http: "outputVar",
    "shell.run": "output",
    "evidence.write": "output",
    "validate.schema": "output",
  });

interface MigrationContext {
  readonly registry: PrimitiveRegistryV2;
  readonly items: DslV1ToV2MigrationItem[];
  readonly primitiveUses: Readonly<Record<string, string>>;
  readonly imports: Map<PrimitiveDefinitionV2["ref"], `sha256:${string}`>;
}

/** Analyze and, only when exact, materialize a report-only V1-to-V2 candidate. */
export function previewDslV1ToV2Migration(
  source: string,
  options: DslV2AuthoringOptions = {}
): DslV1ToV2MigrationReport {
  const sourceSha256 = sha256(source);
  const raw = parseYamlSubset(source);
  if (!raw.ok) {
    return finalize({
      sourceSha256,
      classification: "invalid",
      items: [],
      diagnostics: raw.errors.map((error) => ({
        phase: "parse" as const,
        code: error.code,
        message: error.message,
        path: "root",
        span: {
          lineStart: error.line,
          columnStart: error.column,
          lineEnd: error.line,
          columnEnd: error.column,
        },
      })),
      canonicalEquivalent: false,
    });
  }
  if (!isPlainRecord(raw.value) || raw.value.dsl !== "dzupflow/v1") {
    return finalize({
      sourceSha256,
      classification: "invalid",
      items: [],
      diagnostics: [
        diagnostic(
          "V1_TO_V2_SOURCE_REQUIRED",
          "report-only migration accepts an explicit dzupflow/v1 source",
          "root.dsl"
        ),
      ],
      canonicalEquivalent: false,
    });
  }

  const parsed = parseDslToDocument(source);
  if (!parsed.ok) {
    return finalize({
      sourceSha256,
      classification: "invalid",
      items: [],
      diagnostics: parsed.diagnostics,
      canonicalEquivalent: false,
    });
  }

  const context: MigrationContext = {
    registry: options.primitiveRegistryV2 ?? BUILT_IN_PRIMITIVE_REGISTRY_V2,
    items: [],
    primitiveUses: readPrimitiveUses(parsed.document),
    imports: new Map(),
  };
  const steps = migrateNodes(parsed.document.root.nodes, "root.steps", context);
  const preliminary = overallClassification(context.items);
  const sourceSemanticSha256 = sha256(stableStringify(parsed.document));
  if (preliminary !== "equivalent") {
    return finalize({
      sourceSha256,
      classification: preliminary,
      items: context.items,
      diagnostics: [],
      sourceSemanticSha256,
      canonicalEquivalent: false,
    });
  }

  const candidateRaw = buildCandidateDocument(
    parsed.document,
    steps,
    context.imports
  );
  const formatted = formatDslV2Document(candidateRaw, options);
  if (!formatted.ok) {
    context.items.push({
      path: "root",
      nodeType: "document",
      classification: "lossy",
      reason: "generated candidate did not satisfy the bounded V2 frontend",
    });
    return finalize({
      sourceSha256,
      classification: "lossy",
      items: context.items,
      diagnostics: formatted.diagnostics,
      primitiveImports: listImports(context.imports),
      sourceSemanticSha256,
      canonicalEquivalent: false,
    });
  }

  const equivalent =
    stableStringify(parsed.document) ===
    stableStringify(formatted.canonicalDocument);
  if (!equivalent) {
    context.items.push({
      path: "root",
      nodeType: "document",
      classification: "lossy",
      reason: "candidate canonical document differs from the V1 source",
    });
    return finalize({
      sourceSha256,
      classification: "lossy",
      items: context.items,
      diagnostics: [],
      primitiveImports: listImports(context.imports),
      sourceSemanticSha256,
      candidateSemanticSha256: formatted.semanticSha256,
      canonicalEquivalent: false,
    });
  }

  return finalize({
    sourceSha256,
    classification: "equivalent",
    items: context.items,
    diagnostics: [],
    primitiveImports: listImports(context.imports),
    candidateSource: formatted.canonicalSource,
    candidateSourceSha256: formatted.canonicalSourceSha256,
    sourceSemanticSha256,
    candidateSemanticSha256: formatted.semanticSha256,
    canonicalEquivalent: true,
  });
}

function migrateNodes(
  nodes: readonly FlowNode[],
  path: string,
  context: MigrationContext
): readonly Readonly<Record<string, unknown>>[] {
  return nodes.map((node, index) =>
    migrateNode(node, `${path}[${index}]`, context)
  );
}

function migrateNode(
  node: FlowNode,
  path: string,
  context: MigrationContext
): Readonly<Record<string, unknown>> {
  const commonIssue = unsupportedCommonField(node);
  if (commonIssue !== undefined) {
    context.items.push(item(path, node.type, "lossy", commonIssue));
    return placeholder(node, path);
  }
  if (typeof node.id !== "string" || node.id.length === 0) {
    context.items.push(
      item(path, node.type, "unsupported", "node has no stable id")
    );
    return placeholder(node, path);
  }
  if (node.type === "set") {
    context.items.push(
      item(path, node.type, "equivalent", "maps to core.set@1")
    );
    return {
      id: node.id,
      use: "core.set@1",
      with: { assign: clone(node.assign) },
    };
  }
  if (node.type === "complete") {
    context.items.push(
      item(path, node.type, "equivalent", "maps to core.complete@1")
    );
    return {
      id: node.id,
      use: "core.complete@1",
      with: node.result === undefined ? {} : { result: node.result },
    };
  }
  if (node.type === "branch") {
    const when = reverseV2Condition(node);
    if (when === undefined) {
      context.items.push(
        item(
          path,
          node.type,
          "unsupported",
          "branch condition cannot be represented by the bounded deterministic V2 syntax"
        )
      );
      return placeholder(node, path);
    }
    const thenSteps = migrateNodes(node.then, `${path}.then`, context);
    const elseSteps =
      node.else === undefined
        ? undefined
        : migrateNodes(node.else, `${path}.else`, context);
    context.items.push(
      item(path, node.type, "equivalent", "maps to core.branch@1")
    );
    return {
      id: node.id,
      use: "core.branch@1",
      when,
      with: {
        then: thenSteps,
        ...(elseSteps === undefined ? {} : { else: elseSteps }),
      },
    };
  }

  const candidates = context.registry
    .list()
    .filter((definition) => primitiveKind(definition) === node.type);
  const namespace = candidates[0]?.namespace;
  const version =
    namespace === undefined
      ? undefined
      : pinnedNamespaceVersion(context.primitiveUses[namespace], namespace);
  const definition =
    version === undefined
      ? undefined
      : context.registry.resolve(node.type, version);
  if (definition === undefined || definition.category === "composite") {
    context.items.push(
      item(
        path,
        node.type,
        "unsupported",
        namespace === undefined
          ? "no exact non-composite V2 primitive maps this V1 node"
          : `an exact uses.${namespace} version pin is required for V2 migration`
      )
    );
    return placeholder(node, path);
  }
  context.imports.set(definition.ref, definition.compatibility.semanticHash);
  const body = clone(node) as unknown as Record<string, unknown>;
  // Child steps are V1 nodes and must be migrated too; carrying them through
  // verbatim would embed a V1 subtree inside the V2 candidate.
  if (node.type === "loop") {
    body.body = migrateNodes(node.body, `${path}.body`, context);
  }
  delete body.type;
  delete body.id;
  const outputField = OUTPUT_FIELDS[node.type];
  const output = outputField === undefined ? undefined : body[outputField];
  if (outputField !== undefined) delete body[outputField];
  if (
    output !== undefined &&
    (typeof output !== "string" || output.length === 0)
  ) {
    context.items.push(
      item(
        path,
        node.type,
        "unsupported",
        `${outputField} is not a stable state key`
      )
    );
    return placeholder(node, path);
  }
  const outputPort =
    definition.outputPorts.result === undefined
      ? Object.keys(definition.outputPorts).sort()[0]
      : "result";
  if (output !== undefined && outputPort === undefined) {
    context.items.push(
      item(
        path,
        node.type,
        "unsupported",
        "V1 output has no exact V2 output port"
      )
    );
    return placeholder(node, path);
  }
  context.items.push(
    item(path, node.type, "equivalent", `maps to ${node.type}@${version}`)
  );
  return {
    id: node.id,
    use: `${node.type}@${version}`,
    with: body,
    ...(output === undefined || outputPort === undefined
      ? {}
      : { save: { [outputPort]: `state.${output}` } }),
  };
}

function buildCandidateDocument(
  document: FlowDocumentV1,
  steps: readonly Readonly<Record<string, unknown>>[],
  imports: ReadonlyMap<PrimitiveDefinitionV2["ref"], `sha256:${string}`>
): Readonly<Record<string, unknown>> {
  const meta =
    document.meta === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(document.meta).filter(
            ([key]) => key !== "primitiveUses" && key !== "fragmentUses"
          )
        );
  return {
    dsl: "dzupflow/v2",
    id: document.id,
    ...(document.title === undefined ? {} : { title: document.title }),
    ...(document.description === undefined
      ? {}
      : { description: document.description }),
    version: "2.0.0",
    ...(imports.size === 0
      ? {}
      : { imports: { primitives: listImports(imports) } }),
    ...(document.inputs === undefined
      ? {}
      : { inputs: clone(document.inputs) }),
    ...(document.defaults === undefined
      ? {}
      : { defaults: clone(document.defaults) }),
    ...(document.tags === undefined ? {} : { tags: [...document.tags] }),
    ...(meta === undefined || Object.keys(meta).length === 0
      ? {}
      : { meta: clone(meta) }),
    ...(document.durability === undefined
      ? {}
      : { durability: clone(document.durability) }),
    steps,
  };
}

function readPrimitiveUses(
  document: FlowDocumentV1
): Readonly<Record<string, string>> {
  const value = document.meta?.primitiveUses;
  if (!isPlainRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

function pinnedNamespaceVersion(
  value: string | undefined,
  namespace: string
): string | undefined {
  if (value === undefined) return undefined;
  const escaped = namespace.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `^dzup\\.${escaped}@([A-Za-z0-9][A-Za-z0-9_.-]*)$`,
    "u"
  ).exec(value)?.[1];
}

function listImports(
  imports: ReadonlyMap<PrimitiveDefinitionV2["ref"], `sha256:${string}`>
) {
  return [...imports.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ref, semanticHash]) => ({ ref, semanticHash }));
}

function unsupportedCommonField(node: FlowNode): string | undefined {
  if (node.name !== undefined)
    return "node.name has no bounded V2 envelope field";
  if (node.description !== undefined)
    return "node.description has no bounded V2 envelope field";
  if (node.meta !== undefined && Object.keys(node.meta).length > 0) {
    return "arbitrary V1 node metadata cannot be rewritten as V2 annotations without a semantic change";
  }
  return undefined;
}

function placeholder(
  node: FlowNode,
  path: string
): Readonly<Record<string, unknown>> {
  return {
    id: node.id ?? `unsupported_${path.replace(/[^A-Za-z0-9_]/gu, "_")}`,
    use: "core.complete@1",
    with: { result: "unsupported" },
  };
}

function overallClassification(
  items: readonly DslV1ToV2MigrationItem[]
): "equivalent" | "lossy" | "unsupported" {
  if (items.some((entry) => entry.classification === "unsupported")) {
    return "unsupported";
  }
  return items.some((entry) => entry.classification === "lossy")
    ? "lossy"
    : "equivalent";
}

function item(
  path: string,
  nodeType: string,
  classification: DslV1ToV2MigrationItem["classification"],
  reason: string
): DslV1ToV2MigrationItem {
  return { path, nodeType, classification, reason };
}

function finalize(
  input: Omit<
    DslV1ToV2MigrationReport,
    "schema" | "authoringId" | "reportSha256" | "authority"
  >
): DslV1ToV2MigrationReport {
  const core = {
    schema: "dzupagent.dslV1ToV2MigrationReport/v1" as const,
    authoringId: DSL_V2_AUTHORING_ID,
    ...input,
    authority: v2AuthoringAuthority(),
  };
  return deepFreeze({
    ...core,
    reportSha256: sha256(stableStringify(core)),
  });
}

function diagnostic(
  code: string,
  message: string,
  path: string
): DslDiagnostic {
  return { phase: "normalize", code, message, path };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) value.forEach((item) => deepFreeze(item));
  else Object.values(value).forEach((item) => deepFreeze(item));
  return Object.freeze(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

import {
  FLOW_NODE_KINDS,
  isFlowNodeKind,
  type FlowNodeKind,
} from "@dzupagent/flow-ast";
import {
  BUILT_IN_PRIMITIVES,
  BUILT_IN_SDL_FRAGMENT_DEFINITIONS,
  type PrimitiveDefinition,
} from "@dzupagent/flow-dsl";
import {
  EXECUTION_LEAF_KINDS,
  type ExecutionLeafKind,
} from "@dzupagent/runtime-contracts/orchestration";

import { FLOW_NODE_CAPABILITY_REGISTRY } from "../capability-manifest/node-registry.js";
import type {
  FlowSemanticCatalog,
  FlowSemanticCatalogDiagnostic,
  FlowSemanticExecutionLeafEntry,
  FlowSemanticFragmentEntry,
  FlowSemanticNodeClass,
  FlowSemanticNodeEntry,
  FlowSemanticPrimitiveEntry,
  PrimitiveExpansionTarget,
} from "./types.js";

const GENERATED_FROM = [
  "FLOW_NODE_KIND_REGISTRY",
  "FLOW_NODE_CAPABILITY_REGISTRY",
  "BUILT_IN_PRIMITIVES",
  "BUILT_IN_SDL_FRAGMENT_DEFINITIONS",
  "EXECUTION_LEAF_KINDS",
] as const;

const EXPANSION_NODE_ALIASES: Readonly<Record<string, FlowNodeKind>> =
  Object.freeze({
    if: "branch",
  });

export function generateFlowSemanticCatalog(): FlowSemanticCatalog {
  const diagnostics: FlowSemanticCatalogDiagnostic[] = [];
  const primitiveRefsByKind = indexPrimitiveRefs(BUILT_IN_PRIMITIVES);
  const fragmentRefsById = indexFragmentRefs();
  const executionLeafSet = new Set<string>(EXECUTION_LEAF_KINDS);

  const nodes = FLOW_NODE_KINDS.map((kind) =>
    createNodeEntry(kind, primitiveRefsByKind, executionLeafSet),
  ).sort(compareByIdentity);

  const primitives = BUILT_IN_PRIMITIVES.map((definition, index) =>
    createPrimitiveEntry(
      definition,
      index,
      primitiveRefsByKind,
      executionLeafSet,
      diagnostics,
    ),
  ).sort(compareByIdentity);

  const fragments = BUILT_IN_SDL_FRAGMENT_DEFINITIONS.map((fragment) => {
    const nodeKinds = new Set<FlowNodeKind>();
    const fragmentRefs = new Set<string>();
    collectFragmentSemantics(
      fragment.root,
      fragmentRefsById,
      nodeKinds,
      fragmentRefs,
    );
    const namespace = fragment.id.includes(".")
      ? fragment.id.split(".")[0]!
      : "default";
    return {
      identity: `fragment:${fragment.id}@${fragment.version}`,
      id: fragment.id,
      version: fragment.version,
      namespace,
      catalogRef: `dzup.${namespace}@1`,
      ...(fragment.description !== undefined
        ? { description: fragment.description }
        : {}),
      params: Object.keys(fragment.params ?? {}).sort(),
      exports: Object.keys(fragment.exports ?? {}).sort(),
      nodeKinds: [...nodeKinds].sort(),
      fragmentRefs: [...fragmentRefs].sort(),
    } satisfies FlowSemanticFragmentEntry;
  }).sort(compareByIdentity);

  const executionLeaves = EXECUTION_LEAF_KINDS.flatMap((kind) => {
    if (!isFlowNodeKind(kind)) {
      diagnostics.push({
        code: "EXECUTION_LEAF_WITHOUT_NODE",
        path: `executionLeaves.${kind}`,
        message: `Execution leaf "${kind}" has no public FlowNode mapping.`,
      });
      return [];
    }
    return [
      {
        identity: `execution-leaf:${kind}`,
        kind,
        nodeKind: kind,
        primitiveRefs: primitiveRefsByKind.get(kind) ?? [],
        runtimeCapability: `flow.runtime.${kind}@1`,
      } satisfies FlowSemanticExecutionLeafEntry,
    ];
  }).sort(compareByIdentity);

  detectDuplicateIdentities(
    [...nodes, ...primitives, ...fragments, ...executionLeaves],
    diagnostics,
  );

  return {
    schema: "dzupagent.flowSemanticCatalog/v1",
    generatedFrom: GENERATED_FROM,
    status: diagnostics.length === 0 ? "valid" : "invalid",
    summary: {
      nodes: nodes.length,
      primitives: primitives.length,
      fragments: fragments.length,
      executionLeaves: executionLeaves.length,
    },
    nodes,
    primitives,
    fragments,
    executionLeaves,
    diagnostics,
  };
}

function createNodeEntry(
  kind: FlowNodeKind,
  primitiveRefsByKind: ReadonlyMap<string, readonly string[]>,
  executionLeafSet: ReadonlySet<string>,
): FlowSemanticNodeEntry {
  const descriptor = FLOW_NODE_CAPABILITY_REGISTRY[kind];
  const primitiveRefs = primitiveRefsByKind.get(kind) ?? [];
  const executionLeaf = executionLeafSet.has(kind)
    ? (kind as ExecutionLeafKind)
    : undefined;
  const classification = classifyNode(
    descriptor.owner,
    descriptor.recommendedProfile,
    primitiveRefs,
    executionLeaf,
  );

  return {
    identity: `node:${kind}`,
    kind,
    classification,
    owner: descriptor.owner,
    profile: descriptor.recommendedProfile,
    status: descriptor.status,
    lowering: descriptor.lowering,
    currentRoute: descriptor.currentRoute,
    runtimeCapabilities: [...descriptor.runtimeCapabilities].sort(),
    primitiveRefs,
    ...(executionLeaf !== undefined ? { executionLeaf } : {}),
    deprecated: descriptor.deprecated,
    ...(descriptor.notes !== undefined ? { notes: descriptor.notes } : {}),
  };
}

function classifyNode(
  owner: FlowSemanticNodeEntry["owner"],
  profile: FlowSemanticNodeEntry["profile"],
  primitiveRefs: readonly string[],
  executionLeaf: ExecutionLeafKind | undefined,
): FlowSemanticNodeClass {
  if (owner === "codev") return "product-action";
  if (executionLeaf !== undefined) return "execution-leaf";
  if (primitiveRefs.length > 0) return "primitive";
  if (profile !== "dzup.core@1") return "profile-action";
  return "kernel";
}

function createPrimitiveEntry(
  definition: PrimitiveDefinition,
  index: number,
  primitiveRefsByKind: ReadonlyMap<string, readonly string[]>,
  executionLeafSet: ReadonlySet<string>,
  diagnostics: FlowSemanticCatalogDiagnostic[],
): FlowSemanticPrimitiveEntry {
  const path = `primitives[${index}]`;
  const expandsTo = (definition.expandsTo ?? []).map((target, targetIndex) =>
    resolveExpansionTarget(
      target,
      `${path}.expandsTo[${targetIndex}]`,
      primitiveRefsByKind,
      diagnostics,
    ),
  );

  let mode: FlowSemanticPrimitiveEntry["execution"]["mode"];
  if (definition.expand !== undefined) {
    mode = "macro";
  } else if (
    definition.executesWith !== undefined &&
    executionLeafSet.has(definition.executesWith)
  ) {
    mode = "execution-leaf";
  } else {
    mode = "host-action";
  }

  if (
    definition.expand === undefined &&
    (definition.executesWith === undefined ||
      (!isFlowNodeKind(definition.executesWith) &&
        !executionLeafSet.has(definition.executesWith)))
  ) {
    diagnostics.push({
      code: "UNRESOLVED_PRIMITIVE_EXECUTOR",
      path: `${path}.executesWith`,
      message: `Primitive "${definition.kind}@${definition.version}" has no resolvable node or execution-leaf target.`,
    });
  }

  return {
    identity: `primitive:${definition.kind}@${definition.version}`,
    kind: definition.kind,
    version: definition.version,
    namespace: definition.namespace,
    category: definition.category,
    ...(definition.description !== undefined
      ? { description: definition.description }
      : {}),
    schema: definition.schema,
    ...(definition.outputSchema !== undefined
      ? { outputSchema: definition.outputSchema }
      : {}),
    ...(definition.effectClass !== undefined
      ? { effectClass: definition.effectClass }
      : {}),
    ...(definition.idempotency !== undefined
      ? { idempotency: definition.idempotency }
      : {}),
    execution: {
      mode,
      ...(definition.executesWith !== undefined
        ? { target: definition.executesWith }
        : {}),
    },
    expandsTo,
  };
}

function resolveExpansionTarget(
  authored: string,
  path: string,
  primitiveRefsByKind: ReadonlyMap<string, readonly string[]>,
  diagnostics: FlowSemanticCatalogDiagnostic[],
): PrimitiveExpansionTarget {
  const resolved = EXPANSION_NODE_ALIASES[authored] ?? authored;
  const resolvedNodeKind = isFlowNodeKind(resolved) ? resolved : undefined;
  const primitiveRefs = primitiveRefsByKind.get(authored) ?? [];

  if (resolvedNodeKind === undefined && primitiveRefs.length === 0) {
    diagnostics.push({
      code: "UNRESOLVED_PRIMITIVE_EXPANSION",
      path,
      message: `Primitive expansion target "${authored}" resolves to neither a public node nor a registered primitive.`,
    });
  }

  return {
    authored,
    ...(resolvedNodeKind !== undefined ? { resolvedNodeKind } : {}),
    primitiveRefs,
  };
}

function indexPrimitiveRefs(
  definitions: readonly PrimitiveDefinition[],
): ReadonlyMap<string, readonly string[]> {
  const mutable = new Map<string, string[]>();
  for (const definition of definitions) {
    const refs = mutable.get(definition.kind) ?? [];
    refs.push(`${definition.kind}@${definition.version}`);
    mutable.set(definition.kind, refs);
  }
  return new Map(
    [...mutable.entries()].map(([kind, refs]) => [kind, refs.sort()]),
  );
}

function indexFragmentRefs(): ReadonlyMap<string, readonly string[]> {
  const mutable = new Map<string, string[]>();
  for (const fragment of BUILT_IN_SDL_FRAGMENT_DEFINITIONS) {
    const refs = mutable.get(fragment.id) ?? [];
    refs.push(`${fragment.id}@${fragment.version}`);
    mutable.set(fragment.id, refs);
  }
  return new Map(
    [...mutable.entries()].map(([id, refs]) => [id, refs.sort()]),
  );
}

/**
 * Built-in fragment definitions intentionally retain authored DSL wrappers in
 * a few nested bodies. Walk both canonical `{ type }` nodes and single-key
 * wrappers so the generated catalog reports source semantics rather than
 * relying on unsafe casts.
 */
function collectFragmentSemantics(
  value: unknown,
  fragmentRefsById: ReadonlyMap<string, readonly string[]>,
  nodeKinds: Set<FlowNodeKind>,
  fragmentRefs: Set<string>,
  seen = new WeakSet<object>(),
): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item) =>
      collectFragmentSemantics(
        item,
        fragmentRefsById,
        nodeKinds,
        fragmentRefs,
        seen,
      ),
    );
    return;
  }

  const record = value as Record<string, unknown>;
  const type = record["type"];
  if (typeof type === "string") {
    if (isFlowNodeKind(type)) nodeKinds.add(type);
    for (const ref of fragmentRefsById.get(type) ?? []) {
      fragmentRefs.add(ref);
    }
  }

  for (const [key, nested] of Object.entries(record)) {
    if (isFlowNodeKind(key)) nodeKinds.add(key);
    for (const ref of fragmentRefsById.get(key) ?? []) {
      fragmentRefs.add(ref);
    }
    collectFragmentSemantics(
      nested,
      fragmentRefsById,
      nodeKinds,
      fragmentRefs,
      seen,
    );
  }
}

function detectDuplicateIdentities(
  entries: ReadonlyArray<{ readonly identity: string }>,
  diagnostics: FlowSemanticCatalogDiagnostic[],
): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (seen.has(entry.identity)) {
      diagnostics.push({
        code: "DUPLICATE_SEMANTIC_IDENTITY",
        path: `entries[${index}].identity`,
        message: `Duplicate semantic catalog identity "${entry.identity}".`,
      });
    }
    seen.add(entry.identity);
  });
}

function compareByIdentity<T extends { readonly identity: string }>(
  left: T,
  right: T,
): number {
  return left.identity.localeCompare(right.identity);
}

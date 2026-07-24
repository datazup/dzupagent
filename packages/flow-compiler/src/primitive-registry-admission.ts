import { createHash } from "node:crypto";

import type { FlowNode } from "@dzupagent/flow-ast";
import {
  BUILT_IN_PRIMITIVE_REGISTRY_V2,
  primitiveKind,
  type PrimitiveDefinitionV2,
  type PrimitiveRegistryV2,
} from "@dzupagent/flow-dsl";

import type {
  FlowPrimitiveBindings,
  FlowRequirementSummary,
} from "./types.js";
import { resolvePrimitiveDefinition } from "./stages/primitive-reference-ports.js";

export interface FlowPrimitiveRegistryValidation {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

export interface FlowPrimitiveRegistryReadiness {
  readonly ready: boolean;
  readonly registryHash: `sha256:${string}`;
  readonly selected: readonly {
    readonly kind: string;
    readonly ref: PrimitiveDefinitionV2["ref"];
    readonly semanticHash: PrimitiveDefinitionV2["compatibility"]["semanticHash"];
  }[];
  readonly missingCapabilities: readonly string[];
  readonly issues: readonly string[];
}

export interface FlowPrimitiveRegistryReadinessRequest {
  readonly root: FlowNode;
  readonly registry: PrimitiveRegistryV2;
  readonly bindings?: FlowPrimitiveBindings;
  readonly availableCapabilities: readonly string[];
}

export interface FlowPrimitiveSelectionIssue {
  readonly nodePath: string;
  readonly message: string;
}

/**
 * Validate that a custom registry is an additive extension and that every
 * external selection is bound to an exact ref and semantic hash.
 */
export function validateCompilerPrimitiveRegistry(
  registry: PrimitiveRegistryV2,
  bindings: FlowPrimitiveBindings = {},
): FlowPrimitiveRegistryValidation {
  const issues: string[] = [];
  for (const builtIn of BUILT_IN_PRIMITIVE_REGISTRY_V2.list()) {
    const candidate = registry.get(builtIn.ref);
    if (candidate === undefined) {
      issues.push(`registry is missing built-in primitive ${builtIn.ref}`);
    } else if (
      candidate.compatibility.semanticHash !==
      builtIn.compatibility.semanticHash
    ) {
      issues.push(`registry changes built-in primitive ${builtIn.ref}`);
    }
  }
  for (const [kind, binding] of Object.entries(bindings).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (binding === undefined) continue;
    const definition = registry.get(binding.ref);
    if (definition === undefined) {
      issues.push(`binding "${kind}" references missing ${binding.ref}`);
      continue;
    }
    if (primitiveKind(definition) !== kind) {
      issues.push(
        `binding "${kind}" references different primitive kind ${binding.ref}`,
      );
    }
    if (definition.compatibility.semanticHash !== binding.semanticHash) {
      issues.push(`binding "${kind}" semantic hash does not match ${binding.ref}`);
    }
  }
  return Object.freeze({
    valid: issues.length === 0,
    issues: Object.freeze(issues),
  });
}

/** Explain exact primitive selection and missing host capabilities. */
export function resolvePrimitiveRegistryReadiness(
  request: FlowPrimitiveRegistryReadinessRequest,
): FlowPrimitiveRegistryReadiness {
  const validation = validateCompilerPrimitiveRegistry(
    request.registry,
    request.bindings,
  );
  const selectedDefinitions = collectSelectedDefinitions(
    request.root,
    request.registry,
    request.bindings,
  );
  const available = new Set(request.availableCapabilities);
  const missingCapabilities = Object.freeze(
    [...new Set(selectedDefinitions.flatMap((item) =>
      item.definition.requiresCapabilities.filter(
        (capability) => !available.has(capability),
      ),
    ))].sort(),
  );
  const selected = Object.freeze(
    selectedDefinitions.map(({ kind, definition }) =>
      Object.freeze({
        kind,
        ref: definition.ref,
        semanticHash: definition.compatibility.semanticHash,
      }),
    ),
  );
  const issues = Object.freeze([
    ...validation.issues,
    ...missingCapabilities.map(
      (capability) => `host is missing primitive capability ${capability}`,
    ),
  ]);
  return Object.freeze({
    ready: issues.length === 0,
    registryHash: request.registry.registryHash,
    selected,
    missingCapabilities,
    issues,
  });
}

/** Bind selected V2 identities and capabilities into compile requirements. */
export function bindFlowRequirementsToPrimitiveRegistry(
  root: FlowNode,
  requirements: FlowRequirementSummary,
  registry: PrimitiveRegistryV2 | undefined,
  bindings: FlowPrimitiveBindings | undefined,
): FlowRequirementSummary {
  if (registry === undefined || bindings === undefined) return requirements;
  const selected = collectSelectedDefinitions(root, registry, bindings);
  const requiredCapabilities = [
    ...new Set([
      ...requirements.requiredCapabilities,
      ...selected.flatMap(({ definition }) => [
        ...definition.requiresCapabilities,
      ]),
    ]),
  ].sort();
  const primitiveContracts = selected.map(({ kind, definition }) => ({
    kind,
    ref: definition.ref,
    semanticHash: definition.compatibility.semanticHash,
  }));
  const semanticHash = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        flowSemanticHash: requirements.semanticHash,
        primitiveContracts,
      }),
    )
    .digest("hex")}`;
  return {
    ...requirements,
    semanticHash,
    requiredCapabilities,
  };
}

/** Fail closed when expanded custom primitive provenance is not hash-bound. */
export function validateFlowPrimitiveSelections(
  root: FlowNode,
  registry: PrimitiveRegistryV2 | undefined,
  bindings: FlowPrimitiveBindings | undefined,
): readonly FlowPrimitiveSelectionIssue[] {
  const issues: FlowPrimitiveSelectionIssue[] = [];
  visitNodesWithPath(root, "root", (node, nodePath) => {
    const authored = node.meta?.["primitive"];
    if (typeof authored !== "string") return;
    const ref = primitiveRefFromMetadata(authored);
    if (ref === undefined) {
      issues.push({
        nodePath: `${nodePath}.meta.primitive`,
        message: `invalid expanded primitive identity "${authored}"`,
      });
      return;
    }
    const builtIn = BUILT_IN_PRIMITIVE_REGISTRY_V2.get(ref);
    if (builtIn !== undefined) return;
    const definition = registry?.get(ref);
    if (definition === undefined) {
      issues.push({
        nodePath: `${nodePath}.meta.primitive`,
        message: `expanded primitive ${ref} is absent from the compiler registry`,
      });
      return;
    }
    const kind = primitiveKind(definition);
    const binding = bindings?.[kind];
    if (
      binding?.ref !== ref ||
      binding.semanticHash !== definition.compatibility.semanticHash
    ) {
      issues.push({
        nodePath: `${nodePath}.meta.primitive`,
        message:
          `expanded external primitive ${ref} requires an exact ref and semantic-hash binding`,
      });
    }
  });
  return Object.freeze(issues);
}

function collectSelectedDefinitions(
  root: FlowNode,
  registry: PrimitiveRegistryV2,
  bindings: FlowPrimitiveBindings | undefined,
): Array<{ kind: string; definition: PrimitiveDefinitionV2 }> {
  const selected = new Map<string, PrimitiveDefinitionV2>();
  visitNodes(root, (node) => {
    const definition = resolvePrimitiveDefinition(
      node.type,
      registry,
      bindings,
    );
    if (definition !== undefined) selected.set(node.type, definition);
    const metadataRef =
      typeof node.meta?.["primitive"] === "string"
        ? primitiveRefFromMetadata(node.meta["primitive"])
        : undefined;
    if (metadataRef === undefined) return;
    const metadataDefinition =
      registry.get(metadataRef) ??
      BUILT_IN_PRIMITIVE_REGISTRY_V2.get(metadataRef);
    if (metadataDefinition !== undefined) {
      selected.set(primitiveKind(metadataDefinition), metadataDefinition);
    }
  });
  return [...selected.entries()]
    .map(([kind, definition]) => ({ kind, definition }))
    .sort((left, right) => left.kind.localeCompare(right.kind));
}

function visitNodesWithPath(
  node: FlowNode,
  path: string,
  visit: (node: FlowNode, path: string) => void,
): void {
  visit(node, path);
  childNodes(node).forEach((child, index) =>
    visitNodesWithPath(child, `${path}.children[${index}]`, visit),
  );
}

function primitiveRefFromMetadata(
  value: string,
): PrimitiveDefinitionV2["ref"] | undefined {
  const match = /^([^@\s]+)@([^@\s]+)$/.exec(value);
  return match === null
    ? undefined
    : (`primitive://${match[1]}@${match[2]}` as PrimitiveDefinitionV2["ref"]);
}

function visitNodes(node: FlowNode, visit: (node: FlowNode) => void): void {
  visit(node);
  for (const child of childNodes(node)) visitNodes(child, visit);
}

function childNodes(node: FlowNode): readonly FlowNode[] {
  switch (node.type) {
    case "sequence":
      return node.nodes;
    case "for_each":
    case "persona":
    case "route":
    case "loop":
      return node.body;
    case "branch":
      return [...node.then, ...(node.else ?? [])];
    case "parallel":
      return node.branches.flat();
    case "approval":
      return [...node.onApprove, ...(node.onReject ?? [])];
    case "try_catch":
      return [...node.body, ...node.catch];
    default:
      return [];
  }
}

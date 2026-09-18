/**
 * Resolved V2 leaf inventory for one compiled `for_each` definition
 * (packet DSL-V2-INVENTORY-20260918, plan §4).
 *
 * A pure, opt-in projection: it reads a compiled pipeline artifact whose loop
 * and gate nodes carry the `includeForEachEconomicsV2Provenance` source
 * anchors and binds every authored body node — leaf or control — to its
 * authored path and id, its generated runtime node id and its resolved
 * execution class. From that binding it derives the ordered V2 leaves
 * (`execution` + linked `charge`, or `effect`) and the two digests
 * `LoopEconomicsEvidenceV2` requires.
 *
 * It grants nothing: no reservation, dispatch, release or settlement is
 * decided here, and no receipt is fabricated for a local node. Missing,
 * duplicate, reordered, foreign and contradictory mappings each deny the
 * inventory with a distinct diagnostic code.
 */

import { CANONICAL_JSON_VERSION } from "../idempotency.js";
import type {
  ConditionalEdge,
  GateNode,
  LoopNode,
  PipelineDefinition,
  PipelineNode,
  PipelineNodeSource,
} from "../pipeline-artifact/definition.js";
import { digestPipelineDefinition } from "../pipeline-artifact/digest.js";
import { digest } from "./shared.js";
import type {
  LoopEconomicsControlSelectionV2,
  LoopEconomicsLeafControlRequirementV2,
  LoopEconomicsSha256DigestV2,
} from "./types.js";

export const LOOP_ECONOMICS_LEAF_INVENTORY_V2_SCHEMA =
  "dzupagent.loopEconomicsLeafInventory/v2" as const;

export type LoopEconomicsInventoryDiagnosticCodeV2 =
  | "LOOP_ECONOMICS_V2_INVENTORY_INVALID"
  | "LOOP_ECONOMICS_V2_INVENTORY_MISSING_MAPPING"
  | "LOOP_ECONOMICS_V2_INVENTORY_DUPLICATE_MAPPING"
  | "LOOP_ECONOMICS_V2_INVENTORY_REORDERED_MAPPING"
  | "LOOP_ECONOMICS_V2_INVENTORY_FOREIGN_MAPPING"
  | "LOOP_ECONOMICS_V2_INVENTORY_CONTRADICTORY_MAPPING"
  | "LOOP_ECONOMICS_V2_INVENTORY_UNSUPPORTED_NODE";

export interface LoopEconomicsInventoryDiagnosticV2 {
  readonly code: LoopEconomicsInventoryDiagnosticCodeV2;
  readonly path: string;
  readonly message: string;
}

/** Authored node kinds that resolve to an AI execution and therefore a charge. */
export type LoopEconomicsExecutionResolutionV2 = "agent" | "prompt" | "adapter.run";

/**
 * The resolved execution class of one authored body node, derived from the
 * compiled node type together with the authored node type. `PipelineNode.type`
 * alone cannot classify billable work: an agent-resolved `action` lowers to an
 * `agent` node while `prompt` and `adapter.run` lower to `tool` nodes beside
 * local `set` and `validate.schema`.
 */
export type LoopEconomicsResolvedExecutionClassV2 =
  | { readonly kind: "execution"; readonly resolution: LoopEconomicsExecutionResolutionV2 }
  | { readonly kind: "effect"; readonly resolution: "tool"; readonly effectClass?: string }
  | { readonly kind: "local"; readonly resolution: "set" | "validate.schema" }
  | { readonly kind: "control"; readonly resolution: "branch" };

export interface LoopEconomicsInventoryBindingV2 {
  /** Zero-based authored order within the loop body (pre-order, then before else). */
  readonly order: number;
  readonly authoredPath: string;
  readonly authoredId?: string;
  readonly authoredNodeType: string;
  readonly runtimeNodeId: string;
  /** Runtime node ids from the loop node through enclosing gates to this node. */
  readonly nodePath: readonly string[];
  readonly controlRequirements: readonly LoopEconomicsLeafControlRequirementV2[];
  readonly executionClass: LoopEconomicsResolvedExecutionClassV2;
}

interface LoopEconomicsInventoryLeafBaseV2 {
  readonly leafId: string;
  /** Zero-based execution order within the exact body plan. */
  readonly order: number;
  readonly nodePath: readonly string[];
  readonly controlRequirements: readonly LoopEconomicsLeafControlRequirementV2[];
  readonly runtimeNodeId: string;
  readonly authoredPath: string;
  readonly authoredId?: string;
}

export type LoopEconomicsInventoryLeafV2 =
  | (LoopEconomicsInventoryLeafBaseV2 & {
      readonly kind: "execution";
      readonly resolution: LoopEconomicsExecutionResolutionV2;
    })
  | (LoopEconomicsInventoryLeafBaseV2 & {
      readonly kind: "charge";
      readonly executionLeafId: string;
    })
  | (LoopEconomicsInventoryLeafBaseV2 & {
      readonly kind: "effect";
      readonly effectClass?: string;
    });

export interface LoopEconomicsLeafInventoryV2 {
  readonly schema: typeof LOOP_ECONOMICS_LEAF_INVENTORY_V2_SCHEMA;
  readonly canonicalization: typeof CANONICAL_JSON_VERSION;
  readonly loop: {
    readonly runtimeNodeId: string;
    readonly authoredPath: string;
    readonly authoredId?: string;
  };
  /** Compiled artifact identity; changes with regenerated runtime ids. */
  readonly definitionDigest: LoopEconomicsSha256DigestV2;
  /** Authored body plan identity; stable under regenerated runtime ids. */
  readonly bodyPlanDigest: LoopEconomicsSha256DigestV2;
  readonly controlSelections: readonly LoopEconomicsControlSelectionV2[];
  /** One binding per authored body node, leaf or control, in authored order. */
  readonly bindings: readonly LoopEconomicsInventoryBindingV2[];
  /** Ordered V2 leaves; local and control nodes contribute none. */
  readonly leaves: readonly LoopEconomicsInventoryLeafV2[];
}

export type LoopEconomicsLeafInventoryResultV2 =
  | { readonly status: "admitted"; readonly inventory: LoopEconomicsLeafInventoryV2 }
  | {
      readonly status: "denied";
      readonly diagnostics: readonly LoopEconomicsInventoryDiagnosticV2[];
    };

// ---------------------------------------------------------------------------
// Classification table
// ---------------------------------------------------------------------------

type ClassifiedNodeType = PipelineNode["type"];

type ClassRow = ReadonlyMap<ClassifiedNodeType, LoopEconomicsResolvedExecutionClassV2>;

function classRow(
  ...cells: readonly (readonly [ClassifiedNodeType, LoopEconomicsResolvedExecutionClassV2])[]
): ClassRow {
  return new Map(cells.map(([runtime, cls]) => [runtime, Object.freeze(cls)]));
}

const CLASS_BY_AUTHORED_TYPE: ReadonlyMap<string, ClassRow> = new Map<string, ClassRow>([
  ["action", classRow(["agent", { kind: "execution", resolution: "agent" }], ["tool", { kind: "effect", resolution: "tool" }])],
  ["agent", classRow(["agent", { kind: "execution", resolution: "agent" }])],
  ["prompt", classRow(["tool", { kind: "execution", resolution: "prompt" }])],
  ["adapter.run", classRow(["tool", { kind: "execution", resolution: "adapter.run" }])],
  ["set", classRow(["tool", { kind: "local", resolution: "set" }])],
  ["validate.schema", classRow(["tool", { kind: "local", resolution: "validate.schema" }])],
  ["branch", classRow(["gate", { kind: "control", resolution: "branch" }])],
]);

/** Runtime node types the compiler emits without an authored source anchor (structural, not a leaf). */
const STRUCTURAL_NODE_TYPES: ReadonlySet<ClassifiedNodeType> = new Set(["suspend", "fork", "join", "loop", "gate", "transform"]);

// ---------------------------------------------------------------------------
// Authored path grammar relative to the loop: body[i](.then[j]|.else[j])*
// ---------------------------------------------------------------------------

type Arm = "body" | "then" | "else";

interface PathSegment {
  readonly arm: Arm;
  readonly index: number;
}

const ARM_RANK: Readonly<Record<Arm, number>> = { body: 0, then: 0, else: 1 };
const SEGMENT = /^(body|then|else)\[(0|[1-9][0-9]*)\]$/;

function parseRelativePath(relative: string): readonly PathSegment[] | undefined {
  const segments: PathSegment[] = [];
  for (const [position, raw] of relative.split(".").entries()) {
    const match = SEGMENT.exec(raw);
    if (match === null) return undefined;
    const arm = match[1] as Arm;
    if ((position === 0) !== (arm === "body")) return undefined;
    segments.push({ arm, index: Number(match[2]) });
  }
  return segments;
}

function compareSegments(left: readonly PathSegment[], right: readonly PathSegment[]): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const l = left[index]!;
    const r = right[index]!;
    if (ARM_RANK[l.arm] !== ARM_RANK[r.arm]) return ARM_RANK[l.arm] - ARM_RANK[r.arm];
    if (l.index !== r.index) return l.index - r.index;
  }
  return left.length - right.length;
}

function segmentKey(segments: readonly PathSegment[]): string {
  return segments.map((segment) => `${segment.arm}[${segment.index}]`).join(".");
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

interface BodyEntry {
  readonly node: PipelineNode;
  readonly source: PipelineNodeSource;
  readonly nodeIndex: number;
  readonly segments: readonly PathSegment[];
  readonly executionClass: LoopEconomicsResolvedExecutionClassV2;
}

class Diagnostics {
  readonly items: LoopEconomicsInventoryDiagnosticV2[] = [];

  add(code: LoopEconomicsInventoryDiagnosticCodeV2, path: string, message: string): void {
    this.items.push({ code, path, message });
  }

  get any(): boolean {
    return this.items.length > 0;
  }
}

/**
 * Build the ordered, validated V2 leaf inventory of one compiled `for_each`
 * definition. Pure: the same artifact always yields the same result, and the
 * artifact is never mutated.
 */
export function buildLoopEconomicsLeafInventoryV2(
  definition: PipelineDefinition,
  loopNodeId: string
): LoopEconomicsLeafInventoryResultV2 {
  const diagnostics = new Diagnostics();
  const nodesById = indexNodes(definition, diagnostics);
  const loop = admitLoop(definition, nodesById, loopNodeId, diagnostics);
  if (loop === undefined || diagnostics.any) return { status: "denied", diagnostics: diagnostics.items };

  const entries = admitBodyEntries(definition, nodesById, loop, diagnostics);
  if (diagnostics.any) return { status: "denied", diagnostics: diagnostics.items };

  admitStructure(entries, loop, diagnostics);
  admitGateEdges(definition, entries, diagnostics);
  if (diagnostics.any) return { status: "denied", diagnostics: diagnostics.items };

  return { status: "admitted", inventory: materialize(definition, loop, entries) };
}

interface IndexedNode {
  readonly node: PipelineNode;
  readonly index: number;
}

function indexNodes(definition: PipelineDefinition, diagnostics: Diagnostics): Map<string, IndexedNode> {
  const nodesById = new Map<string, IndexedNode>();
  definition.nodes.forEach((node, index) => {
    if (nodesById.has(node.id)) {
      diagnostics.add(
        "LOOP_ECONOMICS_V2_INVENTORY_DUPLICATE_MAPPING",
        `nodes[${index}].id`,
        `Runtime node id ${JSON.stringify(node.id)} is defined more than once.`
      );
      return;
    }
    nodesById.set(node.id, { node, index });
  });
  return nodesById;
}

interface AdmittedLoop {
  readonly node: LoopNode;
  readonly source: PipelineNodeSource;
  readonly path: string;
}

function admitLoop(
  definition: PipelineDefinition,
  nodesById: ReadonlyMap<string, IndexedNode>,
  loopNodeId: string,
  diagnostics: Diagnostics
): AdmittedLoop | undefined {
  const indexed = nodesById.get(loopNodeId);
  if (indexed === undefined) {
    diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_INVALID", "nodes", `No node ${JSON.stringify(loopNodeId)} in the definition.`);
    return undefined;
  }
  const { node, index } = indexed;
  const path = `nodes[${index}]`;
  if (node.type !== "loop" || node.forEach === undefined) {
    diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_INVALID", `${path}.type`, "Inventory target must be a lowered for_each loop node.");
    return undefined;
  }
  if (node.source === undefined) {
    diagnostics.add(
      "LOOP_ECONOMICS_V2_INVENTORY_MISSING_MAPPING",
      `${path}.source`,
      "Loop node carries no authored source anchor; compile with includeForEachEconomicsV2Provenance."
    );
    return undefined;
  }
  if (node.source.nodeType !== "for_each") {
    diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_CONTRADICTORY_MAPPING", `${path}.source.nodeType`, "Loop node source must be an authored for_each.");
    return undefined;
  }
  return { node, source: node.source, path: node.source.path };
}

function admitBodyEntries(
  definition: PipelineDefinition,
  nodesById: ReadonlyMap<string, IndexedNode>,
  loop: AdmittedLoop,
  diagnostics: Diagnostics
): BodyEntry[] {
  const entries: BodyEntry[] = [];
  const bodyIds = new Set<string>();
  const authoredPaths = new Map<string, string>();
  const authoredIds = new Map<string, string>();
  const prefix = `${loop.path}.`;

  loop.node.bodyNodeIds.forEach((id, position) => {
    const at = `bodyNodeIds[${position}]`;
    if (bodyIds.has(id)) {
      diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_DUPLICATE_MAPPING", at, `Runtime node ${JSON.stringify(id)} appears twice in the loop body.`);
      return;
    }
    bodyIds.add(id);
    const indexed = nodesById.get(id);
    if (indexed === undefined) {
      diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_FOREIGN_MAPPING", at, `Runtime node ${JSON.stringify(id)} is not defined in this artifact.`);
      return;
    }
    const { node, index: nodeIndex } = indexed;
    const nodePath = `nodes[${nodeIndex}]`;
    if (node.source === undefined) {
      // The compiler never anchors structural nodes (complete, parallel
      // fork/join, nested loops); those are outside this inventory rather
      // than a broken mapping. A leaf without an anchor is a broken mapping.
      if (STRUCTURAL_NODE_TYPES.has(node.type)) {
        diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_UNSUPPORTED_NODE", `${nodePath}.type`, `Structural ${node.type} node ${JSON.stringify(id)} is not admitted in the V2 inventory.`);
      } else {
        diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_MISSING_MAPPING", `${nodePath}.source`, `Body node ${JSON.stringify(id)} carries no authored source anchor.`);
      }
      return;
    }
    if (!node.source.path.startsWith(prefix)) {
      diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_FOREIGN_MAPPING", `${nodePath}.source.path`, `Body node ${JSON.stringify(id)} is authored outside this loop.`);
      return;
    }
    const segments = parseRelativePath(node.source.path.slice(prefix.length));
    if (segments === undefined) {
      diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_UNSUPPORTED_NODE", `${nodePath}.source.path`, "Only for_each body leaves and branch arms are admitted in the V2 inventory.");
      return;
    }
    const knownPath = authoredPaths.get(node.source.path);
    if (knownPath !== undefined) {
      diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_DUPLICATE_MAPPING", `${nodePath}.source.path`, `Authored path is already bound to runtime node ${JSON.stringify(knownPath)}.`);
      return;
    }
    authoredPaths.set(node.source.path, id);
    if (node.source.nodeId !== undefined) {
      const knownId = authoredIds.get(node.source.nodeId);
      if (knownId !== undefined) {
        diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_DUPLICATE_MAPPING", `${nodePath}.source.nodeId`, `Authored id is already bound to runtime node ${JSON.stringify(knownId)}.`);
        return;
      }
      authoredIds.set(node.source.nodeId, id);
    }
    const executionClass = classify(node, node.source, nodePath, diagnostics);
    if (executionClass === undefined) return;
    entries.push({ node, source: node.source, nodeIndex, segments, executionClass });
  });

  definition.nodes.forEach((node, index) => {
    if (node.id === loop.node.id || bodyIds.has(node.id) || node.source === undefined) return;
    if (node.source.path.startsWith(prefix)) {
      diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_MISSING_MAPPING", `nodes[${index}]`, `Authored descendant ${JSON.stringify(node.source.path)} is missing from the loop body.`);
    }
  });
  return entries;
}

function classify(
  node: PipelineNode,
  source: PipelineNodeSource,
  path: string,
  diagnostics: Diagnostics
): LoopEconomicsResolvedExecutionClassV2 | undefined {
  const byRuntimeType = CLASS_BY_AUTHORED_TYPE.get(source.nodeType);
  if (byRuntimeType === undefined) {
    diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_UNSUPPORTED_NODE", `${path}.source.nodeType`, `Authored node type ${JSON.stringify(source.nodeType)} has no admitted V2 execution class.`);
    return undefined;
  }
  const resolved = byRuntimeType.get(node.type);
  if (resolved === undefined) {
    diagnostics.add(
      "LOOP_ECONOMICS_V2_INVENTORY_CONTRADICTORY_MAPPING",
      `${path}.type`,
      `Runtime node type ${JSON.stringify(node.type)} contradicts authored ${JSON.stringify(source.nodeType)}.`
    );
    return undefined;
  }
  if (resolved.kind === "effect" && node.effectClass !== undefined) {
    return { ...resolved, effectClass: node.effectClass };
  }
  // A fresh object per binding: the inventory is persisted and handed on, and
  // must never alias the module-level table.
  return { ...resolved };
}

function admitStructure(entries: readonly BodyEntry[], loop: AdmittedLoop, diagnostics: Diagnostics): void {
  const byKey = new Map(entries.map((entry) => [segmentKey(entry.segments), entry] as const));
  const siblings = new Map<string, number[]>();
  const impliedParents = new Set(entries.map((entry) => segmentKey(entry.segments.slice(0, -1))));

  for (const entry of entries) {
    const at = `nodes[${entry.nodeIndex}].source.path`;
    const parentSegments = entry.segments.slice(0, -1);
    const last = entry.segments.at(-1)!;
    const groupKey = `${segmentKey(parentSegments)}#${last.arm}`;
    siblings.set(groupKey, [...(siblings.get(groupKey) ?? []), last.index]);
    if (parentSegments.length === 0) continue;
    const parent = byKey.get(segmentKey(parentSegments));
    if (parent === undefined) {
      diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_MISSING_MAPPING", at, "Branch arm node has no bound gate for its authored branch.");
    } else if (parent.executionClass.kind !== "control") {
      diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_CONTRADICTORY_MAPPING", at, "Branch arm node is authored under a node that is not a branch.");
    }
  }

  for (const [groupKey, indexes] of siblings) {
    const [parentKey, arm] = groupKey.split("#") as [string, Arm];
    const present = new Set(indexes);
    const gaps = Array.from({ length: Math.max(...indexes) + 1 }, (_, index) => index).filter((index) => !present.has(index));
    for (const gap of gaps) {
      const gapKey = `${parentKey === "" ? "" : `${parentKey}.`}${arm}[${gap}]`;
      // Arm nodes authored under the gap prove a branch was authored there;
      // that gate is missing and was already reported per arm node above.
      if (impliedParents.has(gapKey)) continue;
      diagnostics.add(
        "LOOP_ECONOMICS_V2_INVENTORY_UNSUPPORTED_NODE",
        `${loop.path}.${gapKey}`,
        "Authored sibling lowered to no runtime node; constructs without a runtime leaf are not admitted in the V2 inventory."
      );
    }
  }

  const expected = [...entries].sort((left, right) => compareSegments(left.segments, right.segments));
  for (const [position, entry] of entries.entries()) {
    if (expected[position] !== entry) {
      diagnostics.add(
        "LOOP_ECONOMICS_V2_INVENTORY_REORDERED_MAPPING",
        `bodyNodeIds[${position}]`,
        `Runtime order places ${JSON.stringify(entry.source.path)} where authored order expects ${JSON.stringify(expected[position]!.source.path)}.`
      );
      break;
    }
  }

  const bodyGraph = loop.node.bodyGraph;
  const first = entries[0];
  if (bodyGraph !== undefined && first !== undefined && bodyGraph.entryNodeId !== first.node.id) {
    diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_CONTRADICTORY_MAPPING", "bodyGraph.entryNodeId", "Body graph entry is not the first authored body node.");
  }
}

function admitGateEdges(definition: PipelineDefinition, entries: readonly BodyEntry[], diagnostics: Diagnostics): void {
  for (const entry of entries) {
    if (entry.executionClass.kind !== "control") continue;
    const gate = entry.node as GateNode;
    const at = `nodes[${entry.nodeIndex}]`;
    const edges = definition.edges.filter(
      (edge): edge is ConditionalEdge => edge.type === "conditional" && edge.sourceNodeId === gate.id
    );
    if (edges.length === 0) {
      diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_MISSING_MAPPING", `${at}.id`, "Branch gate has no conditional edge.");
      continue;
    }
    if (edges.length > 1) {
      diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_DUPLICATE_MAPPING", `${at}.id`, "Branch gate has more than one conditional edge.");
      continue;
    }
    const branches = edges[0]!.branches;
    const edgeAt = `edges[${definition.edges.indexOf(edges[0]!)}].branches`;
    // The compiler wires each transition to the first *emitted* node of the
    // arm, so the expected target is the lowest present index, not index 0.
    const firstOfArm = (arm: "then" | "else"): BodyEntry | undefined =>
      entries
        .filter((candidate) => candidate.segments.length === entry.segments.length + 1
          && candidate.segments.at(-1)!.arm === arm
          && segmentKey(candidate.segments.slice(0, -1)) === segmentKey(entry.segments))
        .sort((left, right) => left.segments.at(-1)!.index - right.segments.at(-1)!.index)[0];
    for (const [arm, key] of [["then", "true"], ["else", "false"]] as const) {
      const expectedTarget = firstOfArm(arm)?.node.id;
      const actualTarget = branches[key];
      if (expectedTarget === undefined && actualTarget === undefined) continue;
      if (expectedTarget === undefined) {
        diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_CONTRADICTORY_MAPPING", `${edgeAt}.${key}`, `Conditional edge targets a ${arm} arm the authored branch does not declare.`);
      } else if (actualTarget === undefined) {
        diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_MISSING_MAPPING", `${edgeAt}.${key}`, `Conditional edge lacks the ${arm} arm the authored branch declares.`);
      } else if (actualTarget !== expectedTarget) {
        diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_CONTRADICTORY_MAPPING", `${edgeAt}.${key}`, `Conditional edge enters ${arm} at ${JSON.stringify(actualTarget)}, not the authored first ${arm} node ${JSON.stringify(expectedTarget)}.`);
      }
    }
    for (const key of Object.keys(branches)) {
      if (key !== "true" && key !== "false") {
        diagnostics.add("LOOP_ECONOMICS_V2_INVENTORY_CONTRADICTORY_MAPPING", `${edgeAt}.${key}`, "Branch gate admits only true and false transitions.");
      }
    }
  }
}

function materialize(
  definition: PipelineDefinition,
  loop: AdmittedLoop,
  entries: readonly BodyEntry[]
): LoopEconomicsLeafInventoryV2 {
  const controlSelections: LoopEconomicsControlSelectionV2[] = [];
  const selectionIndexByKey = new Map<string, number>();
  const bindingByKey = new Map<string, LoopEconomicsInventoryBindingV2>();
  const bindings: LoopEconomicsInventoryBindingV2[] = [];
  const leaves: LoopEconomicsInventoryLeafV2[] = [];

  for (const [order, entry] of entries.entries()) {
    const parentKey = segmentKey(entry.segments.slice(0, -1));
    const parent = bindingByKey.get(parentKey);
    const last = entry.segments.at(-1)!;
    const controlRequirements: LoopEconomicsLeafControlRequirementV2[] = parent === undefined
      ? []
      : [
          ...parent.controlRequirements,
          { selectionIndex: selectionIndexByKey.get(parentKey)!, kind: "branch", requiredBranch: last.arm as "then" | "else" },
        ];
    const nodePath = [...(parent?.nodePath ?? [loop.node.id]), entry.node.id];
    const binding: LoopEconomicsInventoryBindingV2 = {
      order,
      authoredPath: entry.source.path,
      ...(entry.source.nodeId !== undefined ? { authoredId: entry.source.nodeId } : {}),
      authoredNodeType: entry.source.nodeType,
      runtimeNodeId: entry.node.id,
      nodePath,
      controlRequirements,
      executionClass: entry.executionClass,
    };
    const key = segmentKey(entry.segments);
    bindingByKey.set(key, binding);
    bindings.push(binding);

    if (entry.executionClass.kind === "control") {
      selectionIndexByKey.set(key, controlSelections.length);
      controlSelections.push({ kind: "branch", nodePath, selectedBranch: null });
      continue;
    }
    const leafBase = {
      nodePath,
      controlRequirements,
      runtimeNodeId: binding.runtimeNodeId,
      authoredPath: binding.authoredPath,
      ...(binding.authoredId !== undefined ? { authoredId: binding.authoredId } : {}),
    };
    if (entry.executionClass.kind === "execution") {
      const executionLeafId = `execution:${binding.authoredPath}`;
      leaves.push({ ...leafBase, leafId: executionLeafId, order: leaves.length, kind: "execution", resolution: entry.executionClass.resolution });
      leaves.push({ ...leafBase, leafId: `charge:${binding.authoredPath}`, order: leaves.length, kind: "charge", executionLeafId });
    } else if (entry.executionClass.kind === "effect") {
      leaves.push({
        ...leafBase,
        leafId: `effect:${binding.authoredPath}`,
        order: leaves.length,
        kind: "effect",
        ...(entry.executionClass.effectClass !== undefined ? { effectClass: entry.executionClass.effectClass } : {}),
      });
    }
  }

  return {
    schema: LOOP_ECONOMICS_LEAF_INVENTORY_V2_SCHEMA,
    canonicalization: CANONICAL_JSON_VERSION,
    loop: {
      runtimeNodeId: loop.node.id,
      authoredPath: loop.path,
      ...(loop.source.nodeId !== undefined ? { authoredId: loop.source.nodeId } : {}),
    },
    definitionDigest: digestPipelineDefinition(definition),
    bodyPlanDigest: bodyPlanDigest(loop, entries, bindings, leaves),
    controlSelections,
    bindings,
    leaves,
  };
}

/**
 * The authored plan projection: relative authored paths, ids, node types,
 * execution classes, control structure and leaf kinds. No runtime id enters
 * it, so regenerated ids leave it unchanged, while any authored body change
 * moves it. It is deliberately not the AST digest nor the compiled definition
 * digest.
 */
function bodyPlanDigest(
  loop: AdmittedLoop,
  entries: readonly BodyEntry[],
  bindings: readonly LoopEconomicsInventoryBindingV2[],
  leaves: readonly LoopEconomicsInventoryLeafV2[]
): LoopEconomicsSha256DigestV2 {
  const relative = (path: string): string => path.slice(loop.path.length + 1);
  return digest({
    schema: LOOP_ECONOMICS_LEAF_INVENTORY_V2_SCHEMA,
    bindings: bindings.map((binding, index) => ({
      order: binding.order,
      path: segmentKey(entries[index]!.segments),
      ...(binding.authoredId !== undefined ? { authoredId: binding.authoredId } : {}),
      authoredNodeType: binding.authoredNodeType,
      controlRequirements: binding.controlRequirements,
      executionClass: binding.executionClass,
    })),
    leaves: leaves.map((leaf) => ({
      leafId: `${leaf.kind}:${relative(leaf.authoredPath)}`,
      order: leaf.order,
      kind: leaf.kind,
      ...(leaf.kind === "charge" ? { executionLeafId: `execution:${relative(leaf.authoredPath)}` } : {}),
      ...(leaf.kind === "effect" && leaf.effectClass !== undefined ? { effectClass: leaf.effectClass } : {}),
      ...(leaf.kind === "execution" ? { resolution: leaf.resolution } : {}),
    })),
  });
}

import type { LoopNode, PipelineEdge, PipelineNode, PipelineValidationError } from "@dzupagent/runtime-contracts/pipeline-artifact";

/**
 * Defense-in-depth validation for hand-authored or legacy pipeline artifacts.
 * Compiler-lowered for_each bodies are an ordered chain of leaf nodes. The
 * current item worker does not dispatch graph control or persist per-item
 * concurrent/economic frames, so anything outside that exact shape is denied.
 */
export function validateForEachAdmission(
  loop: LoopNode,
  entryNodeId: string,
  nodeMap: ReadonlyMap<string, PipelineNode>,
  edges: readonly PipelineEdge[],
  loopNodes: readonly LoopNode[]
): PipelineValidationError[] {
  const errors: PipelineValidationError[] = [];

  // 24-I: N>1 is admitted. Absence is still a violation here — this gate
  // validates hand-authored and legacy ARTIFACTS, where a missing concurrency
  // means the field predates the contract rather than "author chose the
  // default". The compiler's rule differs deliberately: there absence means
  // the AUTHOR omitted it, and lowering supplies 1.
  const concurrency = loop.forEach?.concurrency;
  if (
    concurrency === undefined ||
    !Number.isInteger(concurrency) ||
    concurrency < 1
  ) {
    errors.push({
      code: "FOR_EACH_CONCURRENCY_UNSUPPORTED",
      message:
        `LoopNode "${loop.id}" for_each concurrency must be a positive ` +
        `integer; received ${String(concurrency)}`,
      nodeId: loop.id,
    });
  }

  const unsupported = findUnsupportedBodyShape(
    loop,
    entryNodeId,
    nodeMap,
    edges,
    loopNodes
  );
  if (unsupported !== undefined) {
    errors.push({
      code: unsupported.code,
      message:
        `LoopNode "${loop.id}" does not have an admitted leaf-only for_each body: ` +
        `${unsupported.kind} at "${unsupported.nodeId}"; item-body control requires ` +
        "a definition-bound durable item graph frame and canonical recursive dispatcher",
      nodeId: unsupported.nodeId,
    });
  }

  return errors;
}

type UnsupportedBody = {
  code:
    | "FOR_EACH_INTERACTION_UNSUPPORTED"
    | "FOR_EACH_RECURSIVE_CONTROL_UNSUPPORTED"
    | "FOR_EACH_SUSPENSION_UNSUPPORTED"
    | "FOR_EACH_TERMINAL_UNSUPPORTED";
  nodeId: string;
  kind: string;
};

function findUnsupportedBodyShape(
  loop: LoopNode,
  entryNodeId: string,
  nodeMap: ReadonlyMap<string, PipelineNode>,
  edges: readonly PipelineEdge[],
  loopNodes: readonly LoopNode[]
): UnsupportedBody | undefined {
  if (loop.bodyGraph !== undefined) {
    return recursive(loop.id, "for_each declares a graph-shaped body");
  }
  if (loop.bodyNodeIds.length === 0) {
    return recursive(loop.id, "for_each body is empty");
  }
  if (new Set(loop.bodyNodeIds).size !== loop.bodyNodeIds.length) {
    return recursive(loop.id, "for_each body contains duplicate node IDs");
  }

  const bodyIds = new Set(loop.bodyNodeIds);
  if (bodyIds.has(entryNodeId)) {
    return recursive(entryNodeId, "a body node is also the pipeline entry");
  }

  for (const bodyId of loop.bodyNodeIds) {
    const bodyNode = nodeMap.get(bodyId);
    if (bodyNode === undefined) continue;

    const otherOwners = loopNodes.filter(
      (candidate) =>
        candidate.id !== loop.id && candidate.bodyNodeIds.includes(bodyId)
    );
    if (otherOwners.length > 0) {
      return recursive(bodyId, "a body node is owned by more than one loop");
    }

    switch (bodyNode.type) {
      case "agent":
      case "tool":
      case "transform":
        break;
      case "suspend":
        return bodyNode.interaction === undefined && bodyNode.resumeCondition === undefined
          ? terminal(bodyId, "terminal suspend control")
          : suspension(bodyId, "suspend control");
      case "gate":
        return bodyNode.gateType === "approval" || bodyNode.interaction !== undefined
          ? interaction(bodyId, "approval interaction control")
          : recursive(bodyId, "gate control");
      case "fork":
        return recursive(bodyId, "fork control");
      case "join":
        return recursive(bodyId, "join control");
      case "loop":
        return recursive(bodyId, "nested loop control");
      default:
        // G2e — prereq 8 is an either/or: route item bodies through canonical
        // item-scoped dispatch, OR *retain* the leaf-only denial. This slice
        // discharges the second half, and "retain" is the load-bearing word:
        // the denial must stay complete as `PipelineNode` grows.
        //
        // Before G2e this switch had no default. It enumerated all eight
        // members of the union, so it was exhaustive *on that day* — but
        // nothing held it that way. Verified, not assumed: adding a ninth
        // member to `PipelineNode` and rebuilding core produced type errors
        // across the runtime and **none here**; the new type fell out of the
        // switch and was silently ADMITTED into the flat item worker, which
        // cannot dispatch graph control or own a per-item frame for it.
        //
        // Default-deny closes that. `assertNeverBodyNode` additionally makes
        // it a *compile-time* failure, so a future node type cannot reach this
        // line without an author deciding which side of the admission it is on.
        return recursive(
          bodyId,
          `unrecognized item-body node type "${assertNeverBodyNode(bodyNode)}"`
        );
    }
  }

  const expectedPairs = new Set<string>();
  for (let index = 0; index < loop.bodyNodeIds.length - 1; index += 1) {
    expectedPairs.add(pair(loop.bodyNodeIds[index]!, loop.bodyNodeIds[index + 1]!));
  }
  const observedPairs = new Map<string, number>();
  let bodyEdgeCount = 0;

  for (const edge of edges) {
    const targets = edgeTargets(edge);
    const touchesBody = bodyIds.has(edge.sourceNodeId) || targets.some((id) => bodyIds.has(id));
    if (!touchesBody) continue;
    bodyEdgeCount += 1;
    if (edge.type !== "sequential") {
      return recursive(edge.sourceNodeId, `${edge.type} item-body routing`);
    }
    if (!bodyIds.has(edge.sourceNodeId) || !bodyIds.has(edge.targetNodeId)) {
      return recursive(edge.sourceNodeId, "item-body edge crosses the loop boundary");
    }
    const key = pair(edge.sourceNodeId, edge.targetNodeId);
    if (!expectedPairs.has(key)) {
      return recursive(edge.sourceNodeId, "item-body edge does not follow bodyNodeIds order");
    }
    observedPairs.set(key, (observedPairs.get(key) ?? 0) + 1);
  }

  if (bodyEdgeCount === 0) return undefined;
  for (const expected of expectedPairs) {
    if (observedPairs.get(expected) !== 1) {
      return recursive(loop.id, "item-body chain is missing or duplicates a sequential edge");
    }
  }

  return undefined;
}

/**
 * Compile-time exhaustiveness guard for the item-body admission switch (G2e).
 *
 * Every `PipelineNode` member is handled above, so `node` narrows to `never`
 * here and this call typechecks. Add a member to the union without deciding
 * whether the flat item worker may execute it, and the argument no longer
 * narrows to `never` — `yarn typecheck` fails on this line, at the exact place
 * the decision belongs.
 *
 * It still returns a value rather than throwing: a hand-authored or legacy
 * artifact validated at runtime can carry a type this build does not know, and
 * a validator whose job is to *deny* must not crash on the input it exists to
 * reject. The caller turns this into a denial; the type parameter is what makes
 * the omission impossible to ship, and the runtime return is what makes the
 * denial safe when it is reached anyway.
 */
function assertNeverBodyNode(node: never): string {
  return (node as { type?: string }).type ?? "unknown";
}

function edgeTargets(edge: PipelineEdge): string[] {
  return edge.type === "conditional"
    ? Object.values(edge.branches)
    : [edge.targetNodeId];
}

function pair(source: string, target: string): string {
  return `${source}\u0000${target}`;
}

function recursive(nodeId: string, kind: string): UnsupportedBody {
  return { code: "FOR_EACH_RECURSIVE_CONTROL_UNSUPPORTED", nodeId, kind };
}

function interaction(nodeId: string, kind: string): UnsupportedBody {
  return { code: "FOR_EACH_INTERACTION_UNSUPPORTED", nodeId, kind };
}

function suspension(nodeId: string, kind: string): UnsupportedBody {
  return { code: "FOR_EACH_SUSPENSION_UNSUPPORTED", nodeId, kind };
}

function terminal(nodeId: string, kind: string): UnsupportedBody {
  return { code: "FOR_EACH_TERMINAL_UNSUPPORTED", nodeId, kind };
}

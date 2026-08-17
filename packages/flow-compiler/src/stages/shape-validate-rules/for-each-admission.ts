import type {
  FlowNode,
  ForEachNode,
  ValidationError,
} from "@dzupagent/flow-ast";

/**
 * Packet 24-D admission for the current flat for_each worker.
 *
 * The worker can execute only a sequential leaf inventory. It has no durable
 * per-item graph cursor, interaction owner, terminal owner, or concurrent
 * item/economics frame, so those authored forms must fail before lowering.
 */
export function validateForEachAdmission(
  node: ForEachNode,
  path: string
): ValidationError[] {
  const errors: ValidationError[] = [];

  // 24-I: N>1 admitted. Absence still skips — an author who omitted the field
  // gets 1 from lowering. Only an authored value can be invalid here.
  if (
    node.concurrency !== undefined &&
    (!Number.isInteger(node.concurrency) || node.concurrency < 1)
  ) {
    errors.push({
      nodeType: node.type,
      nodePath: `${path}.concurrency`,
      code: "FOR_EACH_CONCURRENCY_UNSUPPORTED",
      category: "control",
      message: "for_each.concurrency must be a positive integer",
    });
  }

  const interaction = findNestedNode(
    node.body,
    `${path}.body`,
    (child) => child.type === "approval" || child.type === "clarification"
  );
  if (interaction !== undefined) {
    errors.push({
      nodeType: interaction.node.type,
      nodePath: interaction.path,
      code: "FOR_EACH_INTERACTION_UNSUPPORTED",
      category: "control",
      message:
        `${interaction.node.type} cannot be nested under for_each until ` +
        "the per-item executor has a durable checkpoint-bound interaction frame",
    });
    return errors;
  }

  const terminal = findNestedNode(
    node.body,
    `${path}.body`,
    (child) => child.type === "complete" || child.type === "return_to"
  );
  if (terminal !== undefined) {
    errors.push({
      nodeType: terminal.node.type,
      nodePath: terminal.path,
      code: "FOR_EACH_TERMINAL_UNSUPPORTED",
      category: "control",
      message:
        `${terminal.node.type} cannot be nested under for_each until terminal item ownership, sibling suppression, aggregation suppression, and outer-continuation suppression are durable`,
    });
    return errors;
  }

  const suspension = findNestedNode(
    node.body,
    `${path}.body`,
    (child) =>
      child.type === "persona" ||
      child.type === "route" ||
      child.type === "wait"
  );
  if (suspension !== undefined) {
    errors.push({
      nodeType: suspension.node.type,
      nodePath: suspension.path,
      code: "FOR_EACH_SUSPENSION_UNSUPPORTED",
      category: "control",
      message:
        `${suspension.node.type} cannot be nested under for_each until the per-item executor has an exact item-owned suspension cursor`,
    });
    return errors;
  }

  const recursive = findNestedNode(
    node.body,
    `${path}.body`,
    (child) =>
      child.type === "branch" ||
      child.type === "parallel" ||
      child.type === "try_catch" ||
      child.type === "for_each" ||
      child.type === "loop" ||
      child.type === "subflow"
  );
  if (recursive !== undefined) {
    errors.push({
      nodeType: recursive.node.type,
      nodePath: recursive.path,
      code: "FOR_EACH_RECURSIVE_CONTROL_UNSUPPORTED",
      category: "control",
      message:
        `${recursive.node.type} cannot be nested under for_each while the ` +
        "item worker uses a flat leaf inventory; admission requires a definition-bound durable item graph frame and canonical recursive dispatcher",
    });
    return errors;
  }

  const unsupportedLeaf = findNestedNode(
    node.body,
    `${path}.body`,
    (child) => !isAdmittedItemBodyNode(child)
  );
  if (unsupportedLeaf !== undefined) {
    errors.push({
      nodeType: unsupportedLeaf.node.type,
      nodePath: unsupportedLeaf.path,
      code: "FOR_EACH_BODY_NODE_UNSUPPORTED",
      category: "control",
      message:
        `${unsupportedLeaf.node.type} cannot be nested under for_each because ` +
        "it does not lower to one executable item-body leaf in the canonical PipelineRuntime",
    });
  }

  return errors;
}

function isAdmittedItemBodyNode(node: FlowNode): boolean {
  switch (node.type) {
    case "sequence":
    case "action":
    case "agent":
    case "validate":
    case "prompt":
    case "worker.dispatch":
    case "shell.run":
    case "evidence.write":
    case "validate.schema":
    case "adapter.run":
    case "adapter.race":
    case "adapter.parallel":
    case "adapter.supervisor":
    case "set":
    case "spdd.import_sources":
    case "spdd.build_source_pack":
    case "spdd.run_analysis":
    case "spdd.generate_canvas":
    case "spdd.validate_canvas":
    case "spdd.review_canvas":
    case "spdd.project_plan":
    case "spdd.arm_dispatch":
    case "spdd.run_validation":
    case "spdd.collect_proof":
    case "spdd.scan_drift":
    case "spdd.create_sync_proposal":
    case "spdd.agent_swarm":
      return true;
    default:
      return false;
  }
}

function findNestedNode(
  nodes: readonly FlowNode[],
  parentPath: string,
  matches: (node: FlowNode) => boolean
): { node: FlowNode; path: string } | undefined {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    const path = `${parentPath}[${index}]`;
    if (matches(node)) return { node, path };

    for (const childGroup of childGroups(node, path)) {
      const nested = findNestedNode(
        childGroup.nodes,
        childGroup.path,
        matches
      );
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function childGroups(
  node: FlowNode,
  path: string
): Array<{ nodes: readonly FlowNode[]; path: string }> {
  switch (node.type) {
    case "sequence":
      return [{ nodes: node.nodes, path: `${path}.nodes` }];
    case "for_each":
    case "persona":
    case "route":
    case "loop":
      return [{ nodes: node.body, path: `${path}.body` }];
    case "branch":
      return [
        { nodes: node.then, path: `${path}.then` },
        ...(node.else === undefined
          ? []
          : [{ nodes: node.else, path: `${path}.else` }]),
      ];
    case "parallel":
      return node.branches.map((branch, branchIndex) => ({
        nodes: branch,
        path: `${path}.branches[${branchIndex}]`,
      }));
    case "try_catch":
      return [
        { nodes: node.body, path: `${path}.body` },
        { nodes: node.catch, path: `${path}.catch` },
      ];
    case "approval":
      return [
        { nodes: node.onApprove, path: `${path}.onApprove` },
        ...(node.onReject === undefined
          ? []
          : [{ nodes: node.onReject, path: `${path}.onReject` }]),
      ];
    default:
      return [];
  }
}

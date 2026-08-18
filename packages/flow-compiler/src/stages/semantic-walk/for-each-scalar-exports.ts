import type {
  FlowNode,
  ForEachNode,
  ValidationError,
} from "@dzupagent/flow-ast";

/**
 * Stage 3 check for `for_each` bodies that write scalar outputs without
 * declaring how iterations aggregate. Split out of `dispatch.ts`, which owns
 * only the recursive node dispatch; this validator shares none of its state.
 */

export function validateForEachScalarExports(
  node: ForEachNode,
  path: string,
  errors: ValidationError[]
): void {
  if (
    node.collect !== undefined ||
    node.attachAs !== undefined ||
    node.accumulator !== undefined
  ) {
    return;
  }

  for (let idx = 0; idx < node.body.length; idx++) {
    const child = node.body[idx];
    if (child === undefined) continue;
    for (const output of collectScalarOutputPaths(
      child,
      `${path}.body[${idx}]`
    )) {
      errors.push({
        nodeType: "for_each",
        nodePath: output.path,
        code: "AMBIGUOUS_LOOP_BODY_OUTPUT",
        category: "control",
        message:
          `for_each body writes scalar output "${output.key}" without explicit aggregation; ` +
          `declare for_each.collect, for_each.attachAs, or for_each.accumulator so iteration outputs are ordered and deterministic.`,
      });
    }
  }
}

function collectScalarOutputPaths(
  node: FlowNode,
  path: string
): Array<{ key: string; path: string }> {
  switch (node.type) {
    case "set":
      return Object.keys(node.assign).map((key) => ({
        key,
        path: `${path}.assign.${key}`,
      }));
    case "classify":
      return [{ key: node.outputKey, path: `${path}.outputKey` }];
    case "clarification":
      return node.outputKey !== undefined
        ? [{ key: node.outputKey, path: `${path}.outputKey` }]
        : [];
    case "memory":
      return node.outputVar !== undefined
        ? [{ key: node.outputVar, path: `${path}.outputVar` }]
        : [];
    case "http":
      return node.outputVar !== undefined
        ? [{ key: node.outputVar, path: `${path}.outputVar` }]
        : [];
    case "subflow":
      return node.outputVar !== undefined
        ? [{ key: node.outputVar, path: `${path}.outputVar` }]
        : [];
    case "prompt":
      return node.outputKey !== undefined
        ? [{ key: node.outputKey, path: `${path}.outputKey` }]
        : [];
    case "worker.dispatch":
    case "spdd.import_sources":
    case "spdd.build_source_pack":
    case "spdd.project_plan":
    case "spdd.scan_drift":
    case "spdd.run_analysis":
    case "spdd.generate_canvas":
    case "spdd.validate_canvas":
    case "spdd.review_canvas":
    case "spdd.arm_dispatch":
    case "spdd.run_validation":
    case "spdd.collect_proof":
    case "spdd.create_sync_proposal":
    case "spdd.agent_swarm":
      return [{ key: node.outputKey, path: `${path}.outputKey` }];
    case "fleet.dispatch":
    case "fleet.gather":
    case "fleet.contract-net":
    case "knowledge.query":
    case "shell.run":
    case "evidence.write":
    case "validate.schema":
    case "adapter.run":
    case "adapter.race":
    case "adapter.parallel":
    case "adapter.supervisor": {
      const output = "output" in node ? node.output : undefined;
      return typeof output === "string" && output.length > 0
        ? [{ key: output, path: `${path}.output` }]
        : [];
    }
    case "agent":
      return [{ key: node.output.key, path: `${path}.output.key` }];
    case "sequence":
      return node.nodes.flatMap((child, index) =>
        collectScalarOutputPaths(child, `${path}.nodes[${index}]`)
      );
    case "branch": {
      const outputs = node.then.flatMap((child, index) =>
        collectScalarOutputPaths(child, `${path}.then[${index}]`)
      );
      if (node.else !== undefined) {
        outputs.push(
          ...node.else.flatMap((child, index) =>
            collectScalarOutputPaths(child, `${path}.else[${index}]`)
          )
        );
      }
      return outputs;
    }
    case "parallel":
      return node.branches.flatMap((branch, branchIndex) =>
        branch.flatMap((child, index) =>
          collectScalarOutputPaths(
            child,
            `${path}.branches[${branchIndex}][${index}]`
          )
        )
      );
    case "approval": {
      const outputs = node.onApprove.flatMap((child, index) =>
        collectScalarOutputPaths(child, `${path}.onApprove[${index}]`)
      );
      if (node.onReject !== undefined) {
        outputs.push(
          ...node.onReject.flatMap((child, index) =>
            collectScalarOutputPaths(child, `${path}.onReject[${index}]`)
          )
        );
      }
      return outputs;
    }
    case "persona":
    case "route":
    case "loop":
      return node.body.flatMap((child, index) =>
        collectScalarOutputPaths(child, `${path}.body[${index}]`)
      );
    case "try_catch":
      return [
        ...node.body.flatMap((child, index) =>
          collectScalarOutputPaths(child, `${path}.body[${index}]`)
        ),
        ...node.catch.flatMap((child, index) =>
          collectScalarOutputPaths(child, `${path}.catch[${index}]`)
        ),
      ];
    case "for_each":
      return [];
    case "action":
    case "complete":
    case "spawn":
    case "emit":
    case "checkpoint":
    case "restore":
    case "wait":
    case "return_to":
    case "validate":
    case "knowledge.write":
      return [];
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
      return [];
    }
  }
}

import type {
  FlowNode,
  ForEachNode,
  ValidationError,
} from "@dzupagent/flow-ast";

import { validateConditionExpr } from "../semantic-condition.js";
import type { WalkContext } from "../semantic-context.js";
import { resolvePersonaNode } from "../semantic-persona-resolver.js";
import { resolveAgentProfile } from "../semantic-profile-resolver.js";
import { resolveAction } from "../semantic-tool-resolver.js";
import { resolveAgent } from "../semantic-toolset-resolver.js";

/**
 * Recursive AST traversal for Stage 3. Dispatches to the appropriate
 * resolver/validator sub-pass for each node variant; structural recursion
 * itself stays in this module.
 */
export async function visit(
  node: FlowNode,
  path: string,
  ctx: WalkContext
): Promise<void> {
  switch (node.type) {
    case "sequence": {
      for (let idx = 0; idx < node.nodes.length; idx++) {
        const child = node.nodes[idx];
        if (child !== undefined) {
          await visit(child, `${path}.nodes[${idx}]`, ctx);
        }
      }
      return;
    }
    case "action": {
      await resolveAction(node, path, ctx);
      return;
    }
    case "for_each": {
      validateConditionExpr(
        node.type,
        node.source,
        `${path}.source`,
        "for_each.source",
        ctx
      );
      for (let idx = 0; idx < node.body.length; idx++) {
        const child = node.body[idx];
        if (child !== undefined) {
          await visit(child, `${path}.body[${idx}]`, ctx);
        }
      }
      validateForEachScalarExports(node, path, ctx.errors);
      return;
    }
    case "branch": {
      validateConditionExpr(
        node.type,
        node.condition,
        `${path}.condition`,
        "branch.condition",
        ctx
      );
      for (let idx = 0; idx < node.then.length; idx++) {
        const child = node.then[idx];
        if (child !== undefined) {
          await visit(child, `${path}.then[${idx}]`, ctx);
        }
      }
      if (node.else !== undefined) {
        for (let idx = 0; idx < node.else.length; idx++) {
          const child = node.else[idx];
          if (child !== undefined) {
            await visit(child, `${path}.else[${idx}]`, ctx);
          }
        }
      }
      return;
    }
    case "parallel": {
      for (let bIdx = 0; bIdx < node.branches.length; bIdx++) {
        const branch = node.branches[bIdx];
        if (branch === undefined) continue;
        for (let idx = 0; idx < branch.length; idx++) {
          const child = branch[idx];
          if (child !== undefined) {
            await visit(child, `${path}.branches[${bIdx}][${idx}]`, ctx);
          }
        }
      }
      return;
    }
    case "approval": {
      for (let idx = 0; idx < node.onApprove.length; idx++) {
        const child = node.onApprove[idx];
        if (child !== undefined) {
          await visit(child, `${path}.onApprove[${idx}]`, ctx);
        }
      }
      if (node.onReject !== undefined) {
        for (let idx = 0; idx < node.onReject.length; idx++) {
          const child = node.onReject[idx];
          if (child !== undefined) {
            await visit(child, `${path}.onReject[${idx}]`, ctx);
          }
        }
      }
      return;
    }
    case "clarification": {
      // Leaf — no refs to resolve.
      return;
    }
    case "persona": {
      await resolvePersonaNode(node, path, ctx);
      for (let idx = 0; idx < node.body.length; idx++) {
        const child = node.body[idx];
        if (child !== undefined) {
          await visit(child, `${path}.body[${idx}]`, ctx);
        }
      }
      return;
    }
    case "route": {
      for (let idx = 0; idx < node.body.length; idx++) {
        const child = node.body[idx];
        if (child !== undefined) {
          await visit(child, `${path}.body[${idx}]`, ctx);
        }
      }
      return;
    }
    case "complete": {
      return;
    }
    case "spawn": {
      // waitForCompletion=true is not yet implemented in the Codev FlowRuntime.
      // Warn at compile time so authors know before runtime.
      if (node.waitForCompletion === true) {
        ctx.warnings.push({
          nodeType: node.type,
          nodePath: `${path}.waitForCompletion`,
          code: "MISSING_REQUIRED_FIELD",
          message:
            `spawn node "${
              node.id ?? node.templateRef
            }": waitForCompletion=true is not yet implemented — ` +
            `the spawn will fire-and-forget at runtime regardless. ` +
            `Remove waitForCompletion or set it to false to silence this warning.`,
          category: "policy",
        });
      }
      return;
    }
    case "classify":
    case "emit":
    case "memory":
    case "checkpoint":
    case "restore":
    case "http":
    case "wait":
    case "subflow":
    case "fleet.dispatch":
    case "fleet.gather":
    case "fleet.contract-net":
    case "knowledge.write":
    case "knowledge.query": {
      // Leaf nodes — no refs to resolve in semantic stage.
      return;
    }
    case "try_catch": {
      for (let idx = 0; idx < node.body.length; idx++) {
        const child = node.body[idx];
        if (child !== undefined)
          await visit(child, `${path}.body[${idx}]`, ctx);
      }
      for (let idx = 0; idx < node.catch.length; idx++) {
        const child = node.catch[idx];
        if (child !== undefined)
          await visit(child, `${path}.catch[${idx}]`, ctx);
      }
      return;
    }
    case "loop": {
      validateConditionExpr(
        node.type,
        node.condition,
        `${path}.condition`,
        "loop.condition",
        ctx
      );
      for (let idx = 0; idx < node.body.length; idx++) {
        const child = node.body[idx];
        if (child !== undefined)
          await visit(child, `${path}.body[${idx}]`, ctx);
      }
      return;
    }
    case "agent": {
      // Profile flattening must run BEFORE toolset resolution so a
      // profile-supplied `toolset` is expanded by the same compile pass.
      // After this call the node carries flattened model/provider/
      // instructions/toolset/policy and `node.profile` is stripped.
      resolveAgentProfile(node, path, ctx);
      await resolveAgent(node, path, ctx);
      return;
    }
    case "return_to": {
      validateConditionExpr(
        node.type,
        node.condition,
        `${path}.condition`,
        "return_to.condition",
        ctx
      );
      return;
    }
    case "prompt":
    case "validate":
    case "set":
    case "worker.dispatch":
    case "shell.run":
    case "evidence.write":
    case "validate.schema":
    case "adapter.run":
    case "adapter.race":
    case "adapter.parallel":
    case "adapter.supervisor":
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
      return;
    default: {
      // Exhaustiveness guard — adding a FlowNode variant without a case fails
      // compilation here.
      const _exhaustive: never = node;
      void _exhaustive;
      return;
    }
  }
}

function validateForEachScalarExports(
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
    case "clarification":
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

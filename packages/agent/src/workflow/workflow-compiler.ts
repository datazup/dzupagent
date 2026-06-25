/**
 * Internal workflow compiler — translates `WorkflowNode[]` into a canonical
 * `PipelineDefinition` that can be executed by `PipelineRuntime`.
 *
 * This file is the coordinator: it walks the user's `WorkflowNode[]` graph
 * in reverse, delegates per-node lowering to `workflow-compiler-node-builders`
 * (step / parallel / branch / suspend / passthrough), threads in the error
 * handlers from `workflow-compiler-error-handlers`, and finally wires up
 * a `NodeExecutor` via `workflow-compiler-executor`. The four sibling
 * modules were carved out so this file can stay focused on flow lowering
 * and stay under the per-file LOC budget.
 *
 * Exported for use by `CompiledWorkflow`; not part of the public package
 * surface.
 *
 * @module workflow/workflow-compiler
 */
import type {
  PipelineDefinition,
  PipelineNode,
} from "@dzupagent/core/pipeline";
import type { WorkflowStep, WorkflowNode } from "./workflow-types.js";
import type {
  WorkflowConfig,
  WorkflowErrorHandler,
} from "./workflow-builder-types.js";
import type {
  WorkflowCompilation,
  WorkflowTransformHandler,
} from "./workflow-compiler-types.js";
import { createNodeBuilders } from "./workflow-compiler-node-builders.js";
import { createNodeExecutorFactory } from "./workflow-compiler-executor.js";
import { omitUndefined } from "../utils/exact-optional.js";

// Re-export `WorkflowCompilation` so existing callers (notably
// `compiled-workflow.ts`) keep importing it from this module.
export type { WorkflowCompilation } from "./workflow-compiler-types.js";
// Re-export `applyErrorHandlers` for unit-test consumers that imported it
// from this module before the split.
export { applyErrorHandlers } from "./workflow-compiler-error-handlers.js";

export function compileWorkflow(
  config: WorkflowConfig,
  nodes: WorkflowNode[],
  errorHandlers: WorkflowErrorHandler[] = []
): WorkflowCompilation {
  const pipelineNodes: PipelineNode[] = [];
  const edges: PipelineDefinition["edges"] = [];
  const predicates: Record<
    string,
    (state: Record<string, unknown>) => boolean | string
  > = {};
  const suspendReasons = new Map<string, string>();
  const handlers = new Map<string, WorkflowTransformHandler>();

  const nodeSeqRef = { value: 0 };
  const transformSeqRef = { value: 0 };
  const predicateSeqRef = { value: 0 };

  const builders = createNodeBuilders({
    config,
    errorHandlers,
    pipelineNodes,
    edges,
    predicates,
    handlers,
    nodeSeqRef,
    transformSeqRef,
    predicateSeqRef,
  });

  const {
    nextNodeId,
    appendSequential,
    addTransformNode,
    addStepNode,
    addParallelNode,
    addBranchNode,
  } = builders;

  const compileStepSequence = (
    steps: WorkflowStep[],
    continuationNodeId: string | undefined,
    sequenceLabel: string
  ): string | undefined => {
    if (steps.length === 0) {
      return continuationNodeId;
    }

    let next = continuationNodeId;
    for (let i = steps.length - 1; i >= 0; i--) {
      const stepNodeId = addStepNode(steps[i]!, sequenceLabel);
      appendSequential(stepNodeId, next);
      next = stepNodeId;
    }
    return next;
  };

  let nextNodeIdInFlow: string | undefined;

  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!;

    switch (node.type) {
      case "step": {
        const stepNodeId = addStepNode(node.step, "linear");
        appendSequential(stepNodeId, nextNodeIdInFlow);
        nextNodeIdInFlow = stepNodeId;
        break;
      }

      case "parallel": {
        const parallelNodeId = addParallelNode(node.steps, node.mergeStrategy);
        appendSequential(parallelNodeId, nextNodeIdInFlow);
        nextNodeIdInFlow = parallelNodeId;
        break;
      }

      case "suspend": {
        const suspendNodeId = nextNodeId("suspend");
        pipelineNodes.push({
          id: suspendNodeId,
          type: "suspend",
          name: `suspend:${node.reason}`,
          timeoutMs: 120_000,
        });
        suspendReasons.set(suspendNodeId, node.reason);
        appendSequential(suspendNodeId, nextNodeIdInFlow);
        nextNodeIdInFlow = suspendNodeId;
        break;
      }

      case "branch": {
        const { nodeId, predicateName } = addBranchNode(
          node.condition,
          node.branches
        );

        const branchTargets: Record<string, string> = {};
        for (const [branchName, branchSteps] of Object.entries(node.branches)) {
          const targetId = compileStepSequence(
            branchSteps,
            nextNodeIdInFlow,
            `branch:${branchName}`
          );
          if (targetId) {
            branchTargets[branchName] = targetId;
          }
        }

        if (Object.keys(branchTargets).length === 0) {
          // Branch node with no executable targets — create a passthrough noop.
          const passthroughId = addTransformNode(
            "noop",
            async () => ({}),
            "branch-passthrough"
          );
          appendSequential(passthroughId, nextNodeIdInFlow);
          branchTargets["__default__"] = passthroughId;
          predicates[predicateName] = () => "__default__";
        }

        edges.push({
          type: "conditional",
          sourceNodeId: nodeId,
          predicateName,
          branches: branchTargets,
        });
        nextNodeIdInFlow = nodeId;
        break;
      }
    }
  }

  if (!nextNodeIdInFlow) {
    nextNodeIdInFlow = addTransformNode(
      "noop",
      async () => ({}),
      "empty-workflow"
    );
  }

  const definition: PipelineDefinition = omitUndefined({
    id: config.id,
    name: config.id,
    version: "1.0.0",
    description: config.description,
    schemaVersion: "1.0.0",
    entryNodeId: nextNodeIdInFlow,
    nodes: pipelineNodes,
    edges,
    checkpointStrategy: "after_each_node",
    metadata: {
      source: "WorkflowBuilder",
      runtime: "PipelineRuntime",
    },
    tags: ["workflow-compat"],
  });

  return {
    definition,
    predicates,
    suspendReasons,
    createNodeExecutor: createNodeExecutorFactory(config.id, handlers),
  };
}

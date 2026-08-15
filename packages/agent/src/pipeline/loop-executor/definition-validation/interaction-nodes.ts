import type { PipelineDefinition, PipelineEdge, PipelineValidationError } from "@dzupagent/core/pipeline";
import { validatePipelineInteractionSpecV1 } from "@dzupagent/runtime-contracts";

export function validateInteractionNodes(
  definition: PipelineDefinition,
  errors: PipelineValidationError[],
): void {
  // --- Checkpoint-bound interaction protocol ---
  for (const node of definition.nodes) {
    if (
      (node.type !== 'gate' && node.type !== 'suspend') ||
      node.interaction === undefined
    ) {
      continue
    }
    if (definition.schemaVersion !== '1.1.0') {
      errors.push({
        code: 'INVALID_INTERACTION_SPEC',
        message: `Interaction node "${node.id}" requires pipeline schemaVersion 1.1.0`,
        nodeId: node.id,
      })
    }
    const validated = validatePipelineInteractionSpecV1(node.interaction)
    if (!validated.valid) {
      errors.push({
        code: 'INVALID_INTERACTION_SPEC',
        message: `Interaction node "${node.id}" is invalid: ${validated.issues
          .map(issue => `${issue.path}: ${issue.message}`)
          .join('; ')}`,
        nodeId: node.id,
      })
      continue
    }
    if (node.type === 'gate') {
      if (node.gateType !== 'approval' || node.interaction.kind !== 'approval') {
        errors.push({
          code: 'INVALID_INTERACTION_SPEC',
          message: `Interaction gate "${node.id}" must be an approval gate with an approval specification`,
          nodeId: node.id,
        })
        continue
      }
      const decisionEdges = definition.edges.filter(
        (edge): edge is Extract<PipelineEdge, { type: 'conditional' }> =>
          edge.type === 'conditional' && edge.sourceNodeId === node.id,
      )
      const decisionEdge = decisionEdges[0]
      if (
        decisionEdges.length !== 1 ||
        decisionEdge === undefined ||
        Object.keys(decisionEdge.branches).length !== 2 ||
        decisionEdge.branches.approved !==
          node.interaction.outcomeToSuccessor.approved ||
        decisionEdge.branches.rejected !==
          node.interaction.outcomeToSuccessor.rejected
      ) {
        errors.push({
          code: 'INVALID_INTERACTION_ROUTING',
          message: `Approval interaction "${node.id}" must have one exact approved/rejected conditional edge`,
          nodeId: node.id,
        })
      }
    } else if (node.interaction.kind !== 'clarification') {
      errors.push({
        code: 'INVALID_INTERACTION_SPEC',
        message: `Suspend interaction "${node.id}" must carry a clarification specification`,
        nodeId: node.id,
      })
    }
  }

}

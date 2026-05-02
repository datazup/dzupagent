import type { FlowNode, FlowNodeMetadata } from '@dzupagent/flow-ast'

export interface FlowArtifactNodeMetadata {
  type: FlowNode['type']
  id?: string
  meta?: FlowNodeMetadata
  toolRef?: string
  condition?: string
  question?: string
}

export interface FlowArtifactMetadata {
  schema: 'dzupagent.flowArtifactMetadata/v1'
  nodes: Record<string, FlowArtifactNodeMetadata>
}

export function collectFlowArtifactMetadata(ast: FlowNode): FlowArtifactMetadata {
  const nodes: Record<string, FlowArtifactNodeMetadata> = {}
  collectNodeMetadata(ast, 'root', nodes)
  return {
    schema: 'dzupagent.flowArtifactMetadata/v1',
    nodes,
  }
}

function collectNodeMetadata(
  node: FlowNode,
  path: string,
  out: Record<string, FlowArtifactNodeMetadata>,
): void {
  out[path] = nodeMetadata(node)

  switch (node.type) {
    case 'sequence':
      node.nodes.forEach((child, index) => collectNodeMetadata(child, `${path}.nodes[${index}]`, out))
      return
    case 'for_each':
      node.body.forEach((child, index) => collectNodeMetadata(child, `${path}.body[${index}]`, out))
      return
    case 'branch':
      node.then.forEach((child, index) => collectNodeMetadata(child, `${path}.then[${index}]`, out))
      node.else?.forEach((child, index) => collectNodeMetadata(child, `${path}.else[${index}]`, out))
      return
    case 'parallel':
      node.branches.forEach((branch, branchIndex) => {
        branch.forEach((child, index) =>
          collectNodeMetadata(child, `${path}.branches[${branchIndex}][${index}]`, out),
        )
      })
      return
    case 'approval':
      node.onApprove.forEach((child, index) => collectNodeMetadata(child, `${path}.onApprove[${index}]`, out))
      node.onReject?.forEach((child, index) => collectNodeMetadata(child, `${path}.onReject[${index}]`, out))
      return
    case 'persona':
    case 'route':
      node.body.forEach((child, index) => collectNodeMetadata(child, `${path}.body[${index}]`, out))
      return
    default:
      return
  }
}

function nodeMetadata(node: FlowNode): FlowArtifactNodeMetadata {
  const base: FlowArtifactNodeMetadata = {
    type: node.type,
    ...(node.id !== undefined ? { id: node.id } : {}),
    ...(node.meta !== undefined ? { meta: node.meta } : {}),
  }

  if (node.type === 'action') return { ...base, toolRef: node.toolRef }
  if (node.type === 'branch') return { ...base, condition: node.condition }
  if (node.type === 'approval' || node.type === 'clarification') {
    return { ...base, question: node.question }
  }
  if (node.type === 'classify') return { ...base, question: node.prompt }
  return base
}

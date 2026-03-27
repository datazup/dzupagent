/**
 * Pipeline documentation renderer — produces markdown with a Mermaid flowchart
 * from a pipeline definition.
 *
 * @module docs/pipeline-doc
 */

export interface PipelineDocNode {
  id: string
  type: string
  name?: string
}

export interface PipelineDocEdge {
  type: string
  sourceNodeId: string
  targetNodeId?: string
  branches?: Record<string, string>
}

export interface PipelineDocInput {
  name: string
  definition: {
    nodes: PipelineDocNode[]
    edges: PipelineDocEdge[]
  }
}

/**
 * Escape a label for use inside Mermaid node definitions.
 */
function escapeMermaid(text: string): string {
  return text.replace(/"/g, "'")
}

/**
 * Render a markdown document with a Mermaid flowchart for a pipeline.
 */
export function renderPipelineDoc(pipeline: PipelineDocInput): string {
  const lines: string[] = []

  lines.push(`# Pipeline: ${pipeline.name}`)
  lines.push('')

  // Node table
  const { nodes, edges } = pipeline.definition

  if (nodes.length > 0) {
    lines.push('## Nodes')
    lines.push('')
    lines.push('| ID | Type | Name |')
    lines.push('|----|------|------|')
    for (const node of nodes) {
      lines.push(`| ${node.id} | ${node.type} | ${node.name ?? '-'} |`)
    }
    lines.push('')
  }

  // Mermaid flowchart
  lines.push('## Flowchart')
  lines.push('')
  lines.push('```mermaid')
  lines.push('flowchart TD')

  // Declare nodes
  for (const node of nodes) {
    const label = escapeMermaid(node.name ?? node.id)
    lines.push(`  ${node.id}["${label}"]`)
  }

  // Declare edges
  for (const edge of edges) {
    if (edge.type === 'conditional' && edge.branches) {
      for (const [label, targetId] of Object.entries(edge.branches)) {
        lines.push(`  ${edge.sourceNodeId} -->|${escapeMermaid(label)}| ${targetId}`)
      }
    } else if (edge.targetNodeId) {
      lines.push(`  ${edge.sourceNodeId} --> ${edge.targetNodeId}`)
    }
  }

  lines.push('```')
  lines.push('')

  return lines.join('\n')
}

/**
 * Pipeline layout — auto-layout for pipeline visualization.
 *
 * Provides a simple topological layout algorithm that arranges nodes
 * top-to-bottom with horizontal spacing for parallel branches.
 *
 * @module pipeline/pipeline-layout
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NodePosition {
  x: number
  y: number
  width?: number
  height?: number
}

export interface ViewportState {
  zoom: number
  panX: number
  panY: number
}

export interface PipelineLayout {
  nodePositions: Record<string, NodePosition>
  viewport?: ViewportState
  layoutAlgorithm?: string
  computedAt?: string
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const DEFAULT_NODE_WIDTH = 200
const DEFAULT_NODE_HEIGHT = 80
const HORIZONTAL_GAP = 60
const VERTICAL_GAP = 100

// ---------------------------------------------------------------------------
// autoLayout — simple topological top-to-bottom layout
// ---------------------------------------------------------------------------

interface LayoutNode {
  id: string
}

interface LayoutEdge {
  sourceNodeId: string
  targetNodeId?: string
}

/**
 * Compute a top-to-bottom layout for pipeline nodes.
 *
 * Algorithm:
 * 1. Build adjacency from edges.
 * 2. Compute depth (longest path from any root) via BFS/DFS.
 * 3. Assign y based on depth, x based on horizontal position within each depth layer.
 */
export function autoLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
): PipelineLayout {
  if (nodes.length === 0) {
    return {
      nodePositions: {},
      layoutAlgorithm: 'topological',
      computedAt: new Date().toISOString(),
    }
  }

  // Build adjacency lists
  const children = new Map<string, string[]>()
  const inDegree = new Map<string, number>()

  for (const node of nodes) {
    children.set(node.id, [])
    inDegree.set(node.id, 0)
  }

  for (const edge of edges) {
    if (edge.targetNodeId) {
      const existing = children.get(edge.sourceNodeId)
      if (existing) {
        existing.push(edge.targetNodeId)
      }
      inDegree.set(edge.targetNodeId, (inDegree.get(edge.targetNodeId) ?? 0) + 1)
    }
  }

  // Compute depth via topological sort (Kahn's algorithm)
  const depth = new Map<string, number>()
  const queue: string[] = []

  for (const node of nodes) {
    if ((inDegree.get(node.id) ?? 0) === 0) {
      queue.push(node.id)
      depth.set(node.id, 0)
    }
  }

  let head = 0
  while (head < queue.length) {
    const current = queue[head]!
    head++
    const currentDepth = depth.get(current) ?? 0
    const childIds = children.get(current) ?? []

    for (const child of childIds) {
      const existingDepth = depth.get(child)
      const newDepth = currentDepth + 1
      // Use max depth to handle nodes with multiple parents
      if (existingDepth === undefined || newDepth > existingDepth) {
        depth.set(child, newDepth)
      }
      const newIn = (inDegree.get(child) ?? 1) - 1
      inDegree.set(child, newIn)
      if (newIn === 0) {
        queue.push(child)
      }
    }
  }

  // Handle any unvisited nodes (cycles or disconnected)
  for (const node of nodes) {
    if (!depth.has(node.id)) {
      depth.set(node.id, 0)
    }
  }

  // Group nodes by depth layer
  const layers = new Map<number, string[]>()
  for (const node of nodes) {
    const d = depth.get(node.id) ?? 0
    const layer = layers.get(d)
    if (layer) {
      layer.push(node.id)
    } else {
      layers.set(d, [node.id])
    }
  }

  // Assign positions
  const nodePositions: Record<string, NodePosition> = {}

  for (const [layerDepth, layerNodes] of layers) {
    const layerWidth = layerNodes.length * (DEFAULT_NODE_WIDTH + HORIZONTAL_GAP) - HORIZONTAL_GAP
    const startX = -layerWidth / 2 + DEFAULT_NODE_WIDTH / 2

    for (let i = 0; i < layerNodes.length; i++) {
      const nodeId = layerNodes[i]!
      nodePositions[nodeId] = {
        x: startX + i * (DEFAULT_NODE_WIDTH + HORIZONTAL_GAP),
        y: layerDepth * (DEFAULT_NODE_HEIGHT + VERTICAL_GAP),
        width: DEFAULT_NODE_WIDTH,
        height: DEFAULT_NODE_HEIGHT,
      }
    }
  }

  return {
    nodePositions,
    layoutAlgorithm: 'topological',
    computedAt: new Date().toISOString(),
    viewport: {
      zoom: 1,
      panX: 0,
      panY: 0,
    },
  }
}

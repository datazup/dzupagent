import { describe, it, expect } from 'vitest'
import { autoLayout } from '../pipeline/pipeline-layout.js'
import type { NodePosition, ViewportState, PipelineLayout } from '../pipeline/pipeline-layout.js'

describe('autoLayout', () => {
  it('returns empty positions for empty input', () => {
    const layout = autoLayout([], [])
    expect(layout.nodePositions).toEqual({})
    expect(layout.layoutAlgorithm).toBe('topological')
    expect(layout.computedAt).toBeTruthy()
  })

  it('assigns positions for a single node', () => {
    const layout = autoLayout([{ id: 'A' }], [])
    expect(layout.nodePositions['A']).toBeDefined()
    const pos = layout.nodePositions['A'] as NodePosition
    expect(typeof pos.x).toBe('number')
    expect(typeof pos.y).toBe('number')
  })

  it('arranges a linear chain top-to-bottom', () => {
    const nodes = [{ id: 'A' }, { id: 'B' }, { id: 'C' }]
    const edges = [
      { sourceNodeId: 'A', targetNodeId: 'B' },
      { sourceNodeId: 'B', targetNodeId: 'C' },
    ]
    const layout = autoLayout(nodes, edges)

    const posA = layout.nodePositions['A'] as NodePosition
    const posB = layout.nodePositions['B'] as NodePosition
    const posC = layout.nodePositions['C'] as NodePosition

    // Each subsequent node should be lower (higher y)
    expect(posA.y).toBeLessThan(posB.y)
    expect(posB.y).toBeLessThan(posC.y)
  })

  it('places parallel branches at the same depth with horizontal spread', () => {
    const nodes = [{ id: 'start' }, { id: 'left' }, { id: 'right' }]
    const edges = [
      { sourceNodeId: 'start', targetNodeId: 'left' },
      { sourceNodeId: 'start', targetNodeId: 'right' },
    ]
    const layout = autoLayout(nodes, edges)

    const posLeft = layout.nodePositions['left'] as NodePosition
    const posRight = layout.nodePositions['right'] as NodePosition

    // Same depth → same y
    expect(posLeft.y).toBe(posRight.y)
    // Different x
    expect(posLeft.x).not.toBe(posRight.x)
  })

  it('includes width and height in node positions', () => {
    const layout = autoLayout([{ id: 'X' }], [])
    const pos = layout.nodePositions['X'] as NodePosition
    expect(pos.width).toBeGreaterThan(0)
    expect(pos.height).toBeGreaterThan(0)
  })

  it('includes viewport state', () => {
    const layout = autoLayout([{ id: 'A' }], [])
    expect(layout.viewport).toBeDefined()
    const vp = layout.viewport as ViewportState
    expect(vp.zoom).toBe(1)
    expect(typeof vp.panX).toBe('number')
    expect(typeof vp.panY).toBe('number')
  })

  it('serializes and deserializes to JSON correctly', () => {
    const nodes = [{ id: 'A' }, { id: 'B' }]
    const edges = [{ sourceNodeId: 'A', targetNodeId: 'B' }]
    const layout = autoLayout(nodes, edges)

    const json = JSON.stringify(layout)
    const parsed = JSON.parse(json) as PipelineLayout

    expect(parsed.nodePositions['A']).toBeDefined()
    expect(parsed.nodePositions['B']).toBeDefined()
    expect(parsed.layoutAlgorithm).toBe('topological')
    expect(parsed.viewport?.zoom).toBe(1)
  })

  it('handles edges without targetNodeId gracefully', () => {
    const nodes = [{ id: 'A' }, { id: 'B' }]
    const edges = [{ sourceNodeId: 'A' }]
    const layout = autoLayout(nodes, edges)
    expect(layout.nodePositions['A']).toBeDefined()
    expect(layout.nodePositions['B']).toBeDefined()
  })

  it('handles diamond-shaped graph (join node)', () => {
    const nodes = [{ id: 'S' }, { id: 'L' }, { id: 'R' }, { id: 'J' }]
    const edges = [
      { sourceNodeId: 'S', targetNodeId: 'L' },
      { sourceNodeId: 'S', targetNodeId: 'R' },
      { sourceNodeId: 'L', targetNodeId: 'J' },
      { sourceNodeId: 'R', targetNodeId: 'J' },
    ]
    const layout = autoLayout(nodes, edges)

    const posS = layout.nodePositions['S'] as NodePosition
    const posL = layout.nodePositions['L'] as NodePosition
    const posJ = layout.nodePositions['J'] as NodePosition

    // Join node should be deeper than branches
    expect(posJ.y).toBeGreaterThan(posL.y)
    expect(posL.y).toBeGreaterThan(posS.y)
  })
})

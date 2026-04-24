import { describe, it, expect } from 'vitest'

import type { FlowDocumentV1 } from '@dzupagent/flow-ast'
import { documentToGraph } from '../document-to-graph.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(nodes: FlowDocumentV1['root']['nodes']): FlowDocumentV1 {
  return {
    dsl: 'dzupflow/v1',
    id: 'test',
    version: 1,
    root: { type: 'sequence', id: 'root', nodes },
  }
}

// ---------------------------------------------------------------------------
// documentToGraph
// ---------------------------------------------------------------------------

describe('documentToGraph', () => {
  describe('single action node', () => {
    it('produces one graph node for a single action', () => {
      const doc = makeDoc([
        { type: 'action', id: 'a1', toolRef: 'skill:foo', input: {} },
      ])
      const graph = documentToGraph(doc)
      expect(graph.nodes).toHaveLength(1)
      expect(graph.nodes[0]?.id).toBe('a1')
      expect(graph.nodes[0]?.type).toBe('action')
      expect(graph.edges).toHaveLength(0)
    })

    it('uses toolRef as label when name is absent', () => {
      const doc = makeDoc([
        { type: 'action', id: 'a1', toolRef: 'skill:run', input: {} },
      ])
      const graph = documentToGraph(doc)
      expect(graph.nodes[0]?.label).toBe('skill:run')
    })

    it('uses name as label when present', () => {
      const doc = makeDoc([
        { type: 'action', id: 'a1', name: 'My Action', toolRef: 'skill:run', input: {} },
      ])
      const graph = documentToGraph(doc)
      expect(graph.nodes[0]?.label).toBe('My Action')
    })
  })

  describe('sequential actions', () => {
    it('produces sequential edges between two action nodes', () => {
      const doc = makeDoc([
        { type: 'action', id: 'a1', toolRef: 'skill:a', input: {} },
        { type: 'action', id: 'a2', toolRef: 'skill:b', input: {} },
      ])
      const graph = documentToGraph(doc)
      expect(graph.nodes).toHaveLength(2)
      expect(graph.edges).toHaveLength(1)
      expect(graph.edges[0]?.source).toBe('a1')
      expect(graph.edges[0]?.target).toBe('a2')
    })

    it('produces N-1 edges for N sequential nodes', () => {
      const doc = makeDoc([
        { type: 'action', id: 'a1', toolRef: 'skill:a', input: {} },
        { type: 'action', id: 'a2', toolRef: 'skill:b', input: {} },
        { type: 'action', id: 'a3', toolRef: 'skill:c', input: {} },
      ])
      const graph = documentToGraph(doc)
      expect(graph.nodes).toHaveLength(3)
      expect(graph.edges).toHaveLength(2)
    })
  })

  describe('branch node', () => {
    it('produces edges from branch to then and else', () => {
      const doc = makeDoc([
        {
          type: 'branch',
          id: 'b1',
          condition: 'x > 0',
          then: [{ type: 'action', id: 'then1', toolRef: 'skill:a', input: {} }],
          else: [{ type: 'action', id: 'else1', toolRef: 'skill:b', input: {} }],
        },
      ])
      const graph = documentToGraph(doc)
      const nodeIds = graph.nodes.map((n) => n.id)
      expect(nodeIds).toContain('b1')
      expect(nodeIds).toContain('then1')
      expect(nodeIds).toContain('else1')

      const branchToThen = graph.edges.find((e) => e.source === 'b1' && e.target === 'then1')
      const branchToElse = graph.edges.find((e) => e.source === 'b1' && e.target === 'else1')
      expect(branchToThen).toBeDefined()
      expect(branchToThen?.label).toBe('then')
      expect(branchToElse).toBeDefined()
      expect(branchToElse?.label).toBe('else')
    })
  })

  describe('parallel node', () => {
    it('produces nodes for each branch', () => {
      const doc = makeDoc([
        {
          type: 'parallel',
          id: 'par1',
          branches: [
            [{ type: 'action', id: 'p1a', toolRef: 'skill:a', input: {} }],
            [{ type: 'action', id: 'p2a', toolRef: 'skill:b', input: {} }],
          ],
          meta: { branchNames: ['branchA', 'branchB'] },
        },
      ])
      const graph = documentToGraph(doc)
      const nodeIds = graph.nodes.map((n) => n.id)
      expect(nodeIds).toContain('par1')
      expect(nodeIds).toContain('p1a')
      expect(nodeIds).toContain('p2a')
    })

    it('produces edges from parallel to each branch entry with label', () => {
      const doc = makeDoc([
        {
          type: 'parallel',
          id: 'par1',
          branches: [
            [{ type: 'action', id: 'pa', toolRef: 'skill:a', input: {} }],
            [{ type: 'action', id: 'pb', toolRef: 'skill:b', input: {} }],
          ],
          meta: { branchNames: ['alpha', 'beta'] },
        },
      ])
      const graph = documentToGraph(doc)
      const edgeLabels = graph.edges.map((e) => e.label)
      expect(edgeLabels).toContain('alpha')
      expect(edgeLabels).toContain('beta')
    })
  })

  describe('approval node', () => {
    it('produces edges with approve/reject labels', () => {
      const doc = makeDoc([
        {
          type: 'approval',
          id: 'app1',
          question: 'Proceed?',
          onApprove: [{ type: 'action', id: 'ok', toolRef: 'skill:a', input: {} }],
          onReject: [{ type: 'action', id: 'nok', toolRef: 'skill:b', input: {} }],
        },
      ])
      const graph = documentToGraph(doc)
      const edgeLabels = graph.edges.map((e) => e.label)
      expect(edgeLabels).toContain('approve')
      expect(edgeLabels).toContain('reject')
    })
  })

  describe('complete node', () => {
    it('projects complete node as a leaf', () => {
      const doc = makeDoc([
        { type: 'complete', id: 'done' },
      ])
      const graph = documentToGraph(doc)
      expect(graph.nodes[0]?.id).toBe('done')
      expect(graph.nodes[0]?.type).toBe('complete')
      expect(graph.edges).toHaveLength(0)
    })
  })

  describe('auto-generated IDs', () => {
    it('generates unique IDs for nodes without id', () => {
      const doc = makeDoc([
        { type: 'action', toolRef: 'skill:a', input: {} },
        { type: 'action', toolRef: 'skill:b', input: {} },
      ])
      const graph = documentToGraph(doc)
      const ids = graph.nodes.map((n) => n.id)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(ids.length)
    })
  })

  describe('deduplication', () => {
    it('does not add duplicate graph nodes', () => {
      // Sequence with one node
      const doc = makeDoc([
        { type: 'action', id: 'a1', toolRef: 'skill:a', input: {} },
      ])
      const graph = documentToGraph(doc)
      const countA1 = graph.nodes.filter((n) => n.id === 'a1').length
      expect(countA1).toBe(1)
    })
  })
})

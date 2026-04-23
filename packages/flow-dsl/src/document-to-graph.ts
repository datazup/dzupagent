import type { FlowDocumentV1, FlowNode } from '@dzupagent/flow-ast'

import type { DerivedGraph, DerivedGraphEdge, DerivedGraphNode } from './types.js'

interface ProjectionState {
  nodes: DerivedGraphNode[]
  edges: DerivedGraphEdge[]
}

interface ProjectionResult {
  entryIds: string[]
  exitIds: string[]
}

export function documentToGraph(document: FlowDocumentV1): DerivedGraph {
  const state: ProjectionState = { nodes: [], edges: [] }
  projectSequence(document.root.nodes, state)
  return { nodes: state.nodes, edges: state.edges }
}

function projectSequence(nodes: FlowNode[], state: ProjectionState): ProjectionResult {
  let entryIds: string[] = []
  let previousExits: string[] = []

  for (const node of nodes) {
    const result = projectNode(node, state)
    if (entryIds.length === 0) entryIds = result.entryIds
    for (const from of previousExits) {
      for (const to of result.entryIds) {
        pushEdge(state, `${from}__${to}`, from, to)
      }
    }
    previousExits = result.exitIds
  }

  return { entryIds, exitIds: previousExits }
}

function projectNode(node: FlowNode, state: ProjectionState): ProjectionResult {
  const id = node.id ?? `${node.type}_${state.nodes.length + 1}`
  pushNode(state, id, node.type, labelForNode(node))

  switch (node.type) {
    case 'action':
    case 'clarification':
    case 'complete':
      return { entryIds: [id], exitIds: [id] }
    case 'sequence': {
      const inner = projectSequence(node.nodes, state)
      if (inner.entryIds.length > 0) {
        for (const entry of inner.entryIds) pushEdge(state, `${id}__${entry}`, id, entry)
      }
      return { entryIds: [id], exitIds: inner.exitIds.length > 0 ? inner.exitIds : [id] }
    }
    case 'for_each':
    case 'persona':
    case 'route': {
      const body = projectSequence(node.body, state)
      for (const entry of body.entryIds) pushEdge(state, `${id}__${entry}`, id, entry)
      return { entryIds: [id], exitIds: body.exitIds.length > 0 ? body.exitIds : [id] }
    }
    case 'branch': {
      const thenBody = projectSequence(node.then, state)
      for (const entry of thenBody.entryIds) pushEdge(state, `${id}__then__${entry}`, id, entry, 'then')
      const elseEntries: string[] = []
      let elseExits: string[] = []
      if (node.else && node.else.length > 0) {
        const elseBody = projectSequence(node.else, state)
        elseEntries.push(...elseBody.entryIds)
        elseExits = elseBody.exitIds
        for (const entry of elseBody.entryIds) pushEdge(state, `${id}__else__${entry}`, id, entry, 'else')
      }
      return {
        entryIds: [id],
        exitIds: [...thenBody.exitIds, ...elseExits].length > 0 ? [...thenBody.exitIds, ...elseExits] : [id],
      }
    }
    case 'approval': {
      const approve = projectSequence(node.onApprove, state)
      for (const entry of approve.entryIds) pushEdge(state, `${id}__approve__${entry}`, id, entry, 'approve')
      const exits = [...approve.exitIds]
      if (node.onReject && node.onReject.length > 0) {
        const reject = projectSequence(node.onReject, state)
        for (const entry of reject.entryIds) pushEdge(state, `${id}__reject__${entry}`, id, entry, 'reject')
        exits.push(...reject.exitIds)
      }
      return { entryIds: [id], exitIds: exits.length > 0 ? exits : [id] }
    }
    case 'parallel': {
      const branchNames = Array.isArray(node.meta?.['branchNames'])
        ? node.meta!['branchNames'].filter((value): value is string => typeof value === 'string')
        : []
      const exits: string[] = []
      node.branches.forEach((branch, index) => {
        const projected = projectSequence(branch, state)
        const label = branchNames[index] ?? `branch_${index + 1}`
        for (const entry of projected.entryIds) pushEdge(state, `${id}__${label}__${entry}`, id, entry, label)
        exits.push(...projected.exitIds)
      })
      return { entryIds: [id], exitIds: exits.length > 0 ? exits : [id] }
    }
    default: {
      const _exhaustive: never = node
      void _exhaustive
      return { entryIds: [id], exitIds: [id] }
    }
  }
}

function pushNode(state: ProjectionState, id: string, type: FlowNode['type'], label: string): void {
  if (state.nodes.some((node) => node.id === id)) return
  state.nodes.push({ id, type, label })
}

function pushEdge(
  state: ProjectionState,
  id: string,
  source: string,
  target: string,
  label?: string,
): void {
  if (state.edges.some((edge) => edge.id === id)) return
  state.edges.push({ id, source, target, ...(label ? { label } : {}) })
}

function labelForNode(node: FlowNode): string {
  if (node.name) return node.name
  switch (node.type) {
    case 'action':
      return node.toolRef
    case 'branch':
      return 'if'
    case 'approval':
      return 'approval'
    case 'clarification':
      return 'clarify'
    case 'persona':
      return node.personaId
    case 'route':
      return node.strategy
    case 'parallel':
      return 'parallel'
    case 'for_each':
      return node.as
    case 'complete':
      return 'complete'
    case 'sequence':
      return 'sequence'
    default: {
      const _exhaustive: never = node
      void _exhaustive
      return 'node'
    }
  }
}

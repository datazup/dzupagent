/**
 * Regression tests for the tail-propagation / terminality contract of the
 * shared lowering pipeline (DSL-02 approval tails, DSL-03 complete
 * terminality).
 *
 * These assert the SPECIFIC edges that must (or must not) exist in the
 * lowered graph — not just that lowering succeeds — because every one of the
 * underlying miscompiles shipped behind a fully green suite.
 */
import { describe, it, expect } from 'vitest'

import type { FlowNode, ResolvedTool } from '@dzupagent/flow-ast'
import type {
  PipelineDefinition,
  PipelineEdge,
  PipelineNode,
} from '@dzupagent/core/orchestration'
import { lowerPipelineFlat } from '../lower/lower-pipeline-flat.js'

function makeIdGen(prefix: string): () => string {
  let n = 0
  return () => `${prefix}-${++n}`
}

function makeSkillRt(ref: string): ResolvedTool {
  return { ref, kind: 'skill', inputSchema: {}, handle: { skillId: ref } }
}

function makeAction(toolRef: string): FlowNode {
  return { type: 'action', id: toolRef, toolRef, input: {} }
}

function nodeByName(
  artifact: PipelineDefinition,
  name: string,
): PipelineNode {
  const node = artifact.nodes.find((n) => n.name === name)
  if (node === undefined) {
    throw new Error(
      `expected node named '${name}' in [${artifact.nodes.map((n) => n.name).join(', ')}]`,
    )
  }
  return node
}

function nodeByNamePrefix(
  artifact: PipelineDefinition,
  prefix: string,
): PipelineNode {
  const node = artifact.nodes.find((n) => n.name?.startsWith(prefix))
  if (node === undefined) {
    throw new Error(
      `expected node with name prefix '${prefix}' in [${artifact.nodes.map((n) => n.name).join(', ')}]`,
    )
  }
  return node
}

function hasSeqEdge(
  artifact: PipelineDefinition,
  sourceNodeId: string,
  targetNodeId: string,
): boolean {
  return artifact.edges.some(
    (e: PipelineEdge) =>
      e.type === 'sequential' &&
      e.sourceNodeId === sourceNodeId &&
      e.targetNodeId === targetNodeId,
  )
}

describe('approval tails (DSL-02)', () => {
  it('wires BOTH the approve tail and the reject tail to the next sibling', () => {
    const resolved = new Map<string, ResolvedTool>()
    resolved.set('root.nodes[0].onApprove[0]', makeSkillRt('skill:approve-work'))
    resolved.set('root.nodes[0].onReject[0]', makeSkillRt('skill:reject-work'))
    resolved.set('root.nodes[1]', makeSkillRt('skill:next'))

    const ast: FlowNode = {
      type: 'sequence',
      nodes: [
        {
          type: 'approval',
          question: 'ship it?',
          onApprove: [makeAction('skill:approve-work')],
          onReject: [makeAction('skill:reject-work')],
        },
        makeAction('skill:next'),
      ],
    }

    const { artifact } = lowerPipelineFlat({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      _idGen: makeIdGen('appr'),
    })

    const approveTail = nodeByName(artifact, 'skill:approve-work')
    const rejectTail = nodeByName(artifact, 'skill:reject-work')
    const next = nodeByName(artifact, 'skill:next')

    // Before the fix the last-node fallback wired ONLY the reject tail:
    // the approve path dead-ended before the continuation.
    expect(hasSeqEdge(artifact, approveTail.id, next.id)).toBe(true)
    expect(hasSeqEdge(artifact, rejectTail.id, next.id)).toBe(true)
    // The gate itself must not bypass the branches into the continuation.
    const gate = nodeByNamePrefix(artifact, 'approval:')
    expect(hasSeqEdge(artifact, gate.id, next.id)).toBe(false)
  })

  it('keeps the rejected path terminal when onReject is absent (no fail-open continuation)', () => {
    const resolved = new Map<string, ResolvedTool>()
    resolved.set('root.nodes[0].onApprove[0]', makeSkillRt('skill:approve-work'))
    resolved.set('root.nodes[1]', makeSkillRt('skill:next'))

    const ast: FlowNode = {
      type: 'sequence',
      nodes: [
        {
          type: 'approval',
          question: 'ship it?',
          onApprove: [makeAction('skill:approve-work')],
        },
        makeAction('skill:next'),
      ],
    }

    const { artifact } = lowerPipelineFlat({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      _idGen: makeIdGen('appr-noreject'),
    })

    const approveTail = nodeByName(artifact, 'skill:approve-work')
    const next = nodeByName(artifact, 'skill:next')
    const gate = nodeByNamePrefix(artifact, 'approval:')

    // The approve path continues; rejection deliberately dead-ends at the
    // gate — an approval must not continue into the next sibling on reject.
    expect(hasSeqEdge(artifact, approveTail.id, next.id)).toBe(true)
    expect(hasSeqEdge(artifact, gate.id, next.id)).toBe(false)
  })
})

describe('complete terminality (DSL-03)', () => {
  it('does not wire a sibling after complete, and warns that it is unreachable', () => {
    const resolved = new Map<string, ResolvedTool>()
    resolved.set('root.nodes[0]', makeSkillRt('skill:first'))
    resolved.set('root.nodes[2]', makeSkillRt('skill:after-complete'))

    const ast: FlowNode = {
      type: 'sequence',
      nodes: [
        makeAction('skill:first'),
        { type: 'complete', result: 'done' },
        makeAction('skill:after-complete'),
      ],
    }

    const { artifact, warnings } = lowerPipelineFlat({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      _idGen: makeIdGen('term'),
    })

    const first = nodeByName(artifact, 'skill:first')
    const complete = nodeByNamePrefix(artifact, 'complete:')
    const after = nodeByName(artifact, 'skill:after-complete')

    expect(hasSeqEdge(artifact, first.id, complete.id)).toBe(true)
    // Before the fix, the last-node fallback wired complete → next sibling,
    // so resume continued straight past the terminal node.
    expect(hasSeqEdge(artifact, complete.id, after.id)).toBe(false)
    expect(
      artifact.edges.some(
        (e: PipelineEdge) => e.type === 'sequential' && e.targetNodeId === after.id,
      ),
    ).toBe(false)
    expect(warnings.some((w) => w.includes('unreachable'))).toBe(true)
  })

  it('a branch arm ending in complete contributes no tail; the other arm still continues', () => {
    const resolved = new Map<string, ResolvedTool>()
    resolved.set('root.nodes[0].else[0]', makeSkillRt('skill:else-work'))
    resolved.set('root.nodes[1]', makeSkillRt('skill:next'))

    const ast: FlowNode = {
      type: 'sequence',
      nodes: [
        {
          type: 'branch',
          condition: 'ok',
          then: [{ type: 'complete', result: 'early-exit' }],
          else: [makeAction('skill:else-work')],
        },
        makeAction('skill:next'),
      ],
    }

    const { artifact } = lowerPipelineFlat({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      _idGen: makeIdGen('branch-term'),
    })

    const complete = nodeByNamePrefix(artifact, 'complete:')
    const elseTail = nodeByName(artifact, 'skill:else-work')
    const next = nodeByName(artifact, 'skill:next')

    expect(hasSeqEdge(artifact, elseTail.id, next.id)).toBe(true)
    expect(hasSeqEdge(artifact, complete.id, next.id)).toBe(false)
  })

  it('a persona body ending in complete contributes no tail to the continuation', () => {
    const resolved = new Map<string, ResolvedTool>()
    resolved.set('root.nodes[1]', makeSkillRt('skill:next'))

    const ast: FlowNode = {
      type: 'sequence',
      nodes: [
        {
          type: 'persona',
          personaId: 'reviewer',
          body: [{ type: 'complete', result: 'reviewed' }],
        },
        makeAction('skill:next'),
      ],
    }

    const { artifact, warnings } = lowerPipelineFlat({
      ast,
      resolved,
      resolvedPersonas: new Map([['root.nodes[0]', 'reviewer']]),
      _idGen: makeIdGen('persona-term'),
    })

    const complete = nodeByNamePrefix(artifact, 'complete:')
    const next = nodeByName(artifact, 'skill:next')

    expect(hasSeqEdge(artifact, complete.id, next.id)).toBe(false)
    expect(warnings.some((w) => w.includes('unreachable'))).toBe(true)
  })
})

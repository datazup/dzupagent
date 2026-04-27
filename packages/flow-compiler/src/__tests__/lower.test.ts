import { describe, it, expect } from 'vitest'

import type { FlowNode, ResolvedTool } from '@dzupagent/flow-ast'
import { lowerSkillChain } from '../lower/lower-skill-chain.js'
import { lowerPipelineFlat } from '../lower/lower-pipeline-flat.js'
import { lowerPipelineLoop } from '../lower/lower-pipeline-loop.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let _seqId = 0
function nextId(): string {
  return `test-${++_seqId}`
}

function makeSkillRt(ref: string): ResolvedTool {
  return { ref, kind: 'skill', inputSchema: {}, handle: { skillId: ref } }
}

function makeAction(toolRef: string): FlowNode {
  return { type: 'action', id: toolRef, toolRef, input: {} }
}

// ---------------------------------------------------------------------------
// lowerSkillChain
// ---------------------------------------------------------------------------

describe('lowerSkillChain', () => {
  it('produces a SkillChain artifact from a single action', () => {
    const resolved = new Map<string, ResolvedTool>()
    // The action inside sequence is at path root.nodes[0]
    resolved.set('root.nodes[0]', makeSkillRt('skill:doWork'))

    const ast: FlowNode = {
      type: 'sequence',
      nodes: [makeAction('skill:doWork')],
    }

    const { artifact, warnings } = lowerSkillChain({ ast, resolved })
    expect(artifact.name).toBe('flow')
    expect(artifact.steps).toHaveLength(1)
    expect(artifact.steps[0]?.skillName).toBe('skill:doWork')
    // Redundant single-child sequence warning
    expect(warnings.some((w) => w.includes('Redundant single-child'))).toBe(true)
  })

  it('uses custom name when provided', () => {
    const resolved = new Map<string, ResolvedTool>()
    resolved.set('root.nodes[0]', makeSkillRt('skill:a'))

    const ast: FlowNode = {
      type: 'sequence',
      nodes: [makeAction('skill:a'), makeAction('skill:b')],
    }
    const { artifact } = lowerSkillChain({ ast, resolved, name: 'my-chain' })
    expect(artifact.name).toBe('my-chain')
  })

  it('throws when AST produces no action steps', () => {
    // A sequence with only a complete node → no steps
    const resolved = new Map<string, ResolvedTool>()
    const ast: FlowNode = {
      type: 'sequence',
      nodes: [{ type: 'complete' }],
    }
    expect(() => lowerSkillChain({ ast, resolved })).toThrow(/empty SkillChain/)
  })

  it('throws for for_each node (router-contract violation)', () => {
    const resolved = new Map<string, ResolvedTool>()
    const ast: FlowNode = {
      type: 'for_each',
      source: 'items',
      as: 'item',
      body: [makeAction('skill:x')],
    }
    expect(() => lowerSkillChain({ ast, resolved })).toThrow(/for_each/)
  })

  it('emits warning and uses toolRef as skillName when unresolved', () => {
    const resolved = new Map<string, ResolvedTool>()
    const ast: FlowNode = makeAction('skill:unknown')
    const { artifact, warnings } = lowerSkillChain({ ast, resolved })
    expect(artifact.steps[0]?.skillName).toBe('skill:unknown')
    expect(warnings.some((w) => w.includes('no resolved tool'))).toBe(true)
  })

  it('emits warning and uses ref as skillName for non-skill kind', () => {
    const resolved = new Map<string, ResolvedTool>()
    resolved.set('root', { ref: 'mcp:tool', kind: 'mcp-tool', inputSchema: {}, handle: {} })
    const ast: FlowNode = makeAction('mcp:tool')
    const { artifact, warnings } = lowerSkillChain({ ast, resolved })
    expect(artifact.steps[0]?.skillName).toBe('mcp:tool')
    expect(warnings.some((w) => w.includes('"mcp-tool"'))).toBe(true)
  })

  it('lowering branch emits warning and concatenates then+else', () => {
    const resolved = new Map<string, ResolvedTool>()
    resolved.set('root.then[0]', makeSkillRt('skill:a'))
    resolved.set('root.else[0]', makeSkillRt('skill:b'))

    const ast: FlowNode = {
      type: 'branch',
      condition: 'x > 0',
      then: [makeAction('skill:a')],
      else: [makeAction('skill:b')],
    }
    const { artifact, warnings } = lowerSkillChain({ ast, resolved })
    expect(artifact.steps).toHaveLength(2)
    expect(warnings.some((w) => w.includes('sequential then+else'))).toBe(true)
  })

  it('lowering parallel emits warning and concatenates branches', () => {
    const resolved = new Map<string, ResolvedTool>()
    resolved.set('root.branches[0][0]', makeSkillRt('skill:a'))
    resolved.set('root.branches[1][0]', makeSkillRt('skill:b'))

    const ast: FlowNode = {
      type: 'parallel',
      branches: [
        [makeAction('skill:a')],
        [makeAction('skill:b')],
      ],
    }
    const { artifact, warnings } = lowerSkillChain({ ast, resolved })
    expect(artifact.steps).toHaveLength(2)
    expect(warnings.some((w) => w.includes('sequential'))).toBe(true)
  })

  it('lowering clarification emits a synthetic suspend step', () => {
    const resolved = new Map<string, ResolvedTool>()
    const ast: FlowNode = {
      type: 'clarification',
      question: 'What is your name?',
    }
    const { artifact, warnings } = lowerSkillChain({ ast, resolved })
    expect(artifact.steps[0]?.skillName).toContain('__clarification__')
    expect(artifact.steps[0]?.suspendBefore).toBe(true)
    expect(warnings.some((w) => w.includes('synthetic suspend'))).toBe(true)
  })

  it('lowering approval sets suspendBefore on first step', () => {
    const resolved = new Map<string, ResolvedTool>()
    resolved.set('root.onApprove[0]', makeSkillRt('skill:proceed'))

    const ast: FlowNode = {
      type: 'approval',
      question: 'Proceed?',
      onApprove: [makeAction('skill:proceed')],
    }
    const { artifact } = lowerSkillChain({ ast, resolved })
    expect(artifact.steps[0]?.suspendBefore).toBe(true)
  })

  it('lowering approval emits warning when onReject is present', () => {
    const resolved = new Map<string, ResolvedTool>()
    resolved.set('root.onApprove[0]', makeSkillRt('skill:proceed'))

    const ast: FlowNode = {
      type: 'approval',
      question: 'Proceed?',
      onApprove: [makeAction('skill:proceed')],
      onReject: [makeAction('skill:abort')],
    }
    const { warnings } = lowerSkillChain({ ast, resolved })
    expect(warnings.some((w) => w.includes('onReject'))).toBe(true)
  })

  it('lowering persona inlines body with warning', () => {
    const resolved = new Map<string, ResolvedTool>()
    resolved.set('root.body[0]', makeSkillRt('skill:explain'))

    const ast: FlowNode = {
      type: 'persona',
      personaId: 'coach',
      body: [makeAction('skill:explain')],
    }
    const { artifact, warnings } = lowerSkillChain({ ast, resolved })
    expect(artifact.steps).toHaveLength(1)
    expect(warnings.some((w) => w.includes('persona binding metadata'))).toBe(true)
  })

  it('lowering route inlines body with warning', () => {
    const resolved = new Map<string, ResolvedTool>()
    resolved.set('root.body[0]', makeSkillRt('skill:run'))

    const ast: FlowNode = {
      type: 'route',
      strategy: 'capability',
      tags: ['fast'],
      body: [makeAction('skill:run')],
    }
    const { artifact, warnings } = lowerSkillChain({ ast, resolved })
    expect(artifact.steps).toHaveLength(1)
    expect(warnings.some((w) => w.includes('routing metadata'))).toBe(true)
  })

  it('lowering complete emits warning when result is set', () => {
    const resolved = new Map<string, ResolvedTool>()
    // complete produces no steps by itself — combine with action to avoid empty chain error
    const ast: FlowNode = {
      type: 'sequence',
      nodes: [
        makeAction('skill:a'),
        { type: 'complete', result: 'done' },
      ],
    }
    const { warnings } = lowerSkillChain({ ast, resolved })
    expect(warnings.some((w) => w.includes('result="done"') || w.includes('result'))).toBe(true)
  })

  it('sequence with single child emits redundant-wrapper warning', () => {
    const resolved = new Map<string, ResolvedTool>()
    const ast: FlowNode = {
      type: 'sequence',
      nodes: [makeAction('skill:a')],
    }
    const { warnings } = lowerSkillChain({ ast, resolved })
    expect(warnings.some((w) => w.includes('Redundant single-child'))).toBe(true)
  })

  it('lowering memory node emits a step with type __memory__ in skillName', () => {
    const resolved = new Map<string, ResolvedTool>()
    // memory produces a step — combine with action so chain is non-empty on its own,
    // but here the memory step itself is sufficient
    const ast: FlowNode = {
      type: 'sequence',
      nodes: [
        {
          type: 'memory',
          operation: 'write',
          tier: 'session',
          key: 'userPref',
        },
        makeAction('skill:a'),
      ],
    }
    const { artifact } = lowerSkillChain({ ast, resolved })
    const memStep = artifact.steps.find((s) => s.skillName.startsWith('__memory__'))
    expect(memStep).toBeDefined()
    expect(memStep?.skillName).toBe('__memory__write_session_userpref')
    expect(typeof memStep?.stateTransformer).toBe('function')
    // Verify stateTransformer preserves existing state and injects memoryOp
    const transformed = memStep!.stateTransformer!({ existingKey: 'val' })
    expect(transformed['existingKey']).toBe('val')
    expect(transformed['__memoryOp']).toEqual({ operation: 'write', tier: 'session', key: 'userPref' })
  })
})

// ---------------------------------------------------------------------------
// lowerPipelineFlat
// ---------------------------------------------------------------------------

describe('lowerPipelineFlat', () => {
  it('produces a PipelineDefinition artifact', () => {
    const resolved = new Map<string, ResolvedTool>()
    resolved.set('root', makeSkillRt('skill:a'))

    const ast: FlowNode = makeAction('skill:a')
    const { artifact, warnings } = lowerPipelineFlat({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      _idGen: nextId,
    })
    expect(artifact.schemaVersion).toBe('1.0.0')
    expect(artifact.nodes).toHaveLength(1)
    expect(warnings).toHaveLength(0)
  })

  it('uses default name when not provided', () => {
    const resolved = new Map<string, ResolvedTool>()
    const ast: FlowNode = makeAction('skill:a')
    const { artifact } = lowerPipelineFlat({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      _idGen: nextId,
    })
    expect(artifact.name).toBe('flow-pipeline')
  })

  it('uses custom name and version when provided', () => {
    const resolved = new Map<string, ResolvedTool>()
    const ast: FlowNode = makeAction('skill:a')
    const { artifact } = lowerPipelineFlat({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      name: 'my-pipeline',
      version: '2.0.0',
      _idGen: nextId,
    })
    expect(artifact.name).toBe('my-pipeline')
    expect(artifact.version).toBe('2.0.0')
  })

  it('sets entryNodeId to the first node', () => {
    const resolved = new Map<string, ResolvedTool>()
    const ast: FlowNode = makeAction('skill:a')
    const { artifact } = lowerPipelineFlat({
      ast,
      resolved,
      resolvedPersonas: new Map(),
      _idGen: nextId,
    })
    expect(artifact.entryNodeId).toBe(artifact.nodes[0]?.id)
  })

  it('throws router-contract violation when for_each is in AST', () => {
    const ast: FlowNode = {
      type: 'for_each',
      source: 'items',
      as: 'item',
      body: [makeAction('skill:a')],
    }
    expect(() => lowerPipelineFlat({
      ast,
      resolved: new Map(),
      resolvedPersonas: new Map(),
      _idGen: nextId,
    })).toThrow(/router-contract violation/)
  })

  it('throws when AST produces no nodes', () => {
    // Empty sequence → no nodes
    const ast: FlowNode = { type: 'sequence', nodes: [] }
    expect(() => lowerPipelineFlat({
      ast,
      resolved: new Map(),
      resolvedPersonas: new Map(),
      _idGen: nextId,
    })).toThrow(/no nodes produced/)
  })

  it('produces edges for a branch node', () => {
    const ast: FlowNode = {
      type: 'branch',
      condition: 'flag',
      then: [makeAction('skill:a')],
    }
    const { artifact } = lowerPipelineFlat({
      ast,
      resolved: new Map(),
      resolvedPersonas: new Map(),
      _idGen: nextId,
    })
    const condEdge = artifact.edges.find((e) => e.type === 'conditional')
    expect(condEdge).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// lowerPipelineLoop
// ---------------------------------------------------------------------------

describe('lowerPipelineLoop', () => {
  it('produces a PipelineDefinition with LoopNode for for_each', () => {
    const ast: FlowNode = {
      type: 'for_each',
      source: 'items',
      as: 'item',
      body: [makeAction('skill:process')],
    }
    const { artifact, warnings } = lowerPipelineLoop({
      ast,
      resolved: new Map(),
      resolvedPersonas: new Map(),
      idGen: nextId,
    })
    const loop = artifact.nodes.find((n) => n.type === 'loop')
    expect(loop).toBeDefined()
    expect(warnings).toHaveLength(1) // unresolved stub warning
  })

  it('uses provided id when given', () => {
    const ast: FlowNode = makeAction('skill:a')
    const { artifact } = lowerPipelineLoop({
      ast,
      resolved: new Map(),
      resolvedPersonas: new Map(),
      idGen: nextId,
      id: 'custom-pipeline-id',
    })
    expect(artifact.id).toBe('custom-pipeline-id')
  })

  it('uses default name and version when not provided', () => {
    const ast: FlowNode = makeAction('skill:a')
    const { artifact } = lowerPipelineLoop({
      ast,
      resolved: new Map(),
      resolvedPersonas: new Map(),
      idGen: nextId,
    })
    expect(artifact.name).toBe('flow-pipeline')
    expect(artifact.version).toBe('0.0.0')
  })

  it('throws when AST produces no nodes', () => {
    const ast: FlowNode = { type: 'sequence', nodes: [] }
    expect(() => lowerPipelineLoop({
      ast,
      resolved: new Map(),
      resolvedPersonas: new Map(),
      idGen: nextId,
    })).toThrow(/no nodes produced/)
  })
})

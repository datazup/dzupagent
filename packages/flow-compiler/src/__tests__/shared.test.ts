import { describe, it, expect } from 'vitest'

import type { FlowNode, ResolvedTool } from '@dzupagent/flow-ast'
import {
  asAgentHandle,
  asMcpToolHandle,
  asSkillHandle,
  asWorkflowHandle,
  lowerNodeToPipeline,
} from '../lower/_shared.js'
import type { LowerPipelineContext } from '../lower/_shared.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _nextId = 0
function makeId(): string {
  return `id-${++_nextId}`
}

function makeCtx(opts: Partial<LowerPipelineContext> = {}): LowerPipelineContext {
  return {
    resolved: new Map(),
    resolvedPersonas: new Map(),
    allowForEach: false,
    idGen: makeId,
    ...opts,
  }
}

function makeSkillRt(ref: string): ResolvedTool {
  return { ref, kind: 'skill', inputSchema: {}, handle: { skillId: ref } }
}

function makeAgentRt(ref: string): ResolvedTool {
  return { ref, kind: 'agent', inputSchema: {}, handle: { agentId: ref } }
}

function makeMcpRt(ref: string): ResolvedTool {
  return { ref, kind: 'mcp-tool', inputSchema: {}, handle: { toolName: ref } }
}

function makeWorkflowRt(ref: string): ResolvedTool {
  return { ref, kind: 'workflow', inputSchema: {}, handle: { workflowId: ref } }
}

function makeAction(toolRef: string, path?: string): FlowNode {
  return { type: 'action', id: path ?? toolRef, toolRef, input: {} }
}

// ---------------------------------------------------------------------------
// Handle narrowing helpers
// ---------------------------------------------------------------------------

describe('handle narrowing helpers', () => {
  describe('asSkillHandle', () => {
    it('returns handle for skill kind', () => {
      const rt = makeSkillRt('skill:foo')
      const handle = asSkillHandle(rt)
      expect(handle).toBeDefined()
    })

    it('throws for non-skill kind', () => {
      const rt = makeAgentRt('agent:bar')
      expect(() => asSkillHandle(rt)).toThrow(/expected kind 'skill'/)
    })

    it('throws with correct error including ref', () => {
      const rt = makeMcpRt('mcp:tool')
      expect(() => asSkillHandle(rt)).toThrow(/mcp:tool/)
    })
  })

  describe('asMcpToolHandle', () => {
    it('returns handle for mcp-tool kind', () => {
      const rt = makeMcpRt('mcp:search')
      const handle = asMcpToolHandle(rt)
      expect(handle).toBeDefined()
    })

    it('throws for skill kind', () => {
      const rt = makeSkillRt('skill:x')
      expect(() => asMcpToolHandle(rt)).toThrow(/expected kind 'mcp-tool'/)
    })
  })

  describe('asWorkflowHandle', () => {
    it('returns handle for workflow kind', () => {
      const rt = makeWorkflowRt('wf:review')
      const handle = asWorkflowHandle(rt)
      expect(handle).toBeDefined()
    })

    it('throws for agent kind', () => {
      const rt = makeAgentRt('agent:x')
      expect(() => asWorkflowHandle(rt)).toThrow(/expected kind 'workflow'/)
    })
  })

  describe('asAgentHandle', () => {
    it('returns handle for agent kind', () => {
      const rt = makeAgentRt('agent:review')
      const handle = asAgentHandle(rt)
      expect(handle).toBeDefined()
    })

    it('throws for workflow kind', () => {
      const rt = makeWorkflowRt('wf:x')
      expect(() => asAgentHandle(rt)).toThrow(/expected kind 'agent'/)
    })
  })
})

// ---------------------------------------------------------------------------
// lowerNodeToPipeline — action
// ---------------------------------------------------------------------------

describe('lowerNodeToPipeline — action', () => {
  it('produces a ToolNode for a resolved mcp-tool ref', () => {
    const ctx = makeCtx()
    const rt = makeMcpRt('mcp:search')
    ctx.resolved.set('root', rt)
    const node = makeAction('mcp:search')
    const result = lowerNodeToPipeline(node, ctx, 'root')
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]?.type).toBe('tool')
    expect(result.warnings).toHaveLength(0)
  })

  it('produces an AgentNode for a resolved agent ref', () => {
    const ctx = makeCtx()
    const rt = makeAgentRt('agent:coder')
    ctx.resolved.set('root', rt)
    const node = makeAction('agent:coder')
    const result = lowerNodeToPipeline(node, ctx, 'root')
    expect(result.nodes[0]?.type).toBe('agent')
  })

  it('throws in executable mode when ref is unresolved', () => {
    const ctx = makeCtx()
    const node = makeAction('skill:unknown')
    expect(() => lowerNodeToPipeline(node, ctx, 'root')).toThrow(
      /executable lowering rejects unresolved semantic references/,
    )
  })

  it('emits a stub ToolNode with warning in diagnostic mode when ref is unresolved', () => {
    const ctx = makeCtx({ mode: 'diagnostic' })
    const node = makeAction('skill:unknown')
    const result = lowerNodeToPipeline(node, ctx, 'root')
    expect(result.nodes).toHaveLength(1)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('no resolved tool')
  })

  it('produces no edges for a single action', () => {
    const ctx = makeCtx()
    ctx.resolved.set('root', makeSkillRt('skill:a'))
    const node = makeAction('skill:a')
    const result = lowerNodeToPipeline(node, ctx, 'root')
    expect(result.edges).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// lowerNodeToPipeline — sequence
// ---------------------------------------------------------------------------

describe('lowerNodeToPipeline — sequence', () => {
  it('produces sequential edges between two action children', () => {
    const ctx = makeCtx()
    ctx.resolved.set('root.nodes[0]', makeSkillRt('skill:a'))
    ctx.resolved.set('root.nodes[1]', makeSkillRt('skill:b'))
    const node: FlowNode = {
      type: 'sequence',
      nodes: [
        makeAction('skill:a'),
        makeAction('skill:b'),
      ],
    }
    const result = lowerNodeToPipeline(node, ctx, 'root')
    expect(result.nodes).toHaveLength(2)
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0]?.type).toBe('sequential')
  })

  it('returns empty result for empty sequence', () => {
    const ctx = makeCtx()
    const node: FlowNode = { type: 'sequence', nodes: [] }
    const result = lowerNodeToPipeline(node, ctx, 'root')
    expect(result.nodes).toHaveLength(0)
    expect(result.edges).toHaveLength(0)
  })

  it('produces N-1 sequential edges for N children', () => {
    const ctx = makeCtx()
    const nodes: FlowNode[] = [
      makeAction('skill:a'),
      makeAction('skill:b'),
      makeAction('skill:c'),
    ]
    nodes.forEach((n, i) => ctx.resolved.set(`root.nodes[${i}]`, makeSkillRt(`skill:${String.fromCharCode(97 + i)}`)))
    const node: FlowNode = { type: 'sequence', nodes }
    const result = lowerNodeToPipeline(node, ctx, 'root')
    // Each action is 1 node; sequence adds N-1 edges
    const seqEdges = result.edges.filter((e) => e.type === 'sequential')
    expect(seqEdges).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// lowerNodeToPipeline — branch
// ---------------------------------------------------------------------------

describe('lowerNodeToPipeline — branch', () => {
  it('produces a GateNode and a conditional edge', () => {
    const ctx = makeCtx()
    ctx.resolved.set('root.then[0]', makeSkillRt('skill:a'))
    const node: FlowNode = {
      type: 'branch',
      condition: 'x > 0',
      then: [makeAction('skill:a')],
    }
    const result = lowerNodeToPipeline(node, ctx, 'root')
    const gate = result.nodes.find((n) => n.type === 'gate')
    expect(gate).toBeDefined()
    const condEdge = result.edges.find((e) => e.type === 'conditional')
    expect(condEdge).toBeDefined()
  })

  it('includes both then and else nodes when else is present', () => {
    const ctx = makeCtx()
    ctx.resolved.set('root.then[0]', makeSkillRt('skill:a'))
    ctx.resolved.set('root.else[0]', makeSkillRt('skill:b'))
    const node: FlowNode = {
      type: 'branch',
      condition: 'flag',
      then: [makeAction('skill:a')],
      else: [makeAction('skill:b')],
    }
    const result = lowerNodeToPipeline(node, ctx, 'root')
    // gate + then action + else action = 3 nodes
    expect(result.nodes).toHaveLength(3)
  })

  it('omits else branch when not present', () => {
    const ctx = makeCtx()
    ctx.resolved.set('root.then[0]', makeSkillRt('skill:a'))
    const node: FlowNode = {
      type: 'branch',
      condition: 'flag',
      then: [makeAction('skill:a')],
    }
    const result = lowerNodeToPipeline(node, ctx, 'root')
    // gate + then action = 2 nodes
    expect(result.nodes).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// lowerNodeToPipeline — parallel
// ---------------------------------------------------------------------------

describe('lowerNodeToPipeline — parallel', () => {
  it('produces a ForkNode and a JoinNode', () => {
    const ctx = makeCtx()
    ctx.resolved.set('root.branches[0][0]', makeSkillRt('skill:a'))
    ctx.resolved.set('root.branches[1][0]', makeSkillRt('skill:b'))
    const node: FlowNode = {
      type: 'parallel',
      branches: [
        [makeAction('skill:a')],
        [makeAction('skill:b')],
      ],
    }
    const result = lowerNodeToPipeline(node, ctx, 'root')
    const fork = result.nodes.find((n) => n.type === 'fork')
    const join = result.nodes.find((n) => n.type === 'join')
    expect(fork).toBeDefined()
    expect(join).toBeDefined()
  })

  it('emits sequential edges from fork to each branch entry', () => {
    const ctx = makeCtx()
    ctx.resolved.set('root.branches[0][0]', makeSkillRt('skill:a'))
    ctx.resolved.set('root.branches[1][0]', makeSkillRt('skill:b'))
    const node: FlowNode = {
      type: 'parallel',
      branches: [
        [makeAction('skill:a')],
        [makeAction('skill:b')],
      ],
    }
    const result = lowerNodeToPipeline(node, ctx, 'root')
    const fork = result.nodes.find((n) => n.type === 'fork')!
    const edgesFromFork = result.edges.filter((e) => e.sourceNodeId === fork.id)
    expect(edgesFromFork).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// lowerNodeToPipeline — clarification
// ---------------------------------------------------------------------------

describe('lowerNodeToPipeline — clarification', () => {
  it('produces a SuspendNode', () => {
    const ctx = makeCtx()
    const node: FlowNode = {
      type: 'clarification',
      id: 'q1',
      question: 'What is your name?',
    }
    const result = lowerNodeToPipeline(node, ctx, 'root')
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]?.type).toBe('suspend')
    expect(result.edges).toHaveLength(0)
  })

  it('includes resumeCondition for choice expected', () => {
    const ctx = makeCtx()
    const node: FlowNode = {
      type: 'clarification',
      question: 'Pick one',
      expected: 'choice',
      choices: ['A', 'B'],
    }
    const result = lowerNodeToPipeline(node, ctx, 'root')
    const suspend = result.nodes[0] as { resumeCondition?: string }
    expect(suspend.resumeCondition).toBeDefined()
    expect(suspend.resumeCondition).toContain('A|B')
  })
})

// ---------------------------------------------------------------------------
// lowerNodeToPipeline — complete
// ---------------------------------------------------------------------------

describe('lowerNodeToPipeline — complete', () => {
  it('produces a SuspendNode (terminal)', () => {
    const ctx = makeCtx()
    const node: FlowNode = { type: 'complete', id: 'done', result: 'ok' }
    const result = lowerNodeToPipeline(node, ctx, 'root')
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]?.type).toBe('suspend')
    expect(result.edges).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// lowerNodeToPipeline — persona
// ---------------------------------------------------------------------------

describe('lowerNodeToPipeline — persona', () => {
  it('produces a SuspendNode and body nodes', () => {
    const ctx = makeCtx()
    ctx.resolved.set('root.body[0]', makeSkillRt('skill:explain'))
    const node: FlowNode = {
      type: 'persona',
      personaId: 'coach',
      body: [makeAction('skill:explain')],
    }
    const result = lowerNodeToPipeline(node, ctx, 'root')
    const suspend = result.nodes.find((n) => n.type === 'suspend')
    expect(suspend).toBeDefined()
    expect(result.nodes.length).toBeGreaterThan(1)
  })

  it('emits warning when persona is not in resolvedPersonas', () => {
    const ctx = makeCtx()
    ctx.resolved.set('root.body[0]', makeSkillRt('skill:a'))
    const node: FlowNode = {
      type: 'persona',
      personaId: 'expert',
      body: [makeAction('skill:a')],
    }
    const result = lowerNodeToPipeline(node, ctx, 'root')
    expect(result.warnings.some((w) => w.includes('not confirmed'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// lowerNodeToPipeline — route
// ---------------------------------------------------------------------------

describe('lowerNodeToPipeline — route', () => {
  it('produces a SuspendNode and body nodes', () => {
    const ctx = makeCtx()
    ctx.resolved.set('root.body[0]', makeSkillRt('skill:run'))
    const node: FlowNode = {
      type: 'route',
      strategy: 'capability',
      tags: ['fast'],
      body: [makeAction('skill:run')],
    }
    const result = lowerNodeToPipeline(node, ctx, 'root')
    const suspend = result.nodes.find((n) => n.type === 'suspend')
    expect(suspend).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// lowerNodeToPipeline — for_each
// ---------------------------------------------------------------------------

describe('lowerNodeToPipeline — for_each', () => {
  it('throws router-contract violation when allowForEach=false', () => {
    const ctx = makeCtx({ allowForEach: false })
    const node: FlowNode = {
      type: 'for_each',
      source: 'items',
      as: 'item',
      body: [makeAction('skill:process')],
    }
    expect(() => lowerNodeToPipeline(node, ctx, 'root')).toThrow(/router-contract violation/)
  })

  it('produces a LoopNode when allowForEach=true', () => {
    const ctx = makeCtx({ allowForEach: true })
    ctx.resolved.set('root.body[0]', makeSkillRt('skill:process'))
    const node: FlowNode = {
      type: 'for_each',
      source: 'items',
      as: 'item',
      body: [makeAction('skill:process')],
    }
    const result = lowerNodeToPipeline(node, ctx, 'root')
    const loop = result.nodes.find((n) => n.type === 'loop')
    expect(loop).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// lowerNodeToPipeline — approval
// ---------------------------------------------------------------------------

describe('lowerNodeToPipeline — approval', () => {
  it('produces a GateNode of gateType approval', () => {
    const ctx = makeCtx()
    ctx.resolved.set('root.onApprove[0]', makeSkillRt('skill:proceed'))
    const node: FlowNode = {
      type: 'approval',
      question: 'Proceed?',
      onApprove: [makeAction('skill:proceed')],
    }
    const result = lowerNodeToPipeline(node, ctx, 'root')
    const gate = result.nodes.find((n) => n.type === 'gate') as { gateType?: string } | undefined
    expect(gate).toBeDefined()
    expect(gate?.gateType).toBe('approval')
  })

  it('includes both onApprove and onReject branches', () => {
    const ctx = makeCtx()
    ctx.resolved.set('root.onApprove[0]', makeSkillRt('skill:proceed'))
    ctx.resolved.set('root.onReject[0]', makeSkillRt('skill:abort'))
    const node: FlowNode = {
      type: 'approval',
      question: 'Proceed?',
      onApprove: [makeAction('skill:proceed')],
      onReject: [makeAction('skill:abort')],
    }
    const result = lowerNodeToPipeline(node, ctx, 'root')
    // gate + onApprove action + onReject action = 3
    expect(result.nodes).toHaveLength(3)
  })
})

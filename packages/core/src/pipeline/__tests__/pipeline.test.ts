import { describe, it, expect } from 'vitest'
import type {
  AgentNode,
  ToolNode,
  TransformNode,
  GateNode,
  ForkNode,
  JoinNode,
  LoopNode,
  SuspendNode,
  PipelineNode,
  PipelineEdge,
  PipelineDefinition,
  PipelineCheckpoint,
  PipelineValidationResult,
} from '../pipeline-definition.js'
import {
  PipelineDefinitionSchema,
  PipelineNodeSchema,
  PipelineEdgeSchema,
  PipelineCheckpointSchema,
  serializePipeline,
  deserializePipeline,
} from '../pipeline-serialization.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalPipeline(
  overrides: Partial<PipelineDefinition> = {},
): PipelineDefinition {
  return {
    id: 'pipe-1',
    name: 'Test Pipeline',
    version: '1.0.0',
    schemaVersion: '1.0.0',
    entryNodeId: 'n1',
    nodes: [{ type: 'tool', id: 'n1', toolName: 'echo' }],
    edges: [],
    ...overrides,
  }
}

function makeFullPipeline(): PipelineDefinition {
  const nodes: PipelineNode[] = [
    { type: 'agent', id: 'n-agent', agentId: 'code-gen', config: { model: 'sonnet' } },
    { type: 'tool', id: 'n-tool', toolName: 'git_status', arguments: { cwd: '/app' } },
    { type: 'transform', id: 'n-transform', transformName: 'extractPaths' },
    { type: 'gate', id: 'n-gate', gateType: 'approval', condition: 'cost < 100' },
    { type: 'fork', id: 'n-fork', forkId: 'parallel-1' },
    { type: 'join', id: 'n-join', forkId: 'parallel-1', mergeStrategy: 'all' },
    {
      type: 'loop',
      id: 'n-loop',
      bodyNodeIds: ['n-tool'],
      maxIterations: 5,
      continuePredicateName: 'hasMore',
      failOnMaxIterations: true,
    },
    { type: 'suspend', id: 'n-suspend', resumeCondition: 'approved' },
  ]

  const edges: PipelineEdge[] = [
    { type: 'sequential', sourceNodeId: 'n-agent', targetNodeId: 'n-tool' },
    {
      type: 'conditional',
      sourceNodeId: 'n-gate',
      predicateName: 'checkBudget',
      branches: { pass: 'n-fork', fail: 'n-suspend' },
    },
    {
      type: 'error',
      sourceNodeId: 'n-tool',
      targetNodeId: 'n-suspend',
      errorCodes: ['TIMEOUT', 'PROVIDER_UNAVAILABLE'],
    },
  ]

  return {
    id: 'full-pipe',
    name: 'Full Pipeline',
    version: '2.1.0',
    description: 'A pipeline using all 8 node types and 3 edge types',
    schemaVersion: '1.0.0',
    entryNodeId: 'n-agent',
    nodes,
    edges,
    budgetLimitCents: 500,
    tokenLimit: 100_000,
    checkpointStrategy: 'after_each_node',
    metadata: { team: 'core' },
    tags: ['ci', 'codegen'],
  }
}

// ---------------------------------------------------------------------------
// Node type tests
// ---------------------------------------------------------------------------

describe('PipelineNode discriminated union', () => {
  it('accepts AgentNode', () => {
    const node: AgentNode = { type: 'agent', id: 'a1', agentId: 'my-agent' }
    const result = PipelineNodeSchema.safeParse(node)
    expect(result.success).toBe(true)
  })

  it('accepts ToolNode', () => {
    const node: ToolNode = { type: 'tool', id: 't1', toolName: 'git_diff' }
    const result = PipelineNodeSchema.safeParse(node)
    expect(result.success).toBe(true)
  })

  it('accepts TransformNode', () => {
    const node: TransformNode = { type: 'transform', id: 'tr1', transformName: 'parsePaths' }
    const result = PipelineNodeSchema.safeParse(node)
    expect(result.success).toBe(true)
  })

  it('accepts GateNode', () => {
    const node: GateNode = { type: 'gate', id: 'g1', gateType: 'budget' }
    const result = PipelineNodeSchema.safeParse(node)
    expect(result.success).toBe(true)
  })

  it('accepts ForkNode', () => {
    const node: ForkNode = { type: 'fork', id: 'f1', forkId: 'par-1' }
    const result = PipelineNodeSchema.safeParse(node)
    expect(result.success).toBe(true)
  })

  it('accepts JoinNode', () => {
    const node: JoinNode = { type: 'join', id: 'j1', forkId: 'par-1', mergeStrategy: 'first' }
    const result = PipelineNodeSchema.safeParse(node)
    expect(result.success).toBe(true)
  })

  it('accepts LoopNode', () => {
    const node: LoopNode = {
      type: 'loop',
      id: 'l1',
      bodyNodeIds: ['a', 'b'],
      maxIterations: 10,
      continuePredicateName: 'shouldContinue',
    }
    const result = PipelineNodeSchema.safeParse(node)
    expect(result.success).toBe(true)
  })

  it('accepts SuspendNode', () => {
    const node: SuspendNode = { type: 'suspend', id: 's1' }
    const result = PipelineNodeSchema.safeParse(node)
    expect(result.success).toBe(true)
  })

  it('accepts optional base fields (name, description, timeoutMs, retries)', () => {
    const node: AgentNode = {
      type: 'agent',
      id: 'a2',
      agentId: 'my-agent',
      name: 'Code Generator',
      description: 'Generates code',
      timeoutMs: 30000,
      retries: 3,
    }
    const result = PipelineNodeSchema.safeParse(node)
    expect(result.success).toBe(true)
  })

  it('rejects unknown node type', () => {
    const node = { type: 'unknown', id: 'u1' }
    const result = PipelineNodeSchema.safeParse(node)
    expect(result.success).toBe(false)
  })

  it('rejects node with missing required fields', () => {
    const node = { type: 'agent', id: 'a1' } // missing agentId
    const result = PipelineNodeSchema.safeParse(node)
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Edge type tests
// ---------------------------------------------------------------------------

describe('PipelineEdge discriminated union', () => {
  it('accepts sequential edge', () => {
    const edge: PipelineEdge = {
      type: 'sequential',
      sourceNodeId: 'n1',
      targetNodeId: 'n2',
    }
    const result = PipelineEdgeSchema.safeParse(edge)
    expect(result.success).toBe(true)
  })

  it('accepts conditional edge', () => {
    const edge: PipelineEdge = {
      type: 'conditional',
      sourceNodeId: 'n1',
      predicateName: 'routeByIntent',
      branches: { code: 'n2', chat: 'n3' },
    }
    const result = PipelineEdgeSchema.safeParse(edge)
    expect(result.success).toBe(true)
  })

  it('accepts error edge', () => {
    const edge: PipelineEdge = {
      type: 'error',
      sourceNodeId: 'n1',
      targetNodeId: 'n-fallback',
      errorCodes: ['TIMEOUT'],
    }
    const result = PipelineEdgeSchema.safeParse(edge)
    expect(result.success).toBe(true)
  })

  it('accepts error edge without errorCodes', () => {
    const edge: PipelineEdge = {
      type: 'error',
      sourceNodeId: 'n1',
      targetNodeId: 'n-fallback',
    }
    const result = PipelineEdgeSchema.safeParse(edge)
    expect(result.success).toBe(true)
  })

  it('rejects edge with unknown type', () => {
    const edge = { type: 'parallel', sourceNodeId: 'n1', targetNodeId: 'n2' }
    const result = PipelineEdgeSchema.safeParse(edge)
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// PipelineDefinition tests
// ---------------------------------------------------------------------------

describe('PipelineDefinition', () => {
  it('accepts a minimal pipeline definition', () => {
    const def = makeMinimalPipeline()
    const result = PipelineDefinitionSchema.safeParse(def)
    expect(result.success).toBe(true)
  })

  it('accepts a full pipeline with all 8 node types and 3 edge types', () => {
    const def = makeFullPipeline()
    const result = PipelineDefinitionSchema.safeParse(def)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.nodes).toHaveLength(8)
      expect(result.data.edges).toHaveLength(3)
    }
  })

  it('rejects pipeline with no nodes', () => {
    const def = makeMinimalPipeline({ nodes: [] })
    const result = PipelineDefinitionSchema.safeParse(def)
    expect(result.success).toBe(false)
  })

  it('rejects pipeline with missing id', () => {
    const { id: _, ...rest } = makeMinimalPipeline()
    const result = PipelineDefinitionSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('rejects pipeline with wrong schemaVersion', () => {
    const def = { ...makeMinimalPipeline(), schemaVersion: '2.0.0' }
    const result = PipelineDefinitionSchema.safeParse(def)
    expect(result.success).toBe(false)
  })

  it('accepts all checkpoint strategies', () => {
    for (const strategy of ['after_each_node', 'on_suspend', 'manual', 'none'] as const) {
      const def = makeMinimalPipeline({ checkpointStrategy: strategy })
      const result = PipelineDefinitionSchema.safeParse(def)
      expect(result.success).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// PipelineCheckpoint tests
// ---------------------------------------------------------------------------

describe('PipelineCheckpoint', () => {
  function makeCheckpoint(
    overrides: Partial<PipelineCheckpoint> = {},
  ): PipelineCheckpoint {
    return {
      pipelineRunId: 'run-1',
      pipelineId: 'pipe-1',
      version: 1,
      schemaVersion: '1.0.0',
      completedNodeIds: ['n1', 'n2'],
      state: { lastOutput: 'hello' },
      createdAt: '2026-03-25T10:00:00.000Z',
      ...overrides,
    }
  }

  it('validates a minimal checkpoint', () => {
    const cp = makeCheckpoint()
    const result = PipelineCheckpointSchema.safeParse(cp)
    expect(result.success).toBe(true)
  })

  it('validates a checkpoint with budgetState and suspendedAtNodeId', () => {
    const cp = makeCheckpoint({
      suspendedAtNodeId: 'n3',
      budgetState: { tokensUsed: 5000, costCents: 12 },
    })
    const result = PipelineCheckpointSchema.safeParse(cp)
    expect(result.success).toBe(true)
  })

  it('round-trips checkpoint fields through JSON', () => {
    const cp = makeCheckpoint({
      suspendedAtNodeId: 'n-suspend',
      budgetState: { tokensUsed: 10000, costCents: 25 },
    })
    const json = JSON.stringify(cp)
    const parsed: unknown = JSON.parse(json)
    const result = PipelineCheckpointSchema.safeParse(parsed)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.pipelineRunId).toBe('run-1')
      expect(result.data.completedNodeIds).toEqual(['n1', 'n2'])
      expect(result.data.budgetState?.tokensUsed).toBe(10000)
      expect(result.data.suspendedAtNodeId).toBe('n-suspend')
    }
  })

  it('rejects checkpoint with missing pipelineRunId', () => {
    const { pipelineRunId: _, ...rest } = makeCheckpoint()
    const result = PipelineCheckpointSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Serialization / deserialization tests
// ---------------------------------------------------------------------------

describe('serializePipeline / deserializePipeline', () => {
  it('round-trips a full pipeline definition', () => {
    const original = makeFullPipeline()
    const json = serializePipeline(original)
    const restored = deserializePipeline(json)
    expect(restored).toEqual(original)
  })

  it('round-trips a minimal pipeline', () => {
    const original = makeMinimalPipeline()
    const json = serializePipeline(original)
    const restored = deserializePipeline(json)
    expect(restored.id).toBe('pipe-1')
    expect(restored.nodes).toHaveLength(1)
  })

  it('deserializePipeline rejects invalid JSON', () => {
    expect(() => deserializePipeline('not-json')).toThrow('invalid JSON')
  })

  it('deserializePipeline rejects missing required fields', () => {
    const invalid = JSON.stringify({ id: 'p1' })
    expect(() => deserializePipeline(invalid)).toThrow('Pipeline deserialization failed')
  })

  it('deserializePipeline rejects wrong schemaVersion', () => {
    const def = { ...makeMinimalPipeline(), schemaVersion: '99.0.0' }
    const json = JSON.stringify(def)
    expect(() => deserializePipeline(json)).toThrow('Pipeline deserialization failed')
  })

  it('serializePipeline rejects invalid definition', () => {
    const invalid = { ...makeMinimalPipeline(), nodes: [] }
    expect(() => serializePipeline(invalid)).toThrow('Pipeline serialization failed')
  })

  it('produces valid JSON (parseable by JSON.parse)', () => {
    const json = serializePipeline(makeMinimalPipeline())
    expect(() => JSON.parse(json)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// JSON-serializable constraint
// ---------------------------------------------------------------------------

describe('JSON-serializable constraint', () => {
  it('PipelineDefinition contains no Date objects or functions', () => {
    const def = makeFullPipeline()
    const json = JSON.stringify(def)
    const parsed = JSON.parse(json) as Record<string, unknown>

    // Recursively check no value is a function or Date
    function assertSerializable(obj: unknown, path: string): void {
      expect(typeof obj).not.toBe('function')
      expect(obj).not.toBeInstanceOf(Date)
      if (obj !== null && typeof obj === 'object') {
        for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
          assertSerializable(value, `${path}.${key}`)
        }
      }
    }

    assertSerializable(parsed, 'root')
  })

  it('PipelineCheckpoint contains no Date objects (uses ISO strings)', () => {
    const cp: PipelineCheckpoint = {
      pipelineRunId: 'run-1',
      pipelineId: 'pipe-1',
      version: 0,
      schemaVersion: '1.0.0',
      completedNodeIds: [],
      state: {},
      createdAt: new Date().toISOString(),
    }
    const json = JSON.stringify(cp)
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(typeof parsed['createdAt']).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// Validation result types (compile-time check)
// ---------------------------------------------------------------------------

describe('PipelineValidationResult', () => {
  it('has the expected shape', () => {
    const result: PipelineValidationResult = {
      valid: false,
      errors: [
        { code: 'MISSING_ENTRY', message: 'Entry node not found', nodeId: 'n1' },
        { code: 'DANGLING_EDGE', message: 'Edge references non-existent node', edgeIndex: 0 },
      ],
      warnings: [
        { code: 'UNREACHABLE_NODE', message: 'Node n3 is unreachable', nodeId: 'n3' },
      ],
    }
    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(2)
    expect(result.warnings).toHaveLength(1)
  })
})

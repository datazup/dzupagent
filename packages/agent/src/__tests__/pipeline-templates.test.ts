import { describe, it, expect } from 'vitest'
import { validatePipeline } from '../pipeline/pipeline-validator.js'
import {
  createCodeReviewPipeline,
  createFeatureGenerationPipeline,
  createTestGenerationPipeline,
  createRefactoringPipeline,
} from '../pipeline/pipeline-templates.js'
import type { PipelineDefinition } from '@dzipagent/core'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertValidPipeline(pipeline: PipelineDefinition): void {
  // Structural checks
  expect(pipeline.id).toBeTruthy()
  expect(pipeline.name).toBeTruthy()
  expect(pipeline.version).toBeTruthy()
  expect(pipeline.schemaVersion).toBe('1.0.0')
  expect(pipeline.entryNodeId).toBeTruthy()
  expect(pipeline.nodes.length).toBeGreaterThan(0)
  expect(pipeline.edges.length).toBeGreaterThan(0)

  // Entry node exists in nodes
  const nodeIds = new Set(pipeline.nodes.map(n => n.id))
  expect(nodeIds.has(pipeline.entryNodeId)).toBe(true)

  // Validator passes
  const result = validatePipeline(pipeline)
  expect(result.errors).toEqual([])
  expect(result.valid).toBe(true)
}

// ---------------------------------------------------------------------------
// Code Review Pipeline
// ---------------------------------------------------------------------------

describe('createCodeReviewPipeline', () => {
  it('produces a valid pipeline with defaults', () => {
    const pipeline = createCodeReviewPipeline()
    assertValidPipeline(pipeline)
    expect(pipeline.id).toBe('code-review-pipeline')
  })

  it('accepts custom reviewerAgentId', () => {
    const pipeline = createCodeReviewPipeline({ reviewerAgentId: 'my-reviewer' })
    assertValidPipeline(pipeline)
    const reviewNode = pipeline.nodes.find(n => n.id === 'review')
    expect(reviewNode).toBeDefined()
    expect(reviewNode!.type).toBe('agent')
    if (reviewNode!.type === 'agent') {
      expect(reviewNode!.agentId).toBe('my-reviewer')
    }
  })

  it('accepts custom budgetLimitCents', () => {
    const pipeline = createCodeReviewPipeline({ budgetLimitCents: 200 })
    expect(pipeline.budgetLimitCents).toBe(200)
  })

  it('has tags', () => {
    const pipeline = createCodeReviewPipeline()
    expect(pipeline.tags).toBeDefined()
    expect(pipeline.tags!.length).toBeGreaterThan(0)
  })

  it('has at least one error edge', () => {
    const pipeline = createCodeReviewPipeline()
    const errorEdges = pipeline.edges.filter(e => e.type === 'error')
    expect(errorEdges.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Feature Generation Pipeline
// ---------------------------------------------------------------------------

describe('createFeatureGenerationPipeline', () => {
  it('produces a valid pipeline with defaults', () => {
    const pipeline = createFeatureGenerationPipeline()
    assertValidPipeline(pipeline)
    expect(pipeline.id).toBe('feature-generation-pipeline')
  })

  it('includes a loop node for fix iterations', () => {
    const pipeline = createFeatureGenerationPipeline()
    const loopNode = pipeline.nodes.find(n => n.type === 'loop')
    expect(loopNode).toBeDefined()
    if (loopNode && loopNode.type === 'loop') {
      expect(loopNode.maxIterations).toBe(3)
      expect(loopNode.bodyNodeIds.length).toBeGreaterThan(0)
    }
  })

  it('respects custom maxFixIterations', () => {
    const pipeline = createFeatureGenerationPipeline({ maxFixIterations: 10 })
    const loopNode = pipeline.nodes.find(n => n.type === 'loop')
    expect(loopNode).toBeDefined()
    if (loopNode && loopNode.type === 'loop') {
      expect(loopNode.maxIterations).toBe(10)
    }
  })

  it('includes an approval gate', () => {
    const pipeline = createFeatureGenerationPipeline()
    const gate = pipeline.nodes.find(n => n.type === 'gate')
    expect(gate).toBeDefined()
    if (gate && gate.type === 'gate') {
      expect(gate.gateType).toBe('approval')
    }
  })

  it('has at least one error edge', () => {
    const pipeline = createFeatureGenerationPipeline()
    const errorEdges = pipeline.edges.filter(e => e.type === 'error')
    expect(errorEdges.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Test Generation Pipeline
// ---------------------------------------------------------------------------

describe('createTestGenerationPipeline', () => {
  it('produces a valid pipeline with defaults', () => {
    const pipeline = createTestGenerationPipeline()
    assertValidPipeline(pipeline)
    expect(pipeline.id).toBe('test-generation-pipeline')
  })

  it('uses default framework vitest', () => {
    const pipeline = createTestGenerationPipeline()
    expect(pipeline.metadata).toBeDefined()
    expect(pipeline.metadata!['framework']).toBe('vitest')
    expect(pipeline.tags).toContain('vitest')
  })

  it('accepts custom framework', () => {
    const pipeline = createTestGenerationPipeline({ framework: 'jest' })
    assertValidPipeline(pipeline)
    expect(pipeline.metadata!['framework']).toBe('jest')
    expect(pipeline.tags).toContain('jest')
  })

  it('includes a quality gate', () => {
    const pipeline = createTestGenerationPipeline()
    const gate = pipeline.nodes.find(n => n.type === 'gate')
    expect(gate).toBeDefined()
    if (gate && gate.type === 'gate') {
      expect(gate.gateType).toBe('quality')
    }
  })

  it('has at least one error edge', () => {
    const pipeline = createTestGenerationPipeline()
    const errorEdges = pipeline.edges.filter(e => e.type === 'error')
    expect(errorEdges.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Refactoring Pipeline
// ---------------------------------------------------------------------------

describe('createRefactoringPipeline', () => {
  it('produces a valid pipeline with defaults (validateTests=true)', () => {
    const pipeline = createRefactoringPipeline()
    assertValidPipeline(pipeline)
    expect(pipeline.id).toBe('refactoring-pipeline')
    // Should include run-tests node
    const testNode = pipeline.nodes.find(n => n.id === 'run-tests')
    expect(testNode).toBeDefined()
  })

  it('produces a valid pipeline with validateTests=false', () => {
    const pipeline = createRefactoringPipeline({ validateTests: false })
    assertValidPipeline(pipeline)
    // Should NOT include run-tests node
    const testNode = pipeline.nodes.find(n => n.id === 'run-tests')
    expect(testNode).toBeUndefined()
  })

  it('accepts custom budgetLimitCents', () => {
    const pipeline = createRefactoringPipeline({ budgetLimitCents: 500 })
    expect(pipeline.budgetLimitCents).toBe(500)
  })

  it('has at least one error edge', () => {
    const pipeline = createRefactoringPipeline()
    const errorEdges = pipeline.edges.filter(e => e.type === 'error')
    expect(errorEdges.length).toBeGreaterThanOrEqual(1)
  })

  it('has tags', () => {
    const pipeline = createRefactoringPipeline()
    expect(pipeline.tags).toBeDefined()
    expect(pipeline.tags!.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Cross-cutting: all 4 pipeline templates
// ---------------------------------------------------------------------------

describe('all pipeline templates pass validator', () => {
  const pipelines: [string, PipelineDefinition][] = [
    ['code-review', createCodeReviewPipeline()],
    ['feature-generation', createFeatureGenerationPipeline()],
    ['test-generation', createTestGenerationPipeline()],
    ['refactoring', createRefactoringPipeline()],
    ['refactoring (no tests)', createRefactoringPipeline({ validateTests: false })],
  ]

  for (const [label, pipeline] of pipelines) {
    it(`"${label}" pipeline is valid`, () => {
      const result = validatePipeline(pipeline)
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
    })
  }
})

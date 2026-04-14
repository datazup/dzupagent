/**
 * Pre-built pipeline templates for common multi-step workflows.
 *
 * Each factory function returns a valid `PipelineDefinition` that passes
 * `validatePipeline()`. Consumers can customize behavior through options.
 *
 * @module pipeline/pipeline-templates
 */

import type { PipelineDefinition } from '@dzupagent/core'

// ---------------------------------------------------------------------------
// Code Review Pipeline
// ---------------------------------------------------------------------------

export interface CodeReviewPipelineOptions {
  /** Agent ID for the reviewer node (default: `'code-reviewer'`). */
  reviewerAgentId?: string
  /** Maximum cost in cents (default: 50). */
  budgetLimitCents?: number
}

/**
 * Creates a code review pipeline:
 *
 * ```
 * load-diff -> analyze -> review -> gate(quality) -> report
 * ```
 */
export function createCodeReviewPipeline(
  options?: CodeReviewPipelineOptions,
): PipelineDefinition {
  const reviewerAgentId = options?.reviewerAgentId ?? 'code-reviewer'
  const budgetLimitCents = options?.budgetLimitCents ?? 50

  return {
    id: 'code-review-pipeline',
    name: 'Code Review Pipeline',
    version: '1.0.0',
    schemaVersion: '1.0.0',
    description: 'Automated code review: load diff, analyze, review, quality gate, report.',
    entryNodeId: 'load-diff',
    budgetLimitCents,
    checkpointStrategy: 'after_each_node',
    tags: ['code-review', 'quality'],
    nodes: [
      {
        id: 'load-diff',
        type: 'tool',
        name: 'Load Diff',
        description: 'Load the code diff to be reviewed.',
        toolName: 'git_diff',
        timeoutMs: 30_000,
      },
      {
        id: 'analyze',
        type: 'agent',
        name: 'Static Analysis',
        description: 'Perform static analysis on the diff.',
        agentId: 'static-analyzer',
        timeoutMs: 60_000,
      },
      {
        id: 'review',
        type: 'agent',
        name: 'Code Review',
        description: 'Review code for bugs, security, performance, and style.',
        agentId: reviewerAgentId,
        timeoutMs: 120_000,
      },
      {
        id: 'quality-gate',
        type: 'gate',
        name: 'Quality Gate',
        description: 'Check that review quality meets threshold.',
        gateType: 'quality',
        timeoutMs: 5_000,
      },
      {
        id: 'report',
        type: 'agent',
        name: 'Generate Report',
        description: 'Produce the final review report.',
        agentId: 'report-generator',
        timeoutMs: 60_000,
      },
      {
        id: 'error-handler',
        type: 'agent',
        name: 'Error Handler',
        description: 'Handle pipeline errors gracefully.',
        agentId: 'error-handler',
        timeoutMs: 30_000,
      },
    ],
    edges: [
      { type: 'sequential', sourceNodeId: 'load-diff', targetNodeId: 'analyze' },
      { type: 'sequential', sourceNodeId: 'analyze', targetNodeId: 'review' },
      { type: 'sequential', sourceNodeId: 'review', targetNodeId: 'quality-gate' },
      { type: 'sequential', sourceNodeId: 'quality-gate', targetNodeId: 'report' },
      { type: 'error', sourceNodeId: 'review', targetNodeId: 'error-handler' },
    ],
  }
}

// ---------------------------------------------------------------------------
// Feature Generation Pipeline
// ---------------------------------------------------------------------------

export interface FeatureGenerationPipelineOptions {
  /** Maximum fix-validate iterations (default: 3). */
  maxFixIterations?: number
  /** Maximum cost in cents (default: 200). */
  budgetLimitCents?: number
}

/**
 * Creates a feature generation pipeline:
 *
 * ```
 * plan -> generate -> validate -> [loop: fix -> validate] -> review -> gate(approval) -> publish
 * ```
 */
export function createFeatureGenerationPipeline(
  options?: FeatureGenerationPipelineOptions,
): PipelineDefinition {
  const maxFixIterations = options?.maxFixIterations ?? 3
  const budgetLimitCents = options?.budgetLimitCents ?? 200

  return {
    id: 'feature-generation-pipeline',
    name: 'Feature Generation Pipeline',
    version: '1.0.0',
    schemaVersion: '1.0.0',
    description: 'End-to-end feature generation: plan, generate, validate, fix loop, review, approve, publish.',
    entryNodeId: 'plan',
    budgetLimitCents,
    checkpointStrategy: 'after_each_node',
    tags: ['feature-generation', 'code-generation'],
    nodes: [
      {
        id: 'plan',
        type: 'agent',
        name: 'Plan Feature',
        description: 'Create an implementation plan for the feature.',
        agentId: 'feature-planner',
        timeoutMs: 120_000,
      },
      {
        id: 'generate',
        type: 'agent',
        name: 'Generate Code',
        description: 'Generate the feature implementation.',
        agentId: 'code-generator',
        timeoutMs: 300_000,
      },
      {
        id: 'validate',
        type: 'tool',
        name: 'Validate',
        description: 'Run tests and type checks against generated code.',
        toolName: 'run_tests',
        timeoutMs: 120_000,
      },
      {
        id: 'fix-loop',
        type: 'loop',
        name: 'Fix Loop',
        description: 'Iteratively fix validation errors.',
        bodyNodeIds: ['fix', 'revalidate'],
        maxIterations: maxFixIterations,
        continuePredicateName: 'hasErrors',
        timeoutMs: 600_000,
      },
      {
        id: 'fix',
        type: 'agent',
        name: 'Fix Errors',
        description: 'Fix validation errors found in the generated code.',
        agentId: 'bug-fixer',
        timeoutMs: 180_000,
      },
      {
        id: 'revalidate',
        type: 'tool',
        name: 'Re-validate',
        description: 'Re-run validation after fixes.',
        toolName: 'run_tests',
        timeoutMs: 120_000,
      },
      {
        id: 'review',
        type: 'agent',
        name: 'Review',
        description: 'Review the generated feature for quality.',
        agentId: 'code-reviewer',
        timeoutMs: 120_000,
      },
      {
        id: 'approval-gate',
        type: 'gate',
        name: 'Approval Gate',
        description: 'Require human approval before publishing.',
        gateType: 'approval',
        timeoutMs: 86_400_000,
      },
      {
        id: 'publish',
        type: 'agent',
        name: 'Publish',
        description: 'Publish the approved feature.',
        agentId: 'publisher',
        timeoutMs: 60_000,
      },
      {
        id: 'error-handler',
        type: 'agent',
        name: 'Error Handler',
        description: 'Handle pipeline errors.',
        agentId: 'error-handler',
        timeoutMs: 30_000,
      },
    ],
    edges: [
      { type: 'sequential', sourceNodeId: 'plan', targetNodeId: 'generate' },
      { type: 'sequential', sourceNodeId: 'generate', targetNodeId: 'validate' },
      { type: 'sequential', sourceNodeId: 'validate', targetNodeId: 'fix-loop' },
      { type: 'sequential', sourceNodeId: 'fix-loop', targetNodeId: 'review' },
      { type: 'sequential', sourceNodeId: 'review', targetNodeId: 'approval-gate' },
      { type: 'sequential', sourceNodeId: 'approval-gate', targetNodeId: 'publish' },
      { type: 'error', sourceNodeId: 'generate', targetNodeId: 'error-handler' },
    ],
  }
}

// ---------------------------------------------------------------------------
// Test Generation Pipeline
// ---------------------------------------------------------------------------

export interface TestGenerationPipelineOptions {
  /** Testing framework hint (default: `'vitest'`). */
  framework?: string
  /** Maximum cost in cents (default: 100). */
  budgetLimitCents?: number
}

/**
 * Creates a test generation pipeline:
 *
 * ```
 * analyze-code -> generate-tests -> run-tests -> gate(quality) -> report
 * ```
 */
export function createTestGenerationPipeline(
  options?: TestGenerationPipelineOptions,
): PipelineDefinition {
  const framework = options?.framework ?? 'vitest'
  const budgetLimitCents = options?.budgetLimitCents ?? 100

  return {
    id: 'test-generation-pipeline',
    name: 'Test Generation Pipeline',
    version: '1.0.0',
    schemaVersion: '1.0.0',
    description: `Generate comprehensive test suites using ${framework}: analyze, generate, run, quality gate, report.`,
    entryNodeId: 'analyze-code',
    budgetLimitCents,
    checkpointStrategy: 'after_each_node',
    tags: ['testing', 'test-generation', framework],
    metadata: { framework },
    nodes: [
      {
        id: 'analyze-code',
        type: 'agent',
        name: 'Analyze Code',
        description: 'Analyze the source code to identify testable units and edge cases.',
        agentId: 'code-analyzer',
        timeoutMs: 120_000,
      },
      {
        id: 'generate-tests',
        type: 'agent',
        name: 'Generate Tests',
        description: 'Generate test files covering unit, integration, and edge cases.',
        agentId: 'test-writer',
        config: { framework },
        timeoutMs: 300_000,
      },
      {
        id: 'run-tests',
        type: 'tool',
        name: 'Run Tests',
        description: 'Execute the generated test suite.',
        toolName: 'run_tests',
        arguments: { framework },
        timeoutMs: 180_000,
      },
      {
        id: 'quality-gate',
        type: 'gate',
        name: 'Coverage Gate',
        description: 'Verify test coverage meets minimum threshold.',
        gateType: 'quality',
        condition: 'coverage >= 80',
        timeoutMs: 5_000,
      },
      {
        id: 'report',
        type: 'agent',
        name: 'Test Report',
        description: 'Generate a test coverage and quality report.',
        agentId: 'report-generator',
        timeoutMs: 60_000,
      },
      {
        id: 'error-handler',
        type: 'agent',
        name: 'Error Handler',
        description: 'Handle test generation errors.',
        agentId: 'error-handler',
        timeoutMs: 30_000,
      },
    ],
    edges: [
      { type: 'sequential', sourceNodeId: 'analyze-code', targetNodeId: 'generate-tests' },
      { type: 'sequential', sourceNodeId: 'generate-tests', targetNodeId: 'run-tests' },
      { type: 'sequential', sourceNodeId: 'run-tests', targetNodeId: 'quality-gate' },
      { type: 'sequential', sourceNodeId: 'quality-gate', targetNodeId: 'report' },
      { type: 'error', sourceNodeId: 'generate-tests', targetNodeId: 'error-handler' },
    ],
  }
}

// ---------------------------------------------------------------------------
// Refactoring Pipeline
// ---------------------------------------------------------------------------

export interface RefactoringPipelineOptions {
  /** Whether to validate by running tests after refactoring (default: `true`). */
  validateTests?: boolean
  /** Maximum cost in cents (default: 150). */
  budgetLimitCents?: number
}

/**
 * Creates a refactoring pipeline:
 *
 * ```
 * analyze -> plan -> refactor -> [optional: run-tests] -> review -> report
 * ```
 */
export function createRefactoringPipeline(
  options?: RefactoringPipelineOptions,
): PipelineDefinition {
  const validateTests = options?.validateTests ?? true
  const budgetLimitCents = options?.budgetLimitCents ?? 150

  const nodes: PipelineDefinition['nodes'] = [
    {
      id: 'analyze',
      type: 'agent',
      name: 'Analyze Codebase',
      description: 'Analyze the codebase for code smells, duplication, and improvement opportunities.',
      agentId: 'code-analyzer',
      timeoutMs: 120_000,
    },
    {
      id: 'plan',
      type: 'agent',
      name: 'Plan Refactoring',
      description: 'Create a step-by-step refactoring plan.',
      agentId: 'refactoring-specialist',
      timeoutMs: 120_000,
    },
    {
      id: 'refactor',
      type: 'agent',
      name: 'Execute Refactoring',
      description: 'Apply refactoring changes according to the plan.',
      agentId: 'refactoring-specialist',
      timeoutMs: 300_000,
    },
    {
      id: 'review',
      type: 'agent',
      name: 'Review Changes',
      description: 'Review refactored code for correctness and quality.',
      agentId: 'code-reviewer',
      timeoutMs: 120_000,
    },
    {
      id: 'report',
      type: 'agent',
      name: 'Refactoring Report',
      description: 'Generate a summary of changes made during refactoring.',
      agentId: 'report-generator',
      timeoutMs: 60_000,
    },
    {
      id: 'error-handler',
      type: 'agent',
      name: 'Error Handler',
      description: 'Handle refactoring errors.',
      agentId: 'error-handler',
      timeoutMs: 30_000,
    },
  ]

  const edges: PipelineDefinition['edges'] = [
    { type: 'sequential', sourceNodeId: 'analyze', targetNodeId: 'plan' },
    { type: 'sequential', sourceNodeId: 'plan', targetNodeId: 'refactor' },
    { type: 'error', sourceNodeId: 'refactor', targetNodeId: 'error-handler' },
  ]

  if (validateTests) {
    nodes.push({
      id: 'run-tests',
      type: 'tool',
      name: 'Run Tests',
      description: 'Validate that refactoring did not break existing tests.',
      toolName: 'run_tests',
      timeoutMs: 180_000,
    })
    edges.push(
      { type: 'sequential', sourceNodeId: 'refactor', targetNodeId: 'run-tests' },
      { type: 'sequential', sourceNodeId: 'run-tests', targetNodeId: 'review' },
    )
  } else {
    edges.push({ type: 'sequential', sourceNodeId: 'refactor', targetNodeId: 'review' })
  }

  edges.push({ type: 'sequential', sourceNodeId: 'review', targetNodeId: 'report' })

  return {
    id: 'refactoring-pipeline',
    name: 'Refactoring Pipeline',
    version: '1.0.0',
    schemaVersion: '1.0.0',
    description: 'Systematic refactoring: analyze, plan, refactor, validate, review, report.',
    entryNodeId: 'analyze',
    budgetLimitCents,
    checkpointStrategy: 'after_each_node',
    tags: ['refactoring', 'code-quality'],
    nodes,
    edges,
  }
}

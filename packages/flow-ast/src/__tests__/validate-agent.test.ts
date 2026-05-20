/**
 * Per-kind validator coverage for `agent` and `validate` nodes
 * (dzupflow/v1alpha-agent — Stage 1).
 */
import { describe, expect, it } from 'vitest'

import { flowNodeSchema, validateFlowNodeShape } from '../validate.js'

// ── agent — happy path ──────────────────────────────────────────────────────

describe('flowNodeSchema — agent node', () => {
  it('accepts a minimal agent with schemaRef output', () => {
    const result = flowNodeSchema.safeParse({
      type: 'agent',
      id: 'plan',
      agentId: 'planner',
      instructions: 'Plan the work',
      output: { key: 'plan', schemaRef: 'plan.v1' },
    })
    expect(result.success).toBe(true)
    if (result.success && result.data.type === 'agent') {
      expect(result.data.agentId).toBe('planner')
      expect(result.data.output.schemaRef).toBe('plan.v1')
    }
  })

  it('accepts an agent with inline schema', () => {
    const result = flowNodeSchema.safeParse({
      type: 'agent',
      id: 'plan',
      agentId: 'planner',
      instructions: 'do it',
      output: { key: 'plan', schema: { type: 'object' } },
    })
    expect(result.success).toBe(true)
  })

  it('accepts a full agent with retry/validation/policy/stop', () => {
    const result = flowNodeSchema.safeParse({
      type: 'agent',
      id: 'plan',
      agentId: 'planner',
      profile: 'planner-agent',
      toolset: 'planning',
      tools: ['fs.read'],
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      instructions: 'Plan',
      input: { topic: 'flow runtime' },
      stop: { maxIterations: 8, maxToolCalls: 40, requireFinalSchema: true },
      output: { key: 'plan', schemaRef: 'plan.v1' },
      onInvalidOutput: { retry: 2, repairPrompt: true, failAfterRetries: true },
      retry: {
        onInvalidOutput: { attempts: 2, repairPrompt: true },
        onToolError: { attempts: 1 },
        onValidationFailure: { attempts: 1, fullLoop: false },
        onModelUnavailable: { attempts: 2, fallbackProfile: 'backup' },
      },
      validation: {
        required: [{ id: 'tc', command: 'yarn typecheck' }],
        repair: { maxAttempts: 2 },
      },
      policy: {
        timeoutMs: 60000,
        budgetCents: 100,
        maxToolCalls: 80,
        workingDirectory: 'apps/codev-app',
        approval: { requiredFor: ['destructive_shell'] },
        audit: { captureToolCalls: true, captureDiffs: false },
      },
    })
    expect(result.success).toBe(true)
  })
})

// ── agent — failure paths ────────────────────────────────────────────────────

describe('flowNodeSchema — agent node failures', () => {
  it('rejects missing agentId', () => {
    const result = flowNodeSchema.safeParse({
      type: 'agent',
      id: 'plan',
      instructions: 'do',
      output: { key: 'k', schemaRef: 'x' },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.endsWith('.agentId'))).toBe(true)
    }
  })

  it('rejects missing instructions', () => {
    const result = flowNodeSchema.safeParse({
      type: 'agent',
      id: 'plan',
      agentId: 'a',
      output: { key: 'k', schemaRef: 'x' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects output without schemaRef or schema', () => {
    const errors = validateFlowNodeShape({
      type: 'agent',
      id: 'plan',
      agentId: 'a',
      instructions: 'do',
      output: { key: 'k' },
    })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some((e) => e.message.includes('schemaRef'))).toBe(true)
  })

  it('rejects negative retry attempts', () => {
    const errors = validateFlowNodeShape({
      type: 'agent',
      id: 'plan',
      agentId: 'a',
      instructions: 'do',
      output: { key: 'k', schemaRef: 'x' },
      retry: { onToolError: { attempts: -1 } },
    })
    expect(errors.length).toBeGreaterThan(0)
  })

  it('rejects validation with empty required commands', () => {
    const errors = validateFlowNodeShape({
      type: 'agent',
      id: 'plan',
      agentId: 'a',
      instructions: 'do',
      output: { key: 'k', schemaRef: 'x' },
      validation: { required: [] },
    })
    expect(errors.length).toBeGreaterThan(0)
  })

  it('rejects policy.approval.requiredFor with non-string entries', () => {
    const errors = validateFlowNodeShape({
      type: 'agent',
      id: 'plan',
      agentId: 'a',
      instructions: 'do',
      output: { key: 'k', schemaRef: 'x' },
      policy: { approval: { requiredFor: ['ok', 42] } },
    })
    expect(errors.length).toBeGreaterThan(0)
  })
})

// ── validate node ───────────────────────────────────────────────────────────

describe('flowNodeSchema — validate node', () => {
  it('accepts a validate node with inline commands', () => {
    const result = flowNodeSchema.safeParse({
      type: 'validate',
      id: 'final',
      commands: [{ command: 'yarn typecheck' }, { id: 'test', command: 'yarn test' }],
      repair: { maxAttempts: 2, onFailure: 'retry-prior-agent' },
    })
    expect(result.success).toBe(true)
  })

  it('accepts a validate node with ref only', () => {
    const result = flowNodeSchema.safeParse({
      type: 'validate',
      id: 'final',
      ref: 'top-level.required',
    })
    expect(result.success).toBe(true)
  })

  it('rejects a validate node with neither ref nor commands', () => {
    const result = flowNodeSchema.safeParse({
      type: 'validate',
      id: 'final',
    })
    expect(result.success).toBe(false)
  })

  it('rejects validate.repair.onFailure with unknown value', () => {
    const errors = validateFlowNodeShape({
      type: 'validate',
      id: 'final',
      commands: [{ command: 'yarn typecheck' }],
      repair: { maxAttempts: 1, onFailure: 'invalid' as 'stop' },
    })
    expect(errors.length).toBeGreaterThan(0)
  })

  it('rejects validate.commands with empty command string', () => {
    const errors = validateFlowNodeShape({
      type: 'validate',
      id: 'final',
      commands: [{ command: '' }],
    })
    expect(errors.length).toBeGreaterThan(0)
  })
})

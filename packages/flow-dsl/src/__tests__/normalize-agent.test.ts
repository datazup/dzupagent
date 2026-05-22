/**
 * DSL normalization coverage for the `agent` and `validate` wrappers
 * (dzupflow/v1alpha-agent — Stage 1).
 */
import { describe, expect, it } from 'vitest'

import { normalizeDslDocument } from '../normalize.js'
import type { AgentNode, ValidateNode } from '@dzupagent/flow-ast'

function makeRaw(steps: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dsl: 'dzupflow/v1alpha-agent',
    id: 'agent-flow',
    version: 1,
    steps,
    ...extra,
  }
}

describe('normalizeDslDocument — agent wrapper', () => {
  it('accepts a minimal agent step (schemaRef output)', () => {
    const raw = makeRaw([
      {
        agent: {
          id: 'plan',
          agentId: 'planner',
          instructions: 'Plan',
          output: { key: 'plan', schemaRef: 'plan.v1' },
        },
      },
    ])
    const { document, diagnostics } = normalizeDslDocument(raw)
    expect(diagnostics).toEqual([])
    expect(document?.dsl).toBe('dzupflow/v1alpha-agent')
    const agent = document?.root.nodes[0] as AgentNode | undefined
    expect(agent?.type).toBe('agent')
    expect(agent?.agentId).toBe('planner')
    expect(agent?.output.schemaRef).toBe('plan.v1')
  })

  it('accepts a full agent with retry/validation/policy/stop/onInvalidOutput', () => {
    const raw = makeRaw([
      {
        agent: {
          id: 'plan',
          agentId: 'planner',
          profile: 'planner-profile',
          toolset: 'planning',
          tools: ['fs.read'],
          model: 'claude-sonnet-4-6',
          provider: 'anthropic',
          instructions: 'Plan the work',
          input: { topic: 'flow' },
          stop: { maxIterations: 4, requireFinalSchema: true },
          output: { key: 'plan', schemaRef: 'plan.v1' },
          onInvalidOutput: { retry: 2, repairPrompt: true },
          retry: {
            onInvalidOutput: { attempts: 2, repairPrompt: true },
            onToolError: { attempts: 1 },
            onValidationFailure: { attempts: 1, fullLoop: false },
            onModelUnavailable: { attempts: 2, fallbackProfile: 'backup' },
          },
          validation: {
            required: [{ command: 'yarn typecheck' }],
            repair: { maxAttempts: 2 },
          },
          policy: {
            timeoutMs: 60000,
            budgetCents: 100,
            workingDirectory: 'apps/codev-app',
            approval: { requiredFor: ['destructive_shell'] },
            audit: { captureToolCalls: true },
          },
        },
      },
    ])
    const { document, diagnostics } = normalizeDslDocument(raw)
    expect(diagnostics).toEqual([])
    const agent = document?.root.nodes[0] as AgentNode
    expect(agent.profile).toBe('planner-profile')
    expect(agent.retry?.onToolError?.attempts).toBe(1)
    expect(agent.policy?.approval?.requiredFor).toEqual(['destructive_shell'])
  })

  it('rejects agent missing instructions', () => {
    const raw = makeRaw([
      {
        agent: {
          id: 'plan',
          agentId: 'planner',
          output: { key: 'plan', schemaRef: 'plan.v1' },
        },
      },
    ])
    const { diagnostics } = normalizeDslDocument(raw)
    expect(diagnostics.some((d) => d.path?.includes('instructions'))).toBe(true)
  })

  it('rejects agent.output missing both schemaRef and schema', () => {
    const raw = makeRaw([
      {
        agent: {
          id: 'plan',
          agentId: 'planner',
          instructions: 'Plan',
          output: { key: 'plan' },
        },
      },
    ])
    const { diagnostics } = normalizeDslDocument(raw)
    expect(
      diagnostics.some((d) => d.message.includes('schemaRef') || d.message.includes('schema')),
    ).toBe(true)
  })

  it('reports unsupported agent field', () => {
    const raw = makeRaw([
      {
        agent: {
          id: 'plan',
          agentId: 'planner',
          instructions: 'Plan',
          output: { key: 'plan', schemaRef: 'plan.v1' },
          nonsense: true,
        },
      },
    ])
    const { diagnostics } = normalizeDslDocument(raw)
    expect(diagnostics.some((d) => d.code === 'UNSUPPORTED_FIELD' && d.path?.endsWith('.nonsense'))).toBe(
      true,
    )
  })

  it('rejects non-positive timeout and budget policy limits', () => {
    const raw = makeRaw([
      {
        agent: {
          id: 'plan',
          agentId: 'planner',
          instructions: 'Plan',
          output: { key: 'plan', schemaRef: 'plan.v1' },
          policy: { timeoutMs: 0, budgetCents: -1 },
        },
      },
    ])
    const { diagnostics } = normalizeDslDocument(raw)
    expect(diagnostics.some((d) => d.path?.endsWith('.policy.timeoutMs'))).toBe(true)
    expect(diagnostics.some((d) => d.path?.endsWith('.policy.budgetCents'))).toBe(true)
  })
})

describe('normalizeDslDocument — validate wrapper', () => {
  it('accepts a validate step with inline commands', () => {
    const raw = makeRaw([
      {
        validate: {
          id: 'final',
          commands: [{ command: 'yarn typecheck' }],
          repair: { maxAttempts: 2, onFailure: 'retry-prior-agent' },
        },
      },
    ])
    const { document, diagnostics } = normalizeDslDocument(raw)
    expect(diagnostics).toEqual([])
    const node = document?.root.nodes[0] as ValidateNode
    expect(node.type).toBe('validate')
    expect(node.commands?.[0]?.command).toBe('yarn typecheck')
    expect(node.repair?.onFailure).toBe('retry-prior-agent')
  })

  it('accepts a validate step with ref only', () => {
    const raw = makeRaw([
      {
        validate: {
          id: 'final',
          ref: 'top-level.gates',
        },
      },
    ])
    const { document, diagnostics } = normalizeDslDocument(raw)
    expect(diagnostics).toEqual([])
    const node = document?.root.nodes[0] as ValidateNode
    expect(node.ref).toBe('top-level.gates')
  })

  it('rejects validate with neither ref nor commands', () => {
    const raw = makeRaw([
      {
        validate: { id: 'final' },
      },
    ])
    const { diagnostics } = normalizeDslDocument(raw)
    expect(
      diagnostics.some(
        (d) => d.message.includes('ref') || d.message.includes('commands'),
      ),
    ).toBe(true)
  })

  it('rejects validate.repair.onFailure with unknown value', () => {
    const raw = makeRaw([
      {
        validate: {
          id: 'final',
          commands: [{ command: 'yarn typecheck' }],
          repair: { maxAttempts: 1, onFailure: 'something-else' },
        },
      },
    ])
    const { diagnostics } = normalizeDslDocument(raw)
    expect(diagnostics.some((d) => d.code === 'INVALID_ENUM_VALUE')).toBe(true)
  })
})

describe('normalizeDslDocument — DSL version', () => {
  it('still accepts dzupflow/v1 (no agent/validate steps)', () => {
    const raw = {
      dsl: 'dzupflow/v1',
      id: 'classic',
      version: 1,
      steps: [{ action: { id: 'a', ref: 'tool', input: {} } }],
    }
    const { document, diagnostics } = normalizeDslDocument(raw)
    expect(diagnostics).toEqual([])
    expect(document?.dsl).toBe('dzupflow/v1')
  })

  it('accepts dzupflow/v1alpha-agent discriminator', () => {
    const raw = makeRaw([
      {
        complete: { id: 'done' },
      },
    ])
    const { document, diagnostics } = normalizeDslDocument(raw)
    expect(diagnostics).toEqual([])
    expect(document?.dsl).toBe('dzupflow/v1alpha-agent')
  })

  it('rejects unknown DSL version', () => {
    const raw = {
      dsl: 'dzupflow/v9',
      id: 'x',
      version: 1,
      steps: [],
    }
    const { diagnostics } = normalizeDslDocument(raw)
    expect(diagnostics.some((d) => d.code === 'INVALID_DSL_VERSION')).toBe(true)
  })
})

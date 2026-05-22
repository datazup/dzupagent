/**
 * Parser-level coverage for `agent` and `validate` node shapes.
 * Uses `parseFlow` directly (low-level node parser, not document parser).
 */
import { describe, it, expect } from 'vitest'
import { parseFlow } from '../index.js'
import type { AgentNode } from '../index.js'

describe('parseFlow — agent node', () => {
  it('parses a minimal valid agent node with schemaRef', () => {
    const result = parseFlow({
      type: 'agent',
      id: 'my-agent',
      agentId: 'researcher',
      instructions: 'Do some research.',
      output: { key: 'researchResult', schemaRef: 'research.v1' },
    })
    expect(result.errors).toHaveLength(0)
    const node = result.ast as AgentNode
    expect(node?.type).toBe('agent')
    expect(node?.agentId).toBe('researcher')
    expect(node?.output.key).toBe('researchResult')
  })

  it('parses a minimal valid agent node with inline schema', () => {
    const result = parseFlow({
      type: 'agent',
      id: 'my-agent',
      agentId: 'researcher',
      instructions: 'Do some research.',
      output: { key: 'researchResult', schema: { type: 'object' } },
    })
    expect(result.errors).toHaveLength(0)
    const node = result.ast as AgentNode
    expect(node?.type).toBe('agent')
    expect(node?.agentId).toBe('researcher')
  })

  it('returns error when agentId is missing', () => {
    const result = parseFlow({
      type: 'agent',
      id: 'x',
      instructions: 'hi',
      output: { key: 'out', schemaRef: 'x.v1' },
    })
    expect(result.errors.some((e) => e.message.includes('agentId'))).toBe(true)
    expect(result.ast).toBeNull()
  })

  it('returns error when output.key is missing', () => {
    const result = parseFlow({
      type: 'agent',
      id: 'x',
      agentId: 'a',
      instructions: 'hi',
      output: { schemaRef: 'x.v1' },
    })
    expect(result.errors.some((e) => e.message.includes('output.key'))).toBe(true)
    expect(result.ast).toBeNull()
  })

  it('returns error when output has no schemaRef or schema', () => {
    const result = parseFlow({
      type: 'agent',
      id: 'x',
      agentId: 'a',
      instructions: 'hi',
      output: { key: 'out' },
    })
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.ast).toBeNull()
  })

  it('parses optional fields: model, tools, stop', () => {
    const result = parseFlow({
      type: 'agent',
      id: 'a1',
      agentId: 'planner',
      instructions: 'Plan it.',
      model: 'claude-sonnet-4-6',
      tools: ['doc.read', 'repo.read'],
      stop: { maxIterations: 5, maxToolCalls: 20 },
      output: { key: 'plan', schemaRef: 'plan.v1' },
    })
    expect(result.errors).toHaveLength(0)
    const node = result.ast as AgentNode
    expect(node?.model).toBe('claude-sonnet-4-6')
    expect(node?.tools).toEqual(['doc.read', 'repo.read'])
    expect(node?.stop?.maxIterations).toBe(5)
    expect(node?.stop?.maxToolCalls).toBe(20)
  })

  it('parses profile, toolset, provider, input', () => {
    const result = parseFlow({
      type: 'agent',
      id: 'a2',
      agentId: 'researcher',
      profile: 'research-agent',
      toolset: 'research',
      provider: 'anthropic',
      instructions: 'Research deeply.',
      input: { topic: 'flow runtime' },
      output: { key: 'result', schemaRef: 'result.v1' },
    })
    expect(result.errors).toHaveLength(0)
    const node = result.ast as AgentNode
    expect(node?.profile).toBe('research-agent')
    expect(node?.toolset).toBe('research')
    expect(node?.provider).toBe('anthropic')
    expect(node?.input).toEqual({ topic: 'flow runtime' })
  })

  it('parses retry block', () => {
    const result = parseFlow({
      type: 'agent',
      id: 'a3',
      agentId: 'planner',
      instructions: 'Plan.',
      output: { key: 'plan', schemaRef: 'plan.v1' },
      retry: {
        onInvalidOutput: { attempts: 2, repairPrompt: true },
        onToolError: { attempts: 1 },
      },
    })
    expect(result.errors).toHaveLength(0)
    const node = result.ast as AgentNode
    expect(node?.retry?.onInvalidOutput?.attempts).toBe(2)
    expect(node?.retry?.onInvalidOutput?.repairPrompt).toBe(true)
    expect(node?.retry?.onToolError?.attempts).toBe(1)
  })

  it('parses onInvalidOutput shorthand', () => {
    const result = parseFlow({
      type: 'agent',
      id: 'a4',
      agentId: 'planner',
      instructions: 'Plan.',
      output: { key: 'plan', schemaRef: 'plan.v1' },
      onInvalidOutput: { retry: 3, repairPrompt: true, failAfterRetries: true },
    })
    expect(result.errors).toHaveLength(0)
    const node = result.ast as AgentNode
    expect(node?.onInvalidOutput?.retry).toBe(3)
    expect(node?.onInvalidOutput?.repairPrompt).toBe(true)
    expect(node?.onInvalidOutput?.failAfterRetries).toBe(true)
  })

  it('parses validation block', () => {
    const result = parseFlow({
      type: 'agent',
      id: 'a5',
      agentId: 'planner',
      instructions: 'Plan.',
      output: { key: 'plan', schemaRef: 'plan.v1' },
      validation: {
        required: [{ id: 'tc', command: 'yarn typecheck' }],
        repair: { maxAttempts: 2 },
      },
    })
    expect(result.errors).toHaveLength(0)
    const node = result.ast as AgentNode
    expect(node?.validation?.required).toHaveLength(1)
    expect(node?.validation?.required[0]?.command).toBe('yarn typecheck')
    expect(node?.validation?.repair?.maxAttempts).toBe(2)
  })

  it('parses policy block', () => {
    const result = parseFlow({
      type: 'agent',
      id: 'a6',
      agentId: 'planner',
      instructions: 'Plan.',
      output: { key: 'plan', schemaRef: 'plan.v1' },
      policy: {
        timeoutMs: 60000,
        budgetCents: 100,
        workingDirectory: 'apps/codev-app',
        approval: { requiredFor: ['destructive_shell'] },
        audit: { captureToolCalls: true, captureDiffs: false },
      },
    })
    expect(result.errors).toHaveLength(0)
    const node = result.ast as AgentNode
    expect(node?.policy?.timeoutMs).toBe(60000)
    expect(node?.policy?.approval?.requiredFor).toEqual(['destructive_shell'])
    expect(node?.policy?.audit?.captureToolCalls).toBe(true)
  })

  it('rejects non-positive timeout and budget policy limits', () => {
    const result = parseFlow({
      type: 'agent',
      id: 'a-policy',
      agentId: 'planner',
      instructions: 'Plan.',
      output: { key: 'plan', schemaRef: 'plan.v1' },
      policy: { timeoutMs: 0, budgetCents: -1 },
    })
    expect(result.errors.some((e) => e.pointer.endsWith('/policy/timeoutMs'))).toBe(true)
    expect(result.errors.some((e) => e.pointer.endsWith('/policy/budgetCents'))).toBe(true)
  })

  it('returns error when instructions is missing', () => {
    const result = parseFlow({
      type: 'agent',
      id: 'x',
      agentId: 'a',
      output: { key: 'out', schemaRef: 'x.v1' },
    })
    expect(result.errors.some((e) => e.message.includes('instructions'))).toBe(true)
    expect(result.ast).toBeNull()
  })

  it('returns error when agentId is an empty string', () => {
    const result = parseFlow({
      type: 'agent',
      id: 'x',
      agentId: '',
      instructions: 'hi',
      output: { key: 'out', schemaRef: 'x.v1' },
    })
    expect(result.errors.some((e) => e.message.includes('agentId'))).toBe(true)
    expect(result.ast).toBeNull()
  })
})

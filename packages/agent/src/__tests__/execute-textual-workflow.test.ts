import { describe, it, expect } from 'vitest'
import { executeTextualWorkflow, WorkflowParseError, ChainValidationError } from '../skill-chain-executor/index.js'
import { WorkflowRegistry, createSkillChain, SkillRegistry, WorkflowCommandParser } from '@dzupagent/core'
import type { SkillStepResolver } from '../skill-chain-executor/skill-step-resolver.js'
import type { WorkflowStep } from '../workflow/workflow-types.js'

// ---------------------------------------------------------------------------
// Inline mock resolver (avoids cross-package build timing issues)
// ---------------------------------------------------------------------------

class MockSkillStepResolver implements SkillStepResolver {
  private readonly skills = new Map<
    string,
    (state: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>
  >()

  registerText(skillId: string, output: string): void {
    this.skills.set(skillId, () => ({ [skillId]: output }))
  }

  register(
    skillId: string,
    fn: (state: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): void {
    this.skills.set(skillId, fn)
  }

  async resolve(skillId: string): Promise<WorkflowStep> {
    const fn = this.skills.get(skillId)
    if (!fn) throw new Error(`MockSkillStepResolver: skill "${skillId}" not registered`)
    return {
      id: skillId,
      description: `Mock skill: ${skillId}`,
      execute: async (input: unknown) => {
        const state = (input as Record<string, unknown>) ?? {}
        return await fn(state)
      },
    }
  }

  canResolve(skillId: string): boolean {
    return this.skills.has(skillId)
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeTextualWorkflow()', () => {
  it('parses arrow-separated text and executes the chain', async () => {
    const resolver = new MockSkillStepResolver()
    resolver.registerText('research', 'research-output')
    resolver.registerText('draft', 'draft-output')

    const result = await executeTextualWorkflow(
      'research \u2192 draft',
      resolver,
      {},
      { skillRegistry: new SkillRegistry() },
    )

    const outputs = result['previousOutputs'] as Record<string, string>
    expect(outputs['research']).toBe('research-output')
    expect(outputs['draft']).toBe('draft-output')
    expect(result['lastOutput']).toBe('draft-output')
  })

  it('executes a named workflow from registry (exact match)', async () => {
    const resolver = new MockSkillStepResolver()
    resolver.registerText('a', 'output-a')
    resolver.registerText('b', 'output-b')

    const chain = createSkillChain('my-flow', [{ skillName: 'a' }, { skillName: 'b' }])
    const registry = new WorkflowRegistry()
    registry.register('my-flow', chain)

    const result = await executeTextualWorkflow('my-flow', resolver, {}, {
      registry,
      skillRegistry: new SkillRegistry(),
    })

    expect(result['lastOutput']).toBe('output-b')
  })

  it('executes a single skill when text is a single token', async () => {
    const resolver = new MockSkillStepResolver()
    resolver.registerText('brainstorm', 'brainstorm-output')

    const result = await executeTextualWorkflow('brainstorm', resolver, {}, {
      skillRegistry: new SkillRegistry(),
    })
    expect(result['lastOutput']).toBe('brainstorm-output')
  })

  it('throws WorkflowParseError when text cannot be parsed into steps', async () => {
    const resolver = new MockSkillStepResolver()

    // Use a normalizer that returns empty to force parse failure
    const parser = new WorkflowCommandParser({ normalizer: () => '' })

    await expect(
      executeTextualWorkflow('any text', resolver, {}, { parser }),
    ).rejects.toThrow(WorkflowParseError)
  })

  it('throws ChainValidationError when skill cannot be resolved', async () => {
    const resolver = new MockSkillStepResolver()
    // 'unknown-skill' is not registered in resolver

    await expect(
      executeTextualWorkflow('unknown-skill', resolver, {}, {
        skillRegistry: new SkillRegistry(),
      }),
    ).rejects.toThrow(ChainValidationError)
  })

  it('passes initialState through to steps', async () => {
    const resolver = new MockSkillStepResolver()
    resolver.register('step', (state) => ({ step: `got:${state['myKey']}` }))

    const result = await executeTextualWorkflow('step', resolver, { myKey: 'hello' }, {
      skillRegistry: new SkillRegistry(),
    })
    const outputs = result['previousOutputs'] as Record<string, string>
    expect(outputs['step']).toBe('got:hello')
  })
})

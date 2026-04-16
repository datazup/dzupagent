import { describe, it, expect } from 'vitest'
import { streamTextualWorkflow, WorkflowParseError } from '../skill-chain-executor/index.js'
import { WorkflowRegistry, createSkillChain, SkillRegistry, WorkflowCommandParser } from '@dzupagent/core'
import type { SkillStepResolver } from '../skill-chain-executor/skill-step-resolver.js'
import type { WorkflowStep } from '../workflow/workflow-types.js'
import type { WorkflowEvent } from '../workflow/workflow-types.js'

// ---------------------------------------------------------------------------
// Inline mock resolver (mirrors execute-textual-workflow.test.ts)
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
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(gen: AsyncGenerator<WorkflowEvent>): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = []
  for await (const event of gen) {
    events.push(event)
  }
  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('streamTextualWorkflow()', () => {
  it('yields step:started, step:completed, and workflow:completed events', async () => {
    const resolver = new MockSkillStepResolver()
    resolver.registerText('research', 'research-output')
    resolver.registerText('draft', 'draft-output')

    const gen = streamTextualWorkflow(
      'research \u2192 draft',
      resolver,
      {},
      { skillRegistry: new SkillRegistry() },
    )

    const events = await collectEvents(gen)
    const types = events.map(e => e.type)

    expect(types).toContain('step:started')
    expect(types).toContain('step:completed')
    expect(types).toContain('workflow:completed')

    // Should have started/completed pairs for both steps
    const started = events.filter(e => e.type === 'step:started')
    const completed = events.filter(e => e.type === 'step:completed')
    expect(started).toHaveLength(2)
    expect(completed).toHaveLength(2)
  })

  it('streams a named workflow from registry (exact match)', async () => {
    const resolver = new MockSkillStepResolver()
    resolver.registerText('a', 'output-a')
    resolver.registerText('b', 'output-b')

    const chain = createSkillChain('my-flow', [{ skillName: 'a' }, { skillName: 'b' }])
    const registry = new WorkflowRegistry()
    registry.register('my-flow', chain)

    const gen = streamTextualWorkflow('my-flow', resolver, {}, {
      registry,
      skillRegistry: new SkillRegistry(),
    })

    const events = await collectEvents(gen)
    const types = events.map(e => e.type)

    expect(types).toContain('step:started')
    expect(types).toContain('workflow:completed')
  })

  it('throws WorkflowParseError when text cannot be parsed into steps', async () => {
    const resolver = new MockSkillStepResolver()

    const parser = new WorkflowCommandParser({ normalizer: () => '' })

    const gen = streamTextualWorkflow('any text', resolver, {}, { parser })

    // The generator throws on first iteration when parsing fails
    await expect(collectEvents(gen)).rejects.toThrow(WorkflowParseError)
  })

  it('accepts an AbortSignal option without error', async () => {
    const controller = new AbortController()
    const resolver = new MockSkillStepResolver()
    resolver.registerText('quick', 'done')

    // Verify the signal option is accepted and the generator completes normally
    const gen = streamTextualWorkflow('quick', resolver, {}, {
      signal: controller.signal,
      skillRegistry: new SkillRegistry(),
    })

    const events = await collectEvents(gen)
    const types = events.map(e => e.type)
    expect(types).toContain('workflow:completed')
  })

  it('streams a single skill when text is a single token', async () => {
    const resolver = new MockSkillStepResolver()
    resolver.registerText('brainstorm', 'brainstorm-output')

    const gen = streamTextualWorkflow('brainstorm', resolver, {}, {
      skillRegistry: new SkillRegistry(),
    })

    const events = await collectEvents(gen)
    const types = events.map(e => e.type)

    expect(types).toContain('step:started')
    expect(types).toContain('step:completed')
    expect(types).toContain('workflow:completed')

    const started = events.filter(e => e.type === 'step:started')
    expect(started).toHaveLength(1)
  })
})

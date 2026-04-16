/**
 * Mock implementation of SkillStepResolver for deterministic testing
 * of skill chain execution without real agent/LLM dependencies.
 */
import type { WorkflowStep } from '@dzupagent/agent'
import type { SkillStepResolver } from '@dzupagent/agent'

export interface MockCall {
  skillId: string
  state: Record<string, unknown>
}

export class MockSkillStepResolver implements SkillStepResolver {
  private readonly skills = new Map<
    string,
    (state: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>
  >()
  readonly calls: MockCall[] = []

  /** Register a skill that returns `{ [skillId]: output }`. */
  registerText(skillId: string, output: string): void {
    this.skills.set(skillId, () => ({ [skillId]: output }))
  }

  /** Register a skill with a custom state transform function (sync or async). */
  register(
    skillId: string,
    fn: (state: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): void {
    this.skills.set(skillId, fn)
  }

  /** Register a skill that always throws the given error. */
  registerError(skillId: string, error: Error | string): void {
    this.skills.set(skillId, async () => {
      throw error instanceof Error ? error : new Error(error)
    })
  }

  /** Register a skill that waits `delayMs` then returns `{ [skillId]: output }`. */
  registerDelay(skillId: string, delayMs: number, output: string): void {
    this.skills.set(skillId, async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      return { [skillId]: output }
    })
  }

  /** Remove a previously registered skill. */
  unregister(skillId: string): void {
    this.skills.delete(skillId)
  }

  async resolve(skillId: string): Promise<WorkflowStep> {
    const fn = this.skills.get(skillId)
    if (!fn) throw new Error(`MockSkillStepResolver: skill "${skillId}" not registered`)
    return {
      id: skillId,
      description: `Mock skill: ${skillId}`,
      execute: async (input: unknown) => {
        const state = (input as Record<string, unknown>) ?? {}
        this.calls.push({ skillId, state: { ...state } })
        return await fn(state)
      },
    }
  }

  canResolve(skillId: string): boolean {
    return this.skills.has(skillId)
  }
}

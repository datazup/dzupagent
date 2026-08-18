import { describe, expect, it } from 'vitest'

import { SkillChainBuilder, SkillRegistry } from '@dzupagent/core'
import { SkillChainExecutor } from '../skill-chain-executor.js'
import type { SkillStepResolver } from '../skill-step-resolver.js'
import type { WorkflowStep } from '../../workflow/workflow-types.js'

type SkillHandler = (
  state: Record<string, unknown>,
) => Record<string, unknown> | Promise<Record<string, unknown>>

class AdmissionSkillResolver implements SkillStepResolver {
  private readonly skills = new Map<string, SkillHandler>()

  registerText(skillId: string, output: string): void {
    this.skills.set(skillId, () => ({ [skillId]: output }))
  }

  register(skillId: string, handler: SkillHandler): void {
    this.skills.set(skillId, handler)
  }

  async resolve(skillId: string): Promise<WorkflowStep> {
    const handler = this.skills.get(skillId)
    if (!handler) {
      throw new Error(`AdmissionSkillResolver: skill "${skillId}" not registered`)
    }

    return {
      id: skillId,
      execute: async input => handler((input as Record<string, unknown>) ?? {}),
    }
  }

  canResolve(skillId: string): boolean {
    return this.skills.has(skillId)
  }
}

function buildExecutor(resolver: AdmissionSkillResolver): SkillChainExecutor {
  return new SkillChainExecutor({
    resolver,
    registry: new SkillRegistry(),
  })
}

function readPreviousOutputs(result: Record<string, unknown>): Record<string, string> {
  return result['previousOutputs'] as Record<string, string>
}

describe('SkillChainExecutor parallel output admission', () => {
  it('retains every declared parallel text output in previousOutputs', async () => {
    const resolver = new AdmissionSkillResolver()
    resolver.registerText('alpha', 'alpha-output')
    resolver.registerText('beta', 'beta-output')

    const result = await buildExecutor(resolver).execute(
      new SkillChainBuilder('parallel-ledger')
        .parallel(['alpha', 'beta'])
        .build(),
      {},
    )

    expect(readPreviousOutputs(result)).toEqual({
      alpha: 'alpha-output',
      beta: 'beta-output',
    })
  })

  it('passes all parallel outputs to the next skill through previousOutputs', async () => {
    const resolver = new AdmissionSkillResolver()
    resolver.registerText('alpha', 'alpha-output')
    resolver.registerText('beta', 'beta-output')
    resolver.register('consumer', state => {
      const previousOutputs = state['previousOutputs'] as Record<string, string>
      return {
        consumer: `${previousOutputs['alpha']}|${previousOutputs['beta']}`,
      }
    })

    const result = await buildExecutor(resolver).execute(
      new SkillChainBuilder('parallel-consumer')
        .parallel(['alpha', 'beta'])
        .step('consumer')
        .build(),
      {},
    )

    expect(result['consumer']).toBe('alpha-output|beta-output')
    expect(result['lastOutput']).toBe('alpha-output|beta-output')
  })

  it('merges in declared order even when parallel skills settle in reverse order', async () => {
    const resolver = new AdmissionSkillResolver()
    let started = 0
    let markBothStarted: (() => void) | undefined
    const bothStarted = new Promise<void>(resolve => {
      markBothStarted = resolve
    })
    let resolveFirst: ((value: Record<string, unknown>) => void) | undefined
    let resolveSecond: ((value: Record<string, unknown>) => void) | undefined

    const markStarted = () => {
      started += 1
      if (started === 2) markBothStarted?.()
    }

    resolver.register('first', () => new Promise(resolve => {
      resolveFirst = resolve
      markStarted()
    }))
    resolver.register('second', () => new Promise(resolve => {
      resolveSecond = resolve
      markStarted()
    }))

    const execution = buildExecutor(resolver).execute(
      new SkillChainBuilder('declared-order')
        .parallel(['first', 'second'])
        .build(),
      {},
    )

    await bothStarted
    resolveSecond?.({ second: 'second-output', collision: 'second' })
    await Promise.resolve()
    resolveFirst?.({ first: 'first-output', collision: 'first' })

    const result = await execution
    expect(result).toMatchObject({
      first: 'first-output',
      second: 'second-output',
      collision: 'second',
    })
    expect(readPreviousOutputs(result)).toMatchObject({
      first: 'first-output',
      second: 'second-output',
    })
  })

  it('makes last-wins apply only the final declared result while retaining the output ledger', async () => {
    const resolver = new AdmissionSkillResolver()
    resolver.register('first', () => ({
      first: 'first-output',
      firstOnly: true,
      collision: 'first',
    }))
    resolver.register('second', () => ({
      second: 'second-output',
      secondOnly: true,
      collision: 'second',
    }))

    const result = await buildExecutor(resolver).execute(
      new SkillChainBuilder('last-wins')
        .parallel(['first', 'second'], { mergeStrategy: 'last-wins' })
        .build(),
      {},
    )

    expect(result['first']).toBeUndefined()
    expect(result['firstOnly']).toBeUndefined()
    expect(result).toMatchObject({
      second: 'second-output',
      secondOnly: true,
      collision: 'second',
    })
    expect(readPreviousOutputs(result)).toEqual({
      first: 'first-output',
      second: 'second-output',
    })
  })

  it('preserves sequential outputs that precede a parallel group', async () => {
    const resolver = new AdmissionSkillResolver()
    resolver.registerText('before', 'before-output')
    resolver.registerText('alpha', 'alpha-output')
    resolver.registerText('beta', 'beta-output')

    const result = await buildExecutor(resolver).execute(
      new SkillChainBuilder('prior-output')
        .step('before')
        .parallel(['alpha', 'beta'])
        .build(),
      {},
    )

    expect(readPreviousOutputs(result)).toEqual({
      before: 'before-output',
      alpha: 'alpha-output',
      beta: 'beta-output',
    })
  })

  it('combines nested previousOutputs from every result in declared order', async () => {
    const resolver = new AdmissionSkillResolver()
    resolver.register('alpha', () => ({
      alpha: 'alpha-output',
      previousOutputs: {
        inherited: 'from-alpha',
        nestedAlpha: 'nested-alpha',
      },
    }))
    resolver.register('beta', () => ({
      beta: 'beta-output',
      previousOutputs: {
        inherited: 'from-beta',
        nestedBeta: 'nested-beta',
      },
    }))

    const result = await buildExecutor(resolver).execute(
      new SkillChainBuilder('nested-ledgers')
        .parallel(['alpha', 'beta'])
        .build(),
      { previousOutputs: { before: 'before-output' } },
    )

    expect(readPreviousOutputs(result)).toEqual({
      before: 'before-output',
      inherited: 'from-beta',
      nestedAlpha: 'nested-alpha',
      alpha: 'alpha-output',
      nestedBeta: 'nested-beta',
      beta: 'beta-output',
    })
  })

  it('uses the final declared parallel text output as terminal lastOutput', async () => {
    const resolver = new AdmissionSkillResolver()
    resolver.registerText('alpha', 'alpha-output')
    resolver.registerText('beta', 'beta-output')

    const result = await buildExecutor(resolver).execute(
      new SkillChainBuilder('terminal-parallel')
        .parallel(['alpha', 'beta'])
        .build(),
      {},
    )

    expect(result['lastOutput']).toBe('beta-output')
  })

  it('does not stringify a non-text terminal parallel output', async () => {
    const resolver = new AdmissionSkillResolver()
    resolver.registerText('alpha', 'alpha-output')
    resolver.register('beta', () => ({ beta: { nested: true } }))

    const result = await buildExecutor(resolver).execute(
      new SkillChainBuilder('non-text-terminal')
        .parallel(['alpha', 'beta'])
        .build(),
      {},
    )

    expect(result['lastOutput']).toBeUndefined()
    expect(readPreviousOutputs(result)).toEqual({ alpha: 'alpha-output' })
  })

  it('does not mutate result objects returned by parallel skills', async () => {
    const resolver = new AdmissionSkillResolver()
    const firstResult = {
      first: 'first-output',
      previousOutputs: { nestedFirst: 'nested-first' },
    }
    const secondResult = {
      second: 'second-output',
      previousOutputs: { nestedSecond: 'nested-second' },
    }
    resolver.register('first', () => firstResult)
    resolver.register('second', () => secondResult)

    await buildExecutor(resolver).execute(
      new SkillChainBuilder('immutable-results')
        .parallel(['first', 'second'])
        .build(),
      {},
    )

    expect(firstResult).toEqual({
      first: 'first-output',
      previousOutputs: { nestedFirst: 'nested-first' },
    })
    expect(secondResult).toEqual({
      second: 'second-output',
      previousOutputs: { nestedSecond: 'nested-second' },
    })
  })
})

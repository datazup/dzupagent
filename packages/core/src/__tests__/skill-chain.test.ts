import { describe, it, expect } from 'vitest'
import {
  createSkillChain,
  validateChain,
  SkillChainBuilder,
} from '../skills/skill-chain.js'
import type { SkillChainStep } from '../skills/skill-chain.js'

describe('createSkillChain', () => {
  it('throws when name is empty', () => {
    expect(() => createSkillChain('', [{ skillName: 'a' }])).toThrow(
      'name must not be empty',
    )
  })

  it('throws when steps array is empty', () => {
    expect(() => createSkillChain('x', [])).toThrow('at least one step')
  })

  it('returns a chain with the given name and steps', () => {
    const chain = createSkillChain('my-chain', [{ skillName: 'a' }])
    expect(chain.name).toBe('my-chain')
    expect(chain.steps).toHaveLength(1)
    expect(chain.steps[0]!.skillName).toBe('a')
  })

  it('defensively copies the steps array so mutations do not affect the chain', () => {
    const steps: SkillChainStep[] = [{ skillName: 'a' }]
    const chain = createSkillChain('x', steps)

    // Mutate the original array
    steps.push({ skillName: 'b' })

    expect(chain.steps).toHaveLength(1)
    expect(chain.steps[0]!.skillName).toBe('a')
  })
})

describe('validateChain', () => {
  it('returns valid: true when all steps are present', () => {
    const chain = createSkillChain('c', [
      { skillName: 'a' },
      { skillName: 'b' },
    ])
    const result = validateChain(chain, ['a', 'b', 'c'])
    expect(result).toEqual({ valid: true, missingSkills: [] })
  })

  it('returns valid: false with missing skills listed', () => {
    const chain = createSkillChain('c', [
      { skillName: 'a' },
      { skillName: 'missing' },
    ])
    const result = validateChain(chain, ['a'])
    expect(result.valid).toBe(false)
    expect(result.missingSkills).toEqual(['missing'])
  })

  it('deduplicates missing skills', () => {
    const chain = createSkillChain('c', [
      { skillName: 'gone' },
      { skillName: 'gone' },
      { skillName: 'also-gone' },
    ])
    const result = validateChain(chain, [])
    expect(result.valid).toBe(false)
    expect(result.missingSkills).toEqual(['gone', 'also-gone'])
  })
})

describe('SkillChainBuilder', () => {
  it('builds a chain via fluent step() calls', () => {
    const chain = new SkillChainBuilder('test')
      .step('research')
      .step('draft', { timeoutMs: 5000 })
      .build()
    expect(chain.name).toBe('test')
    expect(chain.steps).toHaveLength(2)
    expect(chain.steps[1]!.timeoutMs).toBe(5000)
  })

  it('builds a chain with stepIf() condition', () => {
    const condition = (prev: string) => prev.includes('ok')
    const chain = new SkillChainBuilder('cond')
      .step('first')
      .stepIf('second', condition)
      .build()
    expect(chain.steps[1]!.condition).toBe(condition)
  })

  it('builds a chain with stepSuspend()', () => {
    const chain = new SkillChainBuilder('suspend')
      .step('prepare')
      .stepSuspend('review')
      .build()
    expect(chain.steps[1]!.suspendBefore).toBe(true)
  })

  it('throws when no steps added', () => {
    expect(() => new SkillChainBuilder('empty').build()).toThrow('at least one step')
  })

  it('throws when constructor name is empty', () => {
    expect(() => new SkillChainBuilder('')).toThrow('name must not be empty')
  })
})

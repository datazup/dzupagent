import { describe, expect, it } from 'vitest'
import type { EvalInput } from '../types.js'
import { DomainScorer } from '../scorers/domain-scorer.js'
import { clamp01, combinedText, countPatterns, parseCriterionResponse } from '../scorers/domain-scorer/helpers.js'
import { buildDomainConfig, cloneDomainConfig, DOMAIN_CONFIGS } from '../scorers/domain-scorer/configs.js'
import {
  codeTypeCorrectnessDeterministic,
  sqlCorrectnessDeterministic,
} from '../scorers/domain-scorer/deterministic-checks.js'

describe('domain-scorer helper modules', () => {
  it('normalizes weighted configs and preserves built-in metadata', () => {
    const config = buildDomainConfig({
      domain: 'code',
      weightOverrides: {
        typeCorrectness: 2,
        testCoverage: 1,
      },
    })

    const totalWeight = config.criteria.reduce((sum, criterion) => sum + criterion.weight, 0)
    const weights = Object.fromEntries(config.criteria.map((criterion) => [criterion.name, criterion.weight]))

    expect(config.domain).toBe('code')
    expect(config.name).toBe(DOMAIN_CONFIGS.code.name)
    expect(totalWeight).toBeCloseTo(1)
    expect(weights.typeCorrectness / weights.testCoverage).toBeCloseTo(2)
  })

  it('applies custom config overrides without mutating the built-in config map', () => {
    const original = cloneDomainConfig('sql')
    const config = buildDomainConfig({
      domain: 'sql',
      customConfig: {
        name: 'SQL Review',
        description: 'Custom SQL checks',
      },
    })

    expect(config.name).toBe('SQL Review')
    expect(config.description).toBe('Custom SQL checks')
    expect(config.criteria).toEqual(original.criteria)
    expect(config.criteria).not.toBe(original.criteria)
    expect(config.criteria[0]).not.toBe(original.criteria[0])

    config.criteria[0]!.weight = 0.99

    expect(original.name).toBe(DOMAIN_CONFIGS.sql.name)
    expect(DOMAIN_CONFIGS.sql.name).toBe('SQL Quality')
    expect(original.criteria[0]!.weight).toBe(DOMAIN_CONFIGS.sql.criteria[0]!.weight)
    expect(DOMAIN_CONFIGS.sql.criteria[0]!.weight).toBe(0.35)
  })

  it('returns isolated clones from config helpers', () => {
    const cloned = cloneDomainConfig('code')
    const built = buildDomainConfig({ domain: 'code' })

    expect(cloned.criteria).toEqual(DOMAIN_CONFIGS.code.criteria)
    expect(cloned.criteria).not.toBe(DOMAIN_CONFIGS.code.criteria)
    expect(cloned.criteria[0]).not.toBe(DOMAIN_CONFIGS.code.criteria[0])
    expect(built.criteria).not.toBe(DOMAIN_CONFIGS.code.criteria)

    cloned.criteria[0]!.weight = 0.01
    built.criteria[1]!.description = 'mutated in test'

    expect(DOMAIN_CONFIGS.code.criteria[0]!.weight).toBe(0.3)
    expect(DOMAIN_CONFIGS.code.criteria[1]!.description).toBe('Are there tests?')
  })

  it('parses criterion responses and rejects malformed payloads', () => {
    expect(parseCriterionResponse('prefix {"score": 8, "reasoning": "clear"} suffix')).toEqual({
      score: 8,
      reasoning: 'clear',
    })
    expect(parseCriterionResponse('{"score": 11, "reasoning": "too high"}')).toBeNull()
    expect(parseCriterionResponse('not json')).toBeNull()
  })

  it('exposes the helper utilities used by the scorer', () => {
    const input: EvalInput = {
      input: 'SELECT users',
      output: 'SELECT * FROM users',
      reference: 'SELECT id FROM users',
    }

    expect(combinedText(input)).toContain('SELECT * FROM users')
    expect(countPatterns('alpha beta alpha', [/alpha/, /beta/, /gamma/])).toBe(2)
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(0.75)).toBe(0.75)
  })

  it('exposes public scorer contracts for domain detection and deterministic scoring', async () => {
    const sqlInput: EvalInput = {
      input: 'Write a SQL query for users',
      output: 'SELECT id FROM users',
    }
    const scorer = new DomainScorer({ domain: 'sql' })

    const result = await scorer.score(sqlInput)

    expect(DomainScorer.detectDomain(sqlInput)).toBe('sql')
    expect(result.domain).toBe('sql')
    expect(result.aggregateScore).toBeCloseTo(0.81)
    expect(result.passed).toBe(true)
    expect(result.criterionResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        criterion: 'queryCorrectness',
        method: 'deterministic',
        score: 1,
      }),
      expect.objectContaining({
        criterion: 'schemaCompliance',
        method: 'deterministic',
        score: 0,
        reasoning: expect.stringContaining('No evaluation method available'),
      }),
    ]))
  })

  it('keeps deterministic checks behavior-focused', () => {
    expect(sqlCorrectnessDeterministic({
      input: 'question',
      output: 'SELECT id FROM users',
    })).toMatchObject({ score: 1 })
    expect(sqlCorrectnessDeterministic({
      input: 'question',
      output: 'SELECT id FROM users',
    }).reasoning).toContain('syntax checks passed')

    expect(codeTypeCorrectnessDeterministic({
      input: 'question',
      output: 'const value: any = 1\n// @ts-ignore',
    }).score).toBeCloseTo(0.7)
  })
})

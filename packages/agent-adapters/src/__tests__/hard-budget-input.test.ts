import { describe, expect, it, vi } from 'vitest'
import {
  AdapterHardBudgetHostProfileRegistry,
  prepareAdapterHardBudgetInput,
  type AdapterHardBudgetEvaluation,
} from '../hard-budget.js'
import {
  FIXTURE_MODEL,
  fixtureBinding,
  fixtureProfile,
  fixtureRegistry,
} from './hard-budget-test-fixtures.js'

describe('prepareAdapterHardBudgetInput', () => {
  it('derives envelope and tool reservations without mutating input', () => {
    const evaluations: AdapterHardBudgetEvaluation[] = []
    const input = {
      prompt: 'Run the provider-free fixture.',
      systemPrompt: 'Keep the fixture deterministic.',
      correlationId: 'fixture-correlation',
    }
    const result = prepareAdapterHardBudgetInput({
      input,
      provider: 'openai',
      model: FIXTURE_MODEL,
      tools: [{
        type: 'function',
        function: {
          name: 'lookup_fixture',
          parameters: { type: 'object', properties: {} },
        },
      }],
      toolChoice: 'auto',
      policy: {
        registry: fixtureRegistry(),
        binding: fixtureBinding(),
        onEvaluation: (evaluation) => evaluations.push(evaluation),
      },
    })

    expect(result.input).not.toBe(input)
    expect(result.input).toEqual(input)
    expect(result.reservation.envelopeTokens).toBeGreaterThan(0)
    expect(result.reservation.toolTokens).toBeGreaterThan(0)
    expect(result.evaluation).toMatchObject({
      accepted: true,
      adoptionSafe: true,
      satisfied: true,
      profileId: 'provider-free-openai-fixture',
      tokenizerRevision: '1',
      requestFormatRevision: '1',
    })
    expect(result.evaluation.toolSchemaFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(evaluations).toEqual([result.evaluation])
  })

  it('fails closed for missing profiles without exposing input in telemetry', () => {
    const onEvaluation = vi.fn()

    expect(() => prepareAdapterHardBudgetInput({
      input: { prompt: 'SENSITIVE-FIXTURE-CONTENT' },
      provider: 'openai',
      model: 'unregistered-model',
      policy: {
        registry: new AdapterHardBudgetHostProfileRegistry([]),
        binding: fixtureBinding(),
        onEvaluation,
      },
    })).toThrowError(expect.objectContaining({ code: 'profile_not_found' }))

    expect(onEvaluation).toHaveBeenCalledWith(expect.objectContaining({
      accepted: false,
      code: 'profile_not_found',
    }))
    expect(JSON.stringify(onEvaluation.mock.calls)).not.toContain(
      'SENSITIVE-FIXTURE-CONTENT',
    )
  })

  it('rejects heuristic request measurements and stale bindings', () => {
    expect(() => prepareAdapterHardBudgetInput({
      input: { prompt: 'fixture' },
      provider: 'openai',
      model: FIXTURE_MODEL,
      policy: {
        registry: fixtureRegistry(),
        binding: fixtureBinding({
          countRequest: (request) => ({
            tokens: 1,
            method: 'heuristic',
            model: request.model,
          }),
        }),
      },
    })).toThrowError(expect.objectContaining({ code: 'measurement_unproven' }))

    expect(() => prepareAdapterHardBudgetInput({
      input: { prompt: 'fixture' },
      provider: 'openai',
      model: FIXTURE_MODEL,
      policy: {
        registry: fixtureRegistry(),
        binding: fixtureBinding({ tokenizerRevision: 'stale' }),
      },
    })).toThrowError(expect.objectContaining({
      code: 'tokenizer_binding_mismatch',
    }))
  })

  it('retains protected input and aborts when it cannot fit', () => {
    const input = {
      prompt: 'P'.repeat(100),
      systemPrompt: 'SYSTEM-MUST-STAY',
    }
    const original = { ...input }

    expect(() => prepareAdapterHardBudgetInput({
      input,
      provider: 'openai',
      model: FIXTURE_MODEL,
      policy: {
        registry: fixtureRegistry([fixtureProfile({
          contextWindowTokens: 160,
          reservedOutputTokens: 30,
          reservedSummaryTokens: 10,
        })]),
        binding: fixtureBinding(),
      },
    })).toThrowError(expect.objectContaining({ code: 'transcript_unsafe' }))

    expect(input).toEqual(original)
  })

  it('isolates telemetry callback failures from an accepted boundary', () => {
    const result = prepareAdapterHardBudgetInput({
      input: { prompt: 'fixture' },
      provider: 'openai',
      model: FIXTURE_MODEL,
      policy: {
        registry: fixtureRegistry(),
        binding: fixtureBinding(),
        onEvaluation: () => {
          throw new Error('telemetry unavailable')
        },
      },
    })

    expect(result.hardBudget.adoptionSafe).toBe(true)
  })
})

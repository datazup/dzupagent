/**
 * Focused tests for the extracted recovery-strategy-application helper.
 *
 * These mirror the original in-class `applyStrategy` invariants so the
 * non-stream and stream recovery loops continue to mutate `AgentInput`
 * identically across attempts.
 */

import { describe, it, expect } from 'vitest'
import { applyRecoveryStrategy } from '../recovery/recovery-strategy-application.js'
import type { AdapterProviderId, AgentInput } from '../types.js'

const baseInput: AgentInput = { prompt: 'do the thing' }

const noopResolver = (): AdapterProviderId | undefined => undefined

describe('applyRecoveryStrategy', () => {
  describe('retry-same-provider', () => {
    it('returns a shallow clone with no field changes', () => {
      const out = applyRecoveryStrategy({
        strategy: 'retry-same-provider',
        input: { ...baseInput, maxTurns: 5, maxBudgetUsd: 1 },
        budgetMultiplier: 1.5,
        resolveAlternativeProvider: noopResolver,
      })
      expect(out).toEqual({ prompt: 'do the thing', maxTurns: 5, maxBudgetUsd: 1 })
      expect(out).not.toBe(baseInput)
    })
  })

  describe('retry-different-provider', () => {
    it('injects preferredProvider when an alternative is available', () => {
      const out = applyRecoveryStrategy({
        strategy: 'retry-different-provider',
        input: baseInput,
        exhaustedProviders: new Set(['claude' as AdapterProviderId]),
        budgetMultiplier: 1.5,
        resolveAlternativeProvider: (excluded) => {
          // Asserts the helper passes the exhausted set through verbatim.
          expect(excluded).toEqual(['claude'])
          return 'codex' as AdapterProviderId
        },
      })
      expect(out.options?.preferredProvider).toBe('codex')
      // existing options preserved
      const out2 = applyRecoveryStrategy({
        strategy: 'retry-different-provider',
        input: { ...baseInput, options: { foo: 'bar' } },
        budgetMultiplier: 1.5,
        resolveAlternativeProvider: () => 'gemini' as AdapterProviderId,
      })
      expect(out2.options).toEqual({ foo: 'bar', preferredProvider: 'gemini' })
    })

    it('returns a shallow clone unchanged when no alternative is found', () => {
      const out = applyRecoveryStrategy({
        strategy: 'retry-different-provider',
        input: { ...baseInput, options: { foo: 'bar' } },
        budgetMultiplier: 1.5,
        resolveAlternativeProvider: noopResolver,
      })
      expect(out.options).toEqual({ foo: 'bar' })
      expect(out).not.toBe(baseInput)
    })

    it('passes an empty array when exhaustedProviders is omitted', () => {
      let received: AdapterProviderId[] | undefined
      applyRecoveryStrategy({
        strategy: 'retry-different-provider',
        input: baseInput,
        budgetMultiplier: 1.5,
        resolveAlternativeProvider: (excluded) => {
          received = excluded
          return undefined
        },
      })
      expect(received).toEqual([])
    })
  })

  describe('increase-budget', () => {
    it('multiplies maxTurns (rounded up) and maxBudgetUsd', () => {
      const out = applyRecoveryStrategy({
        strategy: 'increase-budget',
        input: { ...baseInput, maxTurns: 5, maxBudgetUsd: 2 },
        budgetMultiplier: 1.5,
        resolveAlternativeProvider: noopResolver,
      })
      expect(out.maxTurns).toBe(8) // Math.ceil(5 * 1.5) = 8
      expect(out.maxBudgetUsd).toBe(3)
    })

    it('omits fields that were not present on input', () => {
      const out = applyRecoveryStrategy({
        strategy: 'increase-budget',
        input: baseInput, // no maxTurns / maxBudgetUsd
        budgetMultiplier: 2,
        resolveAlternativeProvider: noopResolver,
      })
      expect(out.maxTurns).toBeUndefined()
      expect(out.maxBudgetUsd).toBeUndefined()
    })

    it('only multiplies the field that was present', () => {
      const onlyTurns = applyRecoveryStrategy({
        strategy: 'increase-budget',
        input: { ...baseInput, maxTurns: 3 },
        budgetMultiplier: 2,
        resolveAlternativeProvider: noopResolver,
      })
      expect(onlyTurns.maxTurns).toBe(6)
      expect(onlyTurns.maxBudgetUsd).toBeUndefined()

      const onlyBudget = applyRecoveryStrategy({
        strategy: 'increase-budget',
        input: { ...baseInput, maxBudgetUsd: 0.5 },
        budgetMultiplier: 4,
        resolveAlternativeProvider: noopResolver,
      })
      expect(onlyBudget.maxBudgetUsd).toBe(2)
      expect(onlyBudget.maxTurns).toBeUndefined()
    })
  })

  describe('simplify-task', () => {
    it('prepends the SIMPLIFIED marker to prompt', () => {
      const out = applyRecoveryStrategy({
        strategy: 'simplify-task',
        input: baseInput,
        budgetMultiplier: 1.5,
        resolveAlternativeProvider: noopResolver,
      })
      expect(out.prompt.startsWith('[SIMPLIFIED]')).toBe(true)
      expect(out.prompt.endsWith('do the thing')).toBe(true)
    })

    it('appends to existing systemPrompt when present', () => {
      const out = applyRecoveryStrategy({
        strategy: 'simplify-task',
        input: { ...baseInput, systemPrompt: 'You are helpful.' },
        budgetMultiplier: 1.5,
        resolveAlternativeProvider: noopResolver,
      })
      expect(out.systemPrompt?.startsWith('You are helpful.')).toBe(true)
      expect(out.systemPrompt).toContain('Simplify your approach')
    })

    it('creates a systemPrompt when none was provided', () => {
      const out = applyRecoveryStrategy({
        strategy: 'simplify-task',
        input: baseInput,
        budgetMultiplier: 1.5,
        resolveAlternativeProvider: noopResolver,
      })
      expect(out.systemPrompt).toBe(
        'IMPORTANT: Simplify your approach. Use the most straightforward solution available.',
      )
    })
  })

  describe('terminal strategies', () => {
    it('escalate-human returns input unchanged (same reference)', () => {
      const out = applyRecoveryStrategy({
        strategy: 'escalate-human',
        input: baseInput,
        budgetMultiplier: 1.5,
        resolveAlternativeProvider: noopResolver,
      })
      expect(out).toBe(baseInput)
    })

    it('abort returns input unchanged (same reference)', () => {
      const out = applyRecoveryStrategy({
        strategy: 'abort',
        input: baseInput,
        budgetMultiplier: 1.5,
        resolveAlternativeProvider: noopResolver,
      })
      expect(out).toBe(baseInput)
    })
  })

  describe('immutability', () => {
    it('does not mutate the original input for any non-terminal strategy', () => {
      const original: AgentInput = {
        prompt: 'p',
        maxTurns: 4,
        maxBudgetUsd: 1,
        options: { foo: 'bar' },
        systemPrompt: 'sys',
      }
      const snapshot = JSON.parse(JSON.stringify(original))
      for (const strategy of [
        'retry-same-provider',
        'retry-different-provider',
        'increase-budget',
        'simplify-task',
      ] as const) {
        applyRecoveryStrategy({
          strategy,
          input: original,
          exhaustedProviders: new Set(),
          budgetMultiplier: 2,
          resolveAlternativeProvider: () => 'codex' as AdapterProviderId,
        })
      }
      expect(original).toEqual(snapshot)
    })
  })
})

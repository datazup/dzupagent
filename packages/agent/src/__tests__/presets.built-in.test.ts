import { describe, it, expect } from 'vitest'
import {
  RAGChatPreset,
  ResearchPreset,
  SummarizerPreset,
  QAPreset,
  BUILT_IN_PRESETS,
} from '../presets/built-in.js'
import type { AgentPreset } from '../presets/types.js'

// ---------------------------------------------------------------------------
// Shared assertions for all presets
// ---------------------------------------------------------------------------

const allPresets: [string, AgentPreset][] = [
  ['RAGChatPreset', RAGChatPreset],
  ['ResearchPreset', ResearchPreset],
  ['SummarizerPreset', SummarizerPreset],
  ['QAPreset', QAPreset],
]

describe('built-in presets — common contract', () => {
  it.each(allPresets)('%s has a non-empty name', (_label, preset) => {
    expect(preset.name).toBeTruthy()
    expect(typeof preset.name).toBe('string')
  })

  it.each(allPresets)('%s has a non-empty description', (_label, preset) => {
    expect(preset.description).toBeTruthy()
    expect(typeof preset.description).toBe('string')
  })

  it.each(allPresets)('%s has non-empty instructions', (_label, preset) => {
    expect(preset.instructions).toBeTruthy()
    expect(preset.instructions.length).toBeGreaterThan(10)
  })

  it.each(allPresets)('%s has non-empty toolNames array', (_label, preset) => {
    expect(Array.isArray(preset.toolNames)).toBe(true)
    expect(preset.toolNames.length).toBeGreaterThan(0)
  })

  it.each(allPresets)('%s has guardrails with numeric maxIterations', (_label, preset) => {
    expect(preset.guardrails).toBeDefined()
    expect(typeof preset.guardrails.maxIterations).toBe('number')
    expect(preset.guardrails.maxIterations).toBeGreaterThan(0)
  })

  it.each(allPresets)('%s has guardrails with numeric maxCostCents', (_label, preset) => {
    expect(typeof preset.guardrails.maxCostCents).toBe('number')
    expect(preset.guardrails.maxCostCents!).toBeGreaterThan(0)
  })

  it.each(allPresets)('%s toolNames are all non-empty strings', (_label, preset) => {
    for (const tn of preset.toolNames) {
      expect(typeof tn).toBe('string')
      expect(tn.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// RAGChatPreset specifics
// ---------------------------------------------------------------------------

describe('RAGChatPreset', () => {
  it('has name "rag-chat"', () => {
    expect(RAGChatPreset.name).toBe('rag-chat')
  })

  it('requires rag_query tool', () => {
    expect(RAGChatPreset.toolNames).toContain('rag_query')
  })

  it('has balanced memory profile', () => {
    expect(RAGChatPreset.memoryProfile).toBe('balanced')
  })

  it('has modest iteration budget', () => {
    expect(RAGChatPreset.guardrails.maxIterations).toBeLessThanOrEqual(10)
  })

  it('does not have selfCorrection', () => {
    expect(RAGChatPreset.selfCorrection).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// ResearchPreset specifics
// ---------------------------------------------------------------------------

describe('ResearchPreset', () => {
  it('has name "research"', () => {
    expect(ResearchPreset.name).toBe('research')
  })

  it('has the broadest tool set', () => {
    expect(ResearchPreset.toolNames.length).toBeGreaterThanOrEqual(5)
    expect(ResearchPreset.toolNames).toContain('web_search')
    expect(ResearchPreset.toolNames).toContain('synthesize_report')
  })

  it('has the highest iteration budget among built-ins', () => {
    const maxIter = Math.max(...BUILT_IN_PRESETS.map((p) => p.guardrails.maxIterations))
    expect(ResearchPreset.guardrails.maxIterations).toBe(maxIter)
  })

  it('has maxTokens set', () => {
    expect(ResearchPreset.guardrails.maxTokens).toBeDefined()
    expect(ResearchPreset.guardrails.maxTokens!).toBeGreaterThan(0)
  })

  it('has selfCorrection enabled', () => {
    expect(ResearchPreset.selfCorrection).toBeDefined()
    expect(ResearchPreset.selfCorrection!.enabled).toBe(true)
    expect(ResearchPreset.selfCorrection!.maxReflectionIterations).toBeGreaterThan(0)
  })

  it('has defaultModelTier set', () => {
    expect(ResearchPreset.defaultModelTier).toBe('reasoning')
  })
})

// ---------------------------------------------------------------------------
// SummarizerPreset specifics
// ---------------------------------------------------------------------------

describe('SummarizerPreset', () => {
  it('has name "summarizer"', () => {
    expect(SummarizerPreset.name).toBe('summarizer')
  })

  it('uses minimal memory profile', () => {
    expect(SummarizerPreset.memoryProfile).toBe('minimal')
  })

  it('has low cost budget', () => {
    expect(SummarizerPreset.guardrails.maxCostCents!).toBeLessThanOrEqual(20)
  })

  it('requires rag_query and generate_content', () => {
    expect(SummarizerPreset.toolNames).toContain('rag_query')
    expect(SummarizerPreset.toolNames).toContain('generate_content')
  })
})

// ---------------------------------------------------------------------------
// QAPreset specifics
// ---------------------------------------------------------------------------

describe('QAPreset', () => {
  it('has name "qa"', () => {
    expect(QAPreset.name).toBe('qa')
  })

  it('requires rag_query tool', () => {
    expect(QAPreset.toolNames).toContain('rag_query')
  })

  it('has balanced memory profile', () => {
    expect(QAPreset.memoryProfile).toBe('balanced')
  })

  it('has moderate iteration/cost budget between rag-chat and research', () => {
    expect(QAPreset.guardrails.maxIterations).toBeGreaterThan(RAGChatPreset.guardrails.maxIterations)
    expect(QAPreset.guardrails.maxIterations).toBeLessThan(ResearchPreset.guardrails.maxIterations)
  })
})

// ---------------------------------------------------------------------------
// BUILT_IN_PRESETS collection
// ---------------------------------------------------------------------------

describe('BUILT_IN_PRESETS', () => {
  it('contains exactly 4 presets', () => {
    expect(BUILT_IN_PRESETS).toHaveLength(4)
  })

  it('all have unique names', () => {
    const names = BUILT_IN_PRESETS.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('includes all 4 expected presets', () => {
    const names = BUILT_IN_PRESETS.map((p) => p.name)
    expect(names).toContain('rag-chat')
    expect(names).toContain('research')
    expect(names).toContain('summarizer')
    expect(names).toContain('qa')
  })
})

import { describe, it, expect } from 'vitest'

import {
  DefaultCompactionStrategy,
  type CompactionSessionInfo,
} from '../session/compaction-strategy.js'
import type { AdapterProviderId } from '../types.js'

function makeSession(
  overrides: Partial<CompactionSessionInfo> = {},
): CompactionSessionInfo {
  return {
    sessionId: 'sess-1',
    providerId: 'claude',
    turnCount: 0,
    estimatedTokenCount: 0,
    ...overrides,
  }
}

describe('DefaultCompactionStrategy', () => {
  describe('canCompact', () => {
    it('returns true for providers that support compaction', () => {
      const strategy = new DefaultCompactionStrategy()
      expect(strategy.canCompact('claude')).toBe(true)
      expect(strategy.canCompact('codex')).toBe(true)
      expect(strategy.canCompact('gemini')).toBe(true)
      expect(strategy.canCompact('gemini-sdk')).toBe(true)
      expect(strategy.canCompact('goose')).toBe(true)
    })

    it('returns false for providers without compaction', () => {
      const strategy = new DefaultCompactionStrategy()
      expect(strategy.canCompact('qwen')).toBe(false)
      expect(strategy.canCompact('crush')).toBe(false)
      expect(strategy.canCompact('openrouter')).toBe(false)
    })
  })

  describe('shouldCompact', () => {
    it('returns false when under both thresholds', () => {
      const strategy = new DefaultCompactionStrategy()
      expect(
        strategy.shouldCompact('claude', makeSession(), 5, 1_000),
      ).toBe(false)
    })

    it('returns true when tokenCount exceeds 80% of max context', () => {
      const strategy = new DefaultCompactionStrategy()
      // Claude max = 200_000, 80% = 160_000
      expect(
        strategy.shouldCompact('claude', makeSession(), 1, 160_001),
      ).toBe(true)
    })

    it('returns true when turnCount exceeds 50 (default)', () => {
      const strategy = new DefaultCompactionStrategy()
      expect(
        strategy.shouldCompact('claude', makeSession(), 51, 0),
      ).toBe(true)
    })

    it('returns false for turnCount exactly at 49 and low tokens', () => {
      const strategy = new DefaultCompactionStrategy()
      expect(
        strategy.shouldCompact('claude', makeSession(), 49, 0),
      ).toBe(false)
    })

    it('returns true when turnCount equals max (50)', () => {
      const strategy = new DefaultCompactionStrategy()
      expect(
        strategy.shouldCompact('claude', makeSession(), 50, 0),
      ).toBe(true)
    })

    it('uses custom tokenThresholdRatio', () => {
      const strategy = new DefaultCompactionStrategy({ tokenThresholdRatio: 0.5 })
      // Claude max * 0.5 = 100_000
      expect(strategy.shouldCompact('claude', makeSession(), 0, 100_001)).toBe(true)
      expect(strategy.shouldCompact('claude', makeSession(), 0, 99_999)).toBe(false)
    })

    it('uses custom maxTurnsBeforeCompaction', () => {
      const strategy = new DefaultCompactionStrategy({ maxTurnsBeforeCompaction: 10 })
      expect(strategy.shouldCompact('claude', makeSession(), 10, 0)).toBe(true)
      expect(strategy.shouldCompact('claude', makeSession(), 9, 0)).toBe(false)
    })

    it('respects provider-specific max contexts (gemini: 1M)', () => {
      const strategy = new DefaultCompactionStrategy()
      // Gemini max = 1_000_000, 80% = 800_000
      expect(strategy.shouldCompact('gemini', makeSession(), 0, 799_999)).toBe(false)
      expect(strategy.shouldCompact('gemini', makeSession(), 0, 800_001)).toBe(true)
    })

    it('respects provider-specific max contexts (qwen: 32k)', () => {
      const strategy = new DefaultCompactionStrategy()
      // Qwen max = 32_000, 80% = 25_600
      expect(strategy.shouldCompact('qwen', makeSession(), 0, 25_500)).toBe(false)
      expect(strategy.shouldCompact('qwen', makeSession(), 0, 25_700)).toBe(true)
    })

    it('respects goose max context (128k)', () => {
      const strategy = new DefaultCompactionStrategy()
      expect(strategy.shouldCompact('goose', makeSession(), 0, 100_000)).toBe(false)
      expect(strategy.shouldCompact('goose', makeSession(), 0, 104_000)).toBe(true)
    })
  })

  describe('getCompactionRequest', () => {
    it('returns request with sessionId and strategy', () => {
      const strategy = new DefaultCompactionStrategy()
      strategy.shouldCompact('claude', makeSession(), 5, 1_000)
      const req = strategy.getCompactionRequest('sess-xyz')
      expect(req.sessionId).toBe('sess-xyz')
      expect(req.strategy).toBe('summarize')
      expect(req.targetTokenBudget).toBe(100_000) // 200k * 0.5
    })

    it('returns truncate strategy for providers that do not support compaction', () => {
      const strategy = new DefaultCompactionStrategy()
      strategy.shouldCompact('qwen', makeSession(), 0, 0)
      const req = strategy.getCompactionRequest('sess-qwen')
      expect(req.strategy).toBe('truncate')
      expect(req.targetTokenBudget).toBe(16_000) // 32k * 0.5
    })

    it('returns checkpoint strategy for goose', () => {
      const strategy = new DefaultCompactionStrategy()
      strategy.shouldCompact('goose', makeSession(), 0, 0)
      const req = strategy.getCompactionRequest('sess-goose')
      expect(req.strategy).toBe('checkpoint')
    })

    it('uses custom targetBudgetRatio', () => {
      const strategy = new DefaultCompactionStrategy({ targetBudgetRatio: 0.25 })
      strategy.shouldCompact('claude', makeSession(), 0, 0)
      const req = strategy.getCompactionRequest('sess')
      expect(req.targetTokenBudget).toBe(50_000) // 200k * 0.25
    })

    it('defaults to claude when shouldCompact was never called', () => {
      const strategy = new DefaultCompactionStrategy()
      const req = strategy.getCompactionRequest('sess-new')
      // Defaults to claude provider
      expect(req.strategy).toBe('summarize')
      expect(req.targetTokenBudget).toBe(100_000)
    })

    it('tracks last provider via shouldCompact', () => {
      const strategy = new DefaultCompactionStrategy()
      strategy.shouldCompact('claude', makeSession(), 0, 0)
      strategy.shouldCompact('gemini', makeSession(), 0, 0)
      const req = strategy.getCompactionRequest('sess')
      // Last provider was gemini
      expect(req.strategy).toBe('summarize')
      expect(req.targetTokenBudget).toBe(500_000) // 1M * 0.5
    })
  })

  describe('multi-provider regression', () => {
    it('handles all adapter provider IDs', () => {
      const strategy = new DefaultCompactionStrategy()
      const providers: AdapterProviderId[] = [
        'claude', 'codex', 'gemini', 'gemini-sdk',
        'qwen', 'crush', 'goose', 'openrouter',
      ]
      for (const p of providers) {
        expect(() => strategy.canCompact(p)).not.toThrow()
        expect(() => strategy.shouldCompact(p, makeSession(), 0, 0)).not.toThrow()
      }
    })
  })
})

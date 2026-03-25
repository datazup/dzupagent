import { describe, it, expect, beforeEach } from 'vitest'
import { PolicyAwareStagedWriter } from '../policy-aware-staged-writer.js'
import type { PolicyAwareStagedWriterConfig } from '../policy-aware-staged-writer.js'
import type { StagedRecord } from '../staged-writer.js'
import type { WritePolicy, WriteAction } from '../write-policy.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePolicy(name: string, action: WriteAction): WritePolicy {
  return {
    name,
    evaluate: () => action,
  }
}

function makeContentPolicy(name: string, fn: (value: Record<string, unknown>) => WriteAction): WritePolicy {
  return { name, evaluate: fn }
}

function makeRecord(
  key: string,
  value: Record<string, unknown>,
  confidence = 0.95,
): Omit<StagedRecord, 'stage' | 'createdAt'> {
  return {
    key,
    namespace: 'test-ns',
    scope: { tenantId: 't1' },
    value,
    confidence,
  }
}

function createWriter(
  policies: WritePolicy[],
  overrides?: Partial<PolicyAwareStagedWriterConfig>,
): PolicyAwareStagedWriter {
  return new PolicyAwareStagedWriter({
    autoPromoteThreshold: 0.7,
    autoConfirmThreshold: 0.9,
    maxPending: 100,
    policies,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PolicyAwareStagedWriter', () => {
  describe("capture() with 'auto' policy action", () => {
    it('should proceed normally and respect confidence for auto-promotion', () => {
      const writer = createWriter([makePolicy('allow-all', 'auto')])
      const record = makeRecord('k1', { text: 'safe content' }, 0.95)

      const result = writer.capture(record)

      // High confidence (0.95) + auto policy => should be auto-promoted and auto-confirmed
      expect(result.stage).toBe('confirmed')
      expect(result.key).toBe('k1')
    })

    it('should stay at captured stage when confidence is low and policy is auto', () => {
      const writer = createWriter([makePolicy('allow-all', 'auto')])
      const record = makeRecord('k1', { text: 'safe content' }, 0.3)

      const result = writer.capture(record)

      // Low confidence (0.3) — should not be auto-promoted
      expect(result.stage).toBe('captured')
    })

    it('should auto-promote but not auto-confirm at medium confidence', () => {
      const writer = createWriter([makePolicy('allow-all', 'auto')])
      const record = makeRecord('k1', { text: 'safe content' }, 0.8)

      const result = writer.capture(record)

      // 0.8 >= autoPromoteThreshold (0.7) but < autoConfirmThreshold (0.9)
      expect(result.stage).toBe('candidate')
    })
  })

  describe("capture() with 'reject' policy action", () => {
    it('should return a rejected record', () => {
      const writer = createWriter([makePolicy('reject-all', 'reject')])
      const record = makeRecord('k1', { text: 'forbidden content' }, 0.99)

      const result = writer.capture(record)

      expect(result.stage).toBe('rejected')
      expect(result.key).toBe('k1')
    })

    it('should not appear in pending records', () => {
      const writer = createWriter([makePolicy('reject-all', 'reject')])
      writer.capture(makeRecord('k1', { text: 'forbidden' }, 0.99))

      const pending = writer.getPending()
      expect(pending).toHaveLength(0)
    })

    it('should not appear in getByStage for captured, candidate, or confirmed', () => {
      const writer = createWriter([makePolicy('reject-all', 'reject')])
      writer.capture(makeRecord('k1', { text: 'forbidden' }, 0.99))

      expect(writer.getByStage('captured')).toHaveLength(0)
      expect(writer.getByStage('candidate')).toHaveLength(0)
      expect(writer.getByStage('confirmed')).toHaveLength(0)
    })
  })

  describe("capture() with 'confirm-required' policy action", () => {
    it('should set confidence to 0 so auto-promote never fires', () => {
      const writer = createWriter([makePolicy('needs-review', 'confirm-required')])
      const record = makeRecord('k1', { text: 'architectural decision' }, 0.99)

      const result = writer.capture(record)

      // confidence forced to 0 => stays captured (not promoted)
      expect(result.stage).toBe('captured')
    })

    it('should remain in pending records at captured stage', () => {
      const writer = createWriter([makePolicy('needs-review', 'confirm-required')])
      writer.capture(makeRecord('k1', { text: 'decision' }, 0.99))

      const pending = writer.getPending()
      expect(pending).toHaveLength(1)
      expect(pending[0]!.stage).toBe('captured')
    })
  })

  describe('PII content rejection', () => {
    it('should reject records containing email addresses via a PII policy', () => {
      const piiPolicy = makeContentPolicy('pii-check', (value) => {
        const text = typeof value['text'] === 'string' ? value['text'] : JSON.stringify(value)
        if (/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/.test(text)) {
          return 'reject'
        }
        return 'auto'
      })
      const writer = createWriter([piiPolicy])

      const result = writer.capture(
        makeRecord('k1', { text: 'Contact user@example.com for details' }, 0.99),
      )

      expect(result.stage).toBe('rejected')
    })

    it('should reject high-confidence PII content (policy overrides confidence)', () => {
      const piiPolicy = makeContentPolicy('pii-check', (value) => {
        const text = typeof value['text'] === 'string' ? value['text'] : ''
        return text.includes('SSN: 123-45-6789') ? 'reject' : 'auto'
      })
      const writer = createWriter([piiPolicy])

      const result = writer.capture(
        makeRecord('k1', { text: 'SSN: 123-45-6789' }, 1.0),
      )

      // Even with confidence 1.0, policy rejection wins
      expect(result.stage).toBe('rejected')
    })
  })

  describe('multiple policies composed', () => {
    it('should use the most restrictive action when policies disagree', () => {
      const autoPolicy = makePolicy('allow', 'auto')
      const rejectPolicy = makePolicy('deny', 'reject')
      const writer = createWriter([autoPolicy, rejectPolicy])

      const result = writer.capture(makeRecord('k1', { text: 'anything' }, 0.99))

      // reject > auto, so most restrictive wins
      expect(result.stage).toBe('rejected')
    })

    it('should use confirm-required when that is the most restrictive', () => {
      const autoPolicy = makePolicy('allow', 'auto')
      const confirmPolicy = makePolicy('review', 'confirm-required')
      const writer = createWriter([autoPolicy, confirmPolicy])

      const result = writer.capture(makeRecord('k1', { text: 'anything' }, 0.99))

      // confirm-required > auto, so confidence is forced to 0 => captured
      expect(result.stage).toBe('captured')
    })

    it('should reject over confirm-required when both present', () => {
      const confirmPolicy = makePolicy('review', 'confirm-required')
      const rejectPolicy = makePolicy('deny', 'reject')
      const writer = createWriter([confirmPolicy, rejectPolicy])

      const result = writer.capture(makeRecord('k1', { text: 'anything' }, 0.99))

      // reject > confirm-required
      expect(result.stage).toBe('rejected')
    })
  })

  describe('non-PII content', () => {
    it('should auto-promote as normal when all policies return auto', () => {
      const writer = createWriter([
        makePolicy('p1', 'auto'),
        makePolicy('p2', 'auto'),
      ])
      const record = makeRecord('k1', { text: 'Vanilla TypeScript code' }, 0.95)

      const result = writer.capture(record)

      // 0.95 >= autoConfirmThreshold (0.9) and all policies return auto
      expect(result.stage).toBe('confirmed')
    })
  })

  describe('getByStage("rejected")', () => {
    it('should not include policy-rejected records (they bypass the pending map)', () => {
      // When action is 'reject', the record is returned directly without
      // being added to the internal pending map, so getByStage won't find it.
      const writer = createWriter([makePolicy('deny', 'reject')])
      writer.capture(makeRecord('k1', { text: 'forbidden' }, 0.99))

      const rejected = writer.getByStage('rejected')
      // The rejected record was returned from capture() but never stored in pending
      expect(rejected).toHaveLength(0)
    })

    it('should include records rejected via the reject() method', () => {
      const writer = createWriter([makePolicy('allow', 'auto')])
      writer.capture(makeRecord('k1', { text: 'content' }, 0.3)) // stays captured
      writer.reject('k1')

      const rejected = writer.getByStage('rejected')
      expect(rejected).toHaveLength(1)
      expect(rejected[0]!.key).toBe('k1')
    })
  })

  describe('mixed workflow', () => {
    let sut: PolicyAwareStagedWriter

    beforeEach(() => {
      const piiPolicy = makeContentPolicy('pii', (value) => {
        const text = typeof value['text'] === 'string' ? value['text'] : ''
        if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) return 'reject'
        if (/\b(decision|constraint)\b/i.test(text)) return 'confirm-required'
        return 'auto'
      })
      sut = createWriter([piiPolicy])
    })

    it('should handle a mix of safe, PII, and decision records', () => {
      const safe = sut.capture(makeRecord('safe', { text: 'Use Vitest for testing' }, 0.95))
      const pii = sut.capture(makeRecord('pii', { text: 'SSN is 123-45-6789' }, 0.99))
      const decision = sut.capture(makeRecord('dec', { text: 'The decision is to use PostgreSQL as a constraint' }, 0.99))

      expect(safe.stage).toBe('confirmed')
      expect(pii.stage).toBe('rejected')
      expect(decision.stage).toBe('captured') // confirm-required => confidence 0 => captured

      // Only safe and decision should be in pending (PII rejected bypasses pending)
      const pending = sut.getPending()
      expect(pending).toHaveLength(1) // only decision (safe was confirmed)
      expect(pending[0]!.key).toBe('dec')

      const confirmed = sut.getByStage('confirmed')
      expect(confirmed).toHaveLength(1)
      expect(confirmed[0]!.key).toBe('safe')
    })
  })
})
